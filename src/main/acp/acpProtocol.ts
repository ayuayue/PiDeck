/**
 * ACP (Agent Client Protocol) v1 协议消息类型。
 *
 * 仅覆盖 PiDeck 作为 ACP client 所需的子集：stdio NDJSON 上的 JSON-RPC 2.0。
 * 类型按官方规范 https://agentclientprotocol.com/protocol/v1/ 手写收口，
 * 不引入 @agentclientprotocol/sdk（协议面小，且需要与 PiLocator 的
 * Windows 启动通道 / env 清洗深度配合，见 AcpConnection）。
 *
 * 约定：未知 sessionUpdate kind、未知 configOption type 一律保留原值透传/忽略，
 * 不得抛错——规范要求 client 对未识别内容优雅降级。
 */

/** JSON-RPC 2.0 client → agent 请求（带 id，等待响应）。 */
export type AcpRpcRequest = {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: Record<string, unknown>;
};

/** JSON-RPC 2.0 agent → client 请求（双向协议：agent 也会调我们）。 */
export type AcpIncomingRequest = {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: Record<string, unknown>;
};

/** JSON-RPC 2.0 响应（result 与 error 互斥）。 */
export type AcpRpcResponse = {
	jsonrpc: "2.0";
	id: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
};

/** JSON-RPC 2.0 通知（无 id）。 */
export type AcpRpcNotification = {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
};

export type AcpJsonRpcMessage = AcpIncomingRequest | AcpRpcResponse | AcpRpcNotification;

// ── initialize ─────────────────────────────────────────────────────────────

/**
 * 我们声明的 client 能力。首版刻意最小化：
 * - 不声明 fs（readTextFile/writeTextFile）：agent 用自己的文件工具直接读写磁盘，
 *   与 pi 后端同构；PiDeck 不做 agent 的文件代理。
 * - 不声明 terminal：agent 自带 bash/exec 工具。
 * - loadAgent：支持 session/list + session/load 恢复（agent 声明能力时才调用）。
 */
export type AcpClientCapabilities = {
	loadAgent: boolean;
	fs?: { readTextFile?: boolean; writeTextFile?: boolean };
	terminal?: boolean;
};

/** agent 在 initialize 响应里声明的能力；缺失字段 = 不支持，不得调用对应方法。 */
export type AcpAgentCapabilities = {
	loadSession?: {};
	promptCapabilities?: { agentThought?: boolean; agentThoughtSeries?: boolean };
	sessionCapabilities?: {
		list?: {};
		delete?: {};
		/** 会话可报告 additionalDirectories（v1 扩展）。 */
		additionalDirectories?: {};
	};
	/** _meta 扩展字段原样保留（各 CLI 自有扩展，如 codex-acp 的认证/沙箱配置）。 */
	_meta?: Record<string, unknown>;
};

export type AcpInitializeResult = {
	protocolVersion: number;
	agentCapabilities: AcpAgentCapabilities;
	/** agent 对 human-readable 名（显示用）。 */
	name?: string;
	_meta?: Record<string, unknown>;
};

// ── 内容块（prompt 与 tool_call 共用）───────────────────────────────────────

export type AcpTextBlock = { type: "text"; text: string };
export type AcpImageBlock = { type: "image"; data: string; mimeType: string };
export type AcpResourceLinkBlock = { type: "resource_link"; uri: string; name: string };
export type AcpContentBlock = AcpTextBlock | AcpImageBlock | AcpResourceLinkBlock;

/** tool_call 内容块（在 ContentBlock 之上扩展 diff / terminal）。 */
export type AcpDiffContent = {
	type: "diff";
	path: string;
	oldValue: string;
	newValue: string;
	/** v1 draft 扩展：diff 类型（missing/add/remove/change）；缺失按 unified diff 文本渲染。 */
	kind?: "missing" | "add" | "remove" | "change";
};
export type AcpTerminalContent = { type: "terminal"; terminalId: string };
export type AcpToolCallContent = AcpContentBlock | AcpDiffContent | AcpTerminalContent;

// ── session setup ──────────────────────────────────────────────────────────

export type AcpMcpServer = {
	name: string;
	command: string;
	args?: string[];
	env?: Record<string, string>;
};

export type AcpSessionNewParams = {
	cwd: string;
	mcpServers?: AcpMcpServer[];
};

/** configOptions：agent 暴露的会话级配置选择器（模型/模式/推理档位等）。 */
export type AcpConfigOptionValue = {
	value: string;
	name: string;
	description?: string;
	_meta?: Record<string, unknown>;
};

export type AcpConfigOptionGroup = {
	group: string;
	name: string;
	options: AcpConfigOptionValue[];
};

