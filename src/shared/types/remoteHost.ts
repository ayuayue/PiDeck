import type { Op } from "../op";

export type RemoteHostListItem = {
	id: string;
	label: string;
	sshHost: string;
	verified: boolean;
	disabled: boolean;
};

export type RemoteHostRepairSummary = {
	reason: string;
	classification: "orphan-pin" | "anchor-invalid" | "lock" | "snapshot" | "write-uncertain" | "unknown";
	hostIds: string[];
};

export type RemoteHostListResult =
	| { ok: true; status: "ready" | "needs-repair"; hosts: RemoteHostListItem[] /** 当前连接状态（仅主进程有实时状态的会话）：视图重新挂载时用来补一次快照。 */; states?: Record<string, RemoteHostConnectionState>; repair?: RemoteHostRepairSummary[] }
	| { ok: false; code: "REMOTE_FEATURE_DISABLED" | "REMOTE_HOST_LIST_UNAVAILABLE" };

/**
 * 连接开关的状态。这是**主机的连接状态**，与 Agent 的 send state 分开建模（设计文档 §10）：
 * 主机 ready 不代表每个 Agent runtime 都 ready。
 */
export type RemoteHostConnectionState = "disconnected" | "connecting" | "probing" | "bootstrapping" | "ready" | "degraded" | "reconnecting" | "offline" | "needs-attention";

/** 连接运行的阶段，用于把「卡在哪一步」告诉用户而不泄漏命令与路径。 */
export type RemoteHostConnectionPhase = "openssh" | "authenticate" | "platform" | "node" | "helper" | "pi";

/**
 * 一条脱敏诊断。只承载可枚举的状态/阶段/稳定码，**结构上无法**携带命令、身份文件路径、
 * fingerprint 或响应正文——这些都不该出现在渲染层。
 */
export type RemoteHostDiagnosticEntry = {
	state: RemoteHostConnectionState;
	phase: RemoteHostConnectionPhase;
	code: string;
	at: string;
	exitCode?: number;
};

/**
 * connect 的结果。失败一律是稳定码，不把主进程异常消息直接透给渲染层。
 *
 * `hostId` 是**回显**：调用方已经知道自己请求的是哪台主机，回显让响应保持可归因（并发请求
 * 交错时不会认错）。它不持久化任何东西，因此不构成阻碍 profile 退役的引用——这正是
 * cross-store 契约把这三个结果类型归给 `runtime`（`canHoldHostReferences: false`）的理由。
 */
export type RemoteHostOperationFailure = { ok: false; hostId: string; code: string };

export type RemoteHostConnectResult = { ok: true; hostId: string; state: RemoteHostConnectionState } | RemoteHostOperationFailure;

/**
 * remove 的结果：成功即本机 profile/pin 已退役（远端数据不受影响）。
 * 仍被项目/会话引用时返回 REMOTE_HOST_REFERENCED，由调用方先移除引用。
 */
export type RemoteHostRemoveResult = { ok: true; hostId: string } | RemoteHostOperationFailure;

/** 目录浏览只返回目录名与是否符号链接；文件、大小与内容都不出主进程。 */
/** `isSymlink` 只在列举能判定它的链路上给出（SSH 探测判、WSL 单层列举不判），缺省即「未知」而不是「不是」。 */
export type RemoteDirectoryEntry = { name: string; isSymlink?: boolean };

export type RemoteDirectoryListResult = { ok: true; hostId: string; path: string; entries: RemoteDirectoryEntry[]; truncated: boolean } | RemoteHostOperationFailure;

/** disconnect 的结果：成功或稳定码（主机 id 非法、功能未启用等）。 */
export type RemoteHostDisconnectResult = { ok: true; hostId: string } | RemoteHostOperationFailure;

/** diagnostics 的结果：按主机取有界历史。 */
export type RemoteHostDiagnosticsResult = { ok: true; hostId: string; entries: RemoteHostDiagnosticEntry[] } | RemoteHostOperationFailure;

/**
 * 从 `~/.ssh/config` 扫描出的可添加候选。与主进程解析器的输出同形，但仍在本层重新声明：
 * 渲染层只能依赖 `shared` 契约，不能 import 主进程模块。
 */
export type RemoteHostConfigCandidate = {
	alias: string;
	hostName: string;
	user: string;
	port: number | null;
	identityFile: string | null;
};

/** 扫描结果。`skipped` 让 UI 能解释「为什么某台主机没出现」，而不是静默少一项。 */
export type RemoteHostConfigScanResult = { ok: true; candidates: RemoteHostConfigCandidate[]; skipped: { alias: string; reason: "wildcard" | "invalid" | "unsupported-directive" }[]; user: string; identityFiles: string[] } | { ok: false; code: string };

