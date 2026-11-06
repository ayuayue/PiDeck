/** Owns local discovery and exact-code consent, independently from pi extension discovery. */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostPluginCatalog, HostPluginInfo } from "../../shared/types/hostPlugin";
import { renameWithRetry } from "../utils/fsRetry";
import { isHostPluginId, isPluginRecord } from "./hostPluginManifest";
import { copyHostPluginPackage, readHostPluginPackage, stageHostPluginFile, type HostPluginPackage } from "./hostPluginFiles";
import { parseHostPluginArchive } from "./hostPluginArchive";

type Grant = { fingerprint: string; enabled: boolean };

export class HostPluginManager {
	readonly directory: string;
	private readonly statePath: string;
	private packages = new Map<string, HostPluginPackage>();
	private grants = new Map<string, Grant>();
	private issues: HostPluginCatalog["issues"] = [];
	private listeners = new Set<() => void>();
	private writeQueue: Promise<void> = Promise.resolve();
	private revision = 0;

	constructor(
		userData: string,
		private readonly disabled = false,
	) {
		this.directory = join(userData, "host-plugins");
		this.statePath = join(userData, "host-plugin-state.json");
	}

	/** Corrupt consent is never interpreted as trust; plugins remain disabled. */
	async load(): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		await this.readState();
		await this.rescan();
	}

	/**
	 * 只读授权。旧版本状态文件里的 `seeded`（已移除的内置示例落位记录）直接忽略：
	 * 那份记录不再有任何读者，下次写入时自然消失，不需要额外迁移分支。
	 */
	private async readState(): Promise<void> {
		try {
			const text = await readFile(this.statePath, "utf8");
			if (text.length > 64 * 1024) throw new Error("state-too-large");
			const state: unknown = JSON.parse(text);
			if (isPluginRecord(state) && state.version === 1 && isPluginRecord(state.grants)) {
				for (const [id, grant] of Object.entries(state.grants)) {
					if (isHostPluginId(id) && isPluginRecord(grant) && typeof grant.fingerprint === "string" && /^[a-f0-9]{64}$/.test(grant.fingerprint) && typeof grant.enabled === "boolean") this.grants.set(id, { fingerprint: grant.fingerprint, enabled: grant.enabled });
				}
			}
		} catch {
			/* Missing/invalid state means no grants, never implicit enablement. */
		}
	}

	onChanged(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Rebuild atomically; a racing older scan must not replace newer package identities. */
	async rescan(): Promise<HostPluginCatalog> {
		const revision = ++this.revision;
		const packages = new Map<string, HostPluginPackage>();
		const issues: HostPluginCatalog["issues"] = [];
		const entries = await readdir(this.directory, { withFileTypes: true });
		const directories = entries.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name));
		if (directories.length > 32) issues.push({ directory: "", code: "too-many-plugins" });
		for (const entry of directories.slice(0, 32)) {
			try {
				const plugin = await readHostPluginPackage(join(this.directory, entry.name));
				if (packages.has(plugin.manifest.id)) throw new Error("duplicate-plugin-id");
				packages.set(plugin.manifest.id, plugin);
			} catch (error) {
				issues.push({ directory: entry.name, code: error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : "invalid-package" });
			}
		}
		if (revision === this.revision) {
			this.packages = packages;
			this.issues = issues;
			this.notify();
		}
		return this.catalog();
	}

	/** Install a `.pideck-plugin` archive: extract to a hidden temp dir, re-run full package validation, swap atomically. */
	async installArchive(archivePath: string): Promise<HostPluginCatalog> {
		// 先看体再读内容：拒绝把超大文件整读进内存。
		if ((await stat(archivePath)).size > 24 * 1024 * 1024) throw new Error("archive-too-large");
		const { files } = parseHostPluginArchive(await readFile(archivePath));
		return await this.installFiles(files);
	}

	/**
	 * 逐文件落位：归档、目录包与 GitHub 源码包共用这一条暂存路径，
	 * 三种来源的信任判定、授权门禁与原子换入完全一致，不会因为多一个来源就多一条信任路径。
	 */
	async installFiles(files: ReadonlyArray<{ path: string; bytes: Buffer }>): Promise<HostPluginCatalog> {
		if (files.length === 0) throw new Error("missing-manifest");
		const temporary = this.temporaryDirectory(".install");
		try {
			await mkdir(temporary, { recursive: true });
			for (const file of files) await stageHostPluginFile(temporary, file.path, file.bytes);
			return await this.commitStagedPackage(temporary);
		} finally {
			await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/**
	 * 从本地目录安装：「已解压的目录包」是分发归档之外的第二来源（pi-context 这类上游经
	 * scripts/convert-pi-context-host-plugin.mjs 转换后就是这个形态）。
	 * 与归档导入共用同一条落位路径，信任判定完全一致，差别只在来源是目录而非归档字节。
	 */
	async installDirectory(sourceDirectory: string): Promise<HostPluginCatalog> {
		// 对话框已限制过一次，这里是服务层自己的边界校验：来源必须是一个真实存在的目录。
		if (!(await stat(sourceDirectory).catch(() => undefined))?.isDirectory()) throw new Error("not-a-directory");
		const temporary = this.temporaryDirectory(".install");
		try {
			await copyHostPluginPackage(sourceDirectory, temporary);
			return await this.commitStagedPackage(temporary);
		} finally {
			await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** 隐藏 temp 目录不会进入 rescan（点前缀过滤），失败也不会污染目录列表。 */
	private temporaryDirectory(prefix: string): string {
		return join(this.directory, `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
	}

	/** 全量校验 → 拒绝换血 → 原子换入（失败回滚）；归档与目录两个来源共用，避免两条信任路径漂移。 */
	private async commitStagedPackage(temporary: string): Promise<HostPluginCatalog> {
		// 目录包全量验证（manifest 规则/指纹/panel 入口）复用同一入口，安装包与手工放置无差别信任。
		const plugin = await readHostPluginPackage(temporary);
		const grant = this.grants.get(plugin.manifest.id);
		// 启用中的插件可能正被挂载运行；替换代码必须先禁用，避免运行中被换血。
		if (grant?.enabled) throw new Error("plugin-in-use");
		await this.swapDirectory(temporary, join(this.directory, plugin.manifest.id));
		return this.rescan();
	}

	/**
	 * 把已 staged 的临时目录换成正式目录：旧目录先改名让位，换入失败时回滚，成功后再删旧目录。
	 * 归档安装与目录安装共用同一条换血路径，避免两种来源的原子性语义漂移。
	 */
	private async swapDirectory(temporary: string, target: string): Promise<void> {
		const retired = this.temporaryDirectory(".retired");
		let previous: string | undefined;
		if (
			await stat(target).then(
				() => true,
				() => false,
			)
		)
			previous = await rename(target, retired).then(
				() => retired,
				() => undefined,
			);
		try {
			await renameWithRetry(temporary, target);
		} catch (error) {
			// 换入失败时尽力回滚旧包，不留半更新状态。
			if (previous) await rename(previous, target).catch(() => undefined);
			throw error;
		}
		if (previous) await rm(previous, { recursive: true, force: true }).catch(() => undefined);
	}

	/**
	 * 卸载：撤权 → 删目录 → 清授权。
	 * 插件全部由用户自己安装（文件 / 目录 / GitHub / 市场），没有会自动回来的副本，因此这里没有内置例外。
	 */
	async remove(id: string): Promise<HostPluginCatalog> {
		const plugin = this.packages.get(id);
		if (!plugin) throw new Error("plugin-not-found");
		// 先撤权再动磁盘：挂载中的视图要立刻失效，不能等删除完成（与 setEnabled 同序）。
		if (this.grants.get(id)?.enabled) {
			this.grants.set(id, { fingerprint: plugin.fingerprint, enabled: false });
			this.notify();
		}
		const retired = this.temporaryDirectory(".removed");
		// 按包的实际目录删（不拼 id）：用户手工放进来的目录名可以与其 manifest.id 不同，拼 id 会让卸载直接失败。
		if (
			!(await rename(plugin.root, retired).then(
				() => true,
				() => false,
			))
		)
			throw new Error("plugin-remove-failed");
		await rm(retired, { recursive: true, force: true }).catch(() => undefined);
		this.grants.delete(id);
		await this.persistState().catch(() => undefined);
		return this.rescan();
	}

	catalog(): HostPluginCatalog {
		const plugins: HostPluginInfo[] = [...this.packages.values()].map((plugin) => {
			const grant = this.grants.get(plugin.manifest.id);
			return { manifest: plugin.manifest, fingerprint: plugin.fingerprint, enabled: !this.disabled && grant?.enabled === true && grant.fingerprint === plugin.fingerprint, requiresConsent: grant?.fingerprint !== plugin.fingerprint };
		});
		return { directory: this.directory, plugins, issues: this.issues };
	}

	/** Only exact consent from the trusted management UI can authorize the package. */
	async setEnabled(id: string, enabled: boolean, fingerprint: string): Promise<HostPluginCatalog> {
		const plugin = this.packages.get(id);
		if (!plugin || plugin.fingerprint !== fingerprint || (enabled && this.disabled)) throw new Error("plugin-changed");
		const previous = this.grants.get(id);
		this.grants.set(id, { fingerprint, enabled });
		// Disable first: API revocation cannot wait for disk writes to finish.
		this.notify();
		const persist = this.persistState();
		try {
			await persist;
		} catch (error) {
			// Never restore enablement on failed disable. Failed enable remains revoked.
			this.grants.set(id, { fingerprint: previous?.fingerprint ?? fingerprint, enabled: false });
			this.notify();
			throw error;
		}
		return this.catalog();
	}

	getEnabled(id: string): HostPluginPackage | undefined {
		const plugin = this.packages.get(id);
		const grant = this.grants.get(id);
		return !this.disabled && plugin && grant?.enabled && grant.fingerprint === plugin.fingerprint ? plugin : undefined;
	}

	/** 串行写状态文件：最后一次写入胜出，失败不抛给调用方之外的路径。 */
	private persistState(): Promise<void> {
		const state = JSON.stringify({ version: 1, grants: Object.fromEntries(this.grants) });
		const persist = this.writeQueue.then(async () => {
			const temporary = `${this.statePath}.tmp`;
			await writeFile(temporary, state, { mode: 0o600 });
			await renameWithRetry(temporary, this.statePath);
		});
		this.writeQueue = persist.catch(() => undefined);
		return persist;
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
	/** All active views subscribe here and are released by their owning service. */
	dispose(): void {
		this.listeners.clear();
	}
}
