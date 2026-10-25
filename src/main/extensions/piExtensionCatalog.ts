import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { AppSettings, PiExtensionListResult, PiExtensionSummary } from "../../shared/types";
import { isPackageSource, isPathLikePackageSource } from "../../shared/piPackageSource";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { PiLocator } from "../pi/PiLocator";
import { getAppLogger } from "../logging/sharedLogger";
import { compareVersions } from "../utils/versionCompare";
import { readConfiguredNpmCommand } from "../resourceWhitelist";
import { discoverExtensionEntries } from "./extensionDiscovery";
import { BUILT_IN_EXTENSIONS, INTERNAL_BUILT_IN_EXTENSIONS, isBuiltInExtensionName, readEffectiveBuiltInExtensionsVersion, resolveBuiltInExtensionPath, type BuiltInExtensionPathRoots } from "./builtInExtensions";
import { createNpmRegistryVersionResolver } from "./npmRegistryVersion";

/**
 * 扩展目录域：`pi list` + 本地目录扫描 → 合并 → 启用态投影 → （可选）npm 版本补全，带缓存与并发去重。
 *
 * 为什么独立成模块：这段逻辑（约 400 行含缓存状态机与版本查询快路）与「安装/卸载/开关/内置生命周期」是两件事，
 * 混在一起既超文件红线，也让「缓存代数 / 代际丢弃」这类不方便被无关改动波及的约束暴露在无关编辑面前；
 * 拆分计划与门禁见 docs/pi-self-update-split-plan.md 的 Wave 3。
 *
 * 边界：本模块只管「读与投影」；写盘类动作（装/卸/开关/内置文件清理/移除清单落盘）留在 ExtensionManager，
 * 需要时以回调注入。依赖全部经构造注入，不反向 import ExtensionManager。
 */
export type PiExtensionCatalogTranslate = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

/**
 * pi list 对「过滤式安装」包的 source 后缀：settings.json 里 packages 条目为对象形式
 * （选择性加载指定资源）时，pi 在 list 输出中追加此标记。解析时剥离此后缀，
 * 过滤状态存进 PiExtensionSummary.filtered，避免污染卸载/更新等以 source 为参数的命令。
 */
export const FILTERED_SUFFIX = " (filtered)";

/**
 * 解析 `pi list` 原始输出（导出的纯函数：类内 parseListOutput 只是它的薄包装，便于单测）。
 *
 * 每个包占两行：source 行（较浅缩进）+ 落盘路径行（较深缩进）。source 有两种形态：
 * - 协议源：`npm:` / `file:` / `github:` / `git:` / `http(s):`；
 * - 本地目录包：`pi install <dir>` 后 pi list 直接打印裸路径（盘符 / UNC / POSIX 绝对 / `./` `../`），
 *   不带任何协议前缀。旧实现只认协议前缀，本地包的整行被丢弃 → 扩展页永远看不到它。
 *
 * 为什么路径行靠缩进判定：本地包的 source 与 path 可能字面完全相同（`pi install F:\pkg` 后
 * pi list 打印两行 `F:\pkg`），只能按 pi list 的排版区分（source 缩进 2 空格、path 缩进 4 空格）；
 * 协议源行永远是新的包（既有行为不变），路径型行只有在缩进更深或与 pending.source 相同时才算路径。
 */
export function parsePiListOutput(raw: string): PiExtensionSummary[] {
	const result: PiExtensionSummary[] = [];
	let scope: PiExtensionSummary["scope"] = "unknown";
	let pending: PiExtensionSummary | null = null;
	/** pending 行自身的缩进：用来区分「本包的 path 行」与「下一个本地包 source」。 */
	let pendingIndent = 0;

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

		const indent = line.length - line.trimStart().length;
		const pathLike = isPathLikePackageSource(trimmed);
		const sourceLike = isPackageSource(trimmed);
		if (pending && !pending.path) {
			// 协议源行一定是新包（保持既有行为）；路径型行既可能是上一个包的落盘路径，
			// 也可能是下一个本地包的 source，缩进更深（或与 source 字面相同）时按路径处理。
			const isPathLine = !sourceLike || (pathLike && (indent > pendingIndent || trimmed === pending.source));
			if (isPathLine) {
				pending.path = trimmed;
				continue;
			}
		}

		if (sourceLike) {
			// pi list 对「过滤式安装」的包在 source 后追加 " (filtered)" 标记
			// （settings.json 里 packages 条目是对象形式，只选择性加载列出的资源）。
			// source 必须剥离该后缀：卸载/更新/版本查询都以 source 为参数，
			// 带后缀时 pi remove / pi update / npm view 都找不到目标。
			// 显式标注：pending 的赋值与上面 pending.source 的读取在同一循环里，
			// 缺标注时 TS 会因循环推断报 TS7022（隐式 any），与运行时行为无关。
			const isFiltered: boolean = trimmed.endsWith(FILTERED_SUFFIX);
			const source: string = isFiltered ? trimmed.slice(0, -FILTERED_SUFFIX.length) : trimmed;
			pending = {
				id: `${scope}:${source}`,
				source,
				scope,
				// 路径型 source 是用户目录直装的本地包：标记出来供版本补全（读包自身 package.json）
				// 与卸载/更新路由（pi remove / pi update --extensions）分流。
				...(isPathLikePackageSource(source) ? { local: true } : {}),
				...(isFiltered ? { filtered: true } : {}),
			};
			result.push(pending);
			pendingIndent = indent;
		}
	}

	return result;
}