/** 手动添加的字段（与扫描候选共用同一套提交路径）。 */
/** 编辑补丁：只带要改的字段；缺省字段保持原值。 */
export type RemoteHostUpdatePatch = { label?: string; hostName?: string; user?: string; port?: number; identityFile?: string; authMethod?: "password" };

export type RemoteHostUpdateResult = { ok: true; hostId: string; endpointChanged: boolean; verified: boolean } | (RemoteHostOperationFailure & { saved?: true });

/** 编辑表单初值；`secret: null` 表示没有保存口令（或本机无法解密）。 */
export type RemoteHostEditDraft = { label: string; hostName: string; user?: string; port?: number; identityFile?: string; authMethod?: "password" };
export type RemoteHostEditDraftResult = { ok: true; hostId: string; draft: RemoteHostEditDraft; secret: string | null } | RemoteHostOperationFailure;

export type RemoteHostAddInput = {
	label: string;
	hostName: string;
	user?: string;
	port?: number | null;
	identityFile?: string | null;
	/** `password` pins the key first and authenticates later with an in-memory secret. */
	authMethod?: "password";
};

/**
 * 添加主机的阶段结果。
 *
 * `verified` = 已在主进程完成首次 host key 信任（TOFU）并落盘 pin，主机立刻可连接。没有
 * `pending` 这种中间态：首次信任不需要用户逐字比对指纹（主机密钥变化时走的是连接期校验，
 * 不会在这里被静默接受）。
 */
export type RemoteHostAddResult = { ok: true; hostId: string; status: "verified" } | { ok: false; code: string };

/** Result of the native file picker used for a private key. The path is absolute; nothing is read here. */
export type RemoteHostPickIdentityFileResult = { ok: true; path: string } | { ok: false; code: string };

/**
 * 连接状态变化推送。
 *
 * `connect()` 只能返回它当时到达的状态，之后发生的迁移（degraded、重连、ready 之后的 shutdown）
 * 只能靠推送到达——否则界面会停在过期的状态上（实跑：连接已 ready，界面却显示「已离线」）。
 */
export type RemoteHostStateChange = { hostId: string; state: RemoteHostConnectionState };

/**
 * 修复诊断与执行。
 *
 * 为什么要有这条通道：store 一旦进入 `needs-repair` 就拒绝一切写入（这是对的——它发现了跨文件不一致），
 * 但在此之前的界面只显示一句 `REMOTE_HOST_STORE_NEEDS_REPAIR`：用户看不出**哪坏了**、也**没有出路**。
 * 持久化面有四处（主文件、备份、写锁、pin 目录），任何一处残留都会进这个状态，靠手工删文件不是出路。
 *
 * 分类与动作与主进程 `RemoteHostRepair` 一致；这里重新声明是分层要求（渲染层只能依赖 shared）。
 */
export type RemoteHostRepairClassification = "orphan-pin" | "anchor-invalid" | "lock" | "snapshot" | "write-uncertain" | "unknown";

/** 诊断给出的**合法**动作。界面只能从这些里选，不能自己发明。 */
export type RemoteHostRepairAction = "complete-activation-from-pin" | "discard-orphan-pin" | "clear-stale-lock" | "clear-rebind-lock" | "rebuild-target-and-rebind" | "forget-trust-anchor" | "inspect-snapshot-pair" | "refresh-then-recheck" | "fix-filesystem-permissions" | "human-review";

export type RemoteHostRepairFinding = {
	reason: string;
	classification: RemoteHostRepairClassification;
	hostIds: string[];
	actions: RemoteHostRepairAction[];
};

export type RemoteHostRepairDiagnosisResult = { ok: true; findings: RemoteHostRepairFinding[] } | { ok: false; code: string };

/**
 * 修复确认请求：主进程 → 渲染层推送。
 *
 * 修复会写 store 或删 pin，属于高风险操作，因此和指纹确认同一套规矩：main 签发一次性 requestId，
 * 渲染层只能回答同意/拒绝，动作与目标由 main 持有。
 */
export type RemoteHostRepairRequest = { requestId: string; expiresAt: number; action: RemoteHostRepairAction; hostId?: string; label: string };

/** 发起修复的结果：`pending` 表示已推送确认、等用户回答。 */
export type RemoteHostRepairRunResult = { ok: true; status: "pending" } | { ok: false; code: string };

