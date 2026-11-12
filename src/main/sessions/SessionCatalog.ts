import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { readSshSessionLocator } from "../../shared/projectLocation";
import type { AgentBackend, AgentTab, SessionChannel, SessionEnvironment, SessionLocator, SessionModelPreference, SessionRecord, SessionSource, SessionSummary } from "../../shared/types";
import type { SessionProxyOverride } from "../../shared/types/session";
import { SessionLocatorRouter } from "./SessionLocatorRouter";
import { getAppLogger } from "../logging/sharedLogger";
import { withStoreFileCas } from "../persistence/storeFileCas";
import { preserveUnchangedRecords } from "../persistence/preserveRecordIdentity";
import type { RemoteReferenceWriteGuard } from "../remote/RemoteReferenceWriteGuard";
import { assertHostRebindRecordIds, canonicalHostLocatorJson, isHostRebindRecordId, type HostRebindRecordOutcome, type HostRebindRecordPatch, type HostRebindRecordResult, type HostRebindRecordSnapshot, type HostRebindStorePort } from "../remote/HostRebindJournal";
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
import { buildSessionIdAliasMap } from "../../shared/sessionIdAliases";
import { arbitrateRuntimeMergeTitle, isFileSession, mergeSourceGroupInto } from "./sessionCatalogIdentityRepair";
import type { SessionTitleFallbackKind } from "./sessionNameLine";
import { readArchivedRemoteSessionEntry, type CatalogSnapshotState, type CatalogStateRead, persistLoadedNormalization, readCatalogState, remoteDismissalKey, writeCatalogSnapshot } from "./catalog/catalogFileStore";
import { attachRemoteLocatorEntry, type CatalogMutation, cloneEntry, cloneModelPreference, CONTROL_CHARS_RE, isSessionLocator, equalModel, isRecord, normalizeEntryLocator, recordFromEntry, remoteSessionEntryChanged, type SshSessionLocator, sessionLocatorForEntry, setLocalSessionFilePath } from "./catalog/catalogEntryProjection";
import { createCatalogDraft, type CreateDraftInput } from "./catalog/catalogDraftCreate";
import { migrateLoadedCatalogEntries } from "./catalog/catalogLoadMigration";
import { mergeScannedIntoCatalog, type ScannedMergeOptions } from "./catalog/catalogScannedMerge";
import { assignTitleOrigin, catalogDisplayTitle, claimAutomaticTitle, isPlaceholderCatalogTitle, isTitleLocked, resolveTitleOrigin } from "./catalog/catalogTitleOwnership";

/** 端口边界只允许稳定码（设计 §4.4）：recorder 自己的 needs-repair 码 + 收敛侧的"结果未知"。 */
const SESSION_CATALOG_NEEDS_REPAIR = "SESSION_CATALOG_NEEDS_REPAIR";
const REBIND_UNKNOWN_OUTCOME = "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME";
import { SESSION_CATALOG_BUSY, SESSION_CATALOG_LOCK_UNWRITABLE, SESSION_CATALOG_REVISION_CONFLICT } from "./catalog/catalogStoreCodes";

export { SESSION_CATALOG_BUSY, SESSION_CATALOG_LOCK_UNWRITABLE, SESSION_CATALOG_REVISION_CONFLICT };
export { isSessionLocator };
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

