import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { trashPath } from "../fs/trash";
import { getAppLogger } from "../logging/sharedLogger";
import type { AppSettings, DisabledExtensionEntry, PiCliUpdateResult, PiExtensionListResult, PiExtensionSummary, PiUpdateCheckResult } from "../../shared/types";
import type { PiLocator } from "../pi/PiLocator";
import { toWslLinuxPath, toWindowsHostPath, type WslEnvironment } from "../wsl/WslPaths";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { BUILT_IN_EXTENSIONS, INTERNAL_BUILT_IN_EXTENSIONS, isBuiltInExtensionName, type BuiltInExtensionPathRoots } from "./builtInExtensions";
import { MIN_PI_VERSION_FOR_EXTENSION_WHITELIST, parsePiVersion, piVersionAtLeast } from "./extensionVersionGate";
import { redactForReport, truncateText } from "../health/redact";
import { PiSelfUpdateRunner, supportsPiSelfUpdate } from "../pi/piSelfUpdateRunner";
import { PiExtensionCatalog, type ExtensionNativeState } from "./piExtensionCatalog";
import { isPackageSource, isPathLikePackageSource } from "../../shared/piPackageSource";

export { BUILT_IN_EXTENSIONS } from "./builtInExtensions";
// 目录/版本查询域已抽到 piExtensionCatalog.ts（拆分 Wave 3）；以下是外部契约，原样再导出。
export { BUILT_IN_CONFLICT_KEYWORDS, extensionNameMatches, FILTERED_SUFFIX, type ExtensionNativeState } from "./piExtensionCatalog";

type SettingsProvider = () => AppSettings;
type ExtensionCopy = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

/**
 * 本地文件扩展判定（纯函数，导出供单测）：只有「裸文件名」才是 ~/.pi/agent/extensions 下
 * 自动发现的本地文件（卸载 = 删文件）；协议源与路径型 source（盘符 / UNC / POSIX 绝对 / ./ ../）
 * 都是 pi 的 packages 条目，必须交给 `pi remove`。
 * 判据来自 shared/piPackageSource，与「整包开关 / 项目资源」共用同一套识别，避免两处漂移。
 */
export function isLocalFileExtensionSource(source: string): boolean {
	return !isPackageSource(source);
}

/**
 * 通过 pi CLI 管理已安装扩展，避免桌面端直接改写 pi settings 导致和 CLI 行为不一致。
 * 自动检测 pi 版本，条件性添加 --no-approve（仅 pi >= 0.79.0 支持），
 * 兼容老版本避免 unknown option 错误。
 */
export class ExtensionManager {
	private wslEnvironment: WslEnvironment | null = null;
	/**
	 * 自更新执行链路协作者（拆分 Wave 2，计划见 docs/pi-self-update-split-plan.md）：
	 * 检查 / 通道分派 / 包管理器代跑 / 失败提示都在里面。
	 * public：行为测试需要注入窗口（stub runPi 与各代跑方法、替换 locator、直接调 fetchLatestVersion）。
	 */
	public readonly selfUpdate: PiSelfUpdateRunner;
	/**
	 * 扩展目录/版本查询协作者（拆分 Wave 3，计划见 docs/pi-self-update-split-plan.md）：
	 * pi list + 本地目录扫描 + 启用态投影 + npm 版本补全，缓存与并发去重都在里面。
	 * public：行为测试需要注入窗口（stub loadList / scanLocalExtensions / parseListOutput / npmViewVersion）。
	 */
	public readonly catalog: PiExtensionCatalog;