/**
 * 原生投影结果：启用状态 +（可选的）「过滤式安装」标记。
 *
 * filtered 必须在轻量投影里一并重算：列表缓存保存的是上次 `pi list` 解析的 `(filtered)`，
 * 而开关只在磁盘上改条目形态（整包停用对象 / 折回纯字符串），缓存不会自己更新；
 * pi list 又只看「条目是不是对象」，整包停用与历史空对象都会被算成 filtered。
 */
export type ExtensionNativeState = { enabled: boolean; filtered?: boolean };

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

/** `npm view` 子进程超时：registry 慢或不可达时 npm 自己会在 30s 内重试并可能回答缓存值，
 * 超过这个时间就是真的拖住了扩展页刷新（超时被杀时 stderr 为空，必须自己补标记，见 npmViewVersion）。 */
const NPM_VIEW_TIMEOUT_MS = 30_000;

/** 主进程日志用的错误摘要：只取 message，不把堆栈和对象形态丢进日志 detail。 */
function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type PiExtensionCatalogDeps = {
	/** 复用管理器的 pi 调用（`--no-approve` 判定、PATH/代理环境、WSL 处理都在那里）。 */
	runPi: (args: string[], timeout: number, options?: { offline?: boolean; cwd?: string; projectInstall?: boolean; settings?: AppSettings; version?: string }) => Promise<string>;
	locator: PiLocator;
	getSettings: () => AppSettings;
	/** PiDeck 桌面设置（removedBuiltInExtensions / disabledExtensions）。 */
	getPiDeckSettings: () => AppSettings;
	translate: PiExtensionCatalogTranslate;
	/** 扩展目录所在 home（WSL 下是宿主 home；目录扫描走 Linux 侧时的映射见 toHostPath）。 */
	homeDir: () => string;
	/** 内置扩展磁盘根：提供后可为内置扩展补齐真实路径与包级版本。 */
	builtInRoots?: BuiltInExtensionPathRoots;
	/** 原生启用态读取：装配在当前所在的 manager（开关写盘后立刻反映）。 */
	readNativeState: (extension: PiExtensionSummary) => ExtensionNativeState | undefined;
	/** WSL 路径映射：列表里的路径可能是 Linux 形态，读 package.json 要回宿主路径。 */
	toHostPath: (path: string) => string;
	/** 内置副本落盘清理与移除清单落盘（内置生命周期域仍在 manager）。 */
	removeBuiltInFile: (source: string) => Promise<void>;
	saveRemovedBuiltIn: (removedList: string[]) => Promise<void>;
};

/** 扩展目录读取器：一个实例绑定一份依赖；公共入口只有 list / invalidateCache。 */
export class PiExtensionCatalog {
	private readonly runPi: PiExtensionCatalogDeps["runPi"];
	private readonly locator: PiLocator;
	private readonly getSettings: () => AppSettings;
	private readonly getPiDeckSettings: () => AppSettings;
	private readonly translate: PiExtensionCatalogTranslate;
	private readonly getHomeDir: () => string;
	private readonly builtInRoots: BuiltInExtensionPathRoots | undefined;
	private readonly readNativeState: PiExtensionCatalogDeps["readNativeState"];
	private readonly toHostPath: PiExtensionCatalogDeps["toHostPath"];
	private readonly removeBuiltInFile: PiExtensionCatalogDeps["removeBuiltInFile"];
	private readonly saveRemovedBuiltIn: PiExtensionCatalogDeps["saveRemovedBuiltIn"];

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

	constructor(deps: PiExtensionCatalogDeps) {
		this.runPi = deps.runPi;
		this.locator = deps.locator;
		this.getSettings = deps.getSettings;
		this.getPiDeckSettings = deps.getPiDeckSettings;
		this.translate = deps.translate;
		this.getHomeDir = deps.homeDir;
		this.builtInRoots = deps.builtInRoots;
		this.readNativeState = deps.readNativeState;
		this.toHostPath = deps.toHostPath;
		this.removeBuiltInFile = deps.removeBuiltInFile;
		this.saveRemovedBuiltIn = deps.saveRemovedBuiltIn;
	}

