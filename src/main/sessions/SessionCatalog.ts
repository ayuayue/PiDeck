import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { sessionLocatorFromLegacy } from "../../shared/locationAdapters";
import { readSshSessionLocator } from "../../shared/projectLocation";
import type { AgentBackend, AgentTab, SessionChannel, SessionEnvironment, SessionLocator, SessionModelPreference, SessionRecord, SessionSource, SessionSummary } from "../../shared/types";
import type { SessionProxyOverride } from "../../shared/types/session";
import { SessionLocatorRouter } from "./SessionLocatorRouter";
import { getAppLogger } from "../logging/sharedLogger";
import { withStoreFileCas } from "../persistence/storeFileCas";
import { acquireStoreFileLock, currentBootId, defaultIsProcessAlive } from "../persistence/StoreFileLock";
import { preserveUnchangedRecords } from "../persistence/preserveRecordIdentity";
import type { RemoteReferenceWriteGuard } from "../remote/RemoteReferenceWriteGuard";
import { assertHostRebindRecordIds, canonicalHostLocatorJson, isHostRebindRecordId, type HostRebindRecordOutcome, type HostRebindRecordPatch, type HostRebindRecordResult, type HostRebindRecordSnapshot, type HostRebindStorePort } from "../remote/HostRebindJournal";
import { renameWithRetry } from "../utils/fsRetry";
import {
	buildSessionOriginKey,
	buildSummaryOriginKey,
	canonicalizeSessionPath,
	collectSessionSubtreeIds,
	getImportedSessionSourceId,
	getSessionEnvironment,
	isInSubagentArtifactsDir,
	isUnambiguousAbsoluteSessionPath,
	looksLikeCodexSessionFileStem,
	looksLikePiSessionFileStem,
	looksLikeToolMarkerTitle,
} from "../../shared/sessionIdentity";
import { looksLikeExpandedRefBlockTitle } from "../../shared/expandedRefBlocks";
import { createSessionModelPreference } from "../../shared/modelDisplayName";
import { buildSessionIdAliasMap } from "../../shared/sessionIdAliases";
import { arbitrateRuntimeMergeTitle, isFileSession, mergeSourceGroupInto, repairSessionCatalogIdentities } from "./sessionCatalogIdentityRepair";
import type { SessionTitleFallbackKind } from "./sessionNameLine";

/** #488：存量的 fallback 标题只有「明显是正文摘录」才值得读盘自愈——人写的名字不会这么长。 */
const FALLBACK_TITLE_PROBE_MIN_LENGTH = 120;
/** 一次扫描最多为多少条 fallback 条目读盘自愈；其余留给后续扫描，不把启动变成大批量 JSON 解析。 */
const FALLBACK_TITLE_PROBE_MAX_PER_SCAN = 32;

/** 端口边界只允许稳定码（设计 §4.4）：recorder 自己的 needs-repair 码 + 收敛侧的"结果未知"。 */
const SESSION_CATALOG_NEEDS_REPAIR = "SESSION_CATALOG_NEEDS_REPAIR";
const REBIND_UNKNOWN_OUTCOME = "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME";
/**
 * 写事务的三个稳定码（INV-5c，设计 §3.2）：busy / 令牌过期 / 锁不可写各自可行动，不合并。
 * 与 `PROJECT_STORE_*` 同形（两处的实现共用 `storeFileCas`）。
 */
export const SESSION_CATALOG_BUSY = "SESSION_CATALOG_BUSY";
export const SESSION_CATALOG_REVISION_CONFLICT = "SESSION_CATALOG_REVISION_CONFLICT";
export const SESSION_CATALOG_LOCK_UNWRITABLE = "SESSION_CATALOG_LOCK_UNWRITABLE";
/** 单次 rebind 的补丁上限：与 journal 解码器的 records 上限一致。 */
const MAX_REBIND_PATCHES = 10_000;

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
	/** 外部连接渠道（微信/飞书桥建的会话）；缺省 = 桌面端创建，列表据此显示渠道标志。 */
	channel?: SessionChannel;
	/** 侧边任务会话标记（右侧抽屉面板持有，不登记主区常驻 Tab）；缺省 = 普通会话，旧存档无需迁移。 */
	sideTask?: boolean;
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
	/** 重发/编辑 fork 化替换标记：本会话已被 fork 出的子会话接替（值=子会话稳定 id），列表默认过滤。 */
	supersededBy?: string;
	/**
	 * #354 身份归并别名：启动期修复把历史重复身份记录并入本条目时，被吸收记录的历史稳定 ID。
	 * settings 置顶与渲染层持久化的 Tab 置顶/最近活动仍按旧 ID 存引用，靠本字段迁移到存活 id
	 * （shared/sessionIdAliases.ts）。缺省 = 无归并历史，旧 catalog 数据无需迁移。
	 */
	mergedSessionIds?: string[];
	model?: SessionModelPreference;
	thinkingLevel?: string;
	piSessionId?: string;
	/** DSH 会话身份（DSH host 的 sessionId）；backend=dsh 时由 DshAgentManager 创建/attach 维护。 */
	dshSessionId?: string;
	/** ACP 会话身份（agent 侧 sessionId）；backend=acp 时由 AcpAgentManager attach 回写，重启后 session/load 恢复。 */
	acpSessionId?: string;
	/** DSH 权限预设（read-only/workspace-write/danger-full-access）：草稿期预选，激活时应用。 */
	permissionPreset?: string;
	/** DSH agent 预设（会话「模式」）：草稿期预选；激活新建时随 sessions.create 应用，attach 时从 host 回写。 */
	agentPreset?: string;
	/** ACP 工具预选（AcpToolConfig.id）：backend=acp 草稿期选哪个 CLI；激活时由 AcpAgentManager 消费。 */
	acpToolId?: string;
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
	/**
	 * 写版本（INV-5a）：每次写事务 +1；旧版文件没有该字段，读成 0。
	 * **不 bump `version`**：多版本并行是产品既有行为，旧版遇到未知字段会忽略，而把 version 改成 2
	 * 会让旧版完全读不出 catalog（把「可检测」变成「不可用」）。
	 */
	revision?: number;
	sessions: SessionCatalogEntry[];
	/** 用户主动删除过的 DSH host 会话。host 目录可能还在，自动同步不得再导入。 */
	dismissedDshSessionIds?: string[];
	/**
	 * 用户主动从列表移除过的**远端**（ssh locator）会话：远端文件一律保留（PiDeck 不删远端数据），
	 * 这份墓碑让下次远端扫描不再把它列为「可导入」——否则用户会觉得「删了又回来」。
	 * 按 (hostId, remoteSessionId) 成对记：远端会话身份是「哪台主机 + 会话根下的相对路径」，
	 * 单看 remoteSessionId 会把两台主机上的同名路径当成同一条。
	 */
	dismissedRemoteSessions?: DismissedRemoteSessionEntry[];
	/**
	 * 远端（ssh locator）会话的**本机归档索引**：远端文件被 `mv` 进远端 `.pideck-archive/` 后，
	 * 本机只剩这份索引——它既是「列出归档」的数据源，也是「取消归档」的恢复身份。
	 * 为什么不是「扫远端归档目录」：每次列归档都要跑一遍远端扫描（登录壳 + 会话根探测 + 列目录），
	 * 而归档区本来就不在常规扫描口径里；把两个绝对路径（归档前/后）落进本机索引，
	 * 恢复时就不必重算会话根（会话根可能已经被改过）。
	 */
	archivedRemoteSessions?: ArchivedRemoteSessionEntry[];
};

/**
 * 本机侧的一条**远端归档条目**（P4.5b）。
 *
 * 为什么需要它：远端没有回收站，归档 = 把远端文件**移动**到同目录旁的 `.pideck-archive/`；
 * 移动之后本机必须记住「哪条会话去哪儿了」——只靠远端目录扫描无法恢复（那时远端文件已不在扫描口径内），
 * 也不能重算恢复目标（`originalRemotePath` 才是权威，会话根可能已变）。
 * `sessionId` 是恢复身份：本机归档通道的入参是**本机归档路径**，远端没有这种路径，
 * 所以远端恢复按 id 走（不能沿用本机路径契约）。
 */
export type ArchivedRemoteSessionEntry = {
	/** 本机 catalog 会话 id（恢复身份 + 本机记录重建时的记录 id）。 */
	sessionId: string;
	hostId: string;
	/** 恢复本机记录时的项目归属（归档时刻的值）。 */
	projectId: string;
	/** 归档时刻的标题（恢复记录时沿用）。 */
	title: string;
	/** 归档时刻会话记录的 updatedAt：恢复时原样回填，不把旧会话抬成「刚更新」。 */
	updatedAt: number;
	/** 相对会话根的远端身份；旧记录可能只有绝对路径（见 attachRuntime 的 remoteLocator 注释）。 */
	remoteSessionId?: string;
	/** 远端文件绝对路径算出的身份（runtime 上报写法）；与 remoteSessionId 二选一即可。 */
	remotePath?: string;
	/** 归档前的远端绝对路径（恢复的移动目标）。 */
	originalRemotePath: string;
	/** 归档后的远端绝对路径（当前文件所在位置）。 */
	archivedRemotePath: string;
	archivedAt: number;
};

/**
 * 一条远端归档条目是否可用：两个绝对路径与身份字段是恢复的全部依据。
 * 宽容读出（单条残缺只丢弃那一条）：一条坏索引不该让整份 catalog 变成不可用，
 * 而丢一条的代价是「这条归档在列表里看不到、也恢复不了」，不是数据丢失。
 */
function readArchivedRemoteSessionEntry(value: unknown): ArchivedRemoteSessionEntry | undefined {
	if (!isRecord(value)) return undefined;
	const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
	const hostId = typeof value.hostId === "string" ? value.hostId.trim() : "";
	const projectId = typeof value.projectId === "string" ? value.projectId.trim() : "";
	const originalRemotePath = typeof value.originalRemotePath === "string" ? value.originalRemotePath.trim() : "";
	const archivedRemotePath = typeof value.archivedRemotePath === "string" ? value.archivedRemotePath.trim() : "";
	if (sessionId.length === 0 || hostId.length === 0 || projectId.length === 0 || originalRemotePath.length === 0 || archivedRemotePath.length === 0) return undefined;
	const archivedAt = typeof value.archivedAt === "number" && Number.isFinite(value.archivedAt) ? value.archivedAt : 0;
	const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0;
	const remoteSessionId = typeof value.remoteSessionId === "string" && value.remoteSessionId.length > 0 ? value.remoteSessionId : undefined;
	const remotePath = typeof value.remotePath === "string" && value.remotePath.length > 0 ? value.remotePath : undefined;
	return {
		sessionId,
		hostId,
		projectId,
		title: typeof value.title === "string" ? value.title : "",
		updatedAt,
		...(remoteSessionId !== undefined ? { remoteSessionId } : {}),
		...(remotePath !== undefined ? { remotePath } : {}),
		originalRemotePath,
		archivedRemotePath,
		archivedAt,
	};
}

/**
 * 远端墓碑在内存里的键（`Set` 查询用）：hostId 是 UUID（无空白），remoteSessionId 的形状规则已拒绝
 * 控制字节（见 RemoteSessionScanner.readRemoteSessionId）⇒ `\n` 是唯一分隔符，不会有二义。
 */
/** 远端墓碑条目（P4.5a）：catalog 文件里持久化的「用户已从列表移除」的远端会话身份。
 *  具名而不是内联：跨 store 契约要求每个 hostId 字段都有可归属的属主（内联会变成 <unscoped>）。 */
export type DismissedRemoteSessionEntry = { hostId: string; remoteSessionId: string };

function remoteDismissalKey(hostId: string, remoteSessionId: string): string {
	return `${hostId}\n${remoteSessionId}`;
}

/** 键还原成持久化用的结构化身份；不合法（缺分隔符/空半截）返回 undefined，该条墓碑被丢弃。 */
function readRemoteDismissalKey(key: string): DismissedRemoteSessionEntry | undefined {
	const index = key.indexOf("\n");
	if (index <= 0 || index === key.length - 1) return undefined;
	return { hostId: key.slice(0, index), remoteSessionId: key.slice(index + 1) };
}

/** `readCatalogState` 的结果：ok/empty 是正常形态，另两种由调用方决定怎么 fail closed。 */
type CatalogStateRead =
	| { kind: "ok"; entries: SessionCatalogEntry[]; dismissedDshSessionIds: Set<string>; dismissedRemoteSessionIds: Set<string>; archivedRemoteSessions: Map<string, ArchivedRemoteSessionEntry>; revision: number; locatorNormalizationNeeded: boolean; skipNextBackup: boolean }
	| { kind: "empty" }
	| { kind: "unsupported"; error: UnsupportedSessionCatalogVersionError | UnsupportedSessionCatalogLocatorError }
	| { kind: "unreadable"; primary: string; backup: string };

/**
 * 磁盘上的 revision（INV-5a）：旧版（v1）文件没有这个字段 ⇒ 0；字段存在但值域非法 ⇒ 整份拒绝
 * （fail closed：把损坏的版本号当 0 会让下一次重写静默地把别人的更新归零）。
 */
function readCatalogRevision(value: unknown): number {
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("SESSION_CATALOG_INVALID_REVISION");
	return value;
}

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
export type SessionTitleFetchResult = { name?: string; nameFromSessionInfo?: boolean; valid?: boolean; parentSessionPath?: string; forked?: boolean; fallbackName?: string; fallbackKind?: SessionTitleFallbackKind; legacyFallbackName?: string; firstUserText?: string };

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
	/** WSL 项目补名：装配层据此选择对应发行版/用户的 scanner 读文件，而不是宿主 Node 读 Linux 路径。 */
	wslDistro?: string;
	wslUser?: string;
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

/**
 * 外部删除判定的锚点：从 filePath 父目录逐级向上，返回第一个真实存在的祖先目录；
 * 一路到文件系统根都不存在（或超过爬升上限）返回 undefined。
 * 爬升上限 6：嵌套子代理会话最深结构为 <encoded>/<父会话目录>/<agentId>/run-N/session.jsonl，
 * 从 run-N 爬到 encoded 需 4 层，留 2 层余量；网络盘/移动盘掉线时 2-3 层内即到根停下。
 */