	constructor(
		private readonly locator: PiLocator,
		private readonly getSettings: SettingsProvider,
		/** 获取 PiDeck 桌面设置（含 removedBuiltInExtensions） */
		private readonly getPiDeckSettings: () => AppSettings = getSettings,
		/** 保存 PiDeck 桌面设置的部分更新 */
		private readonly patchPiDeckSettings: (patch: Partial<AppSettings>) => Promise<AppSettings> = async () => getSettings(),
		private readonly translate: ExtensionCopy = () => "Extension operation failed.",
		/** 内置扩展磁盘根：提供后可为内置扩展补齐真实路径，使「打开目录」可用。 */
		private readonly builtInRoots: BuiltInExtensionPathRoots | undefined = undefined,
	) {
		// 依赖全为窄接口/回调：更新器不反向 import 本类，runPi 与输出脱敏复用管理器实现。
		this.selfUpdate = new PiSelfUpdateRunner({
			locator,
			getSettings,
			translate,
			sanitizeCommandOutput: (value) => this.sanitizeCommandOutput(value),
			runPi: (args, timeout, options) => this.runPi(args, timeout, options),
			resetVersionProbeCache: () => {
				this.piVersion = null;
				this.piVersionPromise = null;
			},
			homeDir: () => this.homeDir,
		});
		this.catalog = new PiExtensionCatalog({
			runPi: (args, timeout, options) => this.runPi(args, timeout, options),
			locator,
			getSettings,
			getPiDeckSettings,
			translate,
			homeDir: () => this.homeDir,
			builtInRoots,
			readNativeState: (extension) => this.nativeEnabledReader?.(extension),
			toHostPath: (path) => (this.wslEnvironment ? toWindowsHostPath(path, this.wslEnvironment) : path),
			removeBuiltInFile: (source) => this.removeBuiltInFile(source),
			saveRemovedBuiltIn: (removedList) => this.saveRemovedBuiltIn(removedList),
		});
	}

	/** 将扩展文件边界切换到统一解析出的 WSL HOME；null 恢复 Windows home。 */
	configureWsl(environment: WslEnvironment | null) {
		this.wslEnvironment = environment;
		// 切换 WSL/本地 home 后旧缓存失效。
		this.invalidateListCache();
	}

	private get homeDir(): string {
		return this.wslEnvironment?.windowsHome ?? homedir();
	}

	/** 当前生效的用户 home（供插件开发等需要与扩展目录同源的调用方读取）。 */
	get userHomeDir(): string {
		return this.homeDir;
	}

	/** 缓存的 pi 版本号，用于条件性传递 --no-approve。 */
	private piVersion: string | null = null;
	private piVersionPromise: Promise<string | null> | null = null;

	/**
	 * 安装/卸载/开关后主动清缓存。
	 * 同时递增 generation 并断开 inflight 复用，避免旧请求完成后把已删除/已变更的列表写回。
	 */
	/**
	 * 安装/卸载/开关后主动清缓存（缓存代数与 inflight 复用语义见 PiExtensionCatalog）。
	 */
	invalidateListCache() {
		this.catalog.invalidateCache();
	}

	/** 列出扩展：缓存、并发去重、轻量/强制刷新策略全在 PiExtensionCatalog。 */
	async list(forceRefresh = false): Promise<PiExtensionListResult> {
		return this.catalog.list(forceRefresh);
	}

	/**
	 * 判断是否为本地文件扩展（~/.pi/agent/extensions 下自动发现的 .ts/目录）。
	 *
	 * 只有「裸文件名」（`orca-agent-status.ts`、`my-extension`）才是这里的本地文件：
	 * 协议源（npm:/file:/git:...）与路径型 source（`F:\pkg`、`./pkg`、`/opt/pkg`、UNC）都是
	 * pi 的 packages 条目，不属于 extensions 目录。判定收口在 isLocalFileExtensionSource。
	 */
	private isLocalFileExtension(source: string): boolean {
		return isLocalFileExtensionSource(source);
	}

	/**
	 * 删除本地扩展文件/目录。
	 * 只允许删除 extensions 目录下的单层 basename，防止路径穿越。
	 */
	private async removeLocalExtension(source: string): Promise<void> {
		const extensionsDir = join(this.homeDir, ".pi", "agent", "extensions");
		const trimmed = source.trim();
		const name = basename(trimmed);
		// source 必须等于 basename（如 orca-agent-status.ts），拒绝 ../ 或绝对路径穿越。
		if (!name || name !== trimmed || name === "." || name === "..") {
			throw new Error(this.translate("mainExtension.invalidPath"));
		}
		const targetPath = join(extensionsDir, name);
		// 本地扩展是用户安装的代码：删除走系统回收站（可恢复）；回收站不可用时抛错，拒绝硬删。
		await trashPath(targetPath, { source: "extension:uninstall" });
	}

