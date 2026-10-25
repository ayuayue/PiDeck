/**
 * DSH 用户插件安装服务（IPC dsh:plugin-user-install / dsh:plugin-market-search /
 * dsh:plugin-user-list 的主进程实现）。
 *
 * 安装 = scripts/install-dsh-plugin.mjs 的主进程移植：npm pack → 解包到
 * userData/dsh-plugins 受管目录 → 依赖闭包自包含嵌套（runtime 优先，缺失从 registry
 * 补）→ $DSH_HOME/cordis.patch.yml 追加 Loader 行（先备份，幂等）。
 * 卸载不在这里：DshHost.uninstallUserPlugin + dsh:plugin-user-uninstall 已有完整
 * 语义（移除行 + 仅受管目录回收），UI 卸载直接走那条链路，避免第二套实现分叉。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DshPluginMarketSearchResult, DshUserPluginInstallResult, DshUserPluginListEntry } from "../../shared/types";
import { USER_PATCH_FILENAME, dropEmptyArrayMarker, readUserPatchRows, resolveManagedPluginDir } from "./dshUserPlugins";
import { createDshPluginNpmRunner, validateNpmSpec, type DshPluginNpmLauncher, type DshPluginNpmRunner } from "./dshPluginNpmRunner";
import { extractTgz, nestDependencyClosure, npmPackToDir } from "./dshPluginTarball";
import { searchDshPluginMarket, type FetchLike } from "./dshPluginMarket";

/** 受管插件目录名（userData 下；卸载链路的回收判定用同一约定）。 */
export const MANAGED_PLUGINS_DIRNAME = "dsh-plugins";

/** 插件 manifest 的 dsh 字段（只取 uiOnly 判别关心的形状）。 */
export type DshPluginManifestDshField = {
	client?: {
		platform?: unknown;
		inject?: unknown;
	};
};

/**
 * 判别「UI-only 插件」：主要提供 DSH Web 界面功能（headless host 无可见效果）。
 *
 * 官方判据（research b2 + 官方文档）：`dsh.client` 声明浏览器端注入（platform=web
 * 或 inject 列表）= UI 插件——其 Host 入口不执行逻辑，只有 Web 客户端加载器会挂载
 * 浏览器入口，PiDeck 的 headless host 装了也没有可见效果。
 * dsh 字段缺失时回退命名惯例（*-client-ui-*）。
 */
export function detectUiOnlyPluginManifest(pkg: { name?: string; dsh?: unknown }): boolean {
	const dsh = pkg.dsh;
	if (typeof dsh === "object" && dsh !== null) {
		const client = Reflect.get(dsh, "client");
		if (typeof client === "object" && client !== null) {
			const platform = Reflect.get(client, "platform");
			if (platform === "web") return true;
			const inject = Reflect.get(client, "inject");
			if (Array.isArray(inject) && inject.length > 0) return true;
		}
	}
	const name = typeof pkg.name === "string" ? pkg.name : "";
	return /(?:^|[-/])client-ui(?:[-/]|$)/i.test(name);
}

/** 服务依赖（全注入：装配在 main/index.ts，测试传假实现）。 */
export type DshPluginInstallServiceDeps = {
	/** DSH home（cordis.patch.yml 所在）。 */
	getDshHomeDir: () => string;
	/** userData 根（受管插件目录的父）。 */
	getUserDataDir: () => string;
	/** runtime node_modules（依赖闭包优先来源）；未安装 runtime 时 undefined。 */
	resolveRuntimeNodeModules: () => string | undefined;
	launcher: DshPluginNpmLauncher;
	/** 覆盖默认 npm runner（测试注入替身；生产缺省走 launcher+execFile）。 */
	runNpm?: DshPluginNpmRunner;
	fetchImpl?: FetchLike;
	log?: (scope: string, message: string, detail?: unknown) => void;
};

export class DshPluginInstallService {
	private readonly runNpm: DshPluginNpmRunner;

	constructor(private readonly deps: DshPluginInstallServiceDeps) {
		this.runNpm = deps.runNpm ?? createDshPluginNpmRunner(deps.launcher, "npm");
	}

	/** 受管插件根（userData/dsh-plugins）。 */
	private managedRoot(): string {
		return join(this.deps.getUserDataDir(), MANAGED_PLUGINS_DIRNAME);
	}

	private patchPath(): string {
		return join(this.deps.getDshHomeDir(), USER_PATCH_FILENAME);
	}

	/** 搜索插件市场（官方目录 + npm 双源）。 */
	async searchPlugins(keyword: string): Promise<DshPluginMarketSearchResult> {
		const fetchImpl = this.deps.fetchImpl;
		if (fetchImpl === undefined) throw new Error("network access is not available");
		return searchDshPluginMarket({ keyword, fetchImpl, runNpm: this.runNpm });
	}