/** 回答修复确认的结果。 */
export type RemoteHostRepairAnswerResult = { ok: true; ran: boolean } | { ok: false; code: string };

/**
 * 远端工作区读取（Phase 3 第一段：只读）。
 *
 * 有意**不**经过 `ProjectStore`：远端路径因此不会出现在 `Project` 上，本地 fs 的消费点（359 处）
 * 在类型与数据上都不可能拿到它。持久化登记（远端项目入库）是后续独立一步，届时需要逐点审计。
 *
 * 路径一律是**相对于已确认 root** 的 POSIX 相对路径（根为空串），不是绝对路径：
 * root 由主进程在确认时 canonical 化并持有，渲染层只能给出相对位置，不能自己命名边界。
 */
export type RemoteWorkspacePathKind = "file" | "directory" | "other";

export type RemoteWorkspaceEntry = { name: string; kind: RemoteWorkspacePathKind; bytes?: number };

/**
 * 远端项目登记（Phase 3 第二段）。
 *
 * 与浏览根的确认是**两个不同的用户决定**：这个是把一个已确认的 canonical 目录变成**持久项目**
 * （写 `ProjectStore`），那个只是打开一个只读浏览边界。因此二者有独立通道、独立 broker action
 * 与独立的 pending 表，互不串扰。
 *
 * 渲染层只能提交 `{ hostId, candidatePath }`；canonical 值由 main 在已 pin 连接上解析并持有，
 * 确认框展示的也是 canonical 值。
 */
export type RemoteProjectEnrollRequest = { requestId: string; expiresAt: number; hostId: string; label: string; requestedPath: string; canonicalPath: string };

/**
 * 登记模式（Phase 5 文件面）：`existing` 是缺省且行为不变的「使用已有目录」；
 * `create` 才走「新建空目录」——目标此刻尚不存在，因此 create 模式的 pending 结果没有 canonicalPath。
 */
export type RemoteProjectEnrollMode = "existing" | "create";

/** 发起登记的结果：`pending` 表示已推送确认、等用户回答。create 模式的目标尚不存在，故不回显 canonicalPath。 */
export type RemoteProjectEnrollResult = Op<{ status: "pending"; hostId: string; canonicalPath?: string }>;

/** 回答登记确认的结果；批准时回显新项目的 stable id。 */
export type RemoteProjectEnrollAnswerResult = Op<{ enrolled: boolean; projectId?: string }>;

/**
 * 「新建空远端项目」确认请求（独立于既有目录的登记确认：动作、broker 表与推送通道都分开）。
 *
 * main 只做字符串层 parent/leaf 拆分并把两者绑进 stateDigest；确认框展示父目录与叶名两行，
 * 用户确认的就是「将创建哪个绝对路径」。路径仍以绝对形态出现在**请求**里（enroll 的既有例外），
 * 创建命令的全部校验/规范化由 main 在已 pin 的连接上完成。
 */
export type RemoteProjectCreateRequest = { requestId: string; expiresAt: number; hostId: string; requestedPath: string; parentPath: string; leaf: string };

/** 回答 create 确认的结果；批准并成功登记时回显新项目的 stable id。 */
export type RemoteProjectCreateAnswerResult = Op<{ enrolled: boolean; projectId?: string }>;

/**
 * 按 projectId 的只读远端浏览（Phase 3 第二段）。
 *
 * 与已删除的 `remoteWorkspace*`（按 hostId + 临时确认 root 的浏览）的区别：这里的根来自
 * `ProjectStore` 中该项目持有的 canonical `remotePath`，因此可以跨重启恢复。渲染层只给
 * `projectId` 与**相对路径**，由 main 解析 host/root；绝对路径与 `..` 在触达 reader 前被拒。
 */
/**
 * `revision` 是目录事实的版本：值被替换或标脏时递增。两个读者拿到同一个数 = 看到同一份事实，
 * 所以树与面板不再各自「再问一遍确认一下」。
 */
export type RemoteProjectListResult = Op<{ entries: RemoteWorkspaceEntry[]; revision: number; truncated: boolean; scanned: number }>;

/** 读项目内文件的结果；`contentBase64` 跨 IPC 传二进制。 */
export type RemoteProjectReadResult = Op<{ contentBase64: string; bytes: number; mtimeMs: number }>;

/**
 * 下载结果。
 *
 * `canceled` 是用户动作而不是失败：界面不该为「点了取消」弹错误。
 * `path` 只在成功时出现，是本机绝对路径（远端路径不进这个结构）。
 */