	/**
	 * 卸载后清理禁用记录：1) 旧路径遗留的 pi settings.json disabledExtensions（兼容手动写入/旧版，
	 * 按 source 匹配）；2) PiDeck settings 的 scoped 条目——只清与本次卸载相同作用域的条目，
	 * 避免「卸载项目版但保留用户版禁用状态」被误清。
	 */
	private async clearDisabledEntry(source: string, scope: PiExtensionSummary["scope"] = "user"): Promise<void> {
		try {
			const settingsPath = join(this.homeDir, ".pi", "agent", "settings.json");
			const raw = await readFile(settingsPath, "utf8");
			const settings = JSON.parse(raw) as { disabledExtensions?: string[] };
			const disabled = settings.disabledExtensions ?? [];
			if (disabled.includes(source)) {
				settings.disabledExtensions = disabled.filter((item) => item !== source);
				await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
			}
		} catch {
			// settings 不存在或解析失败时忽略；卸载主流程已成功
		}
		try {
			const current = this.getPiDeckSettings().disabledExtensions ?? [];
			const next = current.filter((entry) => !(entry.scope === scope && entry.source === source));
			if (next.length !== current.length) {
				await this.patchPiDeckSettings({ disabledExtensions: next });
			}
		} catch {
			// PiDeck 设置写入失败不阻塞卸载主流程
		}
	}

	/**
	 * 删除用户扩展目录中的内置扩展文件。
	 * 只允许 pi-deck-* 单层 basename，防止路径穿越。
	 * force: 文件本就不存在时静默成功（幂等，适合启动残留清理）。
	 */
	async removeBuiltInFile(source: string): Promise<void> {
		const extensionsDir = join(this.homeDir, ".pi", "agent", "extensions");
		const trimmed = source.trim();
		const name = basename(trimmed);
		if (!name || name !== trimmed || !isBuiltInExtensionName(name)) {
			throw new Error("非法内置扩展路径");
		}
		// 早返回：loadList 每次都会对 removedBuiltInExtensions 逐项调用本方法清理残留，
		// 绝大多数条目早已不存在；先 existsSync 判定可免掉无效的 rm 系统调用（force 语义保留给真实存在）。
		const target = join(extensionsDir, name);
		if (!existsSync(target)) {
			return;
		}
		await rm(target, { force: true });
		// 启动残留清理的硬删（非用户主动删除，仅限 pi-deck-* 内置白名单）：记日志便于审计。
		getAppLogger()?.info("extension", "Built-in extension file removed", { name, path: join(extensionsDir, name) });
	}

	private async saveRemovedBuiltIn(removedList: string[]): Promise<void> {
		await this.patchPiDeckSettings({ removedBuiltInExtensions: removedList });
	}

	/**
	 * 禁用内置扩展：记入 removedBuiltInExtensions（RPC 启动时跳过 -e），
	 * 并清理用户扩展目录中可能残留的历史部署副本。
	 */
	async disableBuiltIn(source: string): Promise<void> {
		const normalized = source.trim();
		// 白名单成员才可操作：pi-deck-* 前缀不足以证明内置身份（demo 等用户文件同前缀）。
		if (!isBuiltInExtensionName(normalized)) {
			throw new Error("只能操作内置扩展");
		}
		if ((INTERNAL_BUILT_IN_EXTENSIONS as readonly string[]).includes(normalized)) {
			throw new Error("内部内置扩展不可禁用");
		}
		const current = this.getPiDeckSettings().removedBuiltInExtensions ?? [];
		if (!current.includes(normalized)) {
			await this.saveRemovedBuiltIn([...current, normalized]);
		}
		// 幂等清理旧部署；新路径不再依赖用户目录文件。
		await this.removeBuiltInFile(normalized).catch(() => undefined);
		this.invalidateListCache();
	}

	async removeBuiltIn(source: string): Promise<void> {
		const normalized = source.trim();
		// 白名单判定（与 disableBuiltIn 一致）：防 IPC 直接传非内置名（如 demo）走内置删除路径。
		if (!isBuiltInExtensionName(normalized)) {
			throw new Error("只能操作内置扩展");
		}
		await this.disableBuiltIn(normalized);
	}