	private get homeDir(): string {
		return this.getHomeDir();
	}

	/**
	 * 安装/卸载/开关后主动清缓存。
	 * 同时递增 generation 并断开 inflight 复用，避免旧请求完成后把已删除/已变更的列表写回。
	 */
	invalidateCache() {
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
	 * - 命中缓存时也会重跑 enabled 投影（开关写盘后立刻反映），不重跑 pi list / npm view。
	 */
	async list(forceRefresh = false): Promise<PiExtensionListResult> {
		// 有缓存且（非强制刷新，或缓存已含版本信息）时返回。
		// 但必须重跑 enabled 投影：开关这类写操作只改设置/原生规则，主进程写完会刷新投影快照，
		// 而缓存里的 enabled 是上次扫描时算好的——直接返回整份缓存会把刚点开的开关弹回旧值。
		if (this.listCache && (!forceRefresh || this.listCacheHasVersionInfo)) {
			return this.projectCachedEnabled(this.listCache);
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

	/**
	 * 在缓存快照上重算 enabled 状态：克隆顶层后重跑投影，不跑 pi list / npm view / 目录扫描。
	 * 开关这类只改设置的写操作走这里刷新，避免为了让开关显示新状态付一次全量扫描（秒级）。
	 */
	private projectCachedEnabled(cache: PiExtensionListResult): PiExtensionListResult {
		const extensions = cache.extensions.map((extension) => ({ ...extension }));
		// 缓存路径不重读内置清单：内置版本只在热更新后变化，而热更新/扩展文件变更都会
		// invalidateCache（下一次必然重新扫描并重算），这条路径保持纯内存。
		this.applyEnabledProjection(extensions, { refreshBuiltInVersion: false });
		return { ...cache, extensions };
	}

	/**
	 * 把 PiDeck 设置与 pi 原生过滤规则投影成 enabled 状态（纯内存，无副作用）。
	 * 既在扫描末尾调用，也在缓存快照上单独调用（见 projectCachedEnabled）。
	 * 内置版本号默认按当前生效目录重读（含 sha256 校验），缓存路径传 refreshBuiltInVersion=false 跳过。
	 */
	private applyEnabledProjection(extensions: PiExtensionSummary[], options: { refreshBuiltInVersion?: boolean } = {}): void {
		// 通过 PiDeck 桌面设置标记启用状态（与 pi disabledExtensions 分离）。
		const removedBuiltIn = new Set(this.getPiDeckSettings().removedBuiltInExtensions ?? []);
		// 用户禁用的非内置扩展：按 scope+source 匹配（同名可在 user/project 两级独立开关）。
		const disabledExtKeys = new Set((this.getPiDeckSettings().disabledExtensions ?? []).map((entry) => `${entry.scope}:${entry.source}`));
		// 内置扩展版本：包级版本号（extensions-manifest.json，不跟 PiDeck 应用版本走），
		// 覆盖层（热更新）优先。逐行写入而非只在补齐分支赋值——内置条目可能来自
		// pi list、本地目录扫描、兜底补齐三条路径，版本只认「当前生效的那一份」。
		const builtInVersion = options.refreshBuiltInVersion === false || !this.builtInRoots ? null : readEffectiveBuiltInExtensionsVersion(this.builtInRoots);
		for (const ext of extensions) {
			if (ext.builtIn) {
				ext.enabled = !removedBuiltIn.has(ext.source);
				if (builtInVersion) ext.currentVersion = builtInVersion;
			} else {
				// 原生投影优先（迁移后 disabledExtensions 已清空）；未装配时退回旧列表。
				const native = this.readNativeState(ext);
				ext.enabled = native?.enabled ?? !disabledExtKeys.has(`${ext.scope}:${ext.source}`);
				// filtered 也必须在投影里重算：缓存里存的是上次 `pi list` 解析的 (filtered)，
				// 而开关只改磁盘条目形态（整包停用对象 / 折回字符串），缓存不会自己更新。
				// 原生侧不可判定（undefined，如继承层）时保留 pi list 的结论。
				if (native?.filtered !== undefined) ext.filtered = native.filtered;
			}
		}
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
				// 快路为什么失败必须留痕：这正是「检查不到版本」唯一能事后定位的证据
				//（npm 回退失败的日志只说明子进程被杀，不说明 registry 网络本身是否可达）。
				onFallback: ({ packageName, reason }) => {
					getAppLogger()?.warn("extensions", "npm registry fast path failed, falling back to npm view", { packageName, reason });
				},
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
		this.applyEnabledProjection(merged);

		// 仅检测 todo / plan / ask 固定冲突：三方包名含对应关键词时自动禁用内置版。
		// nul-redirect-fix 等其它内置扩展暂不参与冲突检测，避免 mode 等通用词误伤。
		// 注意：此处不走 disableBuiltIn（会 invalidateCache），避免 list 请求中途 generation
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
	 * 补全扩展的已装/最新版本。
	 *
	 * npm 包：读已装 package.json + 查 registry；
	 * 本地目录包（`pi install <dir>`）：registry 上没有「最新版本」这个概念，只读包自身
	 * package.json 的 version，绝不查 npm view / registry，也不产生 hasUpdate——
	 * 这类包更新走 `pi update --extensions` 整批刷新（见 ExtensionManager.updateExtension）。
	 * 其它非 npm 源（git:/github:/https: 等）保持原样直接返回。
	 *
	 * 为什么两条查询各自 settle：registry 慢/断时把「当前版本」也一起吞掉会让整列变成
	 * 「检查扩展版本失败」（2026-10 用户反馈）；读盘失败与查询失败分别留日志与提示。
	 */
	private async enrichExtensionVersion(extension: PiExtensionSummary, resolveLatestVersion: (packageName: string) => Promise<string | null>): Promise<PiExtensionSummary> {
		if (!extension.source.toLowerCase().startsWith("npm:")) {
			// local 标记来自 pi list 解析；source 形态兜底判定覆盖未经 parsePiListOutput
			// 构造的条目（如测试/其它投影），避免本地包漏掉版本与更新语义。
			if (extension.local !== true && !isPathLikePackageSource(extension.source)) return extension;
			const installed = await this.settleQuery(this.readInstalledVersion(extension.path));
			if (installed.error) {
				getAppLogger()?.warn("extensions", "Local extension version unreadable", { source: extension.source, path: extension.path, error: describeError(installed.error) });
			}
			// 读不到（path 缺失/package.json 不存在）时原样返回，UI 显示「-」而不是报版本检查失败。
			return installed.value === undefined ? extension : { ...extension, currentVersion: installed.value };
		}
		const packageName = extension.source.replace(/^npm:/i, "");
		const [installed, latest] = await Promise.all([this.settleQuery(this.readInstalledVersion(extension.path)), this.settleQuery(resolveLatestVersion(packageName))]);
		const currentVersion = installed.value;
		const latestVersion = latest.value ?? undefined;
		if (installed.error) {
			// 本地读盘失败（package.json 缺失/损坏）仍保留 pi list 给出的 path，UI 可据此定位。
			getAppLogger()?.warn("extensions", "Installed extension version unreadable", { source: extension.source, path: extension.path, error: describeError(installed.error) });
		}
		let updateError: string | undefined;
		if (latest.error) {
			// 日志走主进程 logging 模块：console.error 会绕过统一分级与文件落盘（日志纪律）
			getAppLogger()?.error("extensions", "Extension version check failed", {
				source: extension.source,
				error: describeError(latest.error),
			});
			updateError = this.translate("mainExtension.versionCheckFailed");
		}
		return {
			...extension,
			currentVersion,
			latestVersion,
			hasUpdate: Boolean(currentVersion && latestVersion && compareVersions(latestVersion, currentVersion) > 0),
			...(updateError ? { updateError } : {}),
		};
	}

	/**
	 * 结算一次「可失败查询」：成功给值，失败给原因（不抛出）。
	 * 版本补全的两条查询都不该让另一条的结果作废，调用方据此分别决定展示与日志。
	 */
	private async settleQuery<T>(query: Promise<T>): Promise<{ value: T | undefined; error: unknown }> {
		try {
			return { value: await query, error: undefined };
		} catch (error) {
			return { value: undefined, error };
		}
	}

	private async readInstalledVersion(path?: string) {
		if (!path) return undefined;
		const hostPath = this.toHostPath(path);
		const raw = await readFile(join(hostPath, "package.json"), "utf8");
		const parsed = JSON.parse(raw) as { version?: string };
		return parsed.version;
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
					timeout: NPM_VIEW_TIMEOUT_MS,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						// Electron 启动环境经常缺少用户 shell PATH；通过 PiLocator 补齐 PATH 后仍失败时，把 stderr 透出给设置页。
						// npm 失败时一般会写 stderr，但被 timeout 杀掉时 stderr 为空、error.message 只剩
						// 「Command failed: npm view <pkg> version」——必须自己补上超时标记，否则日志里
						// 「registry 慢」与「npm 不存在/参数错」完全无法区分（2026-10 实测）。
						const detail = (stderr || error.message).trim();
						reject(new Error(error.killed ? `${detail} (timeout ${Math.round(NPM_VIEW_TIMEOUT_MS / 1000)}s)` : detail));
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

	/** 解析逻辑是模块级纯函数 parsePiListOutput（便于单测）；这里保留实例入口供既有调用方/测试使用。 */
	private parseListOutput(raw: string): PiExtensionSummary[] {
		return parsePiListOutput(raw);
	}
}