function findExistingAncestorDir(filePath: string, maxDepth = 6): string | undefined {
	let dir = dirname(filePath);
	for (let depth = 0; depth < maxDepth; depth += 1) {
		if (existsSync(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/** 侧栏/Tab 展示用：pi 文件名时间戳不是会话名。 */
function catalogDisplayTitle(title: string | undefined): string | undefined {
	if (!title) return undefined;
	// 工具/上下文代理的确认标记行（`[ACP] acp_status result`）不是任何人起的名字：
	// 展示层一律当没有名字（Untitled），等权威名/自动标题来替换。
	if (looksLikePiSessionFileStem(title) || looksLikeToolMarkerTitle(title)) return undefined;
	return title;
}

/** 占位标题判定：catalog 无真实名称时落成 Untitled（pi 时间戳 stem 加载时也被清成它），
 *  只有这类标题才值得读头部补名，否则每次扫描都会重复读盘。 */
function isPlaceholderCatalogTitle(title: string | undefined): boolean {
	if (!title) return true;
	if (looksLikePiSessionFileStem(title)) return true;
	// 标记脏名同样是占位名：值得再读一次头部，让权威名/首句兜底把它换掉。
	if (looksLikeToolMarkerTitle(title)) return true;
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
	// 标记形态的脏名永远不算所有权：现场（2026-10-14）是扩展的旁路补全被第三方上下文代理接管，
	// 一段 `[ACP] acp_status result` 被当成权威 session_info 名锁成 manual 终态，此后自动命名再也
	// 修不掉，用户看到的就是「标题老是被插件改掉」。放在最前面（覆盖已持久化的 origin），
	// 一次性放开 claimAutomaticTitle / isTitleLocked / scannedTitleOrigin 三条判定。
	if (looksLikeToolMarkerTitle(entry.title)) return undefined;
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
 * #488 存量自愈：旧版本把头窗口外的首条用户消息丢掉、又让 thinking 顶替正文，于是把一段思考原文
 * 锁成了 fallback 标题（用户看到的就是「标题是一段思考」）。正文能读到后原地纠正。
 *
 * 比 #266 更严：源标签必须是 fallback（用户/扩展写下的名字不参与），现存标题必须逐字等于**旧口径**
 * （含 thinking）兜底，本次读到的兜底必须来自 user 正文且与现存标题不同——三条同时成立才改写。
 */
function repairedThinkingFallbackTitle(lockedTitle: string, probe: { fallbackName?: string; fallbackKind?: SessionTitleFallbackKind; legacyFallbackName?: string }): string | undefined {
	if (probe.fallbackKind !== "user") return undefined;
	const fallback = catalogDisplayTitle(probe.fallbackName);
	if (!fallback) return undefined;
	const locked = normalizeFingerprintTitle(lockedTitle);
	if (!locked || normalizeFingerprintTitle(fallback) === locked) return undefined;
	if (normalizeFingerprintTitle(probe.legacyFallbackName) !== locked) return undefined;
	return fallback;
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

export function isSessionLocator(value: unknown): value is SessionLocator {
	if (!isRecord(value)) return false;
	if (value.kind === "local") {
		// 本地 locator 不得携带 hostId：那是一条扫描看不见的主机引用（与项目域同一判据）。放行会把
		// 「指向某主机」读成「本地会话 ⇒ 没有引用」，退役流程据此硬删仍被引用的主机。
		if (value.hostId !== undefined) return false;
		return (
			(value.environment === "native" || value.environment === "wsl") &&
			(value.filePath === undefined || (typeof value.filePath === "string" && value.filePath.length <= 4096)) &&
			(value.wslDistro === undefined || (typeof value.wslDistro === "string" && value.wslDistro.length <= 256)) &&
			(value.wslUser === undefined || (typeof value.wslUser === "string" && value.wslUser.length <= 256))
		);
	}
	if (value.kind !== "ssh") return false;
	// ssh 分支的唯一判据在 shared `readSshSessionLocator`（hostId 与项目域同一个权威值域）。
	// 这里不再写第二套规则：catalog 读取、登记写入与主机引用扫描同判，才不会出现
	// 「codec 放行、扫描抛错」这种同一记录两种结论。
	return readSshSessionLocator(value) !== undefined;
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

/** 远端 Session 的稳定身份（G3 冻结设计第 4/5 条）：hostId + 相对会话根的 POSIX 路径。 */
export type RemoteSessionIdentity = {
	hostId: string;
	/** 远端文件的稳定身份：相对会话根的 POSIX 路径（含 .jsonl）。 */
	remoteSessionId: string;
	/** 本次冻结与 remoteSessionId 同值；独立保留是为了让「以后变成远端绝对路径」不改匹配契约。 */
	remotePath: string;
};

/** 登记一次远端发现的入参；updatedAt 用远端文件 mtime（排序与「最后活动时间」）。 */
export type RemoteSessionRegistrationInput = {
	projectId: string;
	hostId: string;
	remoteSessionId: string;
	remotePath: string;
	/** 暂定标题（文件名 stem）；只在新建、或条目尚未被确认时写入。 */
	title: string;
	/** 远端文件 mtime。 */
	updatedAt: number;
};

export type RemoteSessionRegistration = { record: SessionRecord; created: boolean };

/**
 * 稳定 id 匹配的**单条判定**（计划 §5.3 / G3 冻结设计第 5 条）：这条 locator 是不是这次发现的这个远端会话？
 * 返回命中的依据字段（给测试断言匹配顺序用），不命中返回 undefined。
 *
 * remoteSessionId 是远端文件的稳定身份，优先于 remotePath（后者会随 move/archive 变化）。
 */
export function remoteSessionLocatorMatch(locator: SessionLocator | undefined, identity: RemoteSessionIdentity): "remoteSessionId" | "remotePath" | undefined {
	if (locator?.kind !== "ssh" || locator.hostId !== identity.hostId) return undefined;
	if (locator.remoteSessionId !== undefined && locator.remoteSessionId === identity.remoteSessionId) return "remoteSessionId";
	if (locator.remotePath !== undefined && locator.remotePath === identity.remotePath) return "remotePath";
	return undefined;
}

/**
 * 两遍扫描的稳定 id 匹配：**先按 (hostId, remoteSessionId) 命中整表，再按 (hostId, remotePath) 命中整表**，
 * 都没有才返回 undefined（调用方据此新建）。
 *
 * 为什么不是单遍 first-match：表里靠前的条目可能只有 remotePath 命中（旧记录还没回填 remoteSessionId），
 * 而靠后的条目才是这次会话的 remoteSessionId 命中。单遍会把这次发现挂到错误记录上——表现为同一个远端
 * 会话在侧栏出现两条，或者 stable id 在两次扫描之间漂移。这才是本函数存在的理由，也是它必须被单测锁住的地方。
 */
export function findRemoteSessionEntry(entries: readonly SessionCatalogEntry[], identity: RemoteSessionIdentity): SessionCatalogEntry | undefined {
	const byRemoteSessionId = entries.find((entry) => remoteSessionLocatorMatch(entry.locator, identity) === "remoteSessionId");
	if (byRemoteSessionId) return byRemoteSessionId;
	return entries.find((entry) => remoteSessionLocatorMatch(entry.locator, identity) === "remotePath");
}

/** ssh 分支的 locator 类型；用 Extract 而不是再抄一遍结构，避免与 shared 契约漂移。 */
type SshSessionLocator = Extract<SessionLocator, { kind: "ssh" }>;

/**
 * 登记入参 → 稳定身份（hostId 与两个路径字段的搬运只发生在这里）。
 * 单独抽成具名函数而不是在闭包里就地拼对象：host 引用审计（remoteHostCrossStoreContract）按「具名函数」
 * 归属引用来源，匿名闭包里的 hostId 会变成 <unscoped>，让审计失去可归责的名字。
 */
function remoteSessionIdentity(input: RemoteSessionRegistrationInput): RemoteSessionIdentity {
	return { hostId: input.hostId, remoteSessionId: input.remoteSessionId, remotePath: input.remotePath };
}

/** 稳定身份 → ssh locator（唯一构造点，理由同上）。 */
function remoteSessionLocator(identity: RemoteSessionIdentity): SshSessionLocator {
	return { kind: "ssh", hostId: identity.hostId, remoteSessionId: identity.remoteSessionId, remotePath: identity.remotePath };
}

/**
 * 同主机 + 同一条远端会话文件。
 *
 * 判据刻意只用 `remotePath`：远端 runtime 只上报这一条绝对路径（`remoteSessionId` 是相对会话根的
 * 推导结果，属于登记侧的产物），而 `ensureRemoteSession` 命中已有条目时会把两种写法收敛成上报值 ——
 * 所以「同一远端会话」在这里就是「同一主机上的同一个远端文件」。
 */
function sameRemoteSessionPath(locator: SessionLocator | undefined, hostId: string, remotePath: string): boolean {
	return locator?.kind === "ssh" && locator.hostId === hostId && locator.remotePath === remotePath;
}

/** ssh locator 的身份字段比较（不含 alias：本批不读也不写 alias）。 */
function sameSshLocator(left: SessionLocator | undefined, right: SshSessionLocator): boolean {
	if (left === undefined || left.kind !== "ssh") return false;
	return left.hostId === right.hostId && left.remoteSessionId === right.remoteSessionId && left.remotePath === right.remotePath;
}

/**
 * 入参的协议形状校验：hostId 与持久化判据同源（shared `readSshSessionLocator` 的 UUID 值域），
 * 非法一律拒绝而不是截断。两个身份字段的长度上界也由 shared 把关，本函数只补「登记入参必须显式
 * 给出、且不含控制字节」——非 UUID 的 hostId 永远命中不了任何主机，不能借这条写入路径落盘。
 */
function isRemoteSessionRegistrationInput(value: RemoteSessionRegistrationInput): boolean {
	const { projectId, hostId, remoteSessionId, remotePath, title } = value ?? {};
	if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256) return false;
	const locator = readSshSessionLocator({ kind: "ssh", hostId, remoteSessionId, remotePath });
	if (!locator) return false;
	if (locator.remoteSessionId === undefined || locator.remoteSessionId.length === 0 || CONTROL_CHARS_RE.test(locator.remoteSessionId)) return false;
	if (locator.remotePath === undefined || locator.remotePath.length === 0 || CONTROL_CHARS_RE.test(locator.remotePath)) return false;
	return typeof title === "string";
}

/** 远端定位字段一旦变化就必须落盘；本地镜像字段非空说明读入路径没清干净，也要写回修掉。 */
function remoteSessionEntryChanged(entry: SessionCatalogEntry, locator: SshSessionLocator, title: string | undefined, updatedAt: number): boolean {
	return (
		!sameSshLocator(entry.locator, locator) ||
		(title !== undefined && entry.title !== title) ||
		entry.updatedAt !== updatedAt ||
		entry.filePath !== undefined ||
		entry.originKey !== undefined ||
		entry.piSessionId !== undefined ||
		entry.wslDistro !== undefined ||
		entry.wslUser !== undefined ||
		entry.parentSessionPath !== undefined
	);
}

/** 控制字节：与 shared 的 SessionLocator 校验同域（路径里出现即非法）。 */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function equalModel(left?: SessionModelPreference, right?: SessionModelPreference): boolean {
	return left?.provider === right?.provider && left?.modelId === right?.modelId;
}

/** 各 kind 的合法 locator 键：补丁只能携带该 kind 认识的字段，未知键一律拒绝（不许借端口注入脏字段）。 */
const SESSION_LOCATOR_KEYS: Record<SessionLocator["kind"], readonly string[]> = {
	local: ["kind", "environment", "filePath", "wslDistro", "wslUser"],
	ssh: ["kind", "hostId", "remotePath", "remoteSessionId", "remotePathAliases"],
};

/**
 * 端口补丁的整批形状（设计 §4.4）：形状错误 = 这次调用无法解释 ⇒ 稳定码"结果未知"（收敛侧绝不能
 * 当成"已应用"）。补丁语义非法（不是 ssh→ssh、不止 hostId 变化）不在这里抛，而是逐条判 changed。
 */
function readHostRebindPatches(patches: readonly HostRebindRecordPatch[]): readonly HostRebindRecordPatch[] {
	if (!Array.isArray(patches) || patches.length > MAX_REBIND_PATCHES) throw new Error(REBIND_UNKNOWN_OUTCOME);
	for (const patch of patches) {
		if (!isRecord(patch) || !isHostRebindRecordId(patch.recordId) || typeof patch.beforeLocator !== "string" || typeof patch.afterLocator !== "string") throw new Error(REBIND_UNKNOWN_OUTCOME);
	}
	return patches;
}

/**
 * 解析补丁里的 locator 字符串：必须是 catalog 认可的 locator，且**就是**它的规范 JSON。
 * 规范形态是端口契约（`HostRebindJournal.canonicalHostLocatorJson`）：写进去的 locator 必须能原样读回来，
 * 否则收敛侧重放时永远看不到 `afterLocator`，事务会卡在 STALE_PLAN。
 */
function parseCanonicalSessionLocator(value: string): SessionLocator | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || (parsed.kind !== "local" && parsed.kind !== "ssh")) return undefined;
	const kind: SessionLocator["kind"] = parsed.kind;
	if (!Object.keys(parsed).every((key) => SESSION_LOCATOR_KEYS[kind].includes(key))) return undefined;
	if (!isSessionLocator(parsed)) return undefined;
	return canonicalHostLocatorJson(parsed) === value ? parsed : undefined;
}

/**
 * rebind 补丁只允许把 ssh locator 的 `hostId` 换成另一个（设计 §4.4）：`remotePath` / `remoteSessionId` /
 * `remotePathAliases` 必须原样保留。不合法 ⇒ 该记录判 changed（收敛侧 STALE_PLAN），绝不写盘 ——
 * 这个端口不是通用 locator 改写入口，也不是"顺手修点别的"的地方。
 */
function hostRebindTargetLocator(beforeLocator: string, afterLocator: string): SessionLocator | undefined {
	const before = parseCanonicalSessionLocator(beforeLocator);
	const after = parseCanonicalSessionLocator(afterLocator);
	if (!before || !after || before.kind !== "ssh" || after.kind !== "ssh") return undefined;
	if (before.hostId === after.hostId) return undefined;
	return canonicalHostLocatorJson({ ...before, hostId: after.hostId }) === canonicalHostLocatorJson(after) ? after : undefined;
}

/**
 * 被拒绝的批次（任一条 missing/changed ⇒ 整批不写，INV-9）：没有任何记录被写入，所以"本来能写"的
 * 那几条也只能报 changed —— 端口不允许在没写盘的情况下报 applied（收敛侧把 changed 判为 STALE_PLAN）。
 */
function refusedHostRebind(patches: readonly HostRebindRecordPatch[], outcomes: readonly HostRebindRecordOutcome[]): readonly HostRebindRecordResult[] {
	return patches.map((patch, index) => ({ recordId: patch.recordId, outcome: outcomes[index] === "applied" ? "changed" : outcomes[index] }));
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
	readonly code = SESSION_CATALOG_NEEDS_REPAIR;

	constructor() {
		super(`${SESSION_CATALOG_NEEDS_REPAIR}: catalog cannot be safely loaded`);
		this.name = "SessionCatalogRecoveryError";
	}
}

export class SessionCatalog implements HostRebindStorePort {
	private entries: SessionCatalogEntry[] = [];
	private readonly locatorRouter = new SessionLocatorRouter();
	/** #354 归并别名（被吸收的历史稳定 ID → 现存 ID）：随 catalog 快照一起落盘，重启后重建。 */
	private mergedIdAliases = new Map<string, string>();
	/** Runtime-only records share the catalog lookup contract without durable storage. */
	private transientEntries = new Map<string, SessionCatalogEntry>();
	/** 侧栏删除过的 DSH host 会话：刷新/自动导入跳过；手动导入会清掉墓碑。 */
	private dismissedDshSessionIds = new Set<string>();
	/** 侧栏「移除记录」过的远端会话（键见 remoteDismissalKey）：远端扫描不得再列为「可导入」。 */
	private dismissedRemoteSessionIds = new Set<string>();
	/** 远端会话的本机归档索引（键 = 本机 sessionId）：远端归档的列表与恢复都只靠它。 */
	private archivedRemoteSessions = new Map<string, ArchivedRemoteSessionEntry>();
	private loaded = false;
	private writeQueue: Promise<void> = Promise.resolve();
	/** 启动期归一化写盘（见 persistLoadedNormalization）：不进 writeQueue，flushPendingWrites 单独等。 */
	private initializationWrite: Promise<void> | undefined;
	/** 退出封盘：置位后不再起新写事务，见 flushPendingWrites。 */
	private sealed = false;
	private skipNextBackup = false;
	/** 磁盘快照的 revision（INV-5a）：v1 文件没有该字段 ⇒ 读成 0；每次写事务后等于刚写入的值。 */
	private revision = 0;
	private needsRepair = false;
	private readonly referenceGuard: RemoteReferenceWriteGuard | undefined;

	private identityContext: SessionCatalogContext;

	/** 跨进程写锁：与 catalog 同一个根（`filePath` 是注入的，用 getter 派生以免字段初始化顺序踩坑）。 */
	private get rootDir(): string {
		return dirname(this.filePath);
	}

	private get lockPath(): string {
		return `${this.filePath}.lock`;
	}

	/** 会话活性探针（由 SessionRuntimeCoordinator 注入）：有活跃运行时绑定的会话，
	 *  其 filePath 指向的 jsonl 可能尚未由 pi 落盘，外部删除清理不得误剔。 */
	private sessionLivenessProbe?: (sessionId: string) => boolean;

	constructor(
		private readonly filePath: string,
		identityContext: SessionCatalogContext = {},
		private readonly resolveFilePath?: SessionFilePathResolver,
		private readonly fetchTitle?: SessionTitleFetcher,
		options: { readonly referenceGuard?: RemoteReferenceWriteGuard } = {},
	) {
		this.identityContext = { ...identityContext };
		this.referenceGuard = options.referenceGuard;
	}

	setIdentityContext(context: SessionCatalogContext): void {
		this.identityContext = { ...context };
	}

	/** 注入活性探针（main 装配时一次性接线）；传 undefined 解除。 */
	setSessionLivenessProbe(probe: ((sessionId: string) => boolean) | undefined): void {
		this.sessionLivenessProbe = probe;
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		const read = await this.readCatalogState();
		let locatorNormalizationNeeded = false;
		if (read.kind === "ok") {
			this.entries = read.entries;
			this.dismissedDshSessionIds = read.dismissedDshSessionIds;
			this.dismissedRemoteSessionIds = read.dismissedRemoteSessionIds;
			this.archivedRemoteSessions = read.archivedRemoteSessions;
			this.revision = read.revision;
			this.skipNextBackup = read.skipNextBackup;
			locatorNormalizationNeeded = read.locatorNormalizationNeeded;
		} else if (read.kind === "empty") {
			// 首次运行：两个文件都不存在，不是损坏。
			this.entries = [];
			this.dismissedDshSessionIds = new Set();
			this.dismissedRemoteSessionIds = new Set();
			this.archivedRemoteSessions = new Map();
		} else {
			// unsupported / unreadable：启动仍可用，但绝不把读不出来的快照当成"空 catalog"写回去。
			this.needsRepair = true;
			this.entries = [];
			this.dismissedDshSessionIds = new Set();
			this.dismissedRemoteSessionIds = new Set();
			this.archivedRemoteSessions = new Map();
			if (read.kind === "unsupported") {
				void getAppLogger()?.error("session-catalog", "Catalog format is unsupported", { primary: read.error.message });
			} else {
				void getAppLogger()?.error("session-catalog", "Catalog and backup both failed to load", { primary: read.primary, backup: read.backup });
			}
		}
		// Draft 只代表当前进程中的“尚未发送”编辑面：没有用户消息就没有
		// 可恢复的 Pi session。重启时清掉它们（仅限 pi 后端），避免空 Agent 在
		// 历史列表中永久残留。
		// 例外：DSH 会话的草稿必须保留。DSH 的 host 会话数据由 $DSH_HOME 持久化，
		// catalog 只是 id 映射；即使“创建后激活链路未走完”（attachRuntime 未把
		// status 置 active），重启后用户仍应在侧栏看到并重新激活它。若在此清掉，
		// host 侧会话会变成孤儿且无法从侧栏访问。带 dshSessionId 的异常中间态同样保留。
		/** 本次加载是否改动了内容：决定要不要走一次归一化写事务（没改就一个字节都不写）。 */
		let migrated = false;
		// ACP 同理（StaleDraftReaper 的 acp 豁免、Coordinator 激活失败兑底的
		// draft+acpSessionId 中间态都依赖该保留语义，清单除即 agent 侧孤儿化）。
		const staleDrafts = this.entries.filter((entry) => entry.status === "draft" && entry.backend !== "dsh" && entry.backend !== "acp");
		if (staleDrafts.length > 0) {
			this.entries = this.entries.filter((entry) => entry.status !== "draft" || entry.backend === "dsh" || entry.backend === "acp");
			migrated = true;
		}

		// 兼容旧数据：pi 默认 sessionName（JSONL 文件名时间戳）曾被 onTitleChanged 写进 catalog。
		// 侧栏会显示一排日期，且 refreshAutoTitle 不再把首条消息当标题。加载时清成 Untitled。
		const timestampTitles = this.entries.filter((entry) => looksLikePiSessionFileStem(entry.title));
		if (timestampTitles.length > 0) {
			for (const entry of timestampTitles) entry.title = "Untitled";
			migrated = true;
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
			migrated = true;
		}

		// 路径与派生身份键一起修复：#354 的旧 POSIX 键是全小写，即使绝对路径
		// 本身没变也需要重算。启动时归并已产生的重复索引，保留原始会话 ID；
		// 标题冲突用注入的会话名读取做有界权威证据仲裁（无证据则整组保留），
		// 被吸收的历史 ID 记入 mergedSessionIds，供持久化引用迁移。
		const repaired = await repairSessionCatalogIdentities(this.entries, this.resolveFilePath, (entry) => this.originKeyForEntry(entry), this.fetchTitle);
		if (repaired) {
			this.entries = repaired;
			migrated = true;
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
			migrated = true;
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
			migrated = true;
		}
		// 兼容旧数据：ACP 会话曾被 pi 分支 attach（filePath/piSessionId 落盘）时同理污染；
		// ACP 历史在 agent 侧，PiDeck 无本地会话文件，一律清除。
		const pollutedAcp = this.entries.some((entry) => entry.backend === "acp" && (Boolean(entry.filePath) || Boolean(entry.piSessionId)));
		if (pollutedAcp) {
			for (const entry of this.entries) {
				if (entry.backend !== "acp") continue;
				delete entry.filePath;
				delete entry.piSessionId;
				entry.originKey = undefined;
			}
			migrated = true;
		}
		// 以上归一化只在内存里做完了；**落盘**交给下面这一次写事务：它只在磁盘仍是我们读到的那一版
		// （revision 令牌相等）时才把内存结果写回，否则放弃本次写（下次启动重试）。若照内存快照直接
		// 整份重写，就会把另一个实例刚提交的记录一起丢掉（INV-5a）。
		this.loaded = true;
		if (migrated || locatorNormalizationNeeded || this.skipNextBackup) {
			// 记下这次写：它走自己的锁、不进 writeQueue，退出路径要能单独等它（不然关窗口即截断）。
			const initializationWrite = this.persistLoadedNormalization();
			this.initializationWrite = initializationWrite;
			try {
				await initializationWrite;
			} catch (error) {
				// 修复是 best-effort：内存已生效，下一次启动仍会重试；写不进去不能挡住启动。
				void getAppLogger()?.warn("session-catalog", "Catalog normalization write skipped", {
					cause: error instanceof Error ? error.message : String(error),
				});
			}
		}
		// 归并别名索引在 load 末尾统一重建：修复与各项存量迁移都已落定，
		// get/update/remove/runtime attach 从此统一按现存 ID 归一化。
		this.rebuildMergedIdAliases();
	}

	listEntries(): SessionCatalogEntry[] {
		this.assertLoaded();
		return [...this.entries.map(cloneEntry), ...Array.from(this.transientEntries.values(), cloneEntry)];
	}

	get(id: string): SessionCatalogEntry | undefined {
		this.assertLoaded();
		const transient = this.transientEntries.get(id);
		if (transient) return cloneEntry(transient);
		const canonical = this.resolveSessionId(id);
		const entry = this.entries.find((candidate) => candidate.id === canonical);
		return entry ? cloneEntry(entry) : undefined;
	}

	/** 把已归并的历史稳定 ID 归一化为现存会话 ID；未知 ID 原样返回。
	 *  持久化引用（settings 置顶 / 渲染层 Tab 置顶）在迁移完成前的迟到请求也走这里，
	 *  不能因为拿到旧 ID 就报「会话不存在」或在旧 ID 上另起一个 runtime。 */
	resolveSessionId(id: string): string {
		this.assertLoaded();
		return this.mergedIdAliases.get(id) ?? id;
	}

	/** 重建归并别名索引（条目集合变化后调用；别名只在启动修复时新增，但删除会让旧目标失效）。 */
	private rebuildMergedIdAliases(): void {
		this.mergedIdAliases = buildSessionIdAliasMap(this.entries);
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

	/**
	 * 这条远端会话是否已被用户「移除记录」（墓碑命中）。远端扫描据此把它从「可导入」列表里排除。
	 * 只读查询，不排队写（与 listDismissedDshSessionIds 同口径）。
	 */
	isRemoteSessionDismissed(hostId: string, remoteSessionId: string): boolean {
		this.assertLoaded();
		return this.dismissedRemoteSessionIds.has(remoteDismissalKey(hostId, remoteSessionId));
	}

	/**
	 * 「移除记录」远端会话时记下墓碑：远端文件仍在，但下次远端扫描不得再把它列为「可导入」。
	 * 幂等（重复移除不产生第二次写事务）。**不碰远端**：这里只落本机 catalog 的一个集合。
	 */
	async rememberDismissedRemoteSession(input: DismissedRemoteSessionEntry): Promise<void> {
		this.assertLoaded();
		const hostId = input?.hostId?.trim();
		const remoteSessionId = input?.remoteSessionId?.trim();
		// 身份不明就不记：一个残缺的墓碑会静默地少列（或错列）一条远端会话。
		if (!hostId || !remoteSessionId) return;
		const key = remoteDismissalKey(hostId, remoteSessionId);
		await this.enqueueMutation((entries) => {
			if (this.dismissedRemoteSessionIds.has(key)) {
				return { value: undefined, changed: false };
			}
			this.dismissedRemoteSessionIds.add(key);
			return { value: undefined, changed: true };
		});
	}

	/**
	 * 远端归档数据被**永久删除**成功后清掉同一身份的墓碑（Phase 5）。
	 *
	 * 墓碑的语义是「远端文件还在，但用户把它从列表移除了，别再自动导入」。永久删除之后远端
	 * 文件已经不存在，这条墓碑不再有保护对象；留着只会在用户以后重新创建同路径会话时造成
	 * 「怎么又导不进来」的幽灵状态。幂等：没有墓碑就是 no-op（不产生写事务）。
	 */
	async forgetDismissedRemoteSession(input: DismissedRemoteSessionEntry): Promise<void> {
		this.assertLoaded();
		const hostId = input?.hostId?.trim();
		const remoteSessionId = input?.remoteSessionId?.trim();
		if (!hostId || !remoteSessionId) return;
		const key = remoteDismissalKey(hostId, remoteSessionId);
		await this.enqueueMutation(() => {
			if (!this.dismissedRemoteSessionIds.has(key)) return { value: undefined, changed: false };
			this.dismissedRemoteSessionIds.delete(key);
			return { value: undefined, changed: true };
		});
	}

	/**
	 * 归档一条远端会话：记下本机归档索引（列表与恢复的唯一依据）。
	 *
	 * 调用时机是**远端移动成功之后**（见 sessionIpc 的远端归档分支）：远端失败时本机状态必须原样不动，
	 * 否则索引会声称一个并没有发生的归档。幂等：同一 sessionId 重复记就是覆盖那一条。
	 */
	async rememberArchivedRemoteSession(input: ArchivedRemoteSessionEntry): Promise<void> {
		this.assertLoaded();
		const entry = readArchivedRemoteSessionEntry(input);
		// 残缺条目就不记：一条缺路径/缺身份的索引既列不出也恢复不了，只会在列表里多一个死行。
		if (entry === undefined) return;
		await this.enqueueMutation((entries) => {
			const previous = this.archivedRemoteSessions.get(entry.sessionId);
			if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(entry)) {
				return { value: undefined, changed: false };
			}
			this.archivedRemoteSessions.set(entry.sessionId, entry);
			return { value: undefined, changed: true };
		});
	}

	/**
	 * 这条远端会话的归档条目（不存在返回 undefined）：取消归档的恢复身份。
	 * 只读查询，不排队写（与 isRemoteSessionDismissed 同口径）。
	 */
	getArchivedRemoteSession(sessionId: string): ArchivedRemoteSessionEntry | undefined {
		this.assertLoaded();
		const entry = this.archivedRemoteSessions.get(sessionId);
		return entry === undefined ? undefined : { ...entry };
	}

	/** 当前全部远端归档条目（列表 IPC 的数据源；远端归档区**不扫描**，否则列一次归档就多一次远端往返）。 */
	listArchivedRemoteSessions(): ArchivedRemoteSessionEntry[] {
		this.assertLoaded();
		return [...this.archivedRemoteSessions.values()].map((entry) => ({ ...entry }));
	}

	/**
	 * 取消归档成功后摘掉索引条目，并返回被摘掉的那一条（调用方要拿它重建本机记录）。
	 * 不存在时返回 undefined（幂等：远端已移回、索引已被其他路径清掉的情形不算失败）。
	 */
	async forgetArchivedRemoteSession(sessionId: string): Promise<ArchivedRemoteSessionEntry | undefined> {
		this.assertLoaded();
		return await this.enqueueMutation((_entries) => {
			const entry = this.archivedRemoteSessions.get(sessionId);
			if (entry === undefined) return { value: undefined, changed: false };
			this.archivedRemoteSessions.delete(sessionId);
			return { value: { ...entry }, changed: true };
		});
	}

	createAnonymous(input: { projectId: string; title: string; environment: SessionEnvironment; wslDistro?: string; wslUser?: string; model?: SessionModelPreference; thinkingLevel?: string }): SessionRecord {
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
			wslDistro: input.environment === "wsl" ? (input.wslDistro ?? this.identityContext.wslDistro) : undefined,
			wslUser: input.environment === "wsl" ? (input.wslUser ?? this.identityContext.wslUser) : undefined,
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

	/**
	 * Host-rebind read port（设计 §4.4）：逐条返回记录的当前 locator（规范 JSON）；记录不存在、
	 * 或该记录本来就没有位置（无文件草稿 / dsh / imagegen / 运行期 transient）时按契约返回缺省 locator。
	 *
	 * 权威是**磁盘**（INV-5a / §1.7 第 8 条）：内存快照可能落后于另一个实例已提交的写入，拿它声明
	 * before/after 会让写端口“看不见”别人改过的记录并把它整份覆盖（CE-4）。这里刻意不碰内存：读端口
	 * 无副作用，内存对齐由写事务（enqueueMutation）完成。本函数内没有 await 到内部状态，整批读仍是
	 * 同一个一致性视图。needs-repair / 未加载都不能答成“没有记录”（那会被收敛侧读成“记录已删除”）
	 * ⇒ 直接抛稳定码，fail closed。
	 */
	async readHostRecordLocators(recordIds: readonly string[]): Promise<readonly HostRebindRecordSnapshot[]> {
		this.assertHostRebindUsable();
		assertHostRebindRecordIds(recordIds);
		// 权威是**磁盘**（INV-5a / §1.7 第 8 条）：内存快照可能落后于另一个实例（或本进程那次“写抛异常但已落地”）
		// 已提交的写入，拿它声明 before/after 会让写端口“看不见”别人改过的记录并把它整份覆盖（CE-4）。
		// 读与写走同一个进程内队列，并把内存对齐到刚读到的内容：读不能与在飞的写事务交错，
		// 也不能让旧快照继续当权威。
		const operation = this.writeQueue
			.catch(() => undefined)
			.then(async () => {
				let entries: SessionCatalogEntry[];
				try {
					entries = (await this.readFreshSnapshot()).state;
				} catch {
					throw new Error(SESSION_CATALOG_NEEDS_REPAIR);
				}
				return recordIds.map((recordId) => {
					const entry = entries.find((candidate) => candidate.id === recordId);
					const locator = entry ? this.sessionLocatorForEntry(entry) : undefined;
					return locator ? { recordId, locator: canonicalHostLocatorJson(locator) } : { recordId };
				});
			});
		this.writeQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/**
	 * Host-rebind write port（设计 §4.4）：整批一次原子写（`enqueueMutation` → `writeSnapshot`），
	 * 逐记录 before/after CAS。`txId` 只用于日志对账，catalog 不落它（journal 才是事务记录）。
	 *
	 * - **全有或全无**（INV-9）：任一条 missing/changed 就整批不写；未写入的批次里没有任何记录可以报
	 *   `applied` —— 本来能写的那几条按 changed 报出（收敛侧映射为 STALE_PLAN：这个计划已不成立）。
	 * - **幂等重放**：记录已是 `afterLocator` ⇒ `already-applied`，不产生第二次写。
	 * - **locator 写入口**只有 `setLocalSessionFilePath` / `normalizeEntryLocator`：ssh→ssh 走后者，
	 *   由它同步 filePath/originKey/piSessionId/wslDistro/wslUser/parentSessionPath 的清空。直接改
	 *   `entry.locator` 会留下本地镜像字段，让 findByFilePath / originKeyForEntry / sessionLocatorForEntry
	 *   三条链路各说各话。
	 * - 结果条数恒等于补丁条数（收敛侧把"少返结果"判为 `REMOTE_HOST_REBIND_UNKNOWN_OUTCOME`）。
	 */
	async applyHostRebind(txId: string, patches: readonly HostRebindRecordPatch[]): Promise<readonly HostRebindRecordResult[]> {
		this.assertHostRebindUsable();
		const planned = readHostRebindPatches(patches);
		let results: readonly HostRebindRecordResult[];
		try {
			results = await this.enqueueMutation((entries) => {
				const outcomes: HostRebindRecordOutcome[] = [];
				const pending: { readonly index: number; readonly locator: SessionLocator }[] = [];
				for (const patch of planned) {
					const index = entries.findIndex((candidate) => candidate.id === patch.recordId);
					if (index < 0) {
						// 记录不存在 ⇒ missing（收敛侧转 REMOTE_HOST_REBIND_RECORD_MISSING，INV-6：绝不重建）。
						outcomes.push("missing");
						continue;
					}
					const current = this.sessionLocatorForEntry(entries[index]);
					const currentLocator = current ? canonicalHostLocatorJson(current) : undefined;
					const target = currentLocator === undefined ? undefined : hostRebindTargetLocator(patch.beforeLocator, patch.afterLocator);
					if (currentLocator === undefined || target === undefined) {
						// 记录没有位置，或补丁不是"只换 hostId 的 ssh→ssh"：逐记录判 changed，绝不写盘。
						outcomes.push("changed");
						continue;
					}
					if (currentLocator === patch.afterLocator) {
						outcomes.push("already-applied");
						continue;
					}
					if (currentLocator !== patch.beforeLocator) {
						outcomes.push("changed");
						continue;
					}
					outcomes.push("applied");
					pending.push({ index, locator: target });
				}
				if (outcomes.some((outcome) => outcome !== "applied" && outcome !== "already-applied")) return { value: refusedHostRebind(planned, outcomes), changed: false };
				for (const item of pending) {
					// 只改 locator，再交给唯一的 ssh 分支镜像同步（normalizeEntryLocator，见其注释）。
					entries[item.index] = normalizeEntryLocator({ ...entries[item.index], locator: item.locator });
				}
				return {
					value: planned.map((patch, index) => ({ recordId: patch.recordId, outcome: outcomes[index] })),
					changed: pending.length > 0,
				};
			});
		} catch (error) {
			throw this.asHostRebindError(error);
		}
		void getAppLogger()?.info("session-catalog", "Session catalog rebound to a new host", { txId, applied: results.filter((result) => result.outcome === "applied").length });
		return results;
	}

	/** 端口边界只允许稳定码：needs-repair / 未加载都不能被读成"记录不存在"或"没有补丁"。 */
	private assertHostRebindUsable(): void {
		if (this.needsRepair) throw new Error(SESSION_CATALOG_NEEDS_REPAIR);
		if (!this.loaded) throw new Error(REBIND_UNKNOWN_OUTCOME);
	}

	/**
	 * 端口边界只允许稳定码：needs-repair ⇒ catalog 自己的码；其余（写盘 errno 等）可能已落地也可能
	 * 没落地，一律算"结果未知" —— 收敛侧据此不 retire、保留 journal，下次 resume 幂等重跑。
	 */
	private asHostRebindError(error: unknown): Error {
		if (this.needsRepair) return new Error(SESSION_CATALOG_NEEDS_REPAIR);
		const message = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : undefined;
		if (message === SESSION_CATALOG_NEEDS_REPAIR) return new Error(message);
		return new Error(REBIND_UNKNOWN_OUTCOME);
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
		/** 会话来源渠道（微信/飞书等外部连接）：由 IM 桥在注册会话时写入，落库后侧栏显示渠道标志。 */
		channel?: SessionChannel;
		/**
		 * 命令层权威标题（fork/clone/copy 专用）：命令刚把 (fork) 后缀名物理写进会话文件，
		 * 授权本次注册把标题当作权威名落库（见下方覆盖规则）。
		 */
		titleAuthority?: "command";
		/** fork/clone 产物注册时直接标记（parentSession 链接已由 pi 写入文件头，此处同源标记）。 */
		forked?: boolean;
		/** fork/clone 产物继承源会话的模型偏好与思考档位：子会话 JSONL 里没有新的 model_change，扫描回读拿不到，重启后模型选择器会空。 */
		model?: SessionModelPreference;
		thinkingLevel?: string;
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
					channel: input.channel,
					forked: input.forked,
					model: cloneModelPreference(input.model),
					thinkingLevel: input.thinkingLevel,
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
				// 渠道标志只增补不清空：同一文件后续被普通扫描命中时不带渠道信息，
				// 直接覆盖会让微信/飞书会话的标志在下次扫描后消失。
				if (input.channel) entry.channel = input.channel;
				// 命令层标题覆盖规则（fork/clone/copy）：命令刚刚把 (fork) 名写进会话文件，但扫描
				// 可能抢在改名落盘前先索引了新文件，用正文兜底（首条消息，或复制进来的父会话名）
				// 把标题锁成 fallback —— 而大文件只读头/尾窗口，rename 追加的 session_info 很快被
				// 后续消息推出尾窗，fallback→权威名的升级再也触发不了，侧栏就永久停在首条消息
				// 正文上、也看不到 (fork)（2026-10-11 复现）。
				// 写入范围：未确认（undefined）或内容派生的猜测（fallback）才允许覆盖；用户改名
				// （manual）/扩展自动名（auto）/存量 legacy 一律不动；占位名（Untitled/时间戳
				// stem）不往条目里写。
				if (input.titleAuthority === "command") {
					const commandTitle = catalogDisplayTitle(input.title);
					const currentOrigin = resolveTitleOrigin(entry);
					if (commandTitle && !isPlaceholderCatalogTitle(commandTitle) && commandTitle !== entry.title && (currentOrigin === undefined || currentOrigin === "fallback")) {
						entry.title = commandTitle;
						assignTitleOrigin(entry, "manual");
					}
				}
				// fork 标记只增补不清空：同一文件可能先以普通扫描注册、后经 fork 注册逻辑走到这里。
				if (input.forked) entry.forked = true;
				// 模型/思考档位继承同样只补空值：fork 产物常被后台扫描抢先登记（扫描只能从 JSONL 回读，
				// 子会话没有新的 model_change 就是空的），命令层带来的源会话选择必须补进去，否则
				// 子会话没有 model → 底栏显示「-」、激活不重放模型，pi fork 的静默回落就成了用户
				// 看不见的另一个模型（issue #370）。已有显式选择（用户选择器/扫描回读）不覆盖。
				if (!entry.model && input.model) entry.model = cloneModelPreference(input.model);
				if (!entry.thinkingLevel && input.thinkingLevel) entry.thinkingLevel = input.thinkingLevel;
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
		/** 第 12 步：WSL 项目按自己的档案记录身份；缺省时回退 identityContext（兼容旧调用）。 */
		wslDistro?: string;
		wslUser?: string;
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
		/** ACP 工具预选（AcpToolConfig.id）：backend=acp 草稿期选哪个 CLI。 */
		acpToolId?: string;
		/**
		 * 外部连接渠道（微信/飞书桥建的会话）。与 titleOrigin 独立：渠道只决定标志，
		 * 标题所有权由 titleOrigin 决定（IM 桥想要自动命名就不要传 titleOrigin）。
		 */
		channel?: SessionChannel;
		/** 侧边任务会话（右侧抽屉「侧边任务」面板持有）：与 channel 一样只是归属标志，不改变会话身份与运行时语义。 */
		sideTask?: boolean;
		/** 外部（dsh-web 等）会话导入：host 会话已存在，条目直接置 active（重启不清理）。 */
		dshSessionId?: string;
		/**
		 * fork 产物标记（DSH fork/clone 新建条目的身份元数据；pi 侧同名标记来自文件头探测）。
		 * (fork) 标题后缀已写进标题本身，这里只保留「是不是 fork 出来的会话」供列表/导航判断。
		 */
		forked?: boolean;
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
						(input.forked === true && existing.forked !== true) ||
						existing.status !== "active" ||
						// mtime 变化也落盘：修正历史被顶高的 updatedAt，否则排序永远错
						existing.updatedAt !== (input.updatedAt ?? now);
					existing.projectId = input.projectId;
					existing.title = nextTitle;
					existing.backend = input.backend;
					existing.status = "active";
					// 外部会话 header 携带的 preset 变化（host 会话 header 是权威）随导入同步
					if (input.agentPreset !== undefined) existing.agentPreset = input.agentPreset;
					// fork 产物可能是外部同步先导入、fork 命令后到：标记只增补不清空。
					if (input.forked) existing.forked = true;
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
				channel: input.channel,
				// 只落 true：false 与缺省同义，不写进存档省得 JSON 里堆噪声字段
				sideTask: input.sideTask ? true : undefined,
				forked: input.forked ? true : undefined,
				backend: input.backend,
				// 第 12 步：显式身份优先；旧调用没有时仍回退全局上下文。
				wslDistro: input.environment === "wsl" ? (input.wslDistro ?? this.identityContext.wslDistro) : undefined,
				wslUser: input.environment === "wsl" ? (input.wslUser ?? this.identityContext.wslUser) : undefined,
				// 带 dshSessionId = 导入已有 host 会话（数据在 $DSH_HOME），
				// 不是「尚未发送」的草稿：置 active，重启清理/重新打开都按真实会话处理。
				status: input.dshSessionId ? "active" : "draft",
				model: cloneModelPreference(input.model),
				thinkingLevel: input.thinkingLevel,
				permissionPreset: input.permissionPreset,
				agentPreset: input.agentPreset,
				acpToolId: input.acpToolId,
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
			/** ACP 工具预选（AcpToolConfig.id）：草稿期切换；null = 清除预选。 */
			acpToolId?: string | null;
			/** ACP 会话身份：激活回写/清理（null = 清空）。 */
			acpSessionId?: string | null;
			proxy?: SessionProxyOverride | null;
			/** 切到生图后端时甩开 pi 会话文件引用（null = 清空）。 */
			filePath?: string | null;
			piSessionId?: string | null;
			/** fork 标记：仅显式 true 时置位（fork 身份元数据；(fork) 后缀已物理写入标题）。 */
			forked?: boolean | null;
			/** 侧边任务标记：true = 收进侧边任务面板，null = 释放回普通会话（会话本身保留）。 */
			sideTask?: boolean | null;
		},
	): Promise<SessionRecord> {
		this.assertLoaded();
		const sessionId = this.resolveSessionId(id);
		const transient = this.transientEntries.get(sessionId);
		if (transient) {
			if (patch.title !== undefined) {
				transient.title = patch.title;
				assignTitleOrigin(transient, "manual");
			}
			if (patch.model !== undefined) transient.model = cloneModelPreference(patch.model ?? undefined);
			if (patch.thinkingLevel !== undefined) transient.thinkingLevel = patch.thinkingLevel ?? undefined;
			if (patch.permissionPreset !== undefined) transient.permissionPreset = patch.permissionPreset ?? undefined;
			if (patch.agentPreset !== undefined) transient.agentPreset = patch.agentPreset ?? undefined;
			if (patch.acpToolId !== undefined) transient.acpToolId = patch.acpToolId ?? undefined;
			if (patch.backend !== undefined) transient.backend = patch.backend;
			// 切到生图/DSH 后端时需甩开 Pi 文件定位；路径变更时同步规范 locator。
			if (patch.filePath !== undefined || patch.backend === "dsh" || patch.backend === "imagegen") {
				setLocalSessionFilePath(transient, patch.filePath ?? undefined);
			}
			if (patch.piSessionId !== undefined) transient.piSessionId = patch.piSessionId ?? undefined;
			if (patch.forked === true) transient.forked = true;
			if (patch.sideTask !== undefined) transient.sideTask = patch.sideTask ? true : undefined;
			// null = 清除覆盖恢复跟随全局
			if (patch.proxy !== undefined) transient.proxy = patch.proxy ?? undefined;
			transient.updatedAt = patch.updatedAt ?? Date.now();
			return this.recordFromEntry(transient);
		}
		const entry = await this.enqueueMutation((entries) => {
			const nextEntry = this.requireEntry(entries, sessionId);
			if (patch.title !== undefined) {
				nextEntry.title = patch.title;
				assignTitleOrigin(nextEntry, "manual");
			}
			if (patch.model !== undefined) nextEntry.model = cloneModelPreference(patch.model ?? undefined);
			if (patch.thinkingLevel !== undefined) nextEntry.thinkingLevel = patch.thinkingLevel ?? undefined;
			if (patch.permissionPreset !== undefined) nextEntry.permissionPreset = patch.permissionPreset ?? undefined;
			if (patch.agentPreset !== undefined) nextEntry.agentPreset = patch.agentPreset ?? undefined;
			if (patch.acpToolId !== undefined) nextEntry.acpToolId = patch.acpToolId ?? undefined;
			if (patch.acpSessionId !== undefined) nextEntry.acpSessionId = patch.acpSessionId ?? undefined;
			if (patch.backend !== undefined) nextEntry.backend = patch.backend;
			if (patch.filePath !== undefined || patch.backend === "dsh" || patch.backend === "imagegen") {
				setLocalSessionFilePath(nextEntry, patch.filePath ?? undefined);
			}
			if (patch.piSessionId !== undefined) nextEntry.piSessionId = patch.piSessionId ?? undefined;
			if (patch.forked === true) nextEntry.forked = true;
			if (patch.sideTask !== undefined) nextEntry.sideTask = patch.sideTask ? true : undefined;
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
		const sessionId = this.resolveSessionId(id);
		const transient = this.transientEntries.get(sessionId);
		if (transient) {
			if (claimAutomaticTitle(transient, nextTitle, source)) transient.updatedAt = Date.now();
			return this.recordFromEntry(transient);
		}
		const entry = await this.enqueueMutation((entries) => {
			const nextEntry = this.requireEntry(entries, sessionId);
			const claimed = claimAutomaticTitle(nextEntry, nextTitle, source);
			if (claimed) nextEntry.updatedAt = Date.now();
			return { value: cloneEntry(nextEntry), changed: claimed };
		});
		return this.recordFromEntry(entry);
	}

	/**
	 * ACP CLI（session_info_update）标题回写：agent 侧来源，last-wins。
	 *
	 * 与 applyAutomaticTitle 的差异：CLI 每回合末会持续精修标题（codex 首个标题常是 prompt 原文），
	 * 锁一次会丢掉后续更好的名字，所以同源可重复领取；唯一硬边界是 manual（用户确认名）——
	 * 用户改名的会话绝不被 CLI 拉回（对齐 pi/DSH 侧「自动结果不得覆盖用户改名」语义）。
	 * 标记形态脏名（上下文代理确认行）任何来源都不写。
	 * 存量注意：旧版本曾把 CLI 标题当 manual 写入，这类条目无法与真用户改名区分，
	 * 保守按 manual 处理（CLI 后续标题被拒），直到用户再次手动改名。
	 */
	async applyAgentTitle(id: string, title: string): Promise<SessionRecord | undefined> {
		this.assertLoaded();
		const nextTitle = title.replace(/\s+/g, " ").trim();
		if (!nextTitle || looksLikeToolMarkerTitle(nextTitle)) return undefined;
		const sessionId = this.resolveSessionId(id);
		const transient = this.transientEntries.get(sessionId);
		if (transient) {
			if (resolveTitleOrigin(transient) === "manual" || transient.title === nextTitle) return undefined;
			transient.title = nextTitle;
			assignTitleOrigin(transient, "auto");
			transient.updatedAt = Date.now();
			return this.recordFromEntry(transient);
		}
		let claimed = false;
		const entry = await this.enqueueMutation((entries) => {
			const nextEntry = this.requireEntry(entries, sessionId);
			if (resolveTitleOrigin(nextEntry) === "manual" || nextEntry.title === nextTitle) return { value: cloneEntry(nextEntry), changed: false };
			nextEntry.title = nextTitle;
			assignTitleOrigin(nextEntry, "auto");
			nextEntry.updatedAt = Date.now();
			claimed = true;
			return { value: cloneEntry(nextEntry), changed: true };
		});
		return claimed ? this.recordFromEntry(entry) : undefined;
	}

	/**
	 * Reserves catalog title ownership before a manual rename reaches pi. The rename
	 * RPC is asynchronous, so this closes the window where a pending auto-title
	 * result could otherwise claim the still-provisional record first.
	 */
	async claimTitleOwnership(id: string): Promise<SessionRecord> {
		this.assertLoaded();
		const sessionId = this.resolveSessionId(id);
		const transient = this.transientEntries.get(sessionId);
		if (transient) {
			if (!isTitleLocked(transient)) {
				assignTitleOrigin(transient, "manual");
				transient.updatedAt = Date.now();
			}
			return this.recordFromEntry(transient);
		}
		const entry = await this.enqueueMutation((entries) => {
			const nextEntry = this.requireEntry(entries, sessionId);
			if (isTitleLocked(nextEntry)) return { value: cloneEntry(nextEntry), changed: false };
			assignTitleOrigin(nextEntry, "manual");
			nextEntry.updatedAt = Date.now();
			return { value: cloneEntry(nextEntry), changed: true };
		});
		return this.recordFromEntry(entry);
	}

	/**
	 * 会话运行时身份 → catalog 写入（C9 收拢点）。**按 locator 路由**，三条互斥分支（`remoteLocator`
	 * 优先于 `filePath`：远端路径不得被本机分支解释）：
	 * - `remoteLocator`（远端会话，P4.2 收口）：只写 ssh 身份（见 `attachRemoteLocatorEntry`）；
	 * - `entry.locator` 已是 ssh 且走本机 filePath 分支：拒绝（本机路径分支不得解释远端条目）；
	 * - DSH / 通用 pi：原行为逐字不变。
	 */
	async attachRuntime(input: {
		sessionId: string;
		filePath?: string;
		piSessionId?: string;
		dshSessionId?: string;
		/** ACP 会话身份：backend=acp 激活后回写，重启恢复用。 */
		acpSessionId?: string;
		/** DSH agent 预设（会话「模式」）：attach/新建后 host 回写（host 会话 header 是权威）。 */
		agentPreset?: string;
		/** 真正开聊后再把 DSH 草稿抬成 active；预热只绑 host id，不抬。 */
		promoteToActive?: boolean;
		/** 归档恢复等手动找回才清删除墓碑；激活/fork 回写不得把用户删过的 id 解禁。 */
		restoreDismissed?: boolean;
		/**
		 * 远端会话身份（ssh locator：host 主键 + pi 上报的远端会话文件绝对路径；`remoteSessionId`
		 * 可由调用方给，也可省略——见下面）。
		 *
		 * 为什么 attach 需要它：远端 pi 的会话文件在**那台机器上**（由 pi 自己选好、握手时上报）。把这条
		 * 路径当 `filePath` 写进来，会在本机字段里留下一条读不到也不该存在的路径，并让同一远端会话出现
		 * 两条记录（渲染层先建的 draft + 握手登记另立的那条）。相反方向——远端条目被 local 分支解释——
		 * 同样禁止（下面仍然抛 `UNSUPPORTED_PROJECT_LOCATION`）。
		 *
		 * `remoteSessionId`（相对会话根的 POSIX 路径）省略时由已有记录带过来：它的推导只允许有一份实现
		 * （`RemoteRuntimePort` 里的 `remoteSessionIdWithinRoot`），catalog 不重算、调用方（会话链路）
		 * 也不必知道会话根在哪。
		 */
		remoteLocator?: SshSessionLocator;
	}): Promise<SessionCatalogEntry> {
		this.assertLoaded();
		return this.enqueueMutation(async (entries) => {
			let entry = this.requireEntry(entries, this.resolveSessionId(input.sessionId));
			if (input.remoteLocator) return this.attachRemoteLocatorEntry(entries, entry, input.remoteLocator);
			if (entry.locator?.kind === "ssh") throw new Error("UNSUPPORTED_PROJECT_LOCATION");
			// #314 幂等基线：runtime 事件风暴会反复 attach 同一会话的相同路径/ID。
			// 先记录 mutation 前快照，无实际变化不得刷新 updatedAt——活动区排序与
			// 时间戳都取 updatedAt，重复刷新会让已停止/空闲会话被顶到最前、时间跳动。
			const before = {
				filePath: entry.filePath,
				piSessionId: entry.piSessionId,
				dshSessionId: entry.dshSessionId,
				acpSessionId: entry.acpSessionId,
				agentPreset: entry.agentPreset,
				status: entry.status,
				originKey: entry.originKey,
				createdAt: entry.createdAt,
				model: entry.model,
				thinkingLevel: entry.thinkingLevel,
				importedSourceId: entry.importedSourceId,
			};
			// pi 可能上报相对 cwd 的 sessionFile：写入 catalog 前归一化为绝对路径，
			// 否则与扫描器绝对路径 originKey 不一致，同一文件会出现两条记录。
			const filePath = input.filePath && this.resolveFilePath ? this.resolveFilePath(entry.projectId, input.filePath, entry.environment) : input.filePath;
			// DSH 的 sessionPath 是 host zstd，不是 pi JSONL；写进 filePath 会让渲染层
			// 把空会话当成有磁盘历史（起始页 / 骨架来回抽）。ACP 同理：历史在 agent 侧，
			// PiDeck 无本地会话文件。
			if (filePath && entry.backend !== "dsh" && entry.backend !== "acp" && entry.backend !== "imagegen" && !entry.noSession) {
				setLocalSessionFilePath(entry, filePath);
			}
			if (input.piSessionId) entry.piSessionId = input.piSessionId;
			if (input.acpSessionId) entry.acpSessionId = input.acpSessionId;
			let restoredDismissed = false;
			if (input.dshSessionId) {
				entry.dshSessionId = input.dshSessionId;
				// 只有明确找回才清墓碑。激活回写同一 host id 时如果清掉，
				// 用户删映射后迟到的 attach 会让下次自动同步再导回来。
				if (input.restoreDismissed && this.dismissedDshSessionIds.has(input.dshSessionId)) {
					// 墓碑集合随 writeSnapshot 落盘：delete 已发生在回调内，必须计入
					// changed，否则 changed:false 时内存已删但快照不落盘，重启后墓碑复活。
					restoredDismissed = true;
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
			// ACP 同语义：无本地文件，真正开聊（prompt dispatch）后才抬 active。
			if (input.promoteToActive && input.acpSessionId && entry.status === "draft") {
				entry.status = "active";
			}
			let mergedDuplicate = false;
			if (entry.filePath) {
				// #354 复审：运行时归并不是「找到一条就删」。破坏性归并前必须过与启动修复同一道
				// **物理文件确认**（confirmedOriginKey）：survivor 与候选都必须是 pi 文件会话，
				// 路径经 resolver 确定为无歧义绝对路径，再按完整 source/env/wsl/importedSource
				// 现场重算身份键。只比持久化键——或比相对路径派生出的键——会把两个项目各自的
				// `.pi/sessions/x.jsonl` 算成同一个物理会话，把其中一条记录连标题一起删掉。
				const nextOriginKey = this.confirmedOriginKey(entry);
				// 无法确认物理位置的条目保守保留：不归并、也不改写身份键（改写会把「这曾是小写
				// 旧键」的证据洗掉，下次启动就会按 createdAt 错选存活 ID）；运行时绑定与 attach
				// 元数据照常落库。
				// 同源组还要过与启动修复同一套标题优先级/权威证据仲裁：启动时因无证据而保守保留的
				// 冲突组，在这里同样不得归并，否则用户激活其中一条就会静默丢掉另一条的标题与稳定 ID。
				const group = nextOriginKey ? [entry, ...entries.filter((candidate) => candidate.id !== entry.id && this.confirmedOriginKey(candidate) === nextOriginKey)] : [];
				let canMerge = Boolean(nextOriginKey);
				let titleOwner: SessionCatalogEntry | undefined;
				if (group.length > 1) {
					const arbitration = await arbitrateRuntimeMergeTitle(group, this.fetchTitle);
					canMerge = arbitration.merge;
					titleOwner = arbitration.titleOwner;
				}
				entry.status = "active";
				if (canMerge && nextOriginKey) {
					entry.originKey = nextOriginKey;
					if (group.length > 1) {
						// 存活 ID 必须是本次 attach 的会话：runtime / 渲染层正持有它，其余同源条目全部吸收。
						const absorbedIds = new Set(group.filter((candidate) => candidate.id !== entry.id).map((candidate) => candidate.id));
						const merged = mergeSourceGroupInto(entry.id, group, titleOwner);
						const survivorIndex = entries.findIndex((candidate) => candidate.id === entry.id);
						entries[survivorIndex] = merged;
						entry = merged;
						for (let index = entries.length - 1; index >= 0; index -= 1) {
							if (absorbedIds.has(entries[index].id)) entries.splice(index, 1);
						}
						mergedDuplicate = true;
					}
				}
			}
			// 快照对比逐字段判定真实变化；路径按 canonical 形态比较，隔离分隔符/大小写差异。
			const touched =
				restoredDismissed ||
				mergedDuplicate ||
				canonicalizeSessionPath(before.filePath ?? "", entry.environment) !== canonicalizeSessionPath(entry.filePath ?? "", entry.environment) ||
				before.piSessionId !== entry.piSessionId ||
				before.dshSessionId !== entry.dshSessionId ||
				before.acpSessionId !== entry.acpSessionId ||
				before.agentPreset !== entry.agentPreset ||
				before.status !== entry.status ||
				before.originKey !== entry.originKey ||
				before.createdAt !== entry.createdAt ||
				before.model !== entry.model ||
				before.thinkingLevel !== entry.thinkingLevel ||
				before.importedSourceId !== entry.importedSourceId;
			// 无实际变化：不刷新 updatedAt、不落盘（enqueueMutation changed:false 跳过快照），
			// 让 runtime 事件风暴里的重复 attach 成为廉价 no-op。
			if (!touched) return { value: cloneEntry(entry), changed: false };
			entry.updatedAt = Date.now();
			return { value: cloneEntry(entry), changed: true };
		});
	}

	/**
	 * 远端会话身份的写入口（`attachRuntime` 的 ssh 分支）。语义与上面本机「文件配对」分支**一一对应**：
	 *
	 * - 本机：draft 拿到 filePath 后按 originKey 吸收同一文件已有的重复条目；
	 * - 远端：draft 拿到 pi 上报的远端路径后按 (hostId, remotePath) 吸收握手登记（`ensureRemoteSession`）
	 *   先立的那条记录。
	 *
	 * 两条分支的落点相同：**渲染层手上那个 sessionId 必须是唯一存活的记录**，否则侧栏出现两条。
	 * 差别只在「身份是什么」：本机是路径 originKey，远端是 ssh 身份，因此远端分支绝不碰 filePath /
	 * originKey / piSessionId —— 由 `normalizeEntryLocator` 的 ssh 分支统一清空本地镜像字段。
	 *
	 * 相对身份（remoteSessionId）由被吸收的记录带过来：会话根在哪由 `RemoteRuntimePort` 判定，catalog
	 * 不复刻那套规则（配了自定义 `sessionDir` 的机器上会算错）；这条条目自己已有的身份同样保留
	 * （恢复同一会话时不能因为「只回写了路径」把相对身份/别名丢掉）。
	 */
	private attachRemoteLocatorEntry(entries: SessionCatalogEntry[], entry: SessionCatalogEntry, remoteLocator: SshSessionLocator): { value: SessionCatalogEntry; changed: boolean } {
		// 身份只经 shared 的唯一判据（hostId 值域与项目域/扫描/引用审计同一处）。
		const locator = readSshSessionLocator(remoteLocator);
		const remotePath = locator?.remotePath;
		if (!locator || remotePath === undefined) throw new Error("REMOTE_SESSION_IDENTITY_INVALID");
		const currentLocator = entry.locator?.kind === "ssh" ? entry.locator : undefined;
		const duplicateIndex = entries.findIndex((candidate) => candidate.id !== entry.id && sameRemoteSessionPath(candidate.locator, locator.hostId, remotePath));
		const duplicate = duplicateIndex >= 0 ? entries[duplicateIndex] : undefined;
		const duplicateLocator = duplicate?.locator?.kind === "ssh" ? duplicate.locator : undefined;
		// 已经是同一身份的条目：locator 原样保留（包括 remoteSessionId 与 remotePathAliases）——恢复同一
		// 会话时的回写是幂等的，不能因为它没带相对身份就把已存的身份冲掉。
		const sameIdentity = currentLocator !== undefined && sameRemoteSessionPath(currentLocator, locator.hostId, remotePath);
		const inheritedRemoteSessionId = duplicateLocator?.remoteSessionId ?? currentLocator?.remoteSessionId;
		const next = normalizeEntryLocator({
			...entry,
			locator: sameIdentity ? currentLocator : { ...locator, ...(inheritedRemoteSessionId !== undefined ? { remoteSessionId: inheritedRemoteSessionId } : {}) },
		});
		if (duplicate) {
			// 补空缺顺序与本机分支一致：只填本记录没有的值，已有值（用户选择/更早的创建时间）优先。
			next.model ??= duplicate.model;
			next.thinkingLevel ??= duplicate.thinkingLevel;
			next.importedSourceId ??= duplicate.importedSourceId;
			next.createdAt = Math.min(next.createdAt, duplicate.createdAt);
			entries.splice(duplicateIndex, 1);
		}
		next.status = "active";
		next.updatedAt = Date.now();
		// 用 id 回填：上面的 splice 会让下标整体前移，按下标写会写错条目。
		const targetIndex = entries.findIndex((candidate) => candidate.id === entry.id);
		if (targetIndex < 0) throw new Error("REMOTE_SESSION_IDENTITY_INVALID");
		entries[targetIndex] = next;
		return { value: cloneEntry(next), changed: true };
	}

	async remove(id: string): Promise<boolean> {
		this.assertLoaded();
		const requestedId = this.resolveSessionId(id);
		if (this.transientEntries.delete(requestedId)) return true;
		return this.enqueueMutation((entries) => {
			// 执行时解析：排队期间同源归并可能已把旧 ID 吸收进存活条目。
			const entry = this.findEntryInTransaction(entries, requestedId);
			if (!entry) return { value: false, changed: false };
			entries.splice(entries.indexOf(entry), 1);
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
		const requestedId = this.resolveSessionId(id);
		const parent = this.transientEntries.get(requestedId) ?? this.entries.find((entry) => entry.id === requestedId);
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
			// 执行时解析：排队期间被同源归并吸收的 ID 指向存活条目，删除必须落在真正存活的记录上。
			const idSet = new Set(persistedIds.map((sessionId) => this.canonicalIdInTransaction(sessionId)));
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
		const requestedId = this.resolveSessionId(sessionId);
		const transient = this.transientEntries.get(requestedId);
		if (transient) {
			if (transient.status === "draft") transient.status = "active";
			transient.updatedAt = Date.now();
			return this.recordFromEntry(transient);
		}
		const entry = await this.enqueueMutation((entries) => {
			const nextEntry = this.requireEntry(entries, requestedId);
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
		// 引用写入与引用删除都必须在有 rebind 事务时退让（设计 §3.1 方案 A 的 advisory interlock）。
		if (this.referenceGuard) await this.referenceGuard.assertRebindIdle();
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

	/**
	 * 登记一次远端 Session 发现（G3 冻结设计第 5/6 条）：
	 * 稳定 id 匹配 (hostId, remoteSessionId) → (hostId, remotePath) → 新建。
	 *
	 * 幂等：同一远端文件重复登记命中同一条记录并返回同一个 SessionRecord.id；第二次起没有字段变化 ⇒
	 * changed=false ⇒ 不写盘，也不会产生第二个 stable id。
	 *
	 * 只写远端身份与暂定标题，不碰本地镜像字段：ssh 分支经 normalizeEntryLocator 清空
	 * filePath/originKey/piSessionId/wslDistro/wslUser/parentSessionPath —— 远端路径绝不落到本地字段。
	 * 命中已有记录时不改 projectId：归属是用户/项目侧的决定，登记只负责发现。
	 *
	 * 注意（本批边界）：命中的条目若已有 remoteSessionId 但 remotePath 是别的写法（历史绝对路径），
	 * 这里按冻结设计把 locator 改写成本次发现的相对路径；«改动即加入 remotePathAliases» 属于
	 * Phase 4 的 move/archive 事务，本批不引入 alias 写入口。
	 */
	async ensureRemoteSession(input: RemoteSessionRegistrationInput): Promise<RemoteSessionRegistration> {
		this.assertLoaded();
		if (!isRemoteSessionRegistrationInput(input)) throw new Error("REMOTE_SESSION_IDENTITY_INVALID");
		const identity = remoteSessionIdentity(input);
		// INV-1：写入一条 hostId 引用前必须能证明主机可解析且没有跨 store 事务在跑（门自己读磁盘，
		// 不看内存）。未注入门时不复查 —— 生产装配必须注入，仓库契约侧有装配断言。
		if (this.referenceGuard) await this.referenceGuard.assertHostReferenceWritable(identity.hostId);
		const updatedAt = Number.isFinite(input.updatedAt) && input.updatedAt > 0 ? input.updatedAt : undefined;
		return this.enqueueMutation<RemoteSessionRegistration>((entries) => {
			const locator = remoteSessionLocator(identity);
			const existing = findRemoteSessionEntry(entries, identity);
			if (existing) {
				const next = normalizeEntryLocator({ ...existing, locator });
				// 暂定标题只在条目尚未被确认时写入：用户改名 / 权威名是终态，登记不得覆盖。
				const titleTarget = isTitleLocked(existing) || !input.title ? undefined : input.title;
				const nextUpdatedAt = updatedAt ?? next.updatedAt;
				if (!remoteSessionEntryChanged(existing, locator, titleTarget, nextUpdatedAt)) {
					// 完全相同的重复登记：一个字节都不写（幂等的可观测形态）。
					return { value: { record: this.recordFromEntry(existing), created: false }, changed: false };
				}
				next.updatedAt = nextUpdatedAt;
				if (titleTarget !== undefined) {
					next.title = titleTarget;
					assignTitleOrigin(next, "fallback");
				}
				entries[entries.indexOf(existing)] = next;
				return { value: { record: this.recordFromEntry(next), created: false }, changed: true };
			}
			const now = Date.now();
			const entry: SessionCatalogEntry = {
				id: randomUUID(),
				projectId: input.projectId,
				title: input.title,
				// 文件名 stem 只是暂定名（冻结设计第 6 条）：标成 fallback，允许后续「按需头部解析」用
				// applyAutomaticTitle(..., "auto") 升级；用户改名走 update() 落 manual 终态。
				titleLocked: true,
				titleOrigin: "fallback",
				source: "pi",
				// environment 是 catalog 的必填旧字段；ssh 条目由 normalizeEntryLocator 清空本地镜像字段，
				// 这里的"native"不表示远端主机是本机（locator 才是位置真相）。
				environment: "native",
				locator,
				status: "active",
				createdAt: now,
				updatedAt: updatedAt ?? now,
			};
			entries.push(entry);
			return { value: { record: this.recordFromEntry(entry), created: true }, changed: true };
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
		const { titles: fetchedTitles, legacyProbes: fetchedLegacyProbes, thinkingFallbackRepairs: fetchedThinkingFallbackRepairs, invalid: invalidOrigins, parents: fetchedParents, forked: fetchedForked } = await this.collectScannedTitles(summaries, context);

		// 外部删除清理（在入锁前完成磁盘探测）：mergeScanned 历史上只增改不删，
		// pi 会话文件被外部删除（pi 回收站、用户手工 rm、脚本清理）后条目会永远
		// 残留在侧栏。安全闸（缺一不可）：
		// - 仅本项目 + source=pi + backend≠dsh：dsh 会话文件由 $DSH_HOME 托管；
		// - environment=native：WSL 条目跳过——发行版未运行时 UNC existsSync 恒
		//   false，会把正常会话误删；
		// - 必须真实 existsSync 缺失（而非「不在本轮 summaries 里」），部分扫描/
		//   手动导入调用不会误判；
		// - 必须有存在的祖先目录锚点：从父目录逐级向上找第一个存在的目录，找到
		//   即「磁盘可达而文件不在」= 确定的外部删除；一路到根都不存在（磁盘/
		//   网络盘整体离线、路径临时不可达）才跳过。只看直接父目录会把嵌套子
		//   代理会话（<encoded>/<父会话目录>/<agentId>/run-N/session.jsonl）漏掉——
		//   父会话目录被整体删除后多级父目录都不在，记录永远残留并会在小窗
		//   报 ENOENT（2027-02 事故）。
		const externallyMissingIds = new Set<string>();
		for (const entry of this.entries) {
			if (entry.projectId !== projectId) continue;
			if (entry.source !== "pi" || entry.backend === "dsh") continue;
			if (entry.environment !== "native") continue;
			if (!entry.filePath) continue;
			// 活跃运行时的文件可能尚未落盘：pi 首条消息才创建 jsonl，预热激活后空闲
			// 进程甚至长期不写。有活绑定的会话「文件暂时不在」不是外部删除，跳过；
			// 运行终结后下一轮扫描按真实缺失清理（2026-10-05 事故：预热 attach 同秒
			// 扫描剔掉记录 → 闪回引导页、输入草稿丢失、发送另起新进程）。
			if (this.sessionLivenessProbe?.(entry.id)) continue;
			if (existsSync(entry.filePath)) continue;
			if (!findExistingAncestorDir(entry.filePath)) continue;
			externallyMissingIds.add(entry.id);
		}

		return this.enqueueMutation((entries) => {
			let changed = false;

			// 剔除磁盘已消失的 pi 原生条目（探测结果在入锁前算好）。
			if (externallyMissingIds.size > 0) {
				for (let index = entries.length - 1; index >= 0; index -= 1) {
					if (!externallyMissingIds.has(entries[index]!.id)) continue;
					entries.splice(index, 1);
					changed = true;
				}
			}

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
					// fork/copy 现场（2026-10-08）：扫描在 pi 写入 session_info 名之前的几百毫秒
					// 窗口里先索引了新文件，从首条/尾部窗口兜底猜出一个标题并锁成 fallback；
					// 随后权威名落盘，但 canInitializeTitle 把它拒之门外 → 侧栏永久停在猜出
					// 的正文上。所有权语义上 fallback 是「内容派生的猜测」，权威 session_info
					// 名是「pi/用户写下的名字」——后者必须能升级前者（fallback → manual）。
					// auto/manual/legacy 终态不动（无命中时走 ?? 兑底保持原 origin）。
					const authoritativeUpgrade = initialAuthoritative && resolveTitleOrigin(entry) === "fallback";
					const canAbsorbTitle = canInitializeTitle || authoritativeUpgrade;
					// #266 存量自愈：legacy 条目读盘探测过一次。指纹命中（catalog 存的正是弱兜底名、
					// JSONL 另有权威名）才改写标题；探测过但没命中就消费掉这一次机会，落 manual 终态，
					// 避免每次扫描都为一个不可能自愈的条目读盘。读盘失败则保持 legacy 下次再试。
					const legacyProbe = fetchedLegacyProbes.get(originKey);
					const legacyRepair = legacyProbe ? repairedLegacyFallbackTitle(entry, summaryTitle && summary.nameFromSessionInfo === true ? { ...legacyProbe, authoritative: summaryTitle } : legacyProbe) : undefined;
					// #488 存量自愈：fallback 标题若被旧版本锁成 thinking 原文，笼统可读后原地纠正（origin 保持 fallback）。
					// 排在权威名升级之后：真有 pi/用户写下的名字时以它为准。
					const thinkingFallbackRepair = fetchedThinkingFallbackRepairs.get(originKey);
					const nextTitle = legacyRepair || (canAbsorbTitle ? initialTitle : undefined) || thinkingFallbackRepair || catalogDisplayTitle(entry.title) || scannedFileStemTitle(summary.filePath);
					// rollout 文件名标题（历史导入兑底）不锁定：留一次被真实标题覆盖的机会；
					// 真实标题一旦落库即锁定，后续 pi /name 或 JSONL 变化不再反向改写。
					// 未锁定条目吸收的新标题按来源升级：权威 session_info → manual，首条消息弱回退 → fallback。
					const nextOrigin = legacyProbe ? "manual" : ((canAbsorbTitle && initialTitle ? scannedTitleOrigin(nextTitle, initialAuthoritative) : undefined) ?? resolveTitleOrigin(entry));
					const nextTitleLocked = nextOrigin !== undefined;
					// 父关系最终值：新探测值优先，缺失时保留旧值（轻量扫描恒缺省，不能清掉已持久化的父）。
					const nextParent = summary.parentSessionPath ?? fetchedParent ?? entry.parentSessionPath;
					// fork 标记同样只增补、不清空：未探测到（轻量扫描/普通会话）保留持久化值。
					const nextForked = nextParent ? entry.forked : fetchedForkedFlag || entry.forked;
					// 手动导入钉住的归属：别的项目扫描不得改回去（见 SessionCatalogEntry 注释）；
					// 用户再一次手动导入（manualAssignment）表示明确改主意，允许迁移到新项目。
					const nextProjectId = entry.manualProjectAssignment && !options?.manualAssignment && entry.projectId !== projectId ? entry.projectId : projectId;
					// 扫描快照可能早于排队期间完成的改名或新一轮活动；保留较新时间，但不因标题锁定挡住后续文件活动。
					const nextUpdatedAt = Math.max(entry.updatedAt, summary.updatedAt);
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
						entry.updatedAt !== nextUpdatedAt
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
						entry.updatedAt = nextUpdatedAt;
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
	/** #488 存量自愈：已探过的 fallback 条目（每进程一次）。与 #266 legacy 探测同构——
	 *  命中即改、不命中不再重读，避免每次扫描都为一个不可能自愈的条目读盘。 */
	private readonly probedFallbackTitles = new Set<string>();

	private async collectScannedTitles(
		summaries: SessionSummary[],
		context: SessionCatalogContext,
	): Promise<{ titles: Map<string, ScannedTitleFetch>; legacyProbes: Map<string, LegacyTitleProbe>; thinkingFallbackRepairs: Map<string, string>; invalid: Set<string>; parents: Map<string, string>; forked: Map<string, boolean> }> {
		const titles = new Map<string, ScannedTitleFetch>();
		// 只收录**读取成功**的 legacy 探测：读不到（权限/锁定/WSL 抖动）时条目保持 legacy，下次扫描再试，
		// 否则一次瞬时失败就会把唯一的一次自愈机会消费掉。
		const legacyProbes = new Map<string, LegacyTitleProbe>();
		// #488：指纹命中的 fallback 重写结果（originKey → 新标题）。读不到同样不消费机会（见 worker）。
		const thinkingFallbackRepairs = new Map<string, string>();
		const invalid = new Set<string>();
		const parents = new Map<string, string>();
		const forked = new Map<string, boolean>();
		if (!this.fetchTitle) return { titles, legacyProbes, thinkingFallbackRepairs, invalid, parents, forked };
		const byOrigin = new Map(this.entries.filter((entry) => entry.originKey).map((entry) => [entry.originKey!, entry]));
		const wanted: Array<{ originKey: string; filePath: string; includeTitle: boolean; legacyProbe?: boolean; fallbackProbe?: boolean; lockedTitle?: string }> = [];
		let fallbackProbesQueued = 0;
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
				// #488：旧版本把 thinking 原文锁成了 fallback 标题。只探「一眼是正文摘录」的长标题（FALLBACK_TITLE_PROBE_MIN_LENGTH），
				// 每进程每条一次，且单次扫描限量（FALLBACK_TITLE_PROBE_MAX_PER_SCAN）——存量条目很多时
				// 不能让启动退化成大批量 JSON 解析，剩下的留给后续扫描。
				const thinkingFallback = existing.source === "pi" && resolveTitleOrigin(existing) === "fallback" && normalizeFingerprintTitle(existing.title).length > FALLBACK_TITLE_PROBE_MIN_LENGTH && !this.probedFallbackTitles.has(originKey) && fallbackProbesQueued < FALLBACK_TITLE_PROBE_MAX_PER_SCAN;
				if (legacy) wanted.push({ originKey, filePath: summary.filePath, includeTitle: true, legacyProbe: true, lockedTitle: existing.title });
				else if (tintinwebOrphan) wanted.push({ originKey, filePath: summary.filePath, includeTitle: false });
				else if (thinkingFallback) {
					this.probedFallbackTitles.add(originKey);
					fallbackProbesQueued += 1;
					wanted.push({ originKey, filePath: summary.filePath, includeTitle: true, fallbackProbe: true, lockedTitle: existing.title });
				}
				continue;
			}
			// readSummary 全量路径已携带初始名称，无需再次读盘。
			if (catalogDisplayTitle(summary.name)) continue;
			// New files and explicitly unlocked provisional records need one exact title
			// read; every other locked record remains entirely out of this path.
			wanted.push({ originKey, filePath: summary.filePath, includeTitle: true });
		}
		if (wanted.length === 0) return { titles, legacyProbes, thinkingFallbackRepairs, invalid, parents, forked };
		// 有界并行读头部；限制并发避免 WSL 环境一次拉起过多 wsl.exe。
		// 单个失败降级为无标题/不拒绝，不影响扫描结果。
		const CONCURRENCY = 8;
		let cursor = 0;
		const workers = Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, async () => {
			while (cursor < wanted.length) {
				const item = wanted[cursor++];
				const result = await this.fetchTitle!(item.filePath, { includeTitle: item.includeTitle, ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}), ...(context.wslUser ? { wslUser: context.wslUser } : {}) }).catch(() => undefined);
				if (!result) {
					// 读不到（文件已删/权限/WSL 抖动）：归还 #488 自愈机会，下次扫描再试。
					if (item.fallbackProbe) this.probedFallbackTitles.delete(item.originKey);
					continue;
				}
				// fallback 探测只用于原地纠错，不登记为标题（否则会绕开既有的权威名升级/锁定规则）。
				if (item.includeTitle && result.name && !item.fallbackProbe) {
					// fromSessionInfo=false 是首条消息弱回退（#266）：所有权只能算 fallback，
					// 缺省（旧 fetcher/未标记）按权威名处理，保持既有行为。
					// 权威名本身是标记脏行（第三方上下文代理把它写进了 session_info）时不采信：
					// 有弱兜底就用弱兜底（侧栏显示首句而不是日志，所有权仍算 fallback，可被扩展升级）；
					// 连弱兜底都没有就干脆不登记，让条目保持占位标题等后续命名。
					const junkMarkerName = result.nameFromSessionInfo !== false && looksLikeToolMarkerTitle(result.name);
					const scannedName = junkMarkerName ? result.fallbackName : result.name;
					if (scannedName) {
						titles.set(item.originKey, { name: scannedName, fromSessionInfo: junkMarkerName ? false : result.nameFromSessionInfo !== false, fallbackName: result.fallbackName });
					}
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
						? await this.fetchTitle!(item.filePath, {
								includeTitle: false,
								includeFirstUserText: true,
								...(context.wslDistro ? { wslDistro: context.wslDistro } : {}),
								...(context.wslUser ? { wslUser: context.wslUser } : {}),
							})
								.then((extra) => extra?.firstUserText)
								.catch(() => undefined)
						: undefined;
					legacyProbes.set(item.originKey, { authoritative, fallback: result.fallbackName, firstUserText });
				}
				if (item.fallbackProbe) {
					const repaired = repairedThinkingFallbackTitle(item.lockedTitle ?? "", { fallbackName: result.fallbackName, fallbackKind: result.fallbackKind, legacyFallbackName: result.legacyFallbackName });
					if (repaired) thinkingFallbackRepairs.set(item.originKey, repaired);
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
		return { titles, legacyProbes, thinkingFallbackRepairs, invalid, parents, forked };
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
			channel: entry.channel,
			backend: entry.backend,
			sideTask: entry.sideTask,
			...(locator ? { locator } : {}),
			filePath: locator ? (locator.kind === "local" ? locator.filePath : undefined) : (recordSummary?.filePath ?? entry.filePath),
			wslDistro: locator?.kind === "ssh" ? undefined : entry.wslDistro,
			wslUser: locator?.kind === "ssh" ? undefined : entry.wslUser,
			importedSourceId: recordSummary ? getImportedSessionSourceId(recordSummary) : entry.importedSourceId,
			parentSessionPath: locator?.kind === "ssh" ? undefined : (recordSummary?.parentSessionPath ?? entry.parentSessionPath),
			forked: entry.forked,
			supersededBy: entry.supersededBy,
			mergedSessionIds: entry.mergedSessionIds ? [...entry.mergedSessionIds] : undefined,
			projectPath: locator?.kind === "ssh" ? undefined : recordSummary?.projectPath,
			preview: recordSummary?.preview ?? "",
			messageCount: recordSummary?.messageCount ?? 0,
			status: entry.status,
			model: entry.model ? { ...entry.model } : undefined,
			thinkingLevel: entry.thinkingLevel,
			permissionPreset: entry.permissionPreset,
			agentPreset: entry.agentPreset,
			acpToolId: entry.acpToolId,
			dshSessionId: entry.dshSessionId,
			acpSessionId: entry.acpSessionId,
			proxy: entry.proxy ? { ...entry.proxy } : undefined,
			createdAt: entry.createdAt,
			// 返回记录与持久化活动时间同口径，不能让旧扫描摘要把刚保住的排序时间又投影回去。
			updatedAt: Math.max(entry.updatedAt, recordSummary?.updatedAt ?? entry.updatedAt),
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
	 * 破坏性同源归并前必须完成的**物理文件确认**（#354 复审）：与启动修复
	 * （repairSessionCatalogIdentities）同一道闸——条目是 pi 文件会话、路径经 resolver
	 * 确定为无歧义绝对路径，然后按完整 source/environment/wsl/importedSource 现场重算身份键。
	 *
	 * 为什么不看持久化的 `originKey`：项目解析不出来时 resolver 按契约原样返回入参，
	 * 两个项目各自的 `.pi/sessions/x.jsonl` 会算出同一个相对路径键；拿它当「已确认位置」
	 * 做归并就是跨项目删记录。无法确认时返回 undefined，调用方必须保守保留。
	 */
	private confirmedOriginKey(entry: SessionCatalogEntry): string | undefined {
		if (!isFileSession(entry) || !entry.filePath) return undefined;
		const resolved = this.resolveFilePath ? this.resolveFilePath(entry.projectId, entry.filePath, entry.environment) : entry.filePath;
		if (!resolved || !isUnambiguousAbsoluteSessionPath(resolved)) return undefined;
		return this.originKeyForEntry(resolved === entry.filePath ? entry : { ...entry, filePath: resolved });
	}

	private requireEntry(entries: SessionCatalogEntry[], id: string): SessionCatalogEntry {
		const entry = this.findEntryInTransaction(entries, id);
		if (!entry) throw new Error(`Session not found: ${id}`);
		return entry;
	}

	/**
	 * 事务内身份归一（#354 复审）：写队列里排在前面的 mutation 可能已经把入队时存在的 ID 吸收进
	 * 同源存活条目（attach 折叠重复记录），所以 queued operation 必须在**执行时**按最新别名表
	 * 解析身份。只靠入队时的 `resolveSessionId` 快照会指向已被吸收的旧 ID，操作一到执行就变成
	 * 「Session not found」/静默不命中（真实的「先 attach 再改名」顺序）。
	 *
	 * 别名索引在每次成功 mutation 后重建，事务内读到的一定是最近一次已提交状态；每轮归并把吸收的
	 * ID 与它自己的历史别名全量累计进 `mergedSessionIds`，因此一步解析即收敛，不会成链。
	 */
	private canonicalIdInTransaction(id: string): string {
		return this.mergedIdAliases.get(id) ?? id;
	}

	private findEntryInTransaction(entries: SessionCatalogEntry[], id: string): SessionCatalogEntry | undefined {
		const canonical = this.canonicalIdInTransaction(id);
		return entries.find((candidate) => candidate.id === canonical);
	}

	/**
	 * 标记重发/编辑 fork 化替换：origin 会话被 fork 出的子会话接替（supersededBy=子会话 id）。
	 * 只打标记不删文件——旧 JSONL 留在磁盘可恢复，会话列表按该标记过滤（sessionsCatalogList）。
	 * 幂等：同值重复标记不产生写入；id 未知（fork 成功但记录已被并发删除的竞态）静默返回 undefined。
	 */
	async markSuperseded(id: string, supersededBy: string): Promise<SessionCatalogEntry | undefined> {
		this.assertLoaded();
		const sessionId = this.resolveSessionId(id);
		return this.enqueueMutation((entries) => {
			// 执行时解析：排队期间同源归并可能已把旧 ID 吸收进存活条目。
			const entry = this.findEntryInTransaction(entries, sessionId);
			if (!entry) return { value: undefined, changed: false };
			if (entry.supersededBy === supersededBy) {
				return { value: cloneEntry(entry), changed: false };
			}
			entry.supersededBy = supersededBy;
			entry.updatedAt = Date.now();
			return { value: cloneEntry(entry), changed: true };
		});
	}

	private assertLoaded(): void {
		if (!this.loaded) throw new Error("SessionCatalog.load() must complete before use");
	}

	private assertWritable(): void {
		if (this.needsRepair) throw new SessionCatalogRecoveryError();
	}

	/**
	 * 退出路径：封盘并等在途写事务落盘。
	 *
	 * 为什么需要：写事务在锁文件存在期间完成（StoreFileLock 先 `open(...,"wx")` 发布空文件，
	 * owner 才在下一次 write 落盘），进程若在窗口内终止就留下读不出 owner 的残留锁。
	 * 退出清理表里的任务（pi/dsh/acp 停止、自动化收尾）会回写 catalog，而 before-quit 只等
	 * runAll 返回——没人等 writeQueue，最后一次写就被进程终止截断。
	 *
	 * 封盘位在此置位：flush 之后到的写事务不再落盘（按内存副本算返回值），否则排在我们后面的
	 * 收尾任务还能再起一次锁窗口。
	 */
	async flushPendingWrites(): Promise<void> {
		this.sealed = true;
		// 两类在途写：启动归一化（独立锁，不受 sealed 影响）与 writeQueue 里的写事务。
		await this.initializationWrite?.catch(() => undefined);
		await this.writeQueue;
	}

	private enqueueMutation<T>(mutate: (entries: SessionCatalogEntry[]) => { value: T; changed: boolean } | Promise<{ value: T; changed: boolean }>): Promise<T> {
		if (this.sealed) {
			// 退出封盘（flushPendingWrites）：不起写事务、不碰锁文件，只用内存副本算返回值给调用方收尾。
			const nextEntries = this.entries.map(cloneEntry);
			return Promise.resolve(mutate(nextEntries)).then((result) => result.value);
		}
		// 写事务（INV-5a）：持锁 → **重读磁盘**（顺带把内存对齐到它）→ 把 mutate 施加在最新内容上 →
		// 有改动才写 revision+1。mutate 的入参仍是“副本”，所以各调用点的闭包无需改变；
		// 它们对 dismissedDshSessionIds 的改动落在刚刚从磁盘同步回来的集合上（readFreshSnapshot）。
		const operation = this.writeQueue
			.catch(() => undefined)
			.then(async () => {
				this.assertWritable();
				const value = await withStoreFileCas<SessionCatalogEntry[], T>({
					rootDir: this.rootDir,
					lockPath: this.lockPath,
					unwritableCode: SESSION_CATALOG_LOCK_UNWRITABLE,
					busyCode: SESSION_CATALOG_BUSY,
					conflictCode: SESSION_CATALOG_REVISION_CONFLICT,
					readFresh: () => this.readFreshSnapshot(),
					mutate: async (fresh) => {
						const nextEntries = fresh.map(cloneEntry);
						const result = await mutate(nextEntries);
						return result.changed ? { state: nextEntries, changed: true, value: result.value } : { state: fresh, changed: false, value: result.value };
					},
					write: (state, revision) => this.writeSnapshot(state, revision),
				});
				// 归并别名索引必须随条目集合前进（删除会让旧 ID 指向不存在的记录）。
				this.rebuildMergedIdAliases();
				return value;
			});
		this.writeQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/**
	 * 读**磁盘**上的最新 catalog（primary → backup → 首次运行的空状态），与 load 的既有选择规则逐条一致：
	 * primary 能读就不看 backup；primary 是“版本/locator 不认识”就停（旧版备份无权授权替换不兼容的主文件）；
	 * primary 读不出来才退到 backup（并置 skipNextBackup）；两个都不存在 = 首次运行；两个都读不出来 = unreadable
	 * （绝不把读不出来的快照当成“空 catalog”）。
	 */
	private async readCatalogState(): Promise<CatalogStateRead> {
		let primaryError: unknown;
		try {
			const snapshot = await this.readCatalogFile(this.filePath);
			return {
				kind: "ok",
				entries: snapshot.entries,
				dismissedDshSessionIds: snapshot.dismissedDshSessionIds,
				dismissedRemoteSessionIds: snapshot.dismissedRemoteSessionIds,
				archivedRemoteSessions: snapshot.archivedRemoteSessions,
				revision: snapshot.revision,
				locatorNormalizationNeeded: snapshot.locatorNormalizationNeeded,
				skipNextBackup: false,
			};
		} catch (error) {
			primaryError = error;
			if (error instanceof UnsupportedSessionCatalogVersionError || error instanceof UnsupportedSessionCatalogLocatorError) {
				return { kind: "unsupported", error };
			}
		}
		let backupError: unknown;
		try {
			const snapshot = await this.readCatalogFile(this.backupFilePath());
			return {
				kind: "ok",
				entries: snapshot.entries,
				dismissedDshSessionIds: snapshot.dismissedDshSessionIds,
				dismissedRemoteSessionIds: snapshot.dismissedRemoteSessionIds,
				archivedRemoteSessions: snapshot.archivedRemoteSessions,
				revision: snapshot.revision,
				locatorNormalizationNeeded: snapshot.locatorNormalizationNeeded,
				skipNextBackup: true,
			};
		} catch (error) {
			backupError = error;
		}
		if (isMissingFileError(primaryError) && isMissingFileError(backupError)) return { kind: "empty" };
		return { kind: "unreadable", primary: primaryError instanceof Error ? primaryError.message : String(primaryError), backup: backupError instanceof Error ? backupError.message : String(backupError) };
	}

	/** 写事务的读步：重读磁盘并把内存对齐到它。读不出来就 fail closed，绝不猜成“空 catalog”。 */
	private async readFreshSnapshot(): Promise<{ state: SessionCatalogEntry[]; revision: number }> {
		const read = await this.readCatalogState();
		if (read.kind === "unsupported") throw read.error;
		if (read.kind === "unreadable") throw new Error(SESSION_CATALOG_NEEDS_REPAIR);
		if (read.kind === "empty") {
			this.entries = [];
			this.dismissedDshSessionIds = new Set();
			this.dismissedRemoteSessionIds = new Set();
			this.archivedRemoteSessions = new Map();
			this.revision = 0;
			this.skipNextBackup = false;
			return { state: this.entries, revision: 0 };
		}
		this.entries = preserveUnchangedRecords(this.entries, read.entries);
		this.dismissedDshSessionIds = read.dismissedDshSessionIds;
		this.dismissedRemoteSessionIds = read.dismissedRemoteSessionIds;
		this.archivedRemoteSessions = read.archivedRemoteSessions;
		this.revision = read.revision;
		this.skipNextBackup = read.skipNextBackup;
		return { state: this.entries, revision: read.revision };
	}

	/**
	 * 加载期归一化的落盘（best-effort）：只在磁盘仍是我们读到的那一版（revision 令牌相等）时才把内存里的
	 * 归一化结果写回；令牌不等 ⇒ 另一个实例已提交更新 ⇒ 放弃本次写（下次启动重试归一化）。
	 *
	 * 为什么不用 enqueueMutation：那里会把磁盘内容读回内存，而本方法的**写的是内存里的归一化结果**；
	 * 两者共用同一套锁与稳定码。跳过的代价只是一次重叠合并/清理延后一次启动，而错写的代价是丢别人的记录。
	 */
	private async persistLoadedNormalization(): Promise<void> {
		const expected = this.revision;
		const lock = await acquireStoreFileLock({
			rootDir: this.rootDir,
			lockPath: this.lockPath,
			unwritableCode: SESSION_CATALOG_LOCK_UNWRITABLE,
			bootId: currentBootId(),
			isProcessAlive: defaultIsProcessAlive,
			now: Date.now,
		});
		if (!lock) throw new Error(SESSION_CATALOG_BUSY);
		try {
			const fresh = await this.readCatalogState();
			const freshRevision = fresh.kind === "ok" ? fresh.revision : fresh.kind === "empty" ? 0 : -1;
			if (freshRevision !== expected) throw new Error(SESSION_CATALOG_REVISION_CONFLICT);
			await this.writeSnapshot(this.entries, expected + 1);
		} finally {
			await lock.release();
		}
	}

	private backupFilePath(): string {
		return `${this.filePath}.bak`;
	}

	private async readCatalogFile(filePath: string): Promise<{
		entries: SessionCatalogEntry[];
		dismissedDshSessionIds: Set<string>;
		dismissedRemoteSessionIds: Set<string>;
		archivedRemoteSessions: Map<string, ArchivedRemoteSessionEntry>;
		locatorNormalizationNeeded: boolean;
		revision: number;
	}> {
		const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<SessionCatalogFile>;
		if (parsed.version !== undefined && parsed.version !== 1) {
			throw new UnsupportedSessionCatalogVersionError();
		}
		const revision = readCatalogRevision(parsed.revision);
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
		// 渠道标志是渲染层显示标志的依据：只认白名单值，手改/未来版本的未知值按「无渠道」
		// 处理，不把未知字符串传给 UI（与 titleOrigin 等字段的读盘清洗同一口径）。
		for (const entry of entries) {
			if (entry.channel !== "wechat" && entry.channel !== "feishu") delete entry.channel;
		}
		const locatorNormalizationNeeded = entries.some((entry) => {
			if (entry.locator?.kind === "ssh") {
				return entry.filePath !== undefined || entry.originKey !== undefined || entry.piSessionId !== undefined || entry.wslDistro !== undefined || entry.wslUser !== undefined || entry.parentSessionPath !== undefined;
			}
			return entry.locator?.kind === "local" && (entry.filePath !== entry.locator.filePath || entry.environment !== entry.locator.environment || entry.wslDistro !== entry.locator.wslDistro || entry.wslUser !== entry.locator.wslUser);
		});
		const dismissed = Array.isArray(parsed.dismissedDshSessionIds) ? parsed.dismissedDshSessionIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
		// 远端墓碑同样宽容读出：单条身份残缺（缺 hostId / 缺 remoteSessionId）只丢弃那一条，不让整份
		// catalog 变成不可用——墓碑只是「别再列出来」的排除提示，丢一条的代价是列表多一条，不是数据丢失。
		const dismissedRemote = (Array.isArray(parsed.dismissedRemoteSessions) ? parsed.dismissedRemoteSessions : []).flatMap((value) => {
			if (!isRecord(value)) return [];
			const hostId = typeof value.hostId === "string" ? value.hostId.trim() : "";
			const remoteSessionId = typeof value.remoteSessionId === "string" ? value.remoteSessionId.trim() : "";
			return hostId.length === 0 || remoteSessionId.length === 0 ? [] : [remoteDismissalKey(hostId, remoteSessionId)];
		});
		// 归档索引同样宽容读出：单条残缺（缺身份/缺路径）只丢弃那一条，不让整份 catalog 不可用。
		const archivedRemoteSessions = new Map<string, ArchivedRemoteSessionEntry>();
		for (const value of Array.isArray(parsed.archivedRemoteSessions) ? parsed.archivedRemoteSessions : []) {
			const entry = readArchivedRemoteSessionEntry(value);
			if (entry !== undefined) archivedRemoteSessions.set(entry.sessionId, entry);
		}
		return {
			entries: entries.map(normalizeEntryLocator),
			dismissedDshSessionIds: new Set(dismissed),
			dismissedRemoteSessionIds: new Set(dismissedRemote),
			archivedRemoteSessions,
			locatorNormalizationNeeded,
			revision,
		};
	}

	private async writeSnapshot(entries: SessionCatalogEntry[], revision: number): Promise<void> {
		this.assertWritable();
		const snapshot: SessionCatalogFile = {
			version: 1,
			// 单调递增的写版本（INV-5a）：写者必须先读过同一版本才能提交，见 enqueueMutation。
			revision,
			sessions: entries.map(cloneEntry),
			// 旧 catalog 没有该字段；空数组也写出，重启后删除墓碑不丢。
			dismissedDshSessionIds: [...this.dismissedDshSessionIds],
			// 同上：远端墓碑也持久化，否则重启后「移除过的会话」会重新出现在可导入列表里。
			dismissedRemoteSessions: [...this.dismissedRemoteSessionIds].flatMap((key) => {
				const identity = readRemoteDismissalKey(key);
				return identity === undefined ? [] : [identity];
			}),
			// 归档索引同样持久化：丢它就是「归档了的远端会话既看不到也恢复不了」。
			archivedRemoteSessions: [...this.archivedRemoteSessions.values()].map((entry) => ({ ...entry })),
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
			// 写成功才算提交：内存状态与 revision 一起前进（与磁盘同源）。
			this.revision = revision;
			this.entries = entries;
		} finally {
			await unlink(tempPath).catch(() => undefined);
			await unlink(backupTempPath).catch(() => undefined);
		}
	}
}

export function didSessionPreferencesChange(entry: SessionCatalogEntry, patch: Pick<SessionCatalogEntry, "model" | "thinkingLevel">): boolean {
	return !equalModel(entry.model, patch.model) || entry.thinkingLevel !== patch.thinkingLevel;
}