export type SessionCatalogFile = {
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

/** 远端墓碑条目（P4.5a）：catalog 文件里持久化的「用户已从列表移除」的远端会话身份。
 *  具名而不是内联：跨 store 契约要求每个 hostId 字段都有可归属的属主（内联会变成 <unscoped>）。 */
export type DismissedRemoteSessionEntry = { hostId: string; remoteSessionId: string };

export type SessionCatalogContext = {
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

	/** 「行被移除」监听：任何路径（删除 / 归档 / 删项目 / 外部删除清理 / 清洗）让会话行消失后触发一次。 */
	private readonly rowsRemovedListeners = new Set<(sessionIds: string[]) => void>();

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

	/**
	 * 订阅「会话行被移除」。覆盖 remove / removeWithDescendants / removeByProjectId / removeByFilePath /
	 * mergeScanned 的清理，以及草稿 / 匿名会话的内存条目；被同源归并吸收（别名仍指向存活行）的 id 不算移除。
	 * 回调同步触发、异常被吞掉，不影响写事务；需要异步收尾的订阅者自己兜底。
	 */
	onRowsRemoved(listener: (sessionIds: string[]) => void): () => void {
		this.rowsRemovedListeners.add(listener);
		return () => {
			this.rowsRemovedListeners.delete(listener);
		};
	}

	private notifyRowsRemoved(sessionIds: Iterable<string>): void {
		const ids = [...new Set(sessionIds)].filter((id) => {
			const survivor = this.mergedIdAliases.get(id);
			return !(survivor && this.entries.some((entry) => entry.id === survivor));
		});
		if (ids.length === 0) return;
		for (const listener of this.rowsRemovedListeners) {
			try {
				listener(ids);
			} catch {
				// 订阅者失败不影响 catalog
			}
		}
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
		const migration = await migrateLoadedCatalogEntries(this.entries, {
			originKeyForEntry: (entry) => this.originKeyForEntry(entry),
			resolveFilePath: this.resolveFilePath,
			fetchTitle: this.fetchTitle,
		});
		this.entries = migration.entries;
		// 以上归一化只在内存里做完了；**落盘**交给下面这一次写事务：它只在磁盘仍是我们读到的那一版
		// （revision 令牌相等）时才把内存结果写回，否则放弃本次写（下次启动重试）。若照内存快照直接
		// 整份重写，就会把另一个实例刚提交的记录一起丢掉（INV-5a）。
		this.loaded = true;
		if (migration.migrated || locatorNormalizationNeeded || this.skipNextBackup) {
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
		return recordFromEntry(entry);
	}

	removeTransient(id: string): boolean {
		this.assertLoaded();
		const removed = this.transientEntries.delete(id);
		if (removed) this.notifyRowsRemoved([id]);
		return removed;
	}

	getRecord(id: string): SessionRecord | undefined {
		const entry = this.get(id);
		return entry ? recordFromEntry(entry) : undefined;
	}

	getLocator(id: string): SessionLocator | undefined {
		const entry = this.get(id);
		return entry ? sessionLocatorForEntry(entry) : undefined;
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
					const locator = entry ? sessionLocatorForEntry(entry) : undefined;
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
					const current = sessionLocatorForEntry(entries[index]);
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

	async createDraft(input: CreateDraftInput): Promise<SessionRecord> {
		this.assertLoaded();
		const entry = await createCatalogDraft(
			{
				dismissedDshSessionIds: () => this.dismissedDshSessionIds,
				identityContext: this.identityContext,
				enqueueMutation: <T>(mutate: CatalogMutation<T>) => this.enqueueMutation(mutate),
			},
			input,
		);
		return recordFromEntry(entry);
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
			return recordFromEntry(transient);
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
		return recordFromEntry(entry);
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
			return recordFromEntry(transient);
		}
		const entry = await this.enqueueMutation((entries) => {
			const nextEntry = this.requireEntry(entries, sessionId);
			const claimed = claimAutomaticTitle(nextEntry, nextTitle, source);
			if (claimed) nextEntry.updatedAt = Date.now();
			return { value: cloneEntry(nextEntry), changed: claimed };
		});
		return recordFromEntry(entry);
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
			return recordFromEntry(transient);
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
		return claimed ? recordFromEntry(entry) : undefined;
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
			return recordFromEntry(transient);
		}
		const entry = await this.enqueueMutation((entries) => {
			const nextEntry = this.requireEntry(entries, sessionId);
			if (isTitleLocked(nextEntry)) return { value: cloneEntry(nextEntry), changed: false };
			assignTitleOrigin(nextEntry, "manual");
			nextEntry.updatedAt = Date.now();
			return { value: cloneEntry(nextEntry), changed: true };
		});
		return recordFromEntry(entry);
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
			if (input.remoteLocator) return attachRemoteLocatorEntry(entries, entry, input.remoteLocator);
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

	async remove(id: string): Promise<boolean> {
		this.assertLoaded();
		const requestedId = this.resolveSessionId(id);
		if (this.transientEntries.delete(requestedId)) {
			this.notifyRowsRemoved([requestedId]);
			return true;
		}
		return this.enqueueMutation((entries) => {
			// 执行时解析：排队期间同源归并可能已把旧 ID 吸收进存活条目。
			const entry = this.findEntryInTransaction(entries, requestedId);
			if (!entry) return { value: false, changed: false };
			entries.splice(entries.indexOf(entry), 1);
			return { value: true, changed: true };
		});
	}

	/**
	 * 子树解析的单一实现：`listSubtreeEntries`（读）与 `removeWithDescendants`（写）共用，
	 * 免得“磁盘要处理哪些文件”与“要摘哪些记录”两处判定漂移。
	 */
	private subtreeOf(id: string): { entries: SessionCatalogEntry[]; ids: string[] } | undefined {
		const requestedId = this.resolveSessionId(id);
		const parent = this.transientEntries.get(requestedId) ?? this.entries.find((entry) => entry.id === requestedId);
		if (!parent) return undefined;
		const entries = this.listEntries().filter((entry) => entry.projectId === parent.projectId);
		return { entries, ids: collectSessionSubtreeIds(entries, parent) };
	}

	/**
	 * 子树成员（含自身）的当前 catalog 条目。
	 *
	 * 与 `removeWithDescendants` 用同一套判定（`collectSessionSubtreeIds` + projectId 隔离），
	 * 但只读不写：磁盘侧的归档/删除要在摘记录之前先知道「还有哪些子会话文件也得一起处理」。
	 * 平铺子代理（与父会话同目录、`parentSessionPath` 指回父文件）不在 `<stem>/` 里，
	 * `SessionScanner.archive/delete` 覆盖不到它们。
	 */
	listSubtreeEntries(id: string): SessionCatalogEntry[] {
		this.assertLoaded();
		const subtree = this.subtreeOf(id);
		if (!subtree) return [];
		const byId = new Map(subtree.entries.map((entry) => [entry.id, entry] as const));
		return subtree.ids
			.map((sessionId) => byId.get(sessionId))
			.filter((entry): entry is SessionCatalogEntry => entry !== undefined)
			.map(cloneEntry);
	}

	/** 归档/删除父会话时清掉整棵子树。
	 *
	 * 磁盘侧 `SessionScanner.archive/delete` 会把 sibling `<stem>/` 一并移走，但
	 * `remove(id)` 只摘一条；`mergeScanned` 只增改不删，列表缓存会把失去父节点的
	 * 子会话孤儿提升成顶层行，再点开就是残留聊天框。匿名会话和草稿没有 filePath，
	 * 不会被当成后代。其它项目即使路径碰巧相似，也按 projectId 隔离。
	 */
	async removeWithDescendants(id: string): Promise<string[]> {
		this.assertLoaded();
		const subtree = this.subtreeOf(id);
		if (!subtree) return [];
		const { ids } = subtree;

		const removed: string[] = [];
		for (const sessionId of ids) {
			if (this.transientEntries.delete(sessionId)) removed.push(sessionId);
		}
		if (removed.length > 0) this.notifyRowsRemoved(removed);
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
			return recordFromEntry(transient);
		}
		const entry = await this.enqueueMutation((entries) => {
			const nextEntry = this.requireEntry(entries, requestedId);
			if (nextEntry.status === "draft") nextEntry.status = "active";
			nextEntry.updatedAt = Date.now();
			return { value: cloneEntry(nextEntry), changed: true };
		});
		return recordFromEntry(entry);
	}

	/**
	 * 删除侧栏项目时清掉该项目下全部 catalog 映射（含 DSH 导入）。
	 * host 会话文件仍在 $DSH_HOME，但不再自动挂回侧栏；用户手动导入才会再出现。
	 */
	async removeByProjectId(projectId: string): Promise<number> {
		this.assertLoaded();
		// 引用写入与引用删除都必须在有 rebind 事务时退让（设计 §3.1 方案 A 的 advisory interlock）。
		if (this.referenceGuard) await this.referenceGuard.assertRebindIdle();
		const removedTransient: string[] = [];
		for (const [id, entry] of this.transientEntries) {
			if (entry.projectId !== projectId) continue;
			this.transientEntries.delete(id);
			removedTransient.push(id);
		}
		if (removedTransient.length > 0) this.notifyRowsRemoved(removedTransient);
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
					return { value: { record: recordFromEntry(existing), created: false }, changed: false };
				}
				next.updatedAt = nextUpdatedAt;
				if (titleTarget !== undefined) {
					next.title = titleTarget;
					assignTitleOrigin(next, "fallback");
				}
				entries[entries.indexOf(existing)] = next;
				return { value: { record: recordFromEntry(next), created: false }, changed: true };
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
			return { value: { record: recordFromEntry(entry), created: true }, changed: true };
		});
	}

	async mergeScanned(
		projectId: string,
		summaries: SessionSummary[],
		context: SessionCatalogContext = this.identityContext,
		options: ScannedMergeOptions = {},
	): Promise<SessionRecord[]> {
		this.assertLoaded();
		return mergeScannedIntoCatalog(
			{
				entries: this.entries,
				transientEntries: this.transientEntries,
				livenessProbe: this.sessionLivenessProbe,
				probedFallbackTitles: this.probedFallbackTitles,
				fetchTitle: this.fetchTitle,
				enqueueMutation: <T>(mutate: CatalogMutation<T>) => this.enqueueMutation(mutate),
			},
			projectId,
			summaries,
			context,
			options,
		);
	}

	/** 对新文件、未确认 provisional 标题，或需要一次性回填旧子代理父关系的条目读取会话头。
	 * 已锁定 catalog 标题不会因为文件 mtime 变化而补读：PiDeck 已持久化显示名，
	 * 也不再关心 JSONL 中段或尾部追加的 session_info。标题读取仍顺带校验会话头、
	 * 补平铺子代理父关系和 fork 标记。 */
	/** #488 存量自愈：已探过的 fallback 条目（每进程一次）。与 #266 legacy 探测同构——
	 *  命中即改、不命中不再重读，避免每次扫描都为一个不可能自愈的条目读盘。 */
	private readonly probedFallbackTitles = new Set<string>();

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
				let removedIds: string[] = [];
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
						// 重试时 mutate 会再跑一遍：每次都重算，只留最后（真正落盘）那次的差集。
						removedIds = [];
						if (result.changed) {
							const kept = new Set(nextEntries.map((entry) => entry.id));
							removedIds = fresh.filter((entry) => !kept.has(entry.id)).map((entry) => entry.id);
						}
						return result.changed ? { state: nextEntries, changed: true, value: result.value } : { state: fresh, changed: false, value: result.value };
					},
					write: (state, revision) => this.writeSnapshot(state, revision),
				});
				// 归并别名索引必须随条目集合前进（删除会让旧 ID 指向不存在的记录）。
				this.rebuildMergedIdAliases();
				if (removedIds.length > 0) this.notifyRowsRemoved(removedIds);
				return value;
			});
		this.writeQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/** 读**磁盘**上的最新 catalog（primary → backup → 首次运行的空状态）。读取规则与实现见 catalog/catalogFileStore.ts。 */
	private async readCatalogState(): Promise<CatalogStateRead> {
		return await readCatalogState(this.filePath);
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

	/** 加载期归一化的落盘（best-effort）：锁 + revision 令牌校验的实现见 catalog/catalogFileStore.ts。 */
	private async persistLoadedNormalization(): Promise<void> {
		await persistLoadedNormalization(this.filePath, this.entries, this.revision, this.snapshotState(), () => this.assertWritable());
	}

	/** 落盘要写的非会话状态（墓碑 / 归档索引 / 备份轮换位）；只在写事务内部取一次快照。 */
	private snapshotState(): CatalogSnapshotState {
		return {
			dismissedDshSessionIds: this.dismissedDshSessionIds,
			dismissedRemoteSessionIds: this.dismissedRemoteSessionIds,
			archivedRemoteSessions: this.archivedRemoteSessions,
			skipNextBackup: this.skipNextBackup,
		};
	}
	private async writeSnapshot(entries: SessionCatalogEntry[], revision: number): Promise<void> {
		await writeCatalogSnapshot(this.filePath, entries, revision, this.snapshotState(), () => this.assertWritable());
		// 写成功才算提交：内存状态与 revision 一起前进（与磁盘同源）。
		this.skipNextBackup = false;
		this.revision = revision;
		this.entries = entries;
	}
}

export function didSessionPreferencesChange(entry: SessionCatalogEntry, patch: Pick<SessionCatalogEntry, "model" | "thinkingLevel">): boolean {
	return !equalModel(entry.model, patch.model) || entry.thinkingLevel !== patch.thinkingLevel;
}
