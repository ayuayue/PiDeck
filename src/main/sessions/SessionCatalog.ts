import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { sessionLocatorFromLegacy } from "../../shared/locationAdapters";
import type { AgentBackend, AgentTab, SessionEnvironment, SessionLocator, SessionModelPreference, SessionRecord, SessionSource, SessionSummary } from "../../shared/types";
import type { SessionProxyOverride } from "../../shared/types/session";
import { SessionLocatorRouter } from "./SessionLocatorRouter";
import { getAppLogger } from "../logging/sharedLogger";
import { renameWithRetry } from "../utils/fsRetry";
import { buildSessionOriginKey, buildSummaryOriginKey, canonicalizeSessionPath, collectSessionSubtreeIds, getImportedSessionSourceId, getSessionEnvironment, isInSubagentArtifactsDir, looksLikeCodexSessionFileStem, looksLikePiSessionFileStem } from "../../shared/sessionIdentity";
import { looksLikeExpandedRefBlockTitle } from "../../shared/expandedRefBlocks";
import { createSessionModelPreference } from "../../shared/modelDisplayName";

/**
 * 会话标题所有权来源（#266 时序抽奖修复）：
 * - undefined：未确认，仍可被第一个自动/补名结果领取一次；
 * - "fallback"：内容派生兜底名（首条消息 / 扫描弱回退），可被 "auto" 升级覆盖；
 * - "auto"：内置扩展经 marker 校验的模型自动命名，终态；
 * - "manual"：用户改名 / 导入 / claimTitleOwnership 预留，终态；
 * - "legacy"：旧 catalog 迁移来的存量条目（titleLocked=true 而来源无法区分，或压根没写 titleLocked）。
 *   授权语义同 manual（一律挡住自动写入），额外允许一次指纹修复：命中 #266 误锁时改用
 *   JSONL 权威名（见 repairedLegacyFallbackTitle）。读过一次盘（无论命中与否）即转 manual 终态，
 *   不再重复读盘；读盘失败保持 legacy 等下次扫描再试。
 */
export type SessionTitleOrigin = "fallback" | "auto" | "manual" | "legacy";

export type SessionCatalogEntry = {
	id: string;
	projectId: string;
	originKey?: string;
	title: string;
	/**
	 * PiDeck owns the display title once this is true. Only an unclaimed fresh
	 * provisional title may accept one automatic or initial JSONL title; pi JSONL/TUI
	 * changes never overwrite an owned catalog title.
	 * titleOrigin 存在时它才是所有权来源的权威，本字段仅作镜像（旧读取路径兼容）。
	 */
	titleLocked?: boolean;
	/** 标题所有权来源；见 SessionTitleOrigin。 */
	titleOrigin?: SessionTitleOrigin;
	/** Anonymous entries are in-memory only and are never written to session-catalog.json. */
	noSession?: boolean;
	source: SessionSource;
	environment: SessionEnvironment;
	/** 运行时后端；缺省 "pi"（旧 catalog 数据兼容）。 */
	backend?: AgentBackend;
	/** Canonical session location; legacy filePath/environment remain readable during migration. */
	locator?: SessionLocator;
	filePath?: string;
	wslDistro?: string;
	wslUser?: string;
	importedSourceId?: string;
	status: "draft" | "active";
	/** 子会话标记：扫描时从 SessionSummary 继承，持久化供 getRecord/listEntries 重建（不丢树形） */
	parentSessionPath?: string;
	/**
	 * fork 会话标记（pi fork/clone 产物，文件头带 parentSession）：
	 * 与 parentSessionPath 独立（后者=子代理折叠关系），仅作 fork 身份元数据——
	 * (fork) 标题后缀由 fork 完成时物理写入会话名（sessionForkTitle.ts），不靠该标记拼装。
	 */
	forked?: boolean;
	model?: SessionModelPreference;
	thinkingLevel?: string;
	piSessionId?: string;
	/** DSH 会话身份（DSH host 的 sessionId）；backend=dsh 时由 DshAgentManager 创建/attach 维护。 */
	dshSessionId?: string;
	/** DSH 权限预设（read-only/workspace-write/danger-full-access）：草稿期预选，激活时应用。 */
	permissionPreset?: string;
	/** DSH agent 预设（会话「模式」）：草稿期预选；激活新建时随 sessions.create 应用，attach 时从 host 回写。 */
	agentPreset?: string;
	/** 会话级代理覆盖（缺省 = 跟随全局）。DSH 会话的设置在 host 启动时被聚合应用。 */
	proxy?: SessionProxyOverride;
	/**
	 * 手动导入钉住的项目归属（外置目录导入）：置位后自动扫描不得把该会话改回原目录对应的项目。
	 * 场景：项目目录被移动/改名后，用户手动把旧路径下的会话导入到新项目；
	 * 旧项目若仍留在侧栏，它的常规扫描会把属于旧 encoded 目录的会话抢回去，
	 * 表现为「导入后刷新一下又不见了」。置位后该条目只由用户操作改归属（重新导入/删除）。
	 */
	manualProjectAssignment?: boolean;
	createdAt: number;
	updatedAt: number;
};

type SessionCatalogFile = {
	version: 1;
	sessions: SessionCatalogEntry[];
	/** 用户主动删除过的 DSH host 会话。host 目录可能还在，自动同步不得再导入。 */
	dismissedDshSessionIds?: string[];
};

type SessionCatalogContext = {
	wslDistro?: string;
	wslUser?: string;
};

/**
 * 将 catalog 条目 filePath 归一化为绝对路径（可选注入）。
 * pi 可能上报相对 cwd 的 sessionFile（如 sessionDir 配置为 ".pi/sessions"），
 * 与扫描器发现的绝对路径 originKey 不同，会造成同文件双记录（侧栏重复显示）。
 * 注入后 catalog 在加载与写入边界统一修正；实现见 main/index.ts。
 */
export type SessionFilePathResolver = (projectId: string, filePath: string, environment: SessionEnvironment) => string;

/** 会话标题读取与有效性校验的合并结果：name 仅用于首次索引或未确认的 provisional 标题；
 * valid:false 表示文件非有效 Pi 会话（如 pi-subagents transcript 转储，首条记录用 recordType 而无 type 头），
 * mergeScanned 应拒绝索引该文件（#168）；parentSessionPath 仅供平铺子代理形态
 * （@tintinweb/pi-subagents：parentSession header + 会话名 <agent>#<8hex>）回填父关系，
 * 用户 fork / 普通会话 / nicobailon 嵌套形态不返回该值。
 * forked 为 pi fork/branch 探测结果（parentSession header + 非 tintinweb 形态）：
 * 只做列表 (fork) 标记，不影响 parentSessionPath 的折叠语义。 */
export type SessionTitleFetchResult = { name?: string; nameFromSessionInfo?: boolean; valid?: boolean; parentSessionPath?: string; forked?: boolean; fallbackName?: string; firstUserText?: string };

/** collectScannedTitles 收集的补名结果：fromSessionInfo=false 表示首条消息弱回退，所有权只算 fallback（#266）。
 *  fallbackName 是本文件的弱兜底候选（首条 user/assistant 文本），与最终 name 取谁无关：
 *  #266 存量自愈要用它比对「catalog 里存的这一行是不是当年被误锁的首句兜底」。 */
type ScannedTitleFetch = { name: string; fromSessionInfo: boolean; fallbackName?: string };

/** legacy 存量条目的一次性探测结果：authoritative 只在真读到权威 session_info 名时才有值。
 *  firstUserText 是「文件内真首句」（可选，按需读取）：头/尾窗口兜底在系统提示很大的会话里会
 *  退化成尾部消息，指纹比对需要它才能命中当年写进 catalog 的真首句（#266）。 */
type LegacyTitleProbe = { authoritative?: string; fallback?: string; firstUserText?: string };

export type SessionTitleFetchOptions = {
	/** false = only inspect the bounded header for structural metadata; do not read name windows. */
	includeTitle?: boolean;
	/** true = 额外有界读取「文件内首条 user 文本」（legacy 存量自愈的第二指纹基准，见 #266）。 */
	includeFirstUserText?: boolean;
};

/** 标题刷新 + 会话头有效性校验：装配层注入（实现为 SessionScanner.inferSessionNameAndValidity，
 * 见 main/index.ts）。读取结果为首次发现和未确认 provisional 标题提供初始化值；已有 catalog 标题
 * 不再跟随 pi-tui /name 或 JSONL 的后续变化。 */
export type SessionTitleFetcher = (filePath: string, options?: SessionTitleFetchOptions) => Promise<SessionTitleFetchResult>;

/** 扫描未读正文时没有 session_info。pi JSONL 文件名是时间戳，不能当标题，否则侧栏全是日期。 */
function scannedFileStemTitle(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	const stem = base.replace(/\.jsonl$/i, "").trim();
	if (!stem || looksLikePiSessionFileStem(stem)) return "Untitled";
	return stem;
}

/** 侧栏/Tab 展示用：pi 文件名时间戳不是会话名。 */
function catalogDisplayTitle(title: string | undefined): string | undefined {
	if (!title) return undefined;
	return looksLikePiSessionFileStem(title) ? undefined : title;
}

/** 占位标题判定：catalog 无真实名称时落成 Untitled（pi 时间戳 stem 加载时也被清成它），
 *  只有这类标题才值得读头部补名，否则每次扫描都会重复读盘。 */
function isPlaceholderCatalogTitle(title: string | undefined): boolean {
	if (!title) return true;
	if (looksLikePiSessionFileStem(title)) return true;
	// 未折叠的块原文标题（`<prompt_template …>` 等历史脏数据）同样是占位名：
	// 允许首次补名把它换成用户可识别的标题，否则它会一直留在侧栏。
	if (looksLikeExpandedRefBlockTitle(title)) return true;
	return /^(?:untitled(?: session)?|new session|新会话)$/i.test(title);
}

/**
 * 解析条目的所有权来源。新字段优先；旧 catalog 只有 titleLocked 时惰性推导为 legacy——
 * true 无法区分「手动」与「扩展自动」，行为按 manual（绝不把已有标题降级成可覆盖），
 * 但保留一次指纹修复机会（#266 存量被误锁的首句兜底，见 repairedLegacyFallbackTitle）。
 */