/** 下载：`canceled` 是用户的动作而不是失败——把它放在成功载荷里，失败分支就只剩稳定码。 */
export type RemoteProjectDownloadResult = Op<{ canceled: true } | { canceled?: false; path: string; bytes: number }>;

/**
 * 上传结果。
 *
 * `uploaded` 只列真正写到远端的文件名（不含远端路径），`failed` 逐项说明哪个没传上去、为什么——
 * 多选上传里一个失败不该让整批结果变成一个笼统的布尔值。
 */
export type RemoteProjectUploadResult = Op<{ canceled: true } | { canceled?: false; uploaded: Array<{ name: string; bytes: number }>; failed: Array<{ name: string; code: string }> }>;

/** 一条文件名匹配；`path` 是**相对项目根**的 POSIX 路径，渲染层不得当成本机路径。 */
export type RemoteProjectSearchEntry = { path: string; name: string; kind: RemoteWorkspacePathKind; bytes?: number };

/**
 * 项目内文件名搜索结果。
 *
 * `truncated` 必须如实呈现：它表示遍历在某一项上限处收束（匹配数 / 已扫描条目 / 深度 / 单目录条目），
 * 因此界面可以说「结果已截断」，而不是把一屏结果伪装成完整答案。
 */
export type RemoteProjectSearchResult = Op<{ entries: RemoteProjectSearchEntry[]; scanned: number; truncated: boolean }>;

/**
 * 一条远端会话文件（Phase 3 第三段，只读发现）。
 *
 * `remoteSessionId` 是远端文件的稳定身份 = 相对会话根的 POSIX 路径；渲染层绝不能把它当本机路径。
 */
export type RemoteSessionEntry = {
	remoteSessionId: string;
	/** 本批与 remoteSessionId 同值（冻结设计第 4 条）。 */
	remotePath: string;
	/** 文件名 stem —— **暂定**标题，不是解析出来的会话名（按需头部解析留待下一增量）。 */
	name: string;
	size: number;
	mtimeMs: number;
};

/**
 * 一个远端项目**已确认 root** 的最近一次复核结果（Phase 3 第四批，设计 (i) 项目级）。
 *
 * 刻意是项目级而不是主机级：漂移属于某一个项目的持久路径，若把它升级成主机级 needs-attention，
 * 一个目录被挪动就会阻断同主机上所有其他项目的读取。`needs-attention` 时 `code` 是稳定的失败码。
 */
export type RemoteProjectRootStatusResult = Op<{
	status: "ok" | "needs-attention";
	code?: string;
	/**
	 * 最近一次 helper 握手声明的能力（只读诊断用）：渲染层据此判断远端内容搜索等功能是否可用。
	 * 旧 helper 不声明或连接尚未建立时缺席——缺席表示「未知/不支持」，一律走能力回退，不猜。
	 */
	helperCapabilities?: readonly string[];
}>;

/**
 * 一次事实失效的范围（目录/Git 共用）。路径是**项目根相对**路径；`status` 的 `repoPath` 也是项目相对。
 *
 * 这是跨 IPC 推送的载荷，所以放在契约层：主进程只标脏，读仍由活跃消费者发起。
 */
export type RemoteProjectFactsScope =
	| { kind: "dir"; path: string }
	| { kind: "repos" }
	| { kind: "status"; repoPath: string }
	/**
	 * 整棵树的事实失效（Git 写成功后使用）：子树条目可能整块变化，但不是「根目录事件」——根事件只重读根层。
	 * 渲染层收到后重读根与全部已加载目录，保留展开集与 currentDir；不用于普通文件写。
	 */
	| { kind: "tree" };

/**
 * 事实变化通知：至少携带 projectId、generation 与被标脏的 scopes。
 *
 * `generation` 是连接代（稳定 helper 身份）；渲染层跨代一律丢弃缓存。空串表示主进程当时不持有
 * 稳定身份（例如断连后），渲染层仍以“同一个项目有一次失效”为准。
 */
export type RemoteProjectFactsChange = { projectId: string; generation: string; scopes: RemoteProjectFactsScope[] };

export type RemoteSessionScanValue = { entries: RemoteSessionEntry[] };
export type RemoteSessionScanResult = ({ ok: true } & RemoteSessionScanValue) | { ok: false; code: string };
/** IPC 结果面（T9）：scanner 内部仍用扁平结果（受保护测试），这里只做边界封装。 */
export type RemoteSessionScanIpcResult = Op<RemoteSessionScanValue>;