	/**
	 * 恢复内置扩展：仅从 removedBuiltInExtensions 移除标记。
	 * 下次 Agent 启动会重新通过 -e 从 app resources 加载，无需再写用户扩展目录。
	 */
	async restoreBuiltIn(source: string): Promise<void> {
		const normalized = source.trim();
		const current = this.getPiDeckSettings().removedBuiltInExtensions ?? [];
		const next = current.filter((s) => s !== normalized);
		if (next.length === current.length) return;
		await this.saveRemovedBuiltIn(next);
		// 若用户目录仍有旧副本，一并删掉，避免与 -e 双加载。
		await this.removeBuiltInFile(normalized).catch(() => undefined);
		this.invalidateListCache();
	}

	/** 卸载：user/unknown 走全局缓存；project 走 `pi remove -l`，projectRoot 由 IPC 层经信任校验解析后传入。 */
	async uninstall(source: string, scope: PiExtensionSummary["scope"] = "user", options: { projectRoot?: string } = {}): Promise<void> {
		const normalized = source.trim();
		if (!normalized) throw new Error(this.translate("mainExtension.sourceRequired"));
		// 只挡白名单内置成员：pi-deck- 前缀不足以证明内置身份——插件开发 demo
		// （pi-deck-demo-plugin.ts）是普通本地扩展，卸载走删文件路径；真内置行的
		// 「卸载」由 removeBuiltIn（标记 removed + 删文件）承担，不能混用普通卸载。
		if (isBuiltInExtensionName(normalized)) {
			throw new Error(this.translate("mainExtension.builtInCannotUninstall"));
		}
		// 裸文件名的本地 .ts/目录扩展不在 pi package 列表里，pi remove 会报 No matching package；
		// 例如 orca-agent-status.ts 只能直接删文件。
		if (this.isLocalFileExtension(normalized)) {
			await this.removeLocalExtension(normalized);
		} else {
			// 协议源与路径型 source（pi install <本地目录>）都登记在 pi 的 packages 里，统一交给
			// pi remove：路径型 source 绝不能落进 removeLocalExtension——那里会把 basename 拼到
			// ~/.pi/agent/extensions 下删除，等于去删一个不存在的文件（必然失败且报告误导）。
			// 项目层 remove 与 install 同一信任路径：带项目 cwd + projectInstall（不推 --no-approve）。
			// --no-approve 下 pi 视项目为不信任直接拒改本地 packages（"Project is not trusted"），且无 cwd 会删错目录。
			await this.runPi(["remove", normalized, ...(scope === "project" ? ["-l"] : [])], 30_000, options.projectRoot ? { cwd: options.projectRoot, projectInstall: true } : {});
		}
		await this.clearDisabledEntry(normalized, scope);
		// 列表已变，清缓存，避免 UI 继续读到旧安装态。
		this.invalidateListCache();
	}

	/** Install globally or in the selected pi 0.85 project scope. */
	async install(source: string, options: { projectRoot?: string } = {}): Promise<string> {
		const normalized = source.trim();
		if (!normalized) throw new Error(this.translate("mainExtension.nameRequired"));
		const args = ["install", normalized, ...(options.projectRoot ? ["-l"] : [])];
		const result = await this.runPi(args, 120_000, {
			offline: false,
			cwd: options.projectRoot,
			projectInstall: Boolean(options.projectRoot),
		});
		this.invalidateListCache();
		return result;
	}

	async checkPiUpdate(): Promise<PiUpdateCheckResult> {
		return this.selfUpdate.check({ ...this.getSettings() });
	}

	/** Self-update only the selected pi installation, and verify it instead of trusting exit status. */
	async updatePi(): Promise<PiCliUpdateResult> {
		// 执行链路在 PiSelfUpdateRunner（拆分 Wave 2）：结果统一走 toUpdateResult 做 home 掩码/截断后再给 UI。
		const result = await this.selfUpdate.update();
		return this.toUpdateResult(result.command, result.output, result.updated);
	}

	/** Before self-update existed, bare `pi update` updated packages only. Keep that safe compatibility. */
	async updateExtensions(): Promise<PiCliUpdateResult> {
		const settings = { ...this.getSettings() };
		const status = await this.locator.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
		if (!status.installed) throw new Error(this.translate("mainExtension.piNotInstalled"));
		if (!parsePiVersion(status.version)) throw new Error(this.translate("mainExtension.piVersionUnknown"));
		const args = supportsPiSelfUpdate(status.version) ? ["update", "--extensions"] : ["update"];
		try {
			const output = await this.runPi(args, 120_000, { offline: false, settings, version: status.version });
			return this.toUpdateResult(`pi ${args.join(" ")}`, output, true);
		} finally {
			// A multi-package failure can still update earlier packages; refresh their displayed versions.
			this.invalidateListCache();
		}
	}