export type AcpConfigOption = {
	id: string;
	name: string;
	description?: string;
	/** select | boolean（boolean 需 client 通告支持，agent 对旧 client 应降级为 select）。 */
	type?: "select" | "boolean";
	currentValue?: string | boolean;
	options?: Array<AcpConfigOptionValue | AcpConfigOptionGroup>;
	/** 语义类别（mode/model/model_config/thought_level），仅 UX 提示用。 */
	category?: string;
	_meta?: Record<string, unknown>;
};

export type AcpSessionSetupResult = {
	sessionId: string;
	/** 旧 API：会话模式；新 agent 应同时提供 configOptions。 */
	modes?: Array<{ id: string; name: string }>;
	currentModeId?: string;
	configOptions?: AcpConfigOption[];
	/** 会话标题（部分 agent 在 new/load 时即返回）。 */
	title?: string;
	_meta?: Record<string, unknown>;
};

// ── session/prompt ─────────────────────────────────────────────────────────

export type AcpSessionPromptParams = {
	sessionId: string;
	prompt: AcpContentBlock[];
};

export type AcpSessionPromptResult = {
	stopReason: "end_turn" | "cancelled" | "aborted" | "error";
	_meta?: Record<string, unknown>;
};

// ── session/update 通知载荷 ────────────────────────────────────────────────

export type AcpPlanEntry = {
	content: string;
	priority?: "high" | "medium" | "low";
	status: "pending" | "in_progress" | "completed";
};

export type AcpToolCallUpdate = {
	sessionUpdate: "tool_call";
	toolCallId: string;
	title: string;
	/** execute（shell/文件编辑等）| read（读文件/搜索等只读）。 */
	kind: "execute" | "read";
	/** pending → in_progress → completed | failed；in_progress 内容可多次追加。 */
	status: "pending" | "in_progress" | "completed" | "failed";
	content: AcpToolCallContent[];
	/** 涉及的代码位置（file:line 锚点）。 */
	locations?: Array<{ path: string; line?: number }>;
	_meta?: Record<string, unknown>;
};

export type AcpSessionUpdate =
	| { sessionUpdate: "user_message_chunk"; content: AcpContentBlock }
	| { sessionUpdate: "agent_message_chunk"; content: AcpTextBlock }
	| { sessionUpdate: "agent_thought_chunk"; content: AcpTextBlock | { type: "reasoning"; text: string } }
	| AcpToolCallUpdate
	| { sessionUpdate: "plan"; plan: AcpPlanEntry[] }
	| { sessionUpdate: "current_mode_update"; currentModeId: string }
	| { sessionUpdate: "available_commands_update"; commands: Array<{ name: string; description?: string; _meta?: Record<string, unknown> }> }
	| { sessionUpdate: "session_info_update"; sessionTitle?: string | null; updatedAt?: string | null; _meta?: Record<string, unknown> }
	| { sessionUpdate: "config_option_update"; configOptions: AcpConfigOption[] }
	/** 未知/后续版本新增的 update：保留原值，由投影层决定忽略。 */
	| ({ sessionUpdate: string } & Record<string, unknown>);

export type AcpSessionUpdateNotification = {
	jsonrpc: "2.0";
	method: "session/update";
	params: {
		sessionId: string;
		update: AcpSessionUpdate;
		/** v1 draft 扩展：update 序号（部分 CLI 提供乱序保护）。 */
		updateId?: number;
	};
};

// ── permission（agent → client 请求）───────────────────────────────────────

export type AcpPermissionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export type AcpPermissionOption = {
	kind: AcpPermissionKind;
	name?: string;
	_meta?: Record<string, unknown>;
};

/** 请求中的被许可对象；v1 定义 command / read_path / write_path / web_search 等变体。 */
export type AcpPermissionRequestItem = { type: "command"; command: string; cwd?: string } | { type: "read_path"; path: string } | { type: "write_path"; path: string } | { type: "web_search" } | ({ type: string } & Record<string, unknown>);

export type AcpPermissionRequestParams = {
	sessionId: string;
	options: AcpPermissionOption[];
	permissions: AcpPermissionRequestItem[];
	_meta?: Record<string, unknown>;
};

export type AcpPermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

// ── session/list 与 session/load（loadAgent 能力，agent 声明时才用）────────

export type AcpSessionInfo = {
	sessionId: string;
	cwd: string;
	title?: string;
	updatedAt?: string;
	_meta?: Record<string, unknown>;
};

/** JSON-RPC 错误码常量（规范/JSON-RPC 2.0 约定）。 */
export const ACP_ERROR_CODE = {
	/** kimi acp 等用 -32000 表示 AUTH_REQUIRED（未登录）。 */
	authRequired: -32000,
} as const;
