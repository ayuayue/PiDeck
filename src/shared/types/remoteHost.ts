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

export type RemoteHostListResult = { ok: true; status: "ready" | "needs-repair"; hosts: RemoteHostListItem[]; repair?: RemoteHostRepairSummary[] } | { ok: false; code: "REMOTE_FEATURE_DISABLED" | "REMOTE_HOST_LIST_UNAVAILABLE" };

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
export type RemoteHostConfigScanResult = { ok: true; candidates: RemoteHostConfigCandidate[]; skipped: { alias: string; reason: "wildcard" | "invalid" | "unsupported-directive" }[]; user: string } | { ok: false; code: string };

/** 手动添加的字段（与扫描候选共用同一套提交路径）。 */
export type RemoteHostAddInput = {
	label: string;
	hostName: string;
	user?: string;
	port?: number | null;
	identityFile?: string | null;
};

/**
 * 指纹确认请求：主进程 → 渲染层推送。
 *
 * `requestId` 是 main-only broker 签发的一次性凭证，渲染层**只能回答它**，不能自己构造候选。
 * 指纹列在这里是因为它是用户**必须亲眼看**的内容——确认的本质就是「这个指纹是不是我核过的那个」。
 */
export type RemoteHostPinRequest = {
	requestId: string;
	expiresAt: number;
	hostId: string;
	hostName: string;
	user: string;
	port: number;
	hostKeyFingerprints: string[];
};

/** 添加主机的阶段结果：`pending` 表示已推送指纹确认、等待用户回答。 */
export type RemoteHostAddResult = { ok: true; hostId: string; status: "pending" } | { ok: false; code: string };

/** 回答指纹确认的结果。`hostId` 在成功时回显，便于 UI 定位到刚添加的那一行。 */
export type RemoteHostPinAnswerResult = { ok: true; hostId: string; approved: boolean } | { ok: false; code: string };

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
export type RemoteHostRepairAction = "complete-activation-from-pin" | "discard-orphan-pin" | "clear-stale-lock" | "rebuild-target-and-rebind" | "forget-trust-anchor" | "inspect-snapshot-pair" | "refresh-then-recheck" | "fix-filesystem-permissions" | "human-review";

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

/** 列目录结果；超出 helper 的条目上限时**拒绝**而不是截断。 */
export type RemoteWorkspaceListResult = { ok: true; entries: RemoteWorkspaceEntry[] } | { ok: false; code: string };

/** 读文件结果；`content` 是 base64（跨 IPC 传输二进制）。 */
export type RemoteWorkspaceReadResult = { ok: true; contentBase64: string; bytes: number; mtimeMs: number } | { ok: false; code: string };

/** 已确认的浏览根：canonical 路径由主进程持有，界面只显示它。 */
export type RemoteWorkspaceRootResult = { ok: true; canonicalPath: string } | { ok: false; code: string };

/** 浏览根确认请求：主进程 → 渲染层推送（与指纹确认同一套 broker 规矩）。 */
export type RemoteWorkspaceRootRequest = { requestId: string; expiresAt: number; hostId: string; label: string; requestedPath: string; canonicalPath: string };

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

/** 发起登记的结果：`pending` 表示已推送确认、等用户回答。 */
export type RemoteProjectEnrollResult = { ok: true; status: "pending"; hostId: string; canonicalPath: string } | { ok: false; code: string };

/** 回答登记确认的结果；批准时回显新项目的 stable id。 */
export type RemoteProjectEnrollAnswerResult = { ok: true; enrolled: boolean; projectId?: string } | { ok: false; code: string };

/**
 * 按 projectId 的只读远端浏览（Phase 3 第二段）。
 *
 * 与 `remoteWorkspace*`（按 hostId + 临时确认 root）的区别：这里的根来自 `ProjectStore` 中该项目
 * 持有的 canonical `remotePath`，因此可以跨重启恢复。渲染层只给 `projectId` 与**相对路径**，
 * 由 main 解析 host/root；绝对路径与 `..` 在触达 reader 前被拒。
 */
export type RemoteProjectListResult = { ok: true; entries: RemoteWorkspaceEntry[] } | { ok: false; code: string };

/** 读项目内文件的结果；`contentBase64` 跨 IPC 传二进制。 */
export type RemoteProjectReadResult = { ok: true; contentBase64: string; bytes: number; mtimeMs: number } | { ok: false; code: string };
