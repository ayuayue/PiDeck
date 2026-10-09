import { execFile } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";
import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { trashPath } from "../fs/trash";
import { getAppLogger } from "../logging/sharedLogger";
import type { AppSettings, DisabledExtensionEntry, PiCliUpdateResult, PiExtensionListResult, PiExtensionSummary, PiUpdateCheckResult } from "../../shared/types";
import type { PiLocator } from "../pi/PiLocator";
import { PiProcess } from "../pi/PiProcess";
import { toWslLinuxPath, toWindowsHostPath, type WslEnvironment } from "../wsl/WslPaths";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { BUILT_IN_EXTENSIONS, INTERNAL_BUILT_IN_EXTENSIONS, isBuiltInExtensionName, isDefaultDisabledBuiltInExtension, readEffectiveBuiltInExtensionsVersion, resolveBuiltInExtensionPath, type BuiltInExtensionPathRoots } from "./builtInExtensions";
import { MIN_PI_VERSION_FOR_EXTENSION_WHITELIST, piVersionAtLeast } from "./extensionVersionGate";
// 版本查询快路：registry HTTP 优先，失败逐包回退 npm view 子进程（传输层优化，展示语义不变）。
import { createNpmRegistryVersionResolver } from "./npmRegistryVersion";
// 版本比较与应用更新检查共用同一实现（含预发布语义：beta < 同号正式版）。
import { compareVersions } from "../utils/versionCompare";
import { discoverExtensionEntries } from "./extensionDiscovery";
import { parsePiVersion } from "./extensionVersionGate";
import { redactForReport, truncateText } from "../health/redact";
import { readConfiguredNpmCommand } from "../resourceWhitelist";
import { resolvePiSelfUpdateChannel } from "../pi/piSelfUpdateChannel";

/** pi 0.70.3 introduced self-update and the packages-only --extensions flag. */
const MIN_PI_VERSION_FOR_SELF_UPDATE = "0.70.3";
const PI_LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const PI_LATEST_VERSION_TIMEOUT_MS = 10_000;

/** Numbered prereleases at the introduction boundary must not enable a not-yet-stable CLI API. */
function supportsPiSelfUpdate(version: string | undefined): boolean {
	const normalized = parsePiVersion(version);
	if (!normalized) return false;
	const [core] = normalized.split("-");
	const comparison = compareVersions(core ?? "", MIN_PI_VERSION_FOR_SELF_UPDATE);
	return comparison > 0 || (comparison === 0 && !normalized.includes("-"));
}

export { BUILT_IN_EXTENSIONS } from "./builtInExtensions";

/** pi 的 npm 包名。pi.dev 版本接口在包改名迁移期可返回不同 packageName，见 fetchPiLatestVersion。 */
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/**
 * pi list 对「过滤式安装」包的 source 后缀：settings.json 里 packages 条目为对象形式
 * （选择性加载指定资源）时，pi 在 list 输出中追加此标记。解析时剥离该后缀，
 * 过滤状态存进 PiExtensionSummary.filtered，避免污染卸载/更新等以 source 为参数的命令。
 */
export const FILTERED_SUFFIX = " (filtered)";

type SettingsProvider = () => AppSettings;
type ExtensionCopy = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

/**
 * 通过 pi CLI 管理已安装扩展，避免桌面端直接改写 pi settings 导致和 CLI 行为不一致。
 * 自动检测 pi 版本，条件性添加 --no-approve（仅 pi >= 0.79.0 支持），
 * 兼容老版本避免 unknown option 错误。
 */
