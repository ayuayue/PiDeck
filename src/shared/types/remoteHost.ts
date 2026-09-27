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