	/**
	 * 更新单个扩展：`pi update <source>`，source 与 list 输出一致（如 npm:context-mode）。
	 *
	 * 路径型 source（`pi install <本地目录>`）没有稳定的单包更新语义：`pi update <path>` 在不同
	 * pi 版本下会报 No matching package 或静默退回整包更新，UI 无法判断结果。统一改走
	 * updateExtensions()（即 `pi update --extensions`，缓存失效与输出脱敏一并复用）；
	 * 返回结果里的 command 如实展示实际执行的命令，用户不会被日志误导。
	 */
	async updateExtension(source: string): Promise<PiCliUpdateResult> {
		const normalized = source.trim();
		if (isPathLikePackageSource(normalized)) {
			return this.updateExtensions();
		}
		try {
			const output = await this.runPi(["update", normalized], 120_000, { offline: false });
			return this.toUpdateResult(`pi update ${normalized}`, output, true);
		} finally {
			this.invalidateListCache();
		}
	}

	/** CLI output can include registry credentials or personal paths; redact before logging/displaying it. */
	private sanitizeCommandOutput(value: string): string {
		return truncateText(redactForReport(value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim(), this.homeDir), 4_000);
	}

	private toUpdateResult(command: string, output: string, updated: boolean): PiCliUpdateResult {
		return { command: this.sanitizeCommandOutput(command), output: this.sanitizeCommandOutput(output), updated };
	}

	/**
	 * 开关扩展：enabled=false 写入 PiDeck settings 的 disabledExtensions（scope+source），
	 * 启动 RPC 时由白名单模式生效；enabled=true 从列表移除。
	 * 不写 pi settings.json：pi 0.82.x 不支持 disabledExtensions，写了也不生效。
	 */
	/**
	 * 注入原生开关（A4）：装配后扩展到开关写 pi settings.json 的过滤规则
	 * （包安装 → 整包停用；本地文件扩展 → 顶层精确 `+path`/`-path`），
	 * 与 TUI 的 pi config 等价。未装配时退回旧禁用列表（渐进迁移，行为不突变）。
	 */
	configureNativeToggle(toggle: (input: { source: string; path?: string; scope: PiExtensionSummary["scope"]; projectId?: string; enabled: boolean }) => Promise<{ ok: boolean; error?: string }>): void {
		this.nativeToggle = toggle;
	}

	/** 注入原生有效状态读取（迁移完成后禁用列表不再是真值来源）。 */
	configureNativeEnabledReader(reader: (extension: PiExtensionSummary) => ExtensionNativeState | undefined): void {
		this.nativeEnabledReader = reader;
	}

	private nativeToggle: ((input: { source: string; path?: string; scope: PiExtensionSummary["scope"]; projectId?: string; enabled: boolean }) => Promise<{ ok: boolean; error?: string }>) | null = null;
	private nativeEnabledReader: ((extension: PiExtensionSummary) => ExtensionNativeState | undefined) | null = null;

	/**
	 * UI 开关统一入口（桌面 IPC 与 Web 工作区路由共用）：先按身份分流——内置扩展走 PiDeck 设置
	 * （`-e` 注入 / removedBuiltInExtensions），其余走 pi 原生过滤规则。
	 *
	 * 分流必须收口在这一层：Web 路由若各自调 setEnabled，内置扩展会被写成顶层 `+/-<source>` 垃圾规则
	 * （pi 匹配不上、界面却报成功）；Web 端扩展列表又刻意剥离了宿主机路径，本地文件扩展会写出一条
	 * pi 永远匹配不上的 `+/-<source>`。两者都在这里补齐。
	 */
	async toggleFromUi(source: string, enabled: boolean, scope: PiExtensionSummary["scope"] = "user", path?: string, projectId?: string): Promise<void> {
		const normalized = source.trim();
		// 白名单判定：pi-deck-* 前缀不足以证明内置身份（插件开发 demo 同前缀，是普通本地扩展）。
		if (isBuiltInExtensionName(normalized)) {
			if (enabled) {
				await this.restoreBuiltIn(normalized);
			} else {
				await this.disableBuiltIn(normalized);
			}
			return;
		}
		// 本地文件扩展的原生规则按真实磁盘路径精确匹配（pi 按绝对路径 / baseDir 相对路径匹配），
		// 缺 path 时（Web 端列表不带路径）从列表缓存反查；包安装按 `npm:` 等 source 协议分流，path 会被忽略。
		const resolvedPath = path ?? (await this.resolveExtensionPath(normalized));
		await this.setEnabled(normalized, enabled, scope, resolvedPath, projectId);
	}