	/**
	 * 安装用户插件（幂等）：已注册同 id 行时跳过登记，只报告 alreadyRegistered。
	 * spec 只接受 npm 包名或 name@精确版本（validateNpmSpec 闸门在入口）。
	 */
	async installUserPlugin(spec: string): Promise<DshUserPluginInstallResult> {
		const validated = validateNpmSpec(spec);
		if (!validated.ok) throw new Error(validated.reason);
		const managedRoot = this.managedRoot();
		mkdirSync(managedRoot, { recursive: true });
		// pack + 解包进临时目录，成功后才原子落位（失败不留半截目录）
		const tmp = join(managedRoot, `.tmp-install-${process.pid}-${Date.now()}`);
		try {
			const packed = await npmPackToDir(this.runNpm, spec, tmp);
			const unpacked = join(tmp, "unpacked");
			await extractTgz(packed.tarPath, unpacked);
			const manifest = JSON.parse(readFileSync(join(unpacked, "package.json"), "utf8")) as Record<string, unknown>;
			const pkgName = manifest.name;
			if (typeof pkgName !== "string" || !pkgName) throw new Error("plugin package.json has no name");
			// 恶意包名（../evil 等）不得逃出受管根：规范化后用 relative 判定（跨平台，免拼分隔符）
			const destDir = resolve(join(managedRoot, ...pkgName.split("/")));
			const rel = relative(resolve(managedRoot), destDir);
			if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
				throw new Error(`plugin package name escapes managed directory: ${pkgName}`);
			}
			const version = typeof manifest.version === "string" ? manifest.version : undefined;
			if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
			mkdirSync(dirname(destDir), { recursive: true });
			cpSync(unpacked, destDir, { recursive: true });
			const closure = await nestDependencyClosure({
				pluginDir: destDir,
				runtimeNodeModules: this.deps.resolveRuntimeNodeModules(),
				runNpm: this.runNpm,
			});
			if (closure.missing.length > 0) {
				this.deps.log?.("dsh-plugin-install", "deps missing after nest", closure.missing);
			}
			const main = typeof manifest.main === "string" && manifest.main ? manifest.main : "index.js";
			const entryUrl = pathToFileURL(join(destDir, main)).href;
			const uiOnly = detectUiOnlyPluginManifest({ name: pkgName, dsh: manifest.dsh });
			const rowId = `${pkgName.replace(/^.*\//, "")}/host`;
			// registerUserPatchRow：true = 本次新写入；alreadyRegistered 语义相反（已存在则跳过）
			const registered = this.registerUserPatchRow(rowId, entryUrl);
			return {
				name: pkgName,
				version,
				rowId,
				entryUrl,
				destDir,
				uiOnly,
				alreadyRegistered: !registered,
				missingDeps: closure.missing,
			};
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	/**
	 * 追加 Loader 行到用户补丁层（先备份，幂等：已存在同 id 行返回 false 不动文件）。
	 * 复刻 install-dsh-plugin.mjs --register 的行级追加：不做 YAML round-trip
	 * （会抹掉用户注释），先摘掉 `[]` 空文档占位（与块式序列不能并存）。
	 */
	private registerUserPatchRow(rowId: string, entryUrl: string): boolean {
		const patchPath = this.patchPath();
		if (existsSync(patchPath)) {
			const raw = readFileSync(patchPath, "utf8");
			// 幂等闸门：不解析、直接文本包含判定（解析失败的手写文件也不重复追加）
			if (raw.includes(`id: ${rowId}`)) return false;
			const current = dropEmptyArrayMarker(raw);
			const backupPath = `${patchPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
			copyFileSync(patchPath, backupPath);
			const separator = current.endsWith("\n") ? "" : "\n";
			const rowText = ["- insert:", `    - id: ${rowId}`, `      name: ${entryUrl}`, "      config: {}", ""].join("\n");
			writeFileSync(patchPath, `${current}${separator}${rowText}\n`, "utf8");
			this.deps.log?.("dsh-plugin-install", "patch row registered", { rowId, backupPath });
			return true;
		}
		mkdirSync(dirname(patchPath), { recursive: true });
		const rowText = ["- insert:", `    - id: ${rowId}`, `      name: ${entryUrl}`, "      config: {}", ""].join("\n");
		writeFileSync(patchPath, `${rowText}\n`, "utf8");
		this.deps.log?.("dsh-plugin-install", "patch file created", { rowId });
		return true;
	}

	/**
	 * 用户补丁层清单（安装服务视角）：每行映射到受管目录内时补全包名/版本/uiOnly，
	 * 其余行（用户手工装的、指向任意路径）保持裸 rowId/moduleName。
	 */
	async listUserPlugins(): Promise<DshUserPluginListEntry[]> {
		const result = readUserPatchRows(this.patchPath());
		const managedRoot = this.managedRoot();
		const entries: DshUserPluginListEntry[] = [];
		for (const row of result.rows) {
			const entry: DshUserPluginListEntry = {
				rowId: row.id ?? "",
				moduleName: row.name ?? "",
			};
			const pluginDir = row.name !== undefined ? resolveManagedPluginDir(row.name, managedRoot) : undefined;
			if (pluginDir !== undefined) {
				try {
					const manifest = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")) as Record<string, unknown>;
					if (typeof manifest.name === "string") entry.packageName = manifest.name;
					if (typeof manifest.version === "string") entry.version = manifest.version;
					entry.uiOnly = detectUiOnlyPluginManifest({ name: typeof manifest.name === "string" ? manifest.name : undefined, dsh: manifest.dsh });
				} catch {
					// manifest 不可读：保持裸行（不影响卸载链路，那边按行名工作）
				}
			}
			entries.push(entry);
		}
		return entries;
	}
}