export class ExtensionManager {
	private wslEnvironment: WslEnvironment | null = null;
	/** 扩展列表缓存：避免每次打开配置页都重新跑 pi list + npm view。 */
	private listCache: PiExtensionListResult | null = null;
	/** 缓存是否包含 npm 版本信息（仅 forceRefresh 路径会写入 true）。 */
	private listCacheHasVersionInfo = false;
	/** 进行中的列表请求，用于启动预热与并发去重。 */
	private listInflight: Promise<PiExtensionListResult> | null = null;
	/** 进行中请求是否为强制刷新（含版本信息）。 */
	private listInflightForce = false;
	/**
	 * 列表缓存代数：安装/卸载/开关后递增。
	 * 用于丢弃失效前已发出的 in-flight 结果，避免旧列表写回缓存导致 UI 不刷新。
	 */
	private listCacheGeneration = 0;
	/**
	 * 每次实际扫描递增。强制刷新可绕过轻量扫描；旧的轻量结果随后返回时，
	 * 不能覆盖已经拿到版本信息的强制刷新缓存。
	 */
	private listRequestSequence = 0;

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
	) {}

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
	invalidateListCache() {
		this.listCache = null;
		this.listCacheHasVersionInfo = false;
		this.listCacheGeneration += 1;
		// 允许下一次 list() 立刻发起新请求，而不是复用失效前的 inflight。
		this.listInflight = null;
		this.listInflightForce = false;
	}

	/**
	 * 列出扩展。
	 * - forceRefresh=false：优先返回内存缓存；无缓存时做一次轻量扫描（跳过 npm view）。
	 * - forceRefresh=true：强制重新 `pi list`，并补充 npm 版本信息。
	 */
	async list(forceRefresh = false): Promise<PiExtensionListResult> {
		// 有缓存且（非强制刷新，或缓存已含版本信息）时直接返回。
		if (this.listCache && (!forceRefresh || this.listCacheHasVersionInfo)) {
			return this.listCache;
		}
		// 已有同级或更强请求在飞时复用，避免并发打爆 pi/npm。
		if (this.listInflight && (!forceRefresh || this.listInflightForce)) {
			return this.listInflight;
		}

		// 捕获当前代数：若请求返回前发生 install/uninstall/toggle，丢弃结果并改走最新 list。
		const generation = this.listCacheGeneration;
		const requestSequence = ++this.listRequestSequence;
		this.listInflightForce = forceRefresh;
		const request = this.loadList(forceRefresh)
			.then((result) => {
				if (generation !== this.listCacheGeneration || requestSequence !== this.listRequestSequence) {
					// 失效前或被更强刷新取代的调用方也必须拿到最新列表，
					// 否则慢到的轻量扫描会覆盖已包含版本信息的强制刷新缓存。
					return this.list(forceRefresh);
				}
				this.listCache = result;
				this.listCacheHasVersionInfo = forceRefresh;
				return result;
			})
			.finally(() => {
				// 仅清理自己：失效后新发起的请求可能已经接管 listInflight。
				if (this.listInflight === request) {
					this.listInflight = null;
					this.listInflightForce = false;
				}
			});
		this.listInflight = request;
		return request;
	}

	private async loadList(includeVersionInfo: boolean): Promise<PiExtensionListResult> {
		// pi 进程列表与本地目录枚举互不依赖，并行启动把两条串行等待（子进程 spawn + 目录 IO）
		// 合并为一次往返；后续解析与 npm view 链仍等 pi 输出，行为与顺序不变。
		const [raw, localExtensions] = await Promise.all([this.runPi(["list"], 20_000), this.scanLocalExtensions()]);
		const parsed = this.parseListOutput(raw);
		// npm view 是扩展页变慢的主因；默认列表先跳过，只有手动刷新时再查更新。
		let piInstalled = parsed;
		if (includeVersionInfo) {
			// registry HTTP 快路：实例随本轮 loadList 创建——同包去重与基址解析都按轮次刷新，
			// 尊重用户改 npmrc 镜像后的下一轮刷新；快路失败逐包回退 npm view 子进程。
			const versionResolver = createNpmRegistryVersionResolver({
				resolveRegistryBase: () => this.resolveNpmRegistryBase(),
				npmViewFallback: (packageName) => this.npmViewVersion(packageName),
			});
			piInstalled = await Promise.all(parsed.map((extension) => this.enrichExtensionVersion(extension, versionResolver.resolveLatestVersion)));
		}

		// 合并，已通过 pi 安装的优先保留原条目
		const installedPaths = new Set(piInstalled.map((ext) => ext.path));
		const merged = [...piInstalled];
		for (const local of localExtensions) {
			if (!local.path || !installedPaths.has(local.path)) {
				merged.push(local);
			}
		}

		// 补充：将已禁用/文件缺失的内置扩展也纳入列表，确保用户可在 UI 中重新启用。
		const existingSources = new Set(merged.map((ext) => ext.source));
		for (const builtIn of BUILT_IN_EXTENSIONS) {
			if (!existingSources.has(builtIn)) {
				// 内置扩展经 -e 从应用资源目录注入；提供 builtInRoots 时补真实磁盘路径，
				// 让「打开目录」按钮可用（否则 path 为 undefined，UI 无法定位）。
				merged.push({
					id: `local:${builtIn}`,
					source: builtIn,
					path: this.builtInRoots ? resolveBuiltInExtensionPath(builtIn, this.builtInRoots) : undefined,
					scope: "user",
					builtIn: true,
				});
			}
		}

		// 通过 PiDeck 桌面设置标记启用状态（与 pi disabledExtensions 分离）。
		// 必须在冲突检测前初始化：后续逻辑会写回 removedBuiltInExtensions 并删磁盘文件。
		const removedBuiltIn = new Set(this.getPiDeckSettings().removedBuiltInExtensions ?? []);
		// 用户禁用的非内置扩展：按 scope+source 匹配（同名可在 user/project 两级独立开关）。
		const disabledExtKeys = new Set((this.getPiDeckSettings().disabledExtensions ?? []).map((entry) => `${entry.scope}:${entry.source}`));
		// 默认关闭（opt-in）的内置扩展：仅当用户显式开启（enabledBuiltInExtensions）才视为启用。
		const optInBuiltIn = new Set(this.getPiDeckSettings().enabledBuiltInExtensions ?? []);
		// 内置扩展版本：包级版本号（extensions-manifest.json，不跟 PiDeck 应用版本走），
		// 覆盖层（热更新）优先。逐行写入而非只在补齐分支赋值——内置条目可能来自
		// pi list、本地目录扫描、兜底补齐三条路径，版本只认「当前生效的那一份」。
		const builtInVersion = this.builtInRoots ? readEffectiveBuiltInExtensionsVersion(this.builtInRoots) : null;
		for (const ext of merged) {
			if (ext.builtIn) {
				ext.enabled = !removedBuiltIn.has(ext.source) && (!isDefaultDisabledBuiltInExtension(ext.source) || optInBuiltIn.has(ext.source));
				if (builtInVersion) ext.currentVersion = builtInVersion;
			} else {
				// 原生投影优先（迁移后 disabledExtensions 已清空）；未装配时退回旧列表。
				ext.enabled = this.nativeEnabledReader?.(ext) ?? !disabledExtKeys.has(`${ext.scope}:${ext.source}`);
			}
		}

		// 仅检测 todo / plan / ask 固定冲突：三方包名含对应关键词时自动禁用内置版。
		// nul-redirect-fix 等其它内置扩展暂不参与冲突检测，避免 mode 等通用词误伤。
		// 注意：此处不走 disableBuiltIn（会 invalidateListCache），避免 list 请求中途 generation
		// 变化导致结果被丢弃后反复重入。
		const conflicts: { builtIn: string; thirdParty: string }[] = [];
		let removedChanged = false;
		for (const [builtInName, keyword] of BUILT_IN_CONFLICT_KEYWORDS) {
			if (removedBuiltIn.has(builtInName)) continue; // 已移除的不重复检测
			const conflicting = merged.find((ext) => !ext.builtIn && ext.enabled !== false && extensionNameMatches(ext.source, keyword));
			if (conflicting) {
				removedBuiltIn.add(builtInName);
				removedChanged = true;
				// 内置扩展已改走 -e；仍清理用户目录历史部署副本，避免与三方包双加载冲突。
				await this.removeBuiltInFile(builtInName).catch(() => undefined);
				conflicts.push({
					builtIn: builtInName,
					thirdParty: conflicting.source,
				});
				// 同步更新 enabled 状态
				for (const ext of merged) {
					if (ext.builtIn && ext.source === builtInName) {
						ext.enabled = false;
					}
				}
			}
		}
		if (removedChanged) {
			await this.saveRemovedBuiltIn([...removedBuiltIn]);
		}

		// 已标记移除但磁盘仍有残留时主动清掉，修复「UI 已禁用但仍冲突」的历史状态。
		for (const builtInName of removedBuiltIn) {
			if (!builtInName.startsWith("pi-deck-") || (INTERNAL_BUILT_IN_EXTENSIONS as readonly string[]).includes(builtInName)) continue;
			await this.removeBuiltInFile(builtInName).catch(() => undefined);
		}

		return { extensions: merged, raw, conflicts: conflicts.length > 0 ? conflicts : undefined };
	}

	/**
	 * 扫描 ~/.pi/agent/extensions/ 目录，发现未被 pi list 列出的本地扩展。
	 * 发现规则与 pi 0.85 runtime resolver 共用：直接 .ts/.js、目录 index.ts/index.js，
	 * 以及 package.json 的 pi.extensions 声明；同一目录声明多个入口仍只显示一行。
	 */
	private async scanLocalExtensions(): Promise<PiExtensionSummary[]> {
		const extensionsDir = join(this.homeDir, ".pi", "agent", "extensions");
		const roots = new Map<string, string>();
		for (const entryPath of discoverExtensionEntries(extensionsDir)) {
			const relativePath = relative(extensionsDir, entryPath);
			const firstSegment = relativePath.split(sep)[0];
			// Manifest entries must resolve back to one direct child. Besides matching the
			// managed resource model, this prevents a malformed manifest from exposing a
			// parent path as the row's uninstall/open-location target.
			if (!firstSegment || firstSegment === "." || firstSegment === "..") continue;
			roots.set(firstSegment, join(extensionsDir, firstSegment));
		}

		return [...roots.entries()].map(([source, path]) => ({
			id: `local:${source}`,
			source,
			path,
			scope: "user",
			// 内置身份只认白名单成员（-e 注入清单）：用户目录里的 pi-deck-* 不再因前缀被判
			// 成内置——插件开发复制的 demo（pi-deck-demo-plugin.ts）是用户可编辑的普通扩展，
			// 启停/卸载走普通路径；真正的内置副本（历史部署残留）仍按内置处理，由启动迁移清理。
			builtIn: isBuiltInExtensionName(source),
		}));
	}

	/**
	 * 判断是否为本地文件扩展（~/.pi/agent/extensions 下自动发现的 .ts/目录）。
	 * pi list 的包源都带 npm:/file:/github: 等协议前缀；裸文件名只能走文件系统删除。
	 */
	private isLocalFileExtension(source: string): boolean {
		return !/^(?:npm|file|github|git|https?):/i.test(source);
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

	/**
	 * 开关「默认关闭」（opt-in）的内置扩展：enabled=true 写入 enabledBuiltInExtensions，
	 * false 则移出；不碰 removedBuiltInExtensions（那是另一套「用户主动禁用默认启用扩展」机制）。
	 * 下次 Agent 启动时按 opt-in 列表决定是否随 -e 注入。
	 */
	async toggleBuiltIn(source: string, enabled: boolean): Promise<void> {
		const normalized = source.trim();
		if (!isDefaultDisabledBuiltInExtension(normalized)) {
			throw new Error("仅默认关闭的内置扩展支持此开关");
		}
		// 自愈：历史上被「移除」过（进了 removedBuiltInExtensions）的 opt-in 扩展，
		// 用户重新打开开关时同步清掉 removed 标记——否则开关 ON 但注入层仍被 removed 拦住。
		if (enabled) {
			const removed = this.getPiDeckSettings().removedBuiltInExtensions ?? [];
			if (removed.includes(normalized)) {
				await this.saveRemovedBuiltIn(removed.filter((s) => s !== normalized));
			}
		}
		const current = this.getPiDeckSettings().enabledBuiltInExtensions ?? [];
		const next = enabled ? (current.includes(normalized) ? current : [...current, normalized]) : current.filter((s) => s !== normalized);
		if (next.length === current.length && next.every((s, i) => s === current[i])) return;
		await this.patchPiDeckSettings({ enabledBuiltInExtensions: next });
		this.invalidateListCache();
	}

	async uninstall(source: string, scope: PiExtensionSummary["scope"] = "user"): Promise<void> {
		const normalized = source.trim();
		if (!normalized) throw new Error(this.translate("mainExtension.sourceRequired"));
		// 只挡白名单内置成员：pi-deck- 前缀不足以证明内置身份——插件开发 demo
		// （pi-deck-demo-plugin.ts）是普通本地扩展，卸载走删文件路径；真内置行的
		// 「卸载」由 removeBuiltIn（标记 removed + 删文件）承担，不能混用普通卸载。
		if (isBuiltInExtensionName(normalized)) {
			throw new Error(this.translate("mainExtension.builtInCannotUninstall"));
		}
		// 本地 .ts/目录扩展不在 pi package 列表里，pi remove 会报 No matching package；
		// 例如 orca-agent-status.ts 只能直接删文件。
		if (this.isLocalFileExtension(normalized)) {
			await this.removeLocalExtension(normalized);
		} else {
			await this.runPi(["remove", normalized, ...(scope === "project" ? ["-l"] : [])], 30_000);
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
		return this.checkPiUpdateFor({ ...this.getSettings() });
	}

	/** Pin the installation settings throughout a check/update, even if the user switches runtimes. */
	private async checkPiUpdateFor(settings: AppSettings): Promise<PiUpdateCheckResult> {
		try {
			const status = await this.locator.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
			if (!status.installed) return { hasUpdate: false, error: this.translate("mainExtension.piNotInstalled") };
			// 与 `pi update --self` 使用同一个 pi.dev 版本接口，避免 npm latest 与 Pi 官方
			// 发布门槛短暂不同步时，PiDeck 显示的版本和 CLI 提示不一致。
			const release = await this.fetchPiLatestVersion(status.version ?? "0.0.0");
			return {
				currentVersion: status.version,
				latestVersion: release.version,
				hasUpdate: compareVersions(release.version, status.version ?? "0.0.0") > 0,
				// command / packageName 供 updatePi 的通道分派与包名 spec 使用。
				command: status.command,
				packageName: release.packageName,
			};
		} catch (error) {
			const detail = this.sanitizeCommandOutput(error instanceof Error ? error.message : String(error));
			void getAppLogger()?.error("extensions", "Pi update check failed", { error: detail });
			return { hasUpdate: false, error: `${this.translate("mainExtension.updateCheckFailed")}\n${detail}` };
		}
	}

	/** Self-update only the selected pi installation, and verify it instead of trusting exit status. */
	async updatePi(): Promise<PiCliUpdateResult> {
		const settings = { ...this.getSettings() };
		const check = await this.checkPiUpdateFor(settings);
		if (check.error) throw new Error(check.error);
		if (!check.hasUpdate) {
			return {
				command: "pi update --self",
				output:
					check.error ??
					this.translate("mainExtension.noUpdate", {
						current: check.currentVersion ?? "unknown",
						latest: check.latestVersion ?? "unknown",
					}),
				updated: false,
			};
		}
		// Older versions have no self-update API: do not guess npm/pnpm/standalone ownership.
		if (!supportsPiSelfUpdate(check.currentVersion)) {
			throw new Error(this.translate("mainExtension.piSelfUpdateUnsupported", { version: check.currentVersion || "?", minimum: MIN_PI_VERSION_FOR_SELF_UPDATE }));
		}
		// 通道分派（bun 全局 / 旧引导前缀 → PiDeck 代跑包管理器；其余 → pi 自身）。
		// 判定依赖 check 返回的 command（选中的 pi 可执行路径形状），见 piSelfUpdateChannel。
		const channel = resolvePiSelfUpdateChannel(check.command ?? "");
		const channelLabel = channel.kind === "bun-global" ? `bun install -g ${check.packageName ?? PI_PACKAGE_NAME}@${check.latestVersion}` : channel.kind === "portable-prefix" ? `npm install -g ${check.packageName ?? PI_PACKAGE_NAME}@${check.latestVersion} --prefix <pi-runtime>` : "pi update --self";
		let output: string;
		try {
			if (channel.kind === "bun-global") {
				output = await this.runBunGlobalUpdate(channel.bunCommand, check.latestVersion ?? "", check.packageName);
			} else if (channel.kind === "portable-prefix") {
				output = await this.runNpmPrefixUpdate(channel.prefixDir, check.latestVersion ?? "", check.packageName);
			} else {
				output = await this.runPi(["update", "--self"], 120_000, { offline: false, settings, version: check.currentVersion });
			}
		} finally {
			// A failed updater may still have changed files; never reuse a pre-update version probe.
			this.piVersion = null;
			this.piVersionPromise = null;
			PiProcess.invalidateVersionCache();
		}
		const status = await this.locator.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
		if (!status.installed || !status.version || compareVersions(status.version, check.latestVersion ?? "0.0.0") < 0) {
			throw new Error(`${this.translate("mainExtension.piUpdateNotApplied", { current: status.version || "?", latest: check.latestVersion || "?" })}\n${this.sanitizeCommandOutput(output)}`);
		}
		return this.toUpdateResult(channelLabel, output, true);
	}

	/** 代跑包管理器安装（bun/npm 全局自更新）：复用 locator 的 PATH 补齐与 shell 决策（与 npmViewVersion 同模式）。 */
	private runPackageInstall(commandPath: string, args: string[], timeoutMs: number): Promise<string> {
		const invocation = this.locator.createInvocation(commandPath, args);
		return new Promise((resolve, reject) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env: this.locator.createProcessEnv(this.getSettings(), invocation.pathPrefix),
					shell: invocation.shell,
					windowsHide: true,
					timeout: timeoutMs,
					maxBuffer: 4 * 1024 * 1024,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						reject(new Error(this.sanitizeCommandOutput(`${stdout}\n${stderr}`) || String(error)));
						return;
					}
					resolve(`${stdout}\n${stderr}`.trim());
				},
			);
		});
	}

	/** bun 全局安装代跑：参数对齐 pi 自身 bun 分支（`bun install -g <pkg>@<ver>`）。 */
	private runBunGlobalUpdate(bunCommand: string, version: string, packageName?: string): Promise<string> {
		return this.runPackageInstall(bunCommand, ["install", "-g", `${packageName ?? PI_PACKAGE_NAME}@${version}`], 180_000);
	}

	/** 旧引导前缀代跑：npm 落回用户全局目录时前缀副本永远停旧，必须显式 --prefix。 */
	private async runNpmPrefixUpdate(prefixDir: string, version: string, packageName?: string): Promise<string> {
		// 复用 pi settings.json 的 npmCommand（与包资源安装同源）：裸 npm 在 GUI PATH 里找不到时，
		// 用户配置的包装命令在这里同样生效（#318/#263）。
		const configured = readConfiguredNpmCommand(join(this.homeDir, ".pi", "agent", "settings.json"));
		return this.runPackageInstall(configured[0], [...configured.slice(1), "install", "-g", `${packageName ?? PI_PACKAGE_NAME}@${version}`, "--prefix", prefixDir], 300_000);
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

	/** 更新单个扩展：`pi update <source>`，source 与 list 输出一致（如 npm:context-mode）。 */
	async updateExtension(source: string): Promise<PiCliUpdateResult> {
		try {
			const output = await this.runPi(["update", source], 120_000, { offline: false });
			return this.toUpdateResult(`pi update ${source}`, output, true);
		} finally {
			this.invalidateListCache();
		}
	}

	private async enrichExtensionVersion(extension: PiExtensionSummary, resolveLatestVersion: (packageName: string) => Promise<string | null>): Promise<PiExtensionSummary> {
		if (!extension.source.toLowerCase().startsWith("npm:")) return extension;
		const packageName = extension.source.replace(/^npm:/i, "");
		try {
			const [currentVersion, latestVersion] = await Promise.all([this.readInstalledVersion(extension.path), resolveLatestVersion(packageName)]);
			return {
				...extension,
				currentVersion,
				// 快路与回退都以 null 表示「没查到」，投影到 PiExtensionSummary 的 undefined 语义
				latestVersion: latestVersion ?? undefined,
				hasUpdate: Boolean(currentVersion && latestVersion && compareVersions(latestVersion, currentVersion) > 0),
			};
		} catch (error) {
			console.error("[ExtensionManager] Extension version check failed", error);
			return { ...extension, updateError: this.translate("mainExtension.versionCheckFailed") };
		}
	}

	private async readInstalledVersion(path?: string) {
		if (!path) return undefined;
		const hostPath = this.wslEnvironment ? toWindowsHostPath(path, this.wslEnvironment) : path;
		const raw = await readFile(join(hostPath, "package.json"), "utf8");
		const parsed = JSON.parse(raw) as { version?: string };
		return parsed.version;
	}

	private async fetchPiLatestVersion(currentVersion: string, timeoutMs: number = PI_LATEST_VERSION_TIMEOUT_MS): Promise<{ version: string; packageName?: string }> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			// 必须走 Electron net.fetch（Chromium 网络栈）：系统代理与 PiDeck 桌面代理
			//（defaultSession.setProxy）才会生效。裸全局 fetch 是 undici 实现，不读任何
			// 代理配置，代理网络下直连 pi.dev 十秒必超时（v0.7.9 起的回归，报错只有
			// 含糊的 AbortError "This operation was aborted"）。动态 import 保持可单测
			//（沙箱注入 electron 桩），与 tokendanceCatalog 等主进程联网点同模式。
			const { net } = await import("electron");
			const response = await net.fetch(PI_LATEST_VERSION_URL, {
				headers: { accept: "application/json", "user-agent": `pi-deck/${currentVersion}` },
				signal: controller.signal,
			});
			if (!response.ok) throw new Error(`pi version check returned HTTP ${response.status}`);
			const payload: unknown = await response.json();
			if (typeof payload !== "object" || payload === null || !("version" in payload) || typeof payload.version !== "string" || !payload.version.trim()) {
				throw new Error("pi version check returned an invalid version");
			}
			// packageName 可选：pi.dev 在包改名迁移期返回与默认包名不同的目标（pi 自身的
			// getSelfUpdatePlan 同样处理），代跑更新时用它拼 <pkg>@<ver>，否则用默认包名。
			const rawPackageName = "packageName" in payload && typeof payload.packageName === "string" ? payload.packageName.trim() : "";
			return { version: payload.version.trim(), ...(rawPackageName ? { packageName: rawPackageName } : {}) };
		} catch (error) {
			// abort() 不带 reason 时上游只会给 "This operation was aborted"，用户无从判断；
			// 命中本方法自己的超时信号时统一转成明确超时文案，真实网络错误原样透传。
			if (controller.signal.aborted) {
				throw new Error(`pi.dev version check timed out after ${Math.round(timeoutMs / 1000)}s (network unreachable or proxy required)`);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	private npmViewVersion(packageName: string) {
		// 复用 pi settings.json 的 npmCommand（与包资源安装同源）：裸 npm 在 GUI PATH 里找不到时
		// （fnm/nvm XDG 布局等），用户配置的包装命令在这里同样生效（#318/#263 遗留）。
		const configured = readConfiguredNpmCommand(join(this.homeDir, ".pi", "agent", "settings.json"));
		const invocation = this.locator.createInvocation(configured[0], [...configured.slice(1), "view", packageName, "version"]);
		return new Promise<string>((resolve, reject) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env: this.locator.createProcessEnv(this.getSettings(), invocation.pathPrefix),
					shell: invocation.shell,
					windowsHide: true,
					timeout: 30_000,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						// Electron 启动环境经常缺少用户 shell PATH；通过 PiLocator 补齐 PATH 后仍失败时，把 stderr 透出给设置页。
						reject(new Error((stderr || error.message).trim()));
						return;
					}
					resolve(stdout.trim());
				},
			);
		});
	}

	/**
	 * 解析 npm registry 基址（`npm config get registry`）：与 npm view 走同一 npm 上下文，
	 * 自动尊重 user/project npmrc 的镜像与 scope 配置。子进程失败、超时或输出不是
	 * http(s) 地址时返回 null，版本查询整轮回退 npm view 子进程（现状行为）。
	 */
	private resolveNpmRegistryBase(): Promise<string | null> {
		const configured = readConfiguredNpmCommand(join(this.homeDir, ".pi", "agent", "settings.json"));
		const invocation = this.locator.createInvocation(configured[0], [...configured.slice(1), "config", "get", "registry"]);
		return new Promise<string | null>((resolve) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env: this.locator.createProcessEnv(this.getSettings(), invocation.pathPrefix),
					shell: invocation.shell,
					windowsHide: true,
					timeout: 10_000,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout) => {
					const value = (error ? "" : stdout).trim();
					resolve(/^https?:\/\//i.test(value) ? value : null);
				},
			);
		});
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
	configureNativeEnabledReader(reader: (extension: PiExtensionSummary) => boolean | undefined): void {
		this.nativeEnabledReader = reader;
	}

	private nativeToggle: ((input: { source: string; path?: string; scope: PiExtensionSummary["scope"]; projectId?: string; enabled: boolean }) => Promise<{ ok: boolean; error?: string }>) | null = null;
	private nativeEnabledReader: ((extension: PiExtensionSummary) => boolean | undefined) | null = null;

	async setEnabled(source: string, enabled: boolean, scope: PiExtensionSummary["scope"] = "user", path?: string, projectId?: string): Promise<void> {
		// 原生配置优先：迁移完成后旧禁用列表已清空，开关直接写 pi 的过滤规则。
		if (this.nativeToggle) {
			const result = await this.nativeToggle({ source, path, scope, projectId, enabled });
			if (!result.ok) throw new Error(result.error ?? "Extension toggle failed.");
			this.invalidateListCache();
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
		// 开关状态变化后同步清缓存，避免 UI 显示旧 enabled。
		this.invalidateListCache();
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

	private parseListOutput(raw: string): PiExtensionSummary[] {
		const result: PiExtensionSummary[] = [];
		let scope: PiExtensionSummary["scope"] = "unknown";
		let pending: PiExtensionSummary | null = null;

		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (/^User packages:/i.test(trimmed)) {
				scope = "user";
				pending = null;
				continue;
			}
			if (/^Project packages:/i.test(trimmed)) {
				scope = "project";
				pending = null;
				continue;
			}

			if (/^(?:npm|file|github|git|https?):/i.test(trimmed)) {
				// pi list 对「过滤式安装」的包在 source 后追加 " (filtered)" 标记
				// （settings.json 里 packages 条目是对象形式，只选择性加载列出的资源）。
				// source 必须剥离该后缀：卸载/更新/版本查询都以 source 为参数，
				// 带后缀时 pi remove / pi update / npm view 都找不到目标。
				const isFiltered = trimmed.endsWith(FILTERED_SUFFIX);
				const source = isFiltered ? trimmed.slice(0, -FILTERED_SUFFIX.length) : trimmed;
				pending = {
					id: `${scope}:${source}`,
					source,
					scope,
					...(isFiltered ? { filtered: true } : {}),
				};
				result.push(pending);
				continue;
			}

			if (pending && !pending.path) {
				pending.path = trimmed;
			}
		}

		return result;
	}
}

/**
 * 当前参与冲突检测的内置扩展与关键词。
 * todo / plan / ask：三方包名含关键词即视为功能冲突；其它内置扩展暂不自动互斥。
 */
export const BUILT_IN_CONFLICT_KEYWORDS = [
	["pi-deck-todo.ts", "todo"],
	["pi-deck-plan-mode.ts", "plan"],
	["pi-deck-goal-mode.ts", "goal"],
	["pi-deck-ask-question.ts", "ask"],
] as const;

/**
 * 固定关键词冲突匹配：清理协议/作用域后，包名是否包含指定关键词。
 * 例：rpiv-todo、my-plan-helper 命中；context-mode 不含 plan/todo 不命中。
 */
export function extensionNameMatches(source: string, keyword: string): boolean {
	const clean = source
		.replace(/^(?:npm|file|github|git|https?):/i, "")
		.replace(/\.ts$/, "")
		.replace(/@[^/]+\//, "")
		.toLowerCase();
	return clean.includes(keyword.toLowerCase());
}