	/** 从扩展列表缓存按 source 反查真实路径；列表不可用或查不到时返回 undefined（由 setEnabled 按原样处理）。 */
	private async resolveExtensionPath(source: string): Promise<string | undefined> {
		try {
			const listed = await this.list();
			return listed.extensions.find((entry) => entry.source === source)?.path;
		} catch {
			return undefined;
		}
	}

	async setEnabled(source: string, enabled: boolean, scope: PiExtensionSummary["scope"] = "user", path?: string, projectId?: string): Promise<void> {
		// 原生配置优先：迁移完成后旧禁用列表已清空，开关直接写 pi 的过滤规则。
		if (this.nativeToggle) {
			const result = await this.nativeToggle({ source, path, scope, projectId, enabled });
			if (!result.ok) throw new Error(result.error ?? "Extension toggle failed.");
			// 不清列表缓存：开关只改 enabled，而 enabled 每次读取都由 applyEnabledProjection 重算
			// （原生规则 + PiDeck 禁用列表），结构信息（path/source/版本）不受影响。清缓存会让跟随
			// 开关的 UI 刷新白等一次 `pi list` 全量扫描（表现为开关行长时间 pending）。
			return;
		}
		// 旧兜底路径的版本门槛（原生开关已在上方优先处理）：过低版本的资源过滤语义不可考，
		// 直接拒绝禁用并提示；启用/移除禁用条目无风险，不做检查；版本未知（getPiVersion 为
		// null，如 pi 未安装/探测失败）时放行，避免拦截其他流程。
		if (!enabled) {
			const version = await this.getPiVersion();
			if (version !== null && !piVersionAtLeast(version, MIN_PI_VERSION_FOR_EXTENSION_WHITELIST)) {
				throw new Error(this.translate("mainExtension.piVersionTooOldForDisable", { version: version ?? "?" }));
			}
		}
		const current = this.getPiDeckSettings().disabledExtensions ?? [];
		const key = (entry: DisabledExtensionEntry) => `${entry.scope}:${entry.source}`;
		// 同 scope+source 只保留一条；不同 scope（user/project）相互独立，同名可在一处禁用、另一处启用。
		const next = current.filter((entry) => key(entry) !== `${scope}:${source.trim()}`);
		if (!enabled) {
			next.push({ scope, source: source.trim() });
		}
		await this.patchPiDeckSettings({ disabledExtensions: next });
		// 同上：结构未变，enabled 由投影重算，不清缓存（清缓存会让开关后的刷新付出一次全量扫描）。
	}

	/** 当前禁用的扩展条目（PiDeck settings，白名单模式依据）。 */
	getDisabledExtensions(): DisabledExtensionEntry[] {
		return this.getPiDeckSettings().disabledExtensions ?? [];
	}

	/**
	 * --no-approve 标志在 pi 0.79.0 引入。检测本地安装的 pi 版本是否支持。
	 */
	private async noApproveSupported(): Promise<boolean> {
		const version = await this.getPiVersion();
		// 完整 semver 比较：0.79+ 与 1.x+ 均支持；版本未知时不支持。
		return piVersionAtLeast(version, "0.79.0");
	}

	private async getPiVersion(): Promise<string | null> {
		if (this.piVersion) return this.piVersion;
		if (this.piVersionPromise) return this.piVersionPromise;
		this.piVersionPromise = this.detectPiVersion();
		return this.piVersionPromise;
	}