function resolveTitleOrigin(entry: Pick<SessionCatalogEntry, "title" | "titleLocked" | "titleOrigin">): SessionTitleOrigin | undefined {
	if (entry.titleOrigin === "fallback" || entry.titleOrigin === "auto" || entry.titleOrigin === "manual" || entry.titleOrigin === "legacy") return entry.titleOrigin;
	if (entry.titleLocked === false) return undefined;
	// 缺 titleOrigin 只有 locked=true：存量条目来源未知，标成 legacy 等一次指纹修复机会（#266）。
	if (entry.titleLocked === true) return "legacy";
	return isPlaceholderCatalogTitle(entry.title) ? undefined : "legacy";
}

/** 缺省是旧 catalog：真实标题默认已由 PiDeck 确认；仅占位标题保留一次初始化机会。 */
function isTitleLocked(entry: Pick<SessionCatalogEntry, "title" | "titleLocked" | "titleOrigin">): boolean {
	// 历史 Codex rollout 文件名标题（旧导入器拿不到会话名时的兑底产物）永远不算锁定：
	// 即使旧 catalog 曾把它写成 locked=true，也要允许重导入后的真实标题覆盖，
	// 否则存量脏标题（看起来就是一串会话 ID）永久无法修复。
	if (looksLikeCodexSessionFileStem(entry.title)) return false;
	return resolveTitleOrigin(entry) !== undefined;
}

/** 一次性写入所有权字段：titleLocked 始终是 titleOrigin 的镜像，旧读取路径不会看到半截状态。 */
function assignTitleOrigin(entry: SessionCatalogEntry, origin: SessionTitleOrigin | undefined): void {
	if (origin) {
		entry.titleOrigin = origin;
		entry.titleLocked = true;
		return;
	}
	delete entry.titleOrigin;
	entry.titleLocked = false;
}

/**
 * #266 存量自愈的指纹判定（纯函数，可直接单测）。
 *
 * 为什么需要指纹：旧 catalog 的 titleLocked=true 条目来源不可区分——既可能是用户改名，
 * 也可能是被缺陷版本 `titleLocked: !isPlaceholderCatalogTitle(initialTitle)` 误锁的首句兜底。
 * 三条指纹同时成立才判定为后者，把误丢的权威名拿回来：
 * 1. 条目来源是 legacy（只有旧 catalog 迁移来的条目走这条路；auto/manual 不参与）；
 * 2. catalog 现存标题逐字等于本次扫描读到的弱兜底候选（首条 user/assistant 文本，或文件内真首句）——
 *    用户手动改成与首句一字不差的标题几乎不可能；
 * 3. JSONL 里存在不同的权威 session_info 名，即当年被 applyAutomaticTitle 丢弃的那个名字。
 *
 * 为什么候选有两条：头/尾窗口的兜底在系统提示很大的会话里会落到尾部消息上（真首句落在 64KB
 * 头窗口之外），只比它会让这类 #266 存量永远修不了；firstUserText 是文件内真首句（有界读取）。
 *
 * @returns 要写回的权威标题；不命中返回 undefined（保持原标题，并转终态不再探测）。
 */
function repairedLegacyFallbackTitle(entry: Pick<SessionCatalogEntry, "title">, probe: { authoritative?: string; fallback?: string; firstUserText?: string }): string | undefined {
	const authoritative = catalogDisplayTitle(probe.authoritative);
	if (!authoritative) return undefined;
	const title = normalizeFingerprintTitle(entry.title);
	if (!title) return undefined;
	const candidates = [probe.fallback, probe.firstUserText].map(normalizeFingerprintTitle).filter(Boolean);
	if (!candidates.some((candidate) => candidate === title)) return undefined;
	if (authoritative === entry.title) return undefined;
	return authoritative;
}

