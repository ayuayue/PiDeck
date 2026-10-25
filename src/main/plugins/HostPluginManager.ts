/** Owns local discovery and exact-code consent, independently from pi extension discovery. */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
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
	/**
	 * 上次由 seedBuiltin 落位的指纹。用来区分「我们随包落的那份」与「用户改过 / 装过别的版本」：
	 * 只有目录内容仍等于这里记录的指纹时才允许被新版内置内容替换，用户动过的一律不覆盖。
	 */
	private seeded = new Map<string, string>();
	/**
	 * 状态文件里没有 `seeded` 记录（本机制之前落位的副本）。
	 * 那段时间只有 seedBuiltin 会写 `userData/host-plugins/<内置 id>`，但磁盘上分不出「我们落的」与「用户自己装的同 id 插件」，
	 * 只能拿 manifest.version 当第二条线索：版本不同 ⇒ 来自另一个 PiDeck 版本的内置载荷（即我们自己落的）；版本相同则当作用户的副本，不覆盖。
	 * 一旦 seedBuiltin 写过一次 seeded 记录就置 false，迁移只发生一次。
	 */
	private legacySeeded = false;
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

	/** 读授权与落位记录；`seedBuiltin` 与 `load` 都要先读它才知道磁盘上那份副本是不是我们自己落的。 */
	private async readState(): Promise<void> {
		let hasSeededRecord = false;
		try {
			const text = await readFile(this.statePath, "utf8");
			if (text.length > 64 * 1024) throw new Error("state-too-large");
			const state: unknown = JSON.parse(text);
			if (isPluginRecord(state) && state.version === 1 && isPluginRecord(state.grants)) {
				for (const [id, grant] of Object.entries(state.grants)) {
					if (isHostPluginId(id) && isPluginRecord(grant) && typeof grant.fingerprint === "string" && /^[a-f0-9]{64}$/.test(grant.fingerprint) && typeof grant.enabled === "boolean") this.grants.set(id, { fingerprint: grant.fingerprint, enabled: grant.enabled });
				}
			}
			if (isPluginRecord(state) && isPluginRecord(state.seeded)) {
				hasSeededRecord = true;
				for (const [id, fingerprint] of Object.entries(state.seeded)) {
					if (isHostPluginId(id) && typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint)) this.seeded.set(id, fingerprint);
				}
			}
		} catch {
			/* Missing/invalid state means no grants, never implicit enablement. */
		}
		this.legacySeeded = !hasSeededRecord;
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
	 * 归档安装、目录安装与内置落位共用同一条换血路径，避免三条路径的原子性语义漂移。
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
	 * 随包内置的示例插件落位。
	 *
	 * 三种情形：目录不存在 → 复制一份；目录内容仍等于上次落位的指纹（用户没动过）→ 用新版替换；
	 * 其余（用户改过、装过别的版本、自己写了一个同 id 的）→ 永不覆盖。
	 *
	 * 「落位」与「授权」仍然是两件事：首次落位后插件是 requiresConsent，要用户在设置页按指纹授权。
	 * 唯一的顺延是——用户授权过的**上一版内置内容**升级到新版内置内容时，授权跟着走。
	 * 这是第一方内容（PiDeck 自己随包分发）换版，若每次都要求重新授权，等于每次应用更新都让用户
	 * 重新批准自己的内置示例；第三方与用户改过的副本都不在顺延范围内。
	 */
	async seedBuiltin(sourceDirectory: string): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		// initialize 的调用序是 seedBuiltin → load，所以这里必须先自己读一次状态，否则看不到落位记录、也认不出旧格式。
		await this.readState();
		const entries: Dirent[] = await readdir(sourceDirectory, { withFileTypes: true }).catch(() => []);
		let changed = false;
		for (const entry of entries.slice(0, 16)) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || !isHostPluginId(entry.name)) continue;
			const source = await readHostPluginPackage(join(sourceDirectory, entry.name)).catch(() => undefined);
			if (!source) continue;
			const target = join(this.directory, entry.name);
			const installed = await readHostPluginPackage(target).catch(() => undefined);
			const seededFingerprint = this.seeded.get(entry.name);
			// 旧状态文件没有落位记录（legacySeeded）：版本不同就说明这份副本来自另一个 PiDeck 版本的内置载荷（见 legacySeeded 注释）。
			const refreshable = installed?.fingerprint === seededFingerprint || (this.legacySeeded && installed !== undefined && installed.manifest.version !== source.manifest.version);
			if (installed && !refreshable) continue;
			if (installed?.fingerprint === source.fingerprint) continue;
			const temporary = this.temporaryDirectory(".seed");
			try {
				await copyHostPluginPackage(join(sourceDirectory, entry.name), temporary);
				await this.swapDirectory(temporary, target);
			} catch {
				/* 内置示例落位失败不影响插件系统其余功能 */
				continue;
			} finally {
				await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
			}
			const grant = this.grants.get(entry.name);
			// 授权顺延：用户批准的就是磁盘上这份（grant 指纹等于 installed 指纹）且我们正在用自己更新的内置载荷替换它。
			if (installed && grant?.enabled === true && grant.fingerprint === installed.fingerprint) this.grants.set(entry.name, { fingerprint: source.fingerprint, enabled: true });
			this.seeded.set(entry.name, source.fingerprint);
			changed = true;
		}
		if (changed) await this.persistState().catch(() => undefined);
	}

	/**
	 * 卸载：撤权 → 删目录 → 清授权与落位记录。
	 * 内置示例不允许卸载——下次启动 seedBuiltin 会把它重新落位，删了只会让人以为卸载没生效；要停用它请用禁用。
	 */
	async remove(id: string): Promise<HostPluginCatalog> {
		const plugin = this.packages.get(id);
		if (!plugin) throw new Error("plugin-not-found");
		if (this.seeded.has(id)) throw new Error("plugin-builtin");
		// 先撤权再动磁盘：挂载中的视图要立刻失效，不能等删除完成（与 setEnabled 同序）。
		if (this.grants.get(id)?.enabled) {
			this.grants.set(id, { fingerprint: plugin.fingerprint, enabled: false });
			this.notify();
		}
		const retired = this.temporaryDirectory(".removed");
		if (
			!(await rename(join(this.directory, id), retired).then(
				() => true,
				() => false,
			))
		)
			throw new Error("plugin-remove-failed");
		await rm(retired, { recursive: true, force: true }).catch(() => undefined);
		this.grants.delete(id);
		this.seeded.delete(id);
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

	/** 串行写状态文件：授权与落位记录同一份，最后一次写入胜出，失败不抛给调用方之外的路径。 */
	private persistState(): Promise<void> {
		const state = JSON.stringify({ version: 1, grants: Object.fromEntries(this.grants), seeded: Object.fromEntries(this.seeded) });
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