/**
 * 一条远端会话的**按需**标题（Phase 3 第四批；I1 把 origin 拆成三档）。
 *
 * 读取是**两段式**：先有界头窗口（≤64 KiB），头内没有权威名时再补一次有界尾窗口（≤64 KiB）——
 * pi 的 `/name` 权威名是**追加在文件尾**的。单次解析最多 1 次 sizing stat + 头读 + 尾读，各自字节有界。
 *
 * `titleOrigin` 必须如实区分三档（口径冻结）：
 * - `"authoritative"`：标题来自**名字字段**——pi 的 `session_info`，或旧版 PiDeck 私有 `sessionName` 行；
 * - `"inferred"`：内容派生的弱兜底（首条 user/assistant 文本，经共享剥块清洗）；
 * - `"fallback"`：文件名 stem 兜底（解析不出时**绝不编造**）。
 *
 * 界面据此决定是否标注「暂定」：只有 `authoritative` 是会话的真实名字。
 *
 * `tailDegraded`（K2-3）如实上报「尾窗口读取失败」：标题与档位仍是头部窗口那份（诚实降级、绝不编造），
 * 但调用方/界面必须能知道「这次没有看到文件尾」——权威名可能就藏在尾窗口里。只在真的降级时出现，
 * 缺省（undefined）即正常；旧读取方忽略这个字段也不会把它当错误。
 */
export type RemoteSessionTitleValue = { title: string; titleOrigin: "authoritative" | "inferred" | "fallback"; tailDegraded?: boolean };
export type RemoteSessionTitleResult = ({ ok: true } & RemoteSessionTitleValue) | { ok: false; code: string };
export type RemoteSessionTitleIpcResult = Op<RemoteSessionTitleValue>;

export type RemoteSessionRegisterValue = { sessionId: string; created: boolean; remoteSessionId: string; remotePath: string };
export type RemoteSessionRegisterResult = ({ ok: true } & RemoteSessionRegisterValue) | { ok: false; code: string };
export type RemoteSessionRegisterIpcResult = Op<RemoteSessionRegisterValue>;

/* ----------------------------- 重新绑定（host rebind，设计 §3.2/§4） ----------------------------- */

/** tx 状态（§4.3）；界面只显示这四种，不显示 pid/bootId/时间戳。 */
export type RemoteHostRebindTxState = "idle" | "journal-present" | "busy" | "lock-unreadable";

/** journal 阶段（§4.1）：只用来显示"大概在哪一步"，不承担完成判定。 */
export type RemoteHostRebindStage = "prepared" | "source-disabled" | "projects-written" | "sessions-written" | "source-retired" | "committed";

/** 预检结果（②）：只有计数与稳定码，不含 recordId、路径或 pin 字节。 */
export type RemoteHostRebindSummary = {
	readonly sourceHostId: string;
	readonly targetHostId: string;
	readonly records: { readonly projects: number; readonly sessions: number };
	readonly referenceScan: { readonly complete: boolean; readonly count: number };
	/** Non-fatal stable tokens from the plan (empty today; reserved so the field never changes shape). */
	readonly warnings: readonly string[];
	readonly tx: RemoteHostRebindTxState;
};

/** 终态（INV-10）：committed 带或不带非致命遗留。 */
export type RemoteHostRebindOutcome = {
	readonly code: "REMOTE_HOST_REBIND_COMMITTED" | "REMOTE_HOST_REBIND_COMMITTED_WITH_WARNINGS";
	readonly stage: RemoteHostRebindStage;
	readonly migratedProjects: number;
	readonly migratedSessions: number;
	readonly sourceRetired: boolean;
	readonly warnings: readonly string[];
};

export type RemoteHostRebindPlanResult = { ok: true; summary: RemoteHostRebindSummary; requestId: string; expiresAt: number } | { ok: false; code: string };

export type RemoteHostRebindAnswerResult = { ok: true; ran: false } | { ok: true; ran: true; outcome: RemoteHostRebindOutcome } | { ok: false; code: string };

export type RemoteHostRebindPending =
	| { readonly present: false; readonly tx: RemoteHostRebindTxState }
	| {
			readonly present: true;
			readonly tx: RemoteHostRebindTxState;
			readonly stage: RemoteHostRebindStage;
			readonly sourceHostId: string;
			readonly targetHostId: string;
			readonly records: { readonly projects: number; readonly sessions: number };
			readonly referenceScan: { readonly complete: boolean; readonly count: number };
	  };

export type RemoteHostRebindDescribeResult = { ok: true; pending: RemoteHostRebindPending } | { ok: false; code: string };

export type RemoteHostRebindResumeResult = { ok: true; resumed: boolean; outcome?: RemoteHostRebindOutcome } | { ok: false; code: string };