/** 指纹比对前的归一化：折叠空白并去首尾空白，避免换行/多空格造成的假阴性。 */
function normalizeFingerprintTitle(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 自动标题领取规则（#266）：只有未确认（undefined）或内容派生的 fallback 能被领取。
 * 扩展模型标题 "auto" 可以升级 fallback；反向（fallback 抢占已有 fallback 或终态）不可以；
 * "auto"/"manual"/"legacy" 是终态（legacy 只能被指纹修复改写），第二个自动结果一律丢弃。
 */
function claimAutomaticTitle(entry: SessionCatalogEntry, nextTitle: string, source: "auto" | "fallback"): boolean {
	const origin = resolveTitleOrigin(entry);
	if (source === "fallback" ? origin !== undefined : origin !== undefined && origin !== "fallback") return false;
	entry.title = nextTitle;
	assignTitleOrigin(entry, source);
	return true;
}

/**
 * 扫描初始化标题的所有权：占位名与历史脏名保持未锁定（留一次初始化机会）；
 * 权威 session_info 名直接终态（manual）；首条消息弱回退只算 fallback，可被扩展自动命名覆盖（#266）。
 */
function scannedTitleOrigin(title: string, authoritative: boolean): SessionTitleOrigin | undefined {
	if (isPlaceholderCatalogTitle(title) || looksLikeCodexSessionFileStem(title)) return undefined;
	return authoritative ? "manual" : "fallback";
}

function cloneModelPreference(model: SessionModelPreference | undefined): SessionModelPreference | undefined {
	return model ? createSessionModelPreference(model.provider, model.modelId, model.modelName) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionLocator(value: unknown): value is SessionLocator {
	if (!isRecord(value)) return false;
	if (value.kind === "local") {
		return (
			(value.environment === "native" || value.environment === "wsl") &&
			(value.filePath === undefined || (typeof value.filePath === "string" && value.filePath.length <= 4096)) &&
			(value.wslDistro === undefined || (typeof value.wslDistro === "string" && value.wslDistro.length <= 256)) &&
			(value.wslUser === undefined || (typeof value.wslUser === "string" && value.wslUser.length <= 256))
		);
	}
	if (value.kind !== "ssh") return false;
	return (
		typeof value.hostId === "string" &&
		Boolean(value.hostId.trim()) &&
		value.hostId.length <= 256 &&
		(value.remotePath === undefined || (typeof value.remotePath === "string" && value.remotePath.length <= 4096)) &&
		(value.remoteSessionId === undefined || (typeof value.remoteSessionId === "string" && value.remoteSessionId.length <= 256)) &&
		(value.remotePathAliases === undefined || (Array.isArray(value.remotePathAliases) && value.remotePathAliases.length <= 32 && value.remotePathAliases.every((path) => typeof path === "string" && path.length <= 4096)))
	);
}

function cloneSessionLocator(locator: SessionLocator | undefined): SessionLocator | undefined {
	if (!locator) return undefined;
	if (locator.kind === "ssh") return { ...locator, ...(locator.remotePathAliases ? { remotePathAliases: [...locator.remotePathAliases] } : {}) };
	return { ...locator };
}

function cloneEntry(entry: SessionCatalogEntry): SessionCatalogEntry {
	return {
		...entry,
		...(entry.locator ? { locator: cloneSessionLocator(entry.locator) } : {}),
		model: cloneModelPreference(entry.model),
	};
}

function normalizeEntryLocator(entry: SessionCatalogEntry): SessionCatalogEntry {
	const normalized = cloneEntry(entry);
	if (normalized.locator?.kind === "ssh") {
		normalized.filePath = undefined;
		normalized.originKey = undefined;
		normalized.piSessionId = undefined;
		normalized.wslDistro = undefined;
		normalized.wslUser = undefined;
		normalized.parentSessionPath = undefined;
	} else if (normalized.locator?.kind === "local") {
		normalized.filePath = normalized.locator.filePath;
		normalized.environment = normalized.locator.environment;
		normalized.wslDistro = normalized.locator.wslDistro;
		normalized.wslUser = normalized.locator.wslUser;
	}
	return normalized;
}

function setLocalSessionFilePath(entry: SessionCatalogEntry, filePath: string | undefined): void {
	if (entry.locator?.kind === "ssh") throw new Error("UNSUPPORTED_PROJECT_LOCATION");
	if (entry.noSession || entry.backend === "dsh" || entry.backend === "imagegen") {
		entry.filePath = undefined;
		entry.locator = undefined;
		return;
	}
	entry.filePath = filePath;
	entry.locator = filePath
		? sessionLocatorFromLegacy({
				environment: entry.environment,
				filePath,
				wslDistro: entry.wslDistro,
				wslUser: entry.wslUser,
			})
		: undefined;
}

function equalModel(left?: SessionModelPreference, right?: SessionModelPreference): boolean {
	return left?.provider === right?.provider && left?.modelId === right?.modelId;
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

export function canAttachRuntimeMetadata(entry: SessionCatalogEntry | undefined, tab: Partial<AgentTab>): boolean {
	if (!entry || !tab.sessionPath) return false;
	// DSH 的 sessionPath 是 host zstd 日志，不是 pi JSONL。走文件配对会把 zstd
	// 写进 filePath，渲染层当成有历史去读，空会话输入时整页抽成「正在加载历史」。
	if (entry.backend === "dsh" || tab.backend === "dsh") return false;
	if (entry.status === "draft" && !entry.filePath) return true;
	if (!entry.filePath) return false;
	const environment = tab.sessionEnvironment ?? entry.environment;
	return (
		buildSessionOriginKey({
			source: entry.source,
			environment: entry.environment,
			filePath: entry.filePath,
			wslDistro: entry.wslDistro,
			wslUser: entry.wslUser,
			importedSourceId: entry.importedSourceId,
		}) ===
		buildSessionOriginKey({
			source: tab.sessionSource ?? entry.source,
			environment,
			filePath: tab.sessionPath,
			wslDistro: tab.wslDistro ?? entry.wslDistro,
			wslUser: tab.wslUser ?? entry.wslUser,
			importedSourceId: tab.importedSourceId ?? entry.importedSourceId,
		})
	);
}

class UnsupportedSessionCatalogVersionError extends Error {
	constructor() {
		super("SESSION_CATALOG_UNSUPPORTED_VERSION");
	}
}

class UnsupportedSessionCatalogLocatorError extends Error {
	constructor() {
		super("SESSION_CATALOG_UNSUPPORTED_LOCATOR");
	}
}

export class SessionCatalogRecoveryError extends Error {
	readonly code = "SESSION_CATALOG_NEEDS_REPAIR";

	constructor() {
		super("SESSION_CATALOG_NEEDS_REPAIR: catalog cannot be safely loaded");
		this.name = "SessionCatalogRecoveryError";
	}
}

export class SessionCatalog {
	private entries: SessionCatalogEntry[] = [];
	private readonly locatorRouter = new SessionLocatorRouter();
	/** Runtime-only records share the catalog lookup contract without durable storage. */
	private transientEntries = new Map<string, SessionCatalogEntry>();
	/** 侧栏删除过的 DSH host 会话：刷新/自动导入跳过；手动导入会清掉墓碑。 */
	private dismissedDshSessionIds = new Set<string>();
	private loaded = false;
	private writeQueue: Promise<void> = Promise.resolve();
	private skipNextBackup = false;
	private needsRepair = false;

	private identityContext: SessionCatalogContext;

	constructor(
		private readonly filePath: string,
		identityContext: SessionCatalogContext = {},
		private readonly resolveFilePath?: SessionFilePathResolver,
		private readonly fetchTitle?: SessionTitleFetcher,
	) {
		this.identityContext = { ...identityContext };
	}

	setIdentityContext(context: SessionCatalogContext): void {
		this.identityContext = { ...context };
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		let primaryError: unknown;
		let locatorNormalizationNeeded = false;
		try {
			const snapshot = await this.readCatalogFile(this.filePath);
			this.entries = snapshot.entries;
			this.dismissedDshSessionIds = snapshot.dismissedDshSessionIds;
			locatorNormalizationNeeded = snapshot.locatorNormalizationNeeded;
		} catch (error) {
			primaryError = error;
			if (error instanceof UnsupportedSessionCatalogVersionError || error instanceof UnsupportedSessionCatalogLocatorError) {
				// A previous-version backup cannot authorize replacing an incompatible primary snapshot.
				this.needsRepair = true;
				void getAppLogger()?.error("session-catalog", "Catalog format is unsupported", { primary: error.message });
			} else {
				try {
					const snapshot = await this.readCatalogFile(this.backupFilePath());
					this.entries = snapshot.entries;
					this.dismissedDshSessionIds = snapshot.dismissedDshSessionIds;
					locatorNormalizationNeeded = snapshot.locatorNormalizationNeeded;
					this.skipNextBackup = true;
				} catch (backupError) {
					if (isMissingFileError(primaryError) && isMissingFileError(backupError)) {
						this.entries = [];
						this.dismissedDshSessionIds = new Set();
					} else {
						// Keep startup available, but never replace unreadable snapshots with an empty catalog.
						this.needsRepair = true;
						void getAppLogger()?.error("session-catalog", "Catalog and backup both failed to load", {
							primary: primaryError instanceof Error ? primaryError.message : String(primaryError),
							backup: backupError instanceof Error ? backupError.message : String(backupError),
						});
						this.entries = [];
						this.dismissedDshSessionIds = new Set();
					}
				}
			}
		}
		// Draft 只代表当前进程中的“尚未发送”编辑面：没有用户消息就没有
		// 可恢复的 Pi session。重启时清掉它们（仅限 pi 后端），避免空 Agent 在
		// 历史列表中永久残留。
		// 例外：DSH 会话的草稿必须保留。DSH 的 host 会话数据由 $DSH_HOME 持久化，
		// catalog 只是 id 映射；即使“创建后激活链路未走完”（attachRuntime 未把
		// status 置 active），重启后用户仍应在侧栏看到并重新激活它。若在此清掉，
		// host 侧会话会变成孤儿且无法从侧栏访问。带 dshSessionId 的异常中间态同样保留。
		const staleDrafts = this.entries.filter((entry) => entry.status === "draft" && entry.backend !== "dsh");
		if (staleDrafts.length > 0) {
			this.entries = this.entries.filter((entry) => entry.status !== "draft" || entry.backend === "dsh");
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// 启动清理是 best-effort；内存已经不再暴露草稿，下一次启动仍会重试清理。
			}
		}

		// 兼容旧数据：pi 默认 sessionName（JSONL 文件名时间戳）曾被 onTitleChanged 写进 catalog。
		// 侧栏会显示一排日期，且 refreshAutoTitle 不再把首条消息当标题。加载时清成 Untitled。
		const timestampTitles = this.entries.filter((entry) => looksLikePiSessionFileStem(entry.title));
		if (timestampTitles.length > 0) {
			for (const entry of timestampTitles) entry.title = "Untitled";
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// 修复是 best-effort；内存已生效，下一次启动仍会重试。
			}
		}

		// 旧 catalog 没有 titleLocked/titleOrigin：已有真实标题视为 PiDeck 已确认，避免升级后被
		// 扫描或 TUI 写入反向覆盖；只有占位标题保留一次初始化/自动命名机会。
		// titleLocked=true 的存量条目无法区分手动/扩展自动，一律迁成 legacy：
		// 行为同 manual（挡住自动写入），另加一次指纹修复机会修 #266 被误锁的首句兜底。
		const missingTitleOwnership = this.entries.filter((entry) => typeof entry.titleLocked !== "boolean" || (entry.titleOrigin === undefined && entry.titleLocked === true));
		if (missingTitleOwnership.length > 0) {
			for (const entry of missingTitleOwnership) {
				if (typeof entry.titleLocked !== "boolean") entry.titleLocked = !isPlaceholderCatalogTitle(entry.title);
				if (entry.titleOrigin === undefined && entry.titleLocked === true) entry.titleOrigin = "legacy";
			}
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// 迁移失败不影响内存中的所有权规则；下次启动会继续写回。
			}
		}

		// 兼容旧数据：早期版本可能存有相对 filePath（pi 返回相对 cwd 的 sessionFile，
		// 如 sessionDir 配置为 ".pi/sessions"）。相对路径与扫描器绝对路径的 originKey
		// 不同 → 同一文件出现两条记录（侧栏重复显示），且文件操作落到错误位置。
		// 加载时用注入的 resolver 统一修正为绝对路径并重算 originKey。
		const repaired = this.repairRelativeFilePaths(this.entries);
		if (repaired) {
			this.entries = repaired;
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// 修复是 best-effort；内存已生效，下一次启动仍会重试。
			}
		}

		// 兼容旧数据：DSH 会话曾只按文件分支 attach（filePath/piSessionId 落盘，
		// dshSessionId 缺失）——标题同步（findByDshSessionId）与重启后 attach 恢复
		// 旧会话都依赖 dshSessionId。加载时把 backend=dsh 且缺 dshSessionId 的
		// 记录用 piSessionId（当时存的就是 host 会话 id）补齐。
		const migratedDsh = this.entries.some((entry) => entry.backend === "dsh" && !entry.dshSessionId && entry.piSessionId);
		if (migratedDsh) {
			for (const entry of this.entries) {
				if (entry.backend === "dsh" && !entry.dshSessionId && entry.piSessionId) {
					entry.dshSessionId = entry.piSessionId;
				}
			}
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// 迁移是 best-effort；内存已生效，下一次启动仍会重试。
			}
		}

		// 兼容旧数据：早期版本把 DSH 会话当 pi 会话 attach（filePath=host zstd 文件、
		// piSessionId=host 会话 id 落盘）。pi 侧逻辑会把 zstd 文件当 pi 会话文件
		// 处理（启动 pi exited code=1、导出/删除误判等）。dsh 条目只保留 dshSessionId，
		// filePath/piSessionId 一律清除（dshSessionId 已在上方迁移补齐）。
		const pollutedDsh = this.entries.some((entry) => entry.backend === "dsh" && (Boolean(entry.filePath) || Boolean(entry.piSessionId)));
		if (pollutedDsh) {
			for (const entry of this.entries) {
				if (entry.backend !== "dsh") continue;
				delete entry.filePath;
				delete entry.piSessionId;
				entry.originKey = undefined;
			}
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// 迁移是 best-effort；内存已生效，下一次启动仍会重试。
			}
		}
		if (locatorNormalizationNeeded && !this.skipNextBackup) {
			try {
				await this.writeSnapshot(this.entries);
			} catch {
				// Canonical locator cleanup is best-effort; in-memory routing already fails closed.
			}
		}
		this.loaded = true;
		if (this.skipNextBackup) {
			await this.writeSnapshot(this.entries);
		}
	}

	listEntries(): SessionCatalogEntry[] {
		this.assertLoaded();
		return [...this.entries.map(cloneEntry), ...Array.from(this.transientEntries.values(), cloneEntry)];
	}

	get(id: string): SessionCatalogEntry | undefined {
		this.assertLoaded();
		const entry = this.transientEntries.get(id) ?? this.entries.find((candidate) => candidate.id === id);
		return entry ? cloneEntry(entry) : undefined;
	}

	/** 按 DSH host 会话 id 反查 catalog 记录（会话标题同步用；只读查询，不排队写）。
	 *  transient 草稿尚未 attach host 会话（无 dshSessionId），只需查持久 entries。 */
	findByDshSessionId(dshSessionId: string): SessionCatalogEntry | undefined {
		this.assertLoaded();
		const entry = this.entries.find((candidate) => candidate.dshSessionId === dshSessionId);
		return entry ? cloneEntry(entry) : undefined;
	}

	/** 侧栏删除过的 DSH host 会话。自动同步跳过；手动导入会清掉。 */
	listDismissedDshSessionIds(): Set<string> {
		this.assertLoaded();
		return new Set(this.dismissedDshSessionIds);
	}

	/** 删除 DSH 映射时记下墓碑，避免 host 目录还在时刷新又把会话导回来。 */
	async rememberDismissedDshSession(dshSessionId: string): Promise<void> {
		this.assertLoaded();
		const id = dshSessionId.trim();
		if (!id) return;
		await this.enqueueMutation((entries) => {
			if (this.dismissedDshSessionIds.has(id)) {
				return { value: undefined, changed: false };
			}
			this.dismissedDshSessionIds.add(id);
			return { value: undefined, changed: true };
		});
	}

	createAnonymous(input: { projectId: string; title: string; environment: SessionEnvironment; model?: SessionModelPreference; thinkingLevel?: string }): SessionRecord {
		this.assertLoaded();
		const now = Date.now();
		const entry: SessionCatalogEntry = {
			id: randomUUID(),
			projectId: input.projectId,
			title: input.title,
			titleLocked: true,
			titleOrigin: "manual",
			noSession: true,
			source: "pi",
			environment: input.environment,
			wslDistro: input.environment === "wsl" ? this.identityContext.wslDistro : undefined,
			wslUser: input.environment === "wsl" ? this.identityContext.wslUser : undefined,
			status: "active",
			model: cloneModelPreference(input.model),
			thinkingLevel: input.thinkingLevel,
			createdAt: now,
			updatedAt: now,
		};
		this.transientEntries.set(entry.id, entry);
		return this.recordFromEntry(entry);
	}

	removeTransient(id: string): boolean {
		this.assertLoaded();
		return this.transientEntries.delete(id);
	}

	getRecord(id: string): SessionRecord | undefined {
		const entry = this.get(id);
		return entry ? this.recordFromEntry(entry) : undefined;
	}

	getLocator(id: string): SessionLocator | undefined {
		const entry = this.get(id);
		return entry ? this.sessionLocatorForEntry(entry) : undefined;
	}

	getLocalFilePath(id: string): string | undefined {
		const locator = this.getLocator(id);
		return locator ? this.locatorRouter.resolveFilePath(locator) : undefined;
	}

	findByFilePath(filePath: string, environment: SessionEnvironment): SessionCatalogEntry | undefined {
		this.assertLoaded();
		const target = canonicalizeSessionPath(filePath, environment);
		const entry = this.entries.find((candidate) => candidate.locator?.kind !== "ssh" && candidate.filePath && candidate.environment === environment && canonicalizeSessionPath(candidate.filePath, environment) === target);
		return entry ? cloneEntry(entry) : undefined;
	}

	async ensureRuntimeTarget(input: {
		projectId: string;
		title: string;
		source: SessionSource;
		environment: SessionEnvironment;
		filePath: string;
		wslDistro?: string;
		wslUser?: string;
		importedSourceId?: string;
		piSessionId?: string;
		/** fork/clone 产物注册时直接标记（parentSession 链接已由 pi 写入文件头，此处同源标记）。 */
		forked?: boolean;
	}): Promise<SessionCatalogEntry> {
		this.assertLoaded();
		// 与 attachRuntime 同口径：进入 catalog 前归一化为绝对路径，保证 originKey 去重一致。
		const filePath = this.resolveFilePath ? this.resolveFilePath(input.projectId, input.filePath, input.environment) : input.filePath;
		return this.enqueueMutation((entries) => {
			const originKey = buildSessionOriginKey({
				source: input.source,
				environment: input.environment,
				filePath,
				wslDistro: input.wslDistro,
				wslUser: input.wslUser,
				importedSourceId: input.importedSourceId,
			});
			let entry = entries.find((candidate) => {
				if (candidate.locator?.kind === "ssh") return false;
				if (candidate.originKey === originKey) return true;
				if (!candidate.filePath) return false;
				return (
					buildSessionOriginKey({
						source: candidate.source,
						environment: candidate.environment,
						filePath: candidate.filePath,
						wslDistro: candidate.wslDistro,
						wslUser: candidate.wslUser,
						importedSourceId: candidate.importedSourceId,
					}) === originKey
				);
			});
			const now = Date.now();
			if (!entry) {
				entry = {
					id: randomUUID(),
					projectId: input.projectId,
					originKey,
					title: input.title,
					titleLocked: true,
					titleOrigin: "manual",
					source: input.source,
					environment: input.environment,
					filePath,
					wslDistro: input.wslDistro,
					wslUser: input.wslUser,
					importedSourceId: input.importedSourceId,
					piSessionId: input.piSessionId,
					forked: input.forked,
					status: "active",
					createdAt: now,
					updatedAt: now,
				};
				setLocalSessionFilePath(entry, filePath);
				entries.push(entry);
			} else {
				entry.projectId = input.projectId;
				entry.originKey = originKey;
				entry.source = input.source;
				entry.environment = input.environment;
				entry.filePath = filePath;
				entry.wslDistro = input.wslDistro;
				entry.wslUser = input.wslUser;
				setLocalSessionFilePath(entry, filePath);
				entry.importedSourceId = input.importedSourceId;
				entry.piSessionId = input.piSessionId;
				// fork 标记只增补不清空：同一文件可能先以普通扫描注册、后经 fork 注册逻辑走到这里。
				if (input.forked) entry.forked = true;
				entry.status = "active";
				entry.updatedAt = now;
			}
			return { value: cloneEntry(entry), changed: true };
		});
	}

	async createDraft(input: {
		projectId: string;
		title: string;
		environment: SessionEnvironment;
		source?: SessionSource;
		backend?: AgentBackend;
		model?: SessionModelPreference;
		thinkingLevel?: string;
		permissionPreset?: string;
		/**
		 * Fresh drafts remain eligible for their first PiDeck automatic or JSONL title,
		 * even when the provisional UI label is not literally "Untitled". Callers that
		 * import an already named external session must opt in to final ownership with
		 * titleOrigin: "manual".
		 */
		titleOrigin?: SessionTitleOrigin;
		/** DSH agent 预设（会话「模式」）草稿期预选；外部会话导入时来自 host 会话 header。 */
		agentPreset?: string;
		/** 外部（dsh-web 等）会话导入：host 会话已存在，条目直接置 active（重启不清理）。 */
		dshSessionId?: string;
		/**
		 * DSH 外部会话的真实活跃时间（磁盘日志文件 mtime）。自动同步每轮全量重导，
		 * 不带这个就用 Date.now()，会话每次重启被顶到启动时刻、永远排在 pi 会话上面。
		 * 语义与 pi 会话一致（扫描器用文件 mtime 当 updatedAt）。
		 */
		updatedAt?: number;
		/** 纠正归属时保留已有真实标题；占位名（cwd 末段）由调用方决定是否覆盖。 */
		keepExistingTitle?: boolean;
		/**
		 * 手动找回（配置页导入 / 归档恢复）才清删除墓碑。
		 * 自动同步禁止带这个：否则删映射的同时刷新还在跑，createDraft 会把墓碑清掉再写回侧栏。
		 */
		restoreDismissed?: boolean;
	}): Promise<SessionRecord> {
		this.assertLoaded();
		const entry = await this.enqueueMutation((entries) => {
			const now = Date.now();
			// 幂等去重：DSH 外部会话按 host 会话 id 唯一映射。同一 dshSessionId 重复
			// 导入（自动同步与手动导入并发、配置页重复点击、host-ready 重放）时
			// 不再新建条目，只更新标题/项目归属——否则侧栏出现两条同 host 会话记录，
			// 且删除其一后另一条仍可加载同一 host 数据（「重复导入」用户问题）。
			if (input.dshSessionId) {
				const dismissed = this.dismissedDshSessionIds.has(input.dshSessionId);
				const existing = entries.find((candidate) => candidate.dshSessionId === input.dshSessionId);
				// 用户已删映射、host 目录还在：自动同步不得再建条目。手动找回才允许。
				if (dismissed && !input.restoreDismissed && !existing) {
					throw new Error("DISMISSED_DSH_SESSION");
				}
				const forgotten = input.restoreDismissed ? this.dismissedDshSessionIds.delete(input.dshSessionId) : false;
				if (existing) {
					const nextTitle = input.keepExistingTitle ? existing.title : input.title;
					const agentPresetChanged = input.agentPreset !== undefined && existing.agentPreset !== input.agentPreset;
					const changed =
						forgotten ||
						existing.projectId !== input.projectId ||
						existing.title !== nextTitle ||
						existing.backend !== input.backend ||
						agentPresetChanged ||
						existing.status !== "active" ||
						// mtime 变化也落盘：修正历史被顶高的 updatedAt，否则排序永远错
						existing.updatedAt !== (input.updatedAt ?? now);
					existing.projectId = input.projectId;
					existing.title = nextTitle;
					existing.backend = input.backend;
					existing.status = "active";
					// 外部会话 header 携带的 preset 变化（host 会话 header 是权威）随导入同步
					if (input.agentPreset !== undefined) existing.agentPreset = input.agentPreset;
					// 排序语义：用磁盘日志文件 mtime（真实活跃时间），不再顶到导入时刻
					existing.updatedAt = input.updatedAt ?? now;
					return { value: cloneEntry(existing), changed };
				}
			}
			const nextEntry: SessionCatalogEntry = {
				id: randomUUID(),
				projectId: input.projectId,
				title: input.title,
				// 导入已有 host 会话（带 dshSessionId）标题已由 host 确认；纯草稿留一次领取机会。
				titleLocked: (input.titleOrigin ?? (input.dshSessionId ? "manual" : undefined)) !== undefined,
				titleOrigin: input.titleOrigin ?? (input.dshSessionId ? "manual" : undefined),
				source: input.source ?? "pi",
				environment: input.environment,
				backend: input.backend,
				wslDistro: input.environment === "wsl" ? this.identityContext.wslDistro : undefined,
				wslUser: input.environment === "wsl" ? this.identityContext.wslUser : undefined,
				// 带 dshSessionId = 导入已有 host 会话（数据在 $DSH_HOME），
				// 不是「尚未发送」的草稿：置 active，重启清理/重新打开都按真实会话处理。
				status: input.dshSessionId ? "active" : "draft",
				model: cloneModelPreference(input.model),
				thinkingLevel: input.thinkingLevel,
				permissionPreset: input.permissionPreset,
				agentPreset: input.agentPreset,
				dshSessionId: input.dshSessionId,
				createdAt: now,
				// 外部会话导入带 mtime（真实活跃时间）；pi 草稿没有该字段，仍用当前时刻
				updatedAt: input.updatedAt ?? now,
			};
			entries.push(nextEntry);
			return { value: cloneEntry(nextEntry), changed: true };
		});
		return this.recordFromEntry(entry);
	}

	async update(
		id: string,
		patch: Partial<Pick<SessionCatalogEntry, "title" | "backend" | "updatedAt">> & {
			model?: SessionModelPreference | null;
			thinkingLevel?: string | null;
			permissionPreset?: string | null;
			/** DSH agent 预设（会话「模式」）：草稿期预选；null = 清除预选。 */
			agentPreset?: string | null;
			proxy?: SessionProxyOverride | null;
			/** 切到生图后端时甩开 pi 会话文件引用（null = 清空）。 */
			filePath?: string | null;
			piSessionId?: string | null;
			/** fork 标记：仅显式 true 时置位（fork 身份元数据；(fork) 后缀已物理写入标题）。 */
			forked?: boolean | null;
		},
	): Promise<SessionRecord> {
		this.assertLoaded();
		const transient = this.transientEntries.get(id);
		if (transient) {
			if (patch.title !== undefined) {
				transient.title = patch.title;
				assignTitleOrigin(transient, "manual");
			}
			if (patch.model !== undefined) transient.model = cloneModelPreference(patch.model ?? undefined);
			if (patch.thinkingLevel !== undefined) transient.thinkingLevel = patch.thinkingLevel ?? undefined;
			if (patch.permissionPreset !== undefined) transient.permissionPreset = patch.permissionPreset ?? undefined;
			if (patch.agentPreset !== undefined) transient.agentPreset = patch.agentPreset ?? undefined;
			if (patch.backend !== undefined) transient.backend = patch.backend;
			// 切到生图/DSH 后端时需甩开 Pi 文件定位；路径变更时同步规范 locator。
			if (patch.filePath !== undefined || patch.backend === "dsh" || patch.backend === "imagegen") {
				setLocalSessionFilePath(transient, patch.filePath ?? undefined);
			}
			if (patch.piSessionId !== undefined) transient.piSessionId = patch.piSessionId ?? undefined;
			if (patch.forked === true) transient.forked = true;
			// null = 清除覆盖恢复跟随全局
			if (patch.proxy !== undefined) transient.proxy = patch.proxy ?? undefined;
			transient.updatedAt = patch.updatedAt ?? Date.now();
			return this.recordFromEntry(transient);
		}
		const entry = await this.enqueueMutation((entries) => {
			const nextEntry = this.requireEntry(entries, id);
			if (patch.title !== undefined) {
				nextEntry.title = patch.title;
				assignTitleOrigin(nextEntry, "manual");
			}
			if (patch.model !== undefined) nextEntry.model = cloneModelPreference(patch.model ?? undefined);
			if (patch.thinkingLevel !== undefined) nextEntry.thinkingLevel = patch.thinkingLevel ?? undefined;
			if (patch.permissionPreset !== undefined) nextEntry.permissionPreset = patch.permissionPreset ?? undefined;
			if (patch.agentPreset !== undefined) nextEntry.agentPreset = patch.agentPreset ?? undefined;
			if (patch.backend !== undefined) nextEntry.backend = patch.backend;
			if (patch.filePath !== undefined || patch.backend === "dsh" || patch.backend === "imagegen") {
				setLocalSessionFilePath(nextEntry, patch.filePath ?? undefined);
			}
			if (patch.piSessionId !== undefined) nextEntry.piSessionId = patch.piSessionId ?? undefined;
			if (patch.forked === true) nextEntry.forked = true;
			// null = 清除覆盖恢复跟随全局
			if (patch.proxy !== undefined) nextEntry.proxy = patch.proxy ?? undefined;
			nextEntry.updatedAt = patch.updatedAt ?? Date.now();
			return { value: cloneEntry(nextEntry), changed: true };
		});
		return this.recordFromEntry(entry);
	}

	/**
	 * 领取 PiDeck 自动标题。与通用 update() 分离：迟到的自动结果不得覆盖先到的用户改名。
	 * source 区分来源（#266）：扩展模型标题 "auto" 可升级首条消息/扫描派生的 "fallback"，
	 * 反向不可；"auto" 与 "manual" 都是终态，第二个自动结果一律丢弃。
	 */
	async applyAutomaticTitle(id: string, title: string, source: "auto" | "fallback"): Promise<SessionRecord> {
		this.assertLoaded();
		const nextTitle = title.replace(/\s+/g, " ").trim();
		if (!nextTitle) throw new Error("Automatic session title is required");
		const transient = this.transientEntries.get(id);
		if (transient) {
			if (claimAutomaticTitle(transient, nextTitle, source)) transient.updatedAt = Date.now();
			return this.recordFromEntry(transient);
		}
		const entry = await this.enqueueMutation((entries) => {
			const nextEntry = this.requireEntry(entries, id);
			const claimed = claimAutomaticTitle(nextEntry, nextTitle, source);
			if (claimed) nextEntry.updatedAt = Date.now();
			return { value: cloneEntry(nextEntry), changed: claimed };
		});
		return this.recordFromEntry(entry);
	}

	/**
	 * Reserves catalog title ownership before a manual rename reaches pi. The rename
	 * RPC is asynchronous, so this closes the window where a pending auto-title
	 * result could otherwise claim the still-provisional record first.
	 */
	async claimTitleOwnership(id: string): Promise<SessionRecord> {
		this.assertLoaded();
		const transient = this.transientEntries.get(id);
		if (transient) {
			if (!isTitleLocked(transient)) {
				assignTitleOrigin(transient, "manual");
				transient.updatedAt = Date.now();
			}
			return this.recordFromEntry(transient);
		}
		const entry = await this.enqueueMutation((entries) => {
			const nextEntry = this.requireEntry(entries, id);
			if (isTitleLocked(nextEntry)) return { value: cloneEntry(nextEntry), changed: false };
			assignTitleOrigin(nextEntry, "manual");
			nextEntry.updatedAt = Date.now();
			return { value: cloneEntry(nextEntry), changed: true };
		});
		return this.recordFromEntry(entry);
	}

	async attachRuntime(input: {
		sessionId: string;
		filePath?: string;
		piSessionId?: string;
		dshSessionId?: string;
		/** DSH agent 预设（会话「模式」）：attach/新建后 host 回写（host 会话 header 是权威）。 */
		agentPreset?: string;
		/** 真正开聊后再把 DSH 草稿抬成 active；预热只绑 host id，不抬。 */
		promoteToActive?: boolean;
		/** 归档恢复等手动找回才清删除墓碑；激活/fork 回写不得把用户删过的 id 解禁。 */
		restoreDismissed?: boolean;
	}): Promise<SessionCatalogEntry> {
		this.assertLoaded();
		return this.enqueueMutation((entries) => {
			const entry = this.requireEntry(entries, input.sessionId);
			if (entry.locator?.kind === "ssh") throw new Error("UNSUPPORTED_PROJECT_LOCATION");
			// pi 可能上报相对 cwd 的 sessionFile：写入 catalog 前归一化为绝对路径，
			// 否则与扫描器绝对路径 originKey 不一致，同一文件会出现两条记录。
			const filePath = input.filePath && this.resolveFilePath ? this.resolveFilePath(entry.projectId, input.filePath, entry.environment) : input.filePath;
			const previousFilePath = entry.filePath;
			// DSH 的 sessionPath 是 host zstd，不是 pi JSONL；写进 filePath 会让渲染层
			// 把空会话当成有磁盘历史（起始页 / 骨架来回抽）。
			if (filePath && entry.backend !== "dsh" && entry.backend !== "imagegen" && !entry.noSession) {
				setLocalSessionFilePath(entry, filePath);
			}
			if (input.piSessionId) entry.piSessionId = input.piSessionId;
			if (input.dshSessionId) {
				entry.dshSessionId = input.dshSessionId;
				// 只有明确找回才清墓碑。激活回写同一 host id 时如果清掉，
				// 用户删映射后迟到的 attach 会让下次自动同步再导回来。
				if (input.restoreDismissed) {
					this.dismissedDshSessionIds.delete(input.dshSessionId);
				}
			}
			// attach/新建时 host 回写的实际 preset（草稿预选可能被 host 修正为部署默认）
			if (input.agentPreset !== undefined) entry.agentPreset = input.agentPreset;
			// DSH 预热/激活也会 attach host id，但此时还没有用户消息。
			// 不能把草稿抬成 active：渲染层会把「active + dshSessionId」当成有历史，
			// 输入一半整页换成「正在加载历史」骨架。导入路径 createDraft({dshSessionId})
			// 已经是 active；真正开聊后由 prompt dispatch 再 promoteToActive。
			if (input.promoteToActive && input.dshSessionId && !entry.filePath && entry.status === "draft") {
				entry.status = "active";
			}
			if (entry.filePath) {
				const pathUnchanged = Boolean(previousFilePath && canonicalizeSessionPath(previousFilePath, entry.environment) === canonicalizeSessionPath(entry.filePath, entry.environment));
				const nextOriginKey = pathUnchanged && entry.originKey ? entry.originKey : this.originKeyForEntry(entry);
				entry.originKey = nextOriginKey;
				entry.status = "active";

				const duplicateIndex = nextOriginKey ? entries.findIndex((candidate) => candidate.id !== entry.id && candidate.originKey === nextOriginKey) : -1;
				if (duplicateIndex >= 0) {
					const duplicate = entries[duplicateIndex];
					entry.model ??= duplicate.model;
					entry.thinkingLevel ??= duplicate.thinkingLevel;
					entry.importedSourceId ??= duplicate.importedSourceId;
					entry.createdAt = Math.min(entry.createdAt, duplicate.createdAt);
					entries.splice(duplicateIndex, 1);
				}
			}
			entry.updatedAt = Date.now();
			return { value: cloneEntry(entry), changed: true };
		});
	}

	async remove(id: string): Promise<boolean> {
		this.assertLoaded();
		if (this.transientEntries.delete(id)) return true;
		return this.enqueueMutation((entries) => {
			const index = entries.findIndex((entry) => entry.id === id);
			if (index < 0) return { value: false, changed: false };
			entries.splice(index, 1);
			return { value: true, changed: true };
		});
	}

	/**
	 * 归档/删除父会话时清掉整棵子树。
	 *
	 * 磁盘侧 `SessionScanner.archive/delete` 会把 sibling `<stem>/` 一并移走，但
	 * `remove(id)` 只摘一条；`mergeScanned` 只增改不删，列表缓存会把失去父节点的
	 * 子会话孤儿提升成顶层行，再点开就是残留聊天框。匿名会话和草稿没有 filePath，
	 * 不会被当成后代。其它项目即使路径碰巧相似，也按 projectId 隔离。
	 */
	async removeWithDescendants(id: string): Promise<string[]> {
		this.assertLoaded();
		const parent = this.transientEntries.get(id) ?? this.entries.find((entry) => entry.id === id);
		if (!parent) return [];
		const projectEntries = this.listEntries().filter((entry) => entry.projectId === parent.projectId);
		const ids = collectSessionSubtreeIds(projectEntries, parent);

		const removed: string[] = [];
		for (const sessionId of ids) {
			if (this.transientEntries.delete(sessionId)) removed.push(sessionId);
		}
		const persistedIds = ids.filter((sessionId) => !removed.includes(sessionId));
		if (persistedIds.length === 0) return removed;

		const persistedRemoved = await this.enqueueMutation((entries) => {
			const idSet = new Set(persistedIds);
			const next = entries.filter((entry) => !idSet.has(entry.id));
			const actuallyRemoved = entries.filter((entry) => idSet.has(entry.id)).map((entry) => entry.id);
			if (actuallyRemoved.length === 0) return { value: [] as string[], changed: false };
			entries.splice(0, entries.length, ...next);
			return { value: actuallyRemoved, changed: true };
		});
		return [...removed, ...persistedRemoved];
	}

	/**
	 * 将 draft 会话提升为 active：生图草稿已把历史落盘到 ImageSession 独立存储后调用，
	 * 避免重启时被 staleDrafts 清理逻辑剔掉（否则侧栏没有入口，历史无法恢复）。
	 * 非 draft / 匿名会话幂等：只更新 updatedAt。
	 */
	async promoteToActive(sessionId: string): Promise<SessionRecord | undefined> {
		this.assertLoaded();
		const transient = this.transientEntries.get(sessionId);
		if (transient) {
			if (transient.status === "draft") transient.status = "active";
			transient.updatedAt = Date.now();
			return this.recordFromEntry(transient);
		}
		const entry = await this.enqueueMutation((entries) => {
			const nextEntry = this.requireEntry(entries, sessionId);
			if (nextEntry.status === "draft") nextEntry.status = "active";
			nextEntry.updatedAt = Date.now();
			return { value: cloneEntry(nextEntry), changed: true };
		});
		return this.recordFromEntry(entry);
	}

	/**
	 * 删除侧栏项目时清掉该项目下全部 catalog 映射（含 DSH 导入）。
	 * host 会话文件仍在 $DSH_HOME，但不再自动挂回侧栏；用户手动导入才会再出现。
	 */
	async removeByProjectId(projectId: string): Promise<number> {
		this.assertLoaded();
		for (const [id, entry] of this.transientEntries) {
			if (entry.projectId === projectId) this.transientEntries.delete(id);
		}
		return this.enqueueMutation((entries) => {
			const next = entries.filter((entry) => entry.projectId !== projectId);
			const removed = entries.length - next.length;
			if (removed === 0) return { value: 0, changed: false };
			entries.splice(0, entries.length, ...next);
			return { value: removed, changed: true };
		});
	}

	async removeByFilePath(filePath: string, environment: SessionEnvironment): Promise<boolean> {
		this.assertLoaded();
		const target = canonicalizeSessionPath(filePath, environment);
		return this.enqueueMutation((entries) => {
			const index = entries.findIndex((entry) => entry.filePath && entry.environment === environment && canonicalizeSessionPath(entry.filePath, environment) === target);
			if (index < 0) return { value: false, changed: false };
			entries.splice(index, 1);
			return { value: true, changed: true };
		});
	}

	async mergeScanned(
		projectId: string,
		summaries: SessionSummary[],
		context: SessionCatalogContext = this.identityContext,
		options: {
			/**
			 * 本次并入来自用户手动导入（外置目录导入）：命中条目打上 manualProjectAssignment，
			 * 之后别的项目扫描不得把归属改回去。
			 */
			manualAssignment?: boolean;
		} = {},
	): Promise<SessionRecord[]> {
		this.assertLoaded();
		// 新发现文件用 pi JSONL 标题初始化 catalog；一旦 catalog 已有记录，后续扫描
		// 只更新文件身份、预览和结构元数据，不能用 pi/TUI 的标题覆盖 PiDeck 名称。
		// 同一次读取仍校验会话头：invalidOrigins 收集非有效会话文件，下面据此清洗与拒绝。
		const { titles: fetchedTitles, legacyProbes: fetchedLegacyProbes, invalid: invalidOrigins, parents: fetchedParents, forked: fetchedForked } = await this.collectScannedTitles(summaries, context);
		return this.enqueueMutation((entries) => {
			let changed = false;

			// 清洗存量脏数据：pi-subagents artifactDir="session"（默认）的产物转储
			// 曾被旧版扫描误注册成 active 条目，导致每个子代理在侧栏「嵌套 + 顶层平铺」
			// 重复显示。扫描端已排除这些文件，但 mergeScanned 只增改不删，存量条目会
			// 永远留在 catalog 里；这里按同一路径规则移除并落盘（仅 pi 来源，导入会话不受影响）。
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index]!;
				if (entry.source !== "pi" || !entry.filePath) continue;
				if (!isInSubagentArtifactsDir(entry.filePath)) continue;
				entries.splice(index, 1);
				changed = true;
			}

			// 清洗会话头校验失败的存量条目：本轮补名读取判定为非有效会话的文件
			// （transcript 等无 type 头的产物，即便不在 subagent-artifacts 目录）。
			// 仅 pi 来源；导入会话由各自导入器保证格式，不参与本校验。
			if (invalidOrigins.size > 0) {
				for (let index = entries.length - 1; index >= 0; index -= 1) {
					const entry = entries[index]!;
					if (entry.source !== "pi") continue;
					if (!entry.originKey || !invalidOrigins.has(entry.originKey)) continue;
					entries.splice(index, 1);
					changed = true;
				}
			}

			// 防御性过滤：扫描端漏网（subagent-artifacts）或会话头校验失败的产物不得注册新条目。
			const acceptedSummaries = summaries.filter((summary) => {
				if (summary.source === "pi" && isInSubagentArtifactsDir(summary.filePath)) return false;
				if (invalidOrigins.has(buildSummaryOriginKey(summary, context))) return false;
				return true;
			});

			const byOrigin = new Map(entries.filter((entry) => entry.originKey && entry.locator?.kind !== "ssh").map((entry) => [entry.originKey!, entry]));
			const summaryById = new Map<string, SessionSummary>();

			// Restore model/thinking from the session file when the catalog lacks them.
			// (Explicit user picks are already stored on the entry and are preserved.)
			function inheritSessionMeta(entry: SessionCatalogEntry, summary: SessionSummary) {
				if (!entry.model && summary.model) {
					entry.model = createSessionModelPreference(summary.model.provider, summary.model.modelId, undefined);
					changed = true;
				}
				if (!entry.thinkingLevel && summary.thinkingLevel) {
					entry.thinkingLevel = summary.thinkingLevel;
					changed = true;
				}
			}

			for (const summary of acceptedSummaries) {
				const originKey = buildSummaryOriginKey(summary, context);
				// 标题来源优先级：summary.name（readSummary 全量路径）先于读头补名。
				// nameFromSessionInfo=false 表示首条消息弱回退，所有权只算 fallback（#266）。
				const summaryTitle = catalogDisplayTitle(summary.name);
				const fetched = fetchedTitles.get(originKey);
				const fetchedTitle = catalogDisplayTitle(fetched?.name);
				const initialAuthoritative = summaryTitle ? summary.nameFromSessionInfo !== false : fetched?.fromSessionInfo === true;
				// 平铺子代理（tintinweb 形态）父关系回补：轻量扫描不带 parentSessionPath，
				// 标题回读时若探测到父（<agent>#<8hex> + parentSession header）则用拾取值；
				// 普通会话/用户 fork 不探测到该值，保持 summary/旧值原样。
				const fetchedParent = fetchedParents.get(originKey);
				// fork 标记回填：仅头部探测确认（parentSession + 非 tintinweb 形态）时置 true；
				// 有父关系（子代理折叠）的会话不标记——fork 与子代理是两种形态。
				const fetchedForkedFlag = fetchedForked.get(originKey);
				const importedSourceId = getImportedSessionSourceId(summary);
				let entry = byOrigin.get(originKey);
				if (!entry) {
					const now = summary.updatedAt || Date.now();
					const initialTitle = summaryTitle || fetchedTitle || scannedFileStemTitle(summary.filePath);
					const initialOrigin = scannedTitleOrigin(initialTitle, initialAuthoritative);
					entry = {
						id: randomUUID(),
						projectId,
						originKey,
						// listPathSummary 没有 name；readSummary 若仍带回时间戳文件名，也不能当标题。
						// 发现时读取到的名称是初始化值；纯占位名留给一次自动/补名领取，
						// 首条消息弱回退只算 fallback（等待扩展模型标题升级）。
						title: initialTitle,
						titleLocked: initialOrigin !== undefined,
						titleOrigin: initialOrigin,
						source: summary.source ?? "pi",
						environment: getSessionEnvironment(summary),
						filePath: summary.filePath,
						wslDistro: summary.wsl ? context.wslDistro : undefined,
						wslUser: summary.wsl ? context.wslUser : undefined,
						importedSourceId,
						status: "active",
						parentSessionPath: summary.parentSessionPath ?? fetchedParent,
						forked: (summary.parentSessionPath ?? fetchedParent) ? undefined : fetchedForkedFlag,
						createdAt: now,
						updatedAt: now,
					};
					setLocalSessionFilePath(entry, summary.filePath);
					entries.push(entry);
					byOrigin.set(originKey, entry);
					changed = true;
					if (options?.manualAssignment) entry.manualProjectAssignment = true;
				} else {
					// Catalog is the display-title authority. An explicitly unlocked entry is a
					// fresh provisional session, even if its UI label is "<project> agent";
					// it may absorb exactly one initial JSONL title before becoming owned.
					const canInitializeTitle = !isTitleLocked(entry);
					const initialTitle = summaryTitle || fetchedTitle;
					// #266 存量自愈：legacy 条目读盘探测过一次。指纹命中（catalog 存的正是弱兜底名、
					// JSONL 另有权威名）才改写标题；探测过但没命中就消费掉这一次机会，落 manual 终态，
					// 避免每次扫描都为一个不可能自愈的条目读盘。读盘失败则保持 legacy 下次再试。
					const legacyProbe = fetchedLegacyProbes.get(originKey);
					const legacyRepair = legacyProbe ? repairedLegacyFallbackTitle(entry, summaryTitle && summary.nameFromSessionInfo === true ? { ...legacyProbe, authoritative: summaryTitle } : legacyProbe) : undefined;
					const nextTitle = legacyRepair || (canInitializeTitle ? initialTitle : undefined) || catalogDisplayTitle(entry.title) || scannedFileStemTitle(summary.filePath);
					// rollout 文件名标题（历史导入兑底）不锁定：留一次被真实标题覆盖的机会；
					// 真实标题一旦落库即锁定，后续 pi /name 或 JSONL 变化不再反向改写。
					// 未锁定条目吸收的新标题按来源升级：权威 session_info → manual，首条消息弱回退 → fallback。
					const nextOrigin = legacyProbe ? "manual" : ((canInitializeTitle && initialTitle ? scannedTitleOrigin(nextTitle, initialAuthoritative) : undefined) ?? resolveTitleOrigin(entry));
					const nextTitleLocked = nextOrigin !== undefined;
					// 父关系最终值：新探测值优先，缺失时保留旧值（轻量扫描恒缺省，不能清掉已持久化的父）。
					const nextParent = summary.parentSessionPath ?? fetchedParent ?? entry.parentSessionPath;
					// fork 标记同样只增补、不清空：未探测到（轻量扫描/普通会话）保留持久化值。
					const nextForked = nextParent ? entry.forked : fetchedForkedFlag || entry.forked;
					// 手动导入钉住的归属：别的项目扫描不得改回去（见 SessionCatalogEntry 注释）；
					// 用户再一次手动导入（manualAssignment）表示明确改主意，允许迁移到新项目。
					const nextProjectId = entry.manualProjectAssignment && !options?.manualAssignment && entry.projectId !== projectId ? entry.projectId : projectId;
					if (
						entry.projectId !== nextProjectId ||
						entry.filePath !== summary.filePath ||
						entry.title !== nextTitle ||
						entry.titleLocked !== nextTitleLocked ||
						entry.titleOrigin !== nextOrigin ||
						entry.source !== (summary.source ?? "pi") ||
						entry.environment !== getSessionEnvironment(summary) ||
						entry.wslDistro !== (summary.wsl ? context.wslDistro : undefined) ||
						entry.wslUser !== (summary.wsl ? context.wslUser : undefined) ||
						entry.importedSourceId !== importedSourceId ||
						entry.status !== "active" ||
						entry.parentSessionPath !== nextParent ||
						entry.forked !== nextForked ||
						entry.updatedAt !== summary.updatedAt
					) {
						entry.projectId = nextProjectId;
						entry.filePath = summary.filePath;
						entry.title = nextTitle;
						entry.titleLocked = nextTitleLocked;
						entry.titleOrigin = nextOrigin;
						entry.source = summary.source ?? "pi";
						entry.environment = getSessionEnvironment(summary);
						entry.wslDistro = summary.wsl ? context.wslDistro : undefined;
						entry.wslUser = summary.wsl ? context.wslUser : undefined;
						setLocalSessionFilePath(entry, summary.filePath);
						entry.importedSourceId = importedSourceId;
						entry.status = "active";
						// 子会话的父子关系可能随后续扫描才被识别（parent 文件出现/路径推断补全），
						// 变化必须计入 changed 才会落盘，否则重拉后仍以孤儿平铺。
						// 平铺子代理（tintinweb 形态）的父来自头部探测（fetchedParent，见上方）。
						// 注意：轻量扫描（listPathSummary）不读正文、parentSessionPath 恒为缺省，
						// 直接用缺省值覆盖会清掉上轮探测/持久化的父关系（重启后孤儿平铺）；
						// 故此处只增补、不清空——新值优先，其次保留旧值。
						entry.parentSessionPath = summary.parentSessionPath ?? fetchedParent ?? entry.parentSessionPath;
						entry.forked = nextForked;
						entry.updatedAt = summary.updatedAt;
						changed = true;
					}
					// 只有本次是手动导入才置位（自动扫描不得清除既有置位，否则归属又会被抢走）。
					if (options?.manualAssignment && !entry.manualProjectAssignment) {
						entry.manualProjectAssignment = true;
						changed = true;
					}
				}
				summaryById.set(entry.id, summary);
				inheritSessionMeta(entry, summary);
			}

			const records = entries.filter((entry) => entry.projectId === projectId).map((entry) => this.recordFromEntry(entry, summaryById.get(entry.id)));
			const idByPath = new Map<string, string>();
			for (const record of records) {
				if (!record.filePath) continue;
				idByPath.set(canonicalizeSessionPath(record.filePath, record.environment), record.id);
			}
			for (const record of records) {
				if (!record.parentSessionPath) continue;
				record.parentSessionId = idByPath.get(canonicalizeSessionPath(record.parentSessionPath, record.environment));
			}
			return {
				value: records.sort((left, right) => right.updatedAt - left.updatedAt),
				changed,
			};
		}).then((records) =>
			[
				...Array.from(this.transientEntries.values())
					.filter((entry) => entry.projectId === projectId)
					.map((entry) => this.recordFromEntry(entry)),
				...records,
			].sort((left, right) => right.updatedAt - left.updatedAt),
		);
	}

	/** 对新文件、未确认 provisional 标题，或需要一次性回填旧子代理父关系的条目读取会话头。
	 * 已锁定 catalog 标题不会因为文件 mtime 变化而补读：PiDeck 已持久化显示名，
	 * 也不再关心 JSONL 中段或尾部追加的 session_info。标题读取仍顺带校验会话头、
	 * 补平铺子代理父关系和 fork 标记。 */
	private async collectScannedTitles(summaries: SessionSummary[], context: SessionCatalogContext): Promise<{ titles: Map<string, ScannedTitleFetch>; legacyProbes: Map<string, LegacyTitleProbe>; invalid: Set<string>; parents: Map<string, string>; forked: Map<string, boolean> }> {
		const titles = new Map<string, ScannedTitleFetch>();
		// 只收录**读取成功**的 legacy 探测：读不到（权限/锁定/WSL 抖动）时条目保持 legacy，下次扫描再试，
		// 否则一次瞬时失败就会把唯一的一次自愈机会消费掉。
		const legacyProbes = new Map<string, LegacyTitleProbe>();
		const invalid = new Set<string>();
		const parents = new Map<string, string>();
		const forked = new Map<string, boolean>();
		if (!this.fetchTitle) return { titles, legacyProbes, invalid, parents, forked };
		const byOrigin = new Map(this.entries.filter((entry) => entry.originKey).map((entry) => [entry.originKey!, entry]));
		const wanted: Array<{ originKey: string; filePath: string; includeTitle: boolean; legacyProbe?: boolean; lockedTitle?: string }> = [];
		for (const summary of summaries) {
			const originKey = buildSummaryOriginKey(summary, context);
			const existing = byOrigin.get(originKey);
			if (existing && isTitleLocked(existing)) {
				// Existing PiDeck-owned sessions do not need title freshness. The only
				// retained disk probe repairs a legacy flat subagent's missing parent link,
				// and requests header-only metadata rather than a full title scan.
				// 例外：legacy 存量条目（#266 可能被误锁）读一次标题窗口，用「权威名 + 弱兜底候选」做指纹判定；
				// 命中即修、不命中转终态，一次读取收口，之后与其他锁定条目一样不再读盘。
				const legacy = existing.source === "pi" && resolveTitleOrigin(existing) === "legacy";
				const tintinwebOrphan = existing.source === "pi" && !existing.parentSessionPath && /^[^#]+#[0-9a-f]{8}$/i.test(existing.title);
				if (legacy) wanted.push({ originKey, filePath: summary.filePath, includeTitle: true, legacyProbe: true, lockedTitle: existing.title });
				else if (tintinwebOrphan) wanted.push({ originKey, filePath: summary.filePath, includeTitle: false });
				continue;
			}
			// readSummary 全量路径已携带初始名称，无需再次读盘。
			if (catalogDisplayTitle(summary.name)) continue;
			// New files and explicitly unlocked provisional records need one exact title
			// read; every other locked record remains entirely out of this path.
			wanted.push({ originKey, filePath: summary.filePath, includeTitle: true });
		}
		if (wanted.length === 0) return { titles, legacyProbes, invalid, parents, forked };
		// 有界并行读头部；限制并发避免 WSL 环境一次拉起过多 wsl.exe。
		// 单个失败降级为无标题/不拒绝，不影响扫描结果。
		const CONCURRENCY = 8;
		let cursor = 0;
		const workers = Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, async () => {
			while (cursor < wanted.length) {
				const item = wanted[cursor++];
				const result = await this.fetchTitle!(item.filePath, { includeTitle: item.includeTitle }).catch(() => undefined);
				if (!result) continue;
				if (item.includeTitle && result.name) {
					// fromSessionInfo=false 是首条消息弱回退（#266）：所有权只能算 fallback，
					// 缺省（旧 fetcher/未标记）按权威名处理，保持既有行为。
					titles.set(item.originKey, { name: result.name, fromSessionInfo: result.nameFromSessionInfo !== false, fallbackName: result.fallbackName });
				}
				if (item.legacyProbe) {
					// 只有真读到 session_info 才算权威名：另一个弱兜底不能用来「修复」弱兜底。
					const authoritative = result.nameFromSessionInfo === true ? result.name : undefined;
					// #266：窗口兜底对不上目录标题时才多读一次有界前缀，取「文件内真首句」当第二指纹基准
					// （系统提示很大时窗口兜底会退化成尾部消息，只有真首句与当年写进 catalog 的标题一致）。
					const needsFirstUserText = Boolean(authoritative) && normalizeFingerprintTitle(result.fallbackName) !== normalizeFingerprintTitle(item.lockedTitle);
					// 深读失败（WSL 超时/文件被占）只降级回「窗口兜底比对」并消费掉这一次机会，不像读盘失败那样保持可重试：
					// 一条修不了的存量条目不值得每次扫描都再读 8MB。方向是安全的——最多保持原标题，不会写错。
					const firstUserText = needsFirstUserText
						? await this.fetchTitle!(item.filePath, { includeTitle: false, includeFirstUserText: true })
								.then((extra) => extra?.firstUserText)
								.catch(() => undefined)
						: undefined;
					legacyProbes.set(item.originKey, { authoritative, fallback: result.fallbackName, firstUserText });
				}
				// valid 显式为 false 才拒绝；缺省（读不到/未校验）保留原行为
				if (result.valid === false) invalid.add(item.originKey);
				// 平铺子代理（tintinweb 形态）回补父关系：来源只推断自 filename，
				// 不以 summary 的 source 过滤，避免引用文件与扫描来源不一致时漏补。
				if (result.parentSessionPath) parents.set(item.originKey, result.parentSessionPath);
				// pi fork/branch 会话标记（parentSession header + 非 tintinweb 形态）：只在探测到
				// 才写 true，不写 false——普通会话/子代理不该反向清掉已持久化的标记。
				if (result.forked === true) forked.set(item.originKey, true);
			}
		});
		await Promise.all(workers);
		return { titles, legacyProbes, invalid, parents, forked };
	}

	private sessionLocatorForEntry(entry: SessionCatalogEntry, summary?: SessionSummary): SessionLocator | undefined {
		if (entry.locator?.kind === "ssh") return cloneSessionLocator(entry.locator);
		if (entry.noSession || entry.backend === "dsh" || entry.backend === "imagegen") return undefined;
		if (entry.locator) return cloneSessionLocator(entry.locator);
		if (summary?.locator) return cloneSessionLocator(summary.locator);
		const filePath = summary?.filePath ?? entry.filePath;
		if (!filePath) return undefined;
		return sessionLocatorFromLegacy({
			environment: summary ? getSessionEnvironment(summary) : entry.environment,
			filePath,
			wslDistro: entry.wslDistro,
			wslUser: entry.wslUser,
		});
	}

	private recordFromEntry(entry: SessionCatalogEntry, summary?: SessionSummary): SessionRecord {
		const locator = this.sessionLocatorForEntry(entry, summary);
		const recordSummary = locator?.kind === "ssh" ? undefined : summary;
		return {
			id: entry.id,
			projectId: entry.projectId,
			title: catalogDisplayTitle(entry.title) || "Untitled",
			noSession: entry.noSession,
			source: recordSummary?.source ?? entry.source,
			environment: recordSummary ? getSessionEnvironment(recordSummary) : entry.environment,
			backend: entry.backend,
			...(locator ? { locator } : {}),
			filePath: locator ? (locator.kind === "local" ? locator.filePath : undefined) : (recordSummary?.filePath ?? entry.filePath),
			wslDistro: locator?.kind === "ssh" ? undefined : entry.wslDistro,
			wslUser: locator?.kind === "ssh" ? undefined : entry.wslUser,
			importedSourceId: recordSummary ? getImportedSessionSourceId(recordSummary) : entry.importedSourceId,
			parentSessionPath: locator?.kind === "ssh" ? undefined : (recordSummary?.parentSessionPath ?? entry.parentSessionPath),
			forked: entry.forked,
			projectPath: locator?.kind === "ssh" ? undefined : recordSummary?.projectPath,
			preview: recordSummary?.preview ?? "",
			messageCount: recordSummary?.messageCount ?? 0,
			status: entry.status,
			model: entry.model ? { ...entry.model } : undefined,
			thinkingLevel: entry.thinkingLevel,
			permissionPreset: entry.permissionPreset,
			agentPreset: entry.agentPreset,
			dshSessionId: entry.dshSessionId,
			proxy: entry.proxy ? { ...entry.proxy } : undefined,
			createdAt: entry.createdAt,
			updatedAt: recordSummary?.updatedAt ?? entry.updatedAt,
			wsl: locator?.kind === "ssh" ? undefined : recordSummary?.wsl,
			codexSessionId: recordSummary?.codexSessionId,
			codexThreadSource: recordSummary?.codexThreadSource,
			codexParentThreadId: recordSummary?.codexParentThreadId,
			codexAgentRole: recordSummary?.codexAgentRole,
			codexAgentNickname: recordSummary?.codexAgentNickname,
		};
	}

	private originKeyForEntry(entry: SessionCatalogEntry): string | undefined {
		if (entry.locator?.kind === "ssh" || !entry.filePath) return undefined;
		return buildSessionOriginKey({
			source: entry.source,
			environment: entry.environment,
			filePath: entry.filePath,
			wslDistro: entry.wslDistro ?? this.identityContext.wslDistro,
			wslUser: entry.wslUser ?? this.identityContext.wslUser,
			importedSourceId: entry.importedSourceId,
		});
	}

	/**
	 * 把条目中的相对 filePath 修正为绝对路径（通过注入的 resolver）。
	 * 返回新数组表示有变更；未注入 resolver 或无需修正时返回 undefined。
	 */
	private repairRelativeFilePaths(entries: SessionCatalogEntry[]): SessionCatalogEntry[] | undefined {
		const resolve = this.resolveFilePath;
		if (!resolve) return undefined;
		let changed = false;
		const next = entries.map((entry) => {
			if (entry.locator?.kind === "ssh" || !entry.filePath) return entry;
			const resolved = resolve(entry.projectId, entry.filePath, entry.environment);
			if (!resolved || resolved === entry.filePath) return entry;
			changed = true;
			const repaired = { ...entry, filePath: resolved };
			setLocalSessionFilePath(repaired, resolved);
			// originKey 随路径变化重算，否则后续 mergeScanned/attachRuntime 仍按旧 key 去重
			if (repaired.originKey) repaired.originKey = this.originKeyForEntry(repaired);
			return repaired;
		});
		return changed ? next : undefined;
	}

	private requireEntry(entries: SessionCatalogEntry[], id: string): SessionCatalogEntry {
		const entry = entries.find((candidate) => candidate.id === id);
		if (!entry) throw new Error(`Session not found: ${id}`);
		return entry;
	}

	private assertLoaded(): void {
		if (!this.loaded) throw new Error("SessionCatalog.load() must complete before use");
	}

	private assertWritable(): void {
		if (this.needsRepair) throw new SessionCatalogRecoveryError();
	}

	private enqueueMutation<T>(mutate: (entries: SessionCatalogEntry[]) => { value: T; changed: boolean }): Promise<T> {
		const operation = this.writeQueue
			.catch(() => undefined)
			.then(async () => {
				this.assertWritable();
				const nextEntries = this.entries.map(cloneEntry);
				const result = mutate(nextEntries);
				if (result.changed) {
					await this.writeSnapshot(nextEntries);
					this.entries = nextEntries;
				}
				return result.value;
			});
		this.writeQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private backupFilePath(): string {
		return `${this.filePath}.bak`;
	}

	private async readCatalogFile(filePath: string): Promise<{
		entries: SessionCatalogEntry[];
		dismissedDshSessionIds: Set<string>;
		locatorNormalizationNeeded: boolean;
	}> {
		const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<SessionCatalogFile>;
		if (parsed.version !== undefined && parsed.version !== 1) {
			throw new UnsupportedSessionCatalogVersionError();
		}
		if (!Array.isArray(parsed.sessions)) {
			throw new Error(`Invalid Session catalog: ${filePath}`);
		}
		const entries = parsed.sessions.filter((entry): entry is SessionCatalogEntry => {
			const validFields = typeof entry?.id === "string" && typeof entry.projectId === "string" && typeof entry.title === "string" && (entry.environment === "native" || entry.environment === "wsl") && (entry.status === "draft" || entry.status === "active");
			if (!validFields) return false;
			if (isRecord(entry.locator) && typeof entry.locator.kind === "string" && entry.locator.kind !== "local" && entry.locator.kind !== "ssh") {
				throw new UnsupportedSessionCatalogLocatorError();
			}
			return entry.locator === undefined || isSessionLocator(entry.locator);
		});
		if (entries.length !== parsed.sessions.length) {
			throw new Error(`Session catalog contains invalid records: ${filePath}`);
		}
		const locatorNormalizationNeeded = entries.some((entry) => {
			if (entry.locator?.kind === "ssh") {
				return entry.filePath !== undefined || entry.originKey !== undefined || entry.piSessionId !== undefined || entry.wslDistro !== undefined || entry.wslUser !== undefined || entry.parentSessionPath !== undefined;
			}
			return entry.locator?.kind === "local" && (entry.filePath !== entry.locator.filePath || entry.environment !== entry.locator.environment || entry.wslDistro !== entry.locator.wslDistro || entry.wslUser !== entry.locator.wslUser);
		});
		const dismissed = Array.isArray(parsed.dismissedDshSessionIds) ? parsed.dismissedDshSessionIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
		return {
			entries: entries.map(normalizeEntryLocator),
			dismissedDshSessionIds: new Set(dismissed),
			locatorNormalizationNeeded,
		};
	}

	private async writeSnapshot(entries: SessionCatalogEntry[]): Promise<void> {
		this.assertWritable();
		const snapshot: SessionCatalogFile = {
			version: 1,
			sessions: entries.map(cloneEntry),
			// 旧 catalog 没有该字段；空数组也写出，重启后删除墓碑不丢。
			dismissedDshSessionIds: [...this.dismissedDshSessionIds],
		};
		await mkdir(dirname(this.filePath), { recursive: true });
		const nonce = randomUUID();
		const tempPath = `${this.filePath}.${nonce}.tmp`;
		const backupPath = this.backupFilePath();
		const backupTempPath = `${backupPath}.${nonce}.tmp`;
		try {
			const handle = await open(tempPath, "w");
			try {
				await handle.writeFile(JSON.stringify(snapshot, null, 2), "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}

			if (!this.skipNextBackup) {
				try {
					await copyFile(this.filePath, backupTempPath);
					await renameWithRetry(backupTempPath, backupPath);
				} catch (error) {
					await unlink(backupTempPath).catch(() => undefined);
					if (isMissingFileError(error)) {
						// 首次写入：主文件还不存在，没有可备份的内容，属正常情况
					} else {
						// 备份轮换失败不能阻断 catalog 写入（新建会话等操作会因此失败）：
						// .bak 只是崩溃恢复的冗余副本，主文件仍是原子替换，旧内容在失败时原样保留。
						void getAppLogger()?.warn("session-catalog", "Backup rotation failed, continuing without backup", {
							cause: error instanceof Error ? error.message : String(error),
						});
					}
				}
			}
			await renameWithRetry(tempPath, this.filePath);
			this.skipNextBackup = false;
		} finally {
			await unlink(tempPath).catch(() => undefined);
			await unlink(backupTempPath).catch(() => undefined);
		}
	}
}

export function didSessionPreferencesChange(entry: SessionCatalogEntry, patch: Pick<SessionCatalogEntry, "model" | "thinkingLevel">): boolean {
	return !equalModel(entry.model, patch.model) || entry.thinkingLevel !== patch.thinkingLevel;
}