	/**
	 * 启动空闲预热：提前跑一次 pi 版本探测并写入 piVersion 缓存，让首次
	 * extensions:list 的 --no-approve 判定不再同步等待 `pi --version` 子进程。
	 *
	 * 尽力而为语义（预热硬约束）：已有缓存则直接返回、不重复探测；探测失败只记日志，
	 * 并把缓存还原成未探测状态——不把 null 固化，否则一次失败的预热会让后续真实调用
	 * 永远拿不到版本，--no-approve 判定被永久降级（预热失败不得影响任何主流程）。
	 */
	async warmPiVersionProbe(): Promise<void> {
		if (this.piVersion) return;
		// 只回滚自己发起的探测：蹭已在飞的探测时失败结果归真实调用方语义，不干预。
		const startedProbe = this.piVersionPromise === null;
		// getPiVersion 函数体内没有 await，调用返回时登记已同步完成；async 包装器不是登记物，
		// 紧邻一次读取拿到的才是本次自发探测写进 this.piVersionPromise 的那个 promise 身份。
		const probePromise = this.getPiVersion();
		const registeredProbe = this.piVersionPromise;
		try {
			const version = await probePromise;
			// 交错窗口内末写者胜出：applyUpdate 的 finally 先清空缓存、新调用方随后登记新探测时，
			// 抹掉 this.piVersionPromise 会让后续真实调用白跑一次 `pi --version` 子进程；
			// 只有登记者仍是本次自发探测才还原，否则保留新调用方的登记。
			if (startedProbe && version === null && this.piVersionPromise === registeredProbe) this.piVersionPromise = null;
		} catch (error) {
			if (startedProbe && this.piVersionPromise === registeredProbe) this.piVersionPromise = null;
			void getAppLogger()?.warn("extensions", "pi version prewarm failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async detectPiVersion(): Promise<string | null> {
		try {
			const settings = this.getSettings();
			const status = await this.locator.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
			if (status.installed && status.version) {
				this.piVersion = status.version;
				return status.version;
			}
		} catch {
			// 版本检测失败时静默处理，后续调用方会 fallback 为不支持 --no-approve
		}
		return null;
	}

	private async runPi(args: string[], timeout: number, options: { offline?: boolean; cwd?: string; projectInstall?: boolean; settings?: AppSettings; version?: string } = {}): Promise<string> {
		// 项目安装必须让 pi 读取已通过 PiDeck trust 校验的项目资源；--no-approve 会绕过该路径。
		const finalArgs = [...args];
		const noApproveSupported = options.version === undefined ? await this.noApproveSupported() : piVersionAtLeast(options.version, "0.79.0");
		if (!options.projectInstall && noApproveSupported) {
			finalArgs.push("--no-approve");
		}
		const settings = options.settings ?? this.getSettings();
		// 设置页装扩展可以等 WSL which；不能在 resolveCommand 里同步卡住主进程。
		if (settings.wslEnabled && settings.wslDistro && settings.wslUser) {
			await this.locator.warmWslCommand(settings.wslDistro, settings.wslUser);
		}
		const runtimeCwd = options.cwd && this.wslEnvironment ? toWslLinuxPath(options.cwd, this.wslEnvironment) : options.cwd;
		const command = this.locator.resolveCommand(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
		const invocation = this.locator.createInvocation(command, finalArgs, {
			wslCwd: this.wslEnvironment && runtimeCwd ? runtimeCwd : undefined,
		});
		const env = this.locator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl);
		// list/remove 默认走离线模式避免配置页被网络拖慢；store install 与 update 显式允许联网，
		// 否则 pi 只会返回简化的结果，无法真正完成包安装/更新。
		if (options.offline !== false) env.PI_OFFLINE = "1";
		else delete env.PI_OFFLINE;
		return new Promise<string>((resolve, reject) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env,
					...(invocation.wsl ? {} : { cwd: runtimeCwd }),
					shell: invocation.shell,
					windowsHide: true,
					timeout,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						const detail = this.sanitizeCommandOutput([stderr, stdout, error.message].filter(Boolean).join("\n"));
						void getAppLogger()?.error("extensions", "pi command failed", {
							args: finalArgs.map((arg) => this.sanitizeCommandOutput(arg)),
							error: detail,
							code: error.code,
							signal: error.signal,
						});
						const reason = this.translate(error.killed ? "mainExtension.commandTimedOut" : "mainExtension.commandFailed", { seconds: timeout / 1_000 });
						reject(new Error(`${reason}\n${detail}`));
						return;
					}
					// Update tools often write their actionable package-manager notices to stderr.
					resolve(args[0] === "update" && stderr.trim() ? `${stdout}\n${stderr}` : stdout);
				},
			);
		});
	}
}
