/**
 * ACP (Agent Client Protocol) v1 协议消息类型。
 *
 * 类型来源分三层：
 * 1. **SDK 派生**（`import type`，零运行时）：与官方规范同步、且形状与 PiDeck
 *    消费面一致的类型直接派生自 @agentclientprotocol/sdk，升级 SDK 即跟进规范。
 * 2. **SDK + 扩展**：SDK 类型之上补充真实 CLI 流量的扩展字段
 *    （如 promptCapabilities.agentThought，SDK 1.4 尚未收录）。
 * 3. **本地保留**：宽容/代差类型——真实流量与最新 schema 有出入的（diff 字段名、
 *    扁平 configOption、plan entries 可缺 priority 等）、与 AcpConnection 行协议
 *    耦合的 JSON-RPC 信封。这些以「实测流量」为准，不从 SDK 派生，避免类型撒谎。
 *
 * 约定：未知 sessionUpdate kind、未知 configOption type 一律保留原值透传/忽略，
 * 不得抛错——规范要求 client 对未识别内容优雅降级。
 */

import type { AgentCapabilities, ClientCapabilities, ContentBlock, InitializeResponse, PermissionOption, PermissionOptionKind, PromptCapabilities, PromptResponse, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse, SessionInfo, StopReason, ToolCallUpdate } from "@agentclientprotocol/sdk";

/** ACP 协议握手版本(v1)。 */
export const ACP_PROTOCOL_VERSION = 1;

// ── JSON-RPC 信封（本地：与 AcpConnection 行协议耦合，SDK 侧抽象成方法联合）──

export type AcpRpcId = number | string;

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
	id: AcpRpcId;
	method: string;
	params?: Record<string, unknown>;
};

/** JSON-RPC 2.0 响应（result 与 error 互斥）。 */
export type AcpRpcResponse = {
	jsonrpc: "2.0";
	id: AcpRpcId;
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

// ── initialize（SDK 派生 + agentThought 扩展）──────────────────────────────

/**
 * 我们声明的 client 能力。首版刻意最小化：
 * - 不声明 fs（readTextFile/writeTextFile）：agent 用自己的文件工具直接读写磁盘，
 *   与 pi 后端同构；PiDeck 不做 agent 的文件代理。
 * - 不声明 terminal：agent 自带 bash/exec 工具。
 * 会话恢复由 agentCapabilities.loadSession 门控，不虚构 client 的 loadAgent 能力。
 */
export type AcpClientCapabilities = ClientCapabilities;

/**
 * SDK PromptCapabilities 未收录 agentThought/agentThoughtSeries（部分 CLI 的
 * 扩展能力字段，实测流量存在），本地补齐；其余字段随 SDK。
 */
export type AcpPromptCapabilities = PromptCapabilities & {
	agentThought?: boolean;
	agentThoughtSeries?: boolean;
};

/** agent 在 initialize 响应里声明的能力；缺失字段 = 不支持，不得调用对应方法。 */
export type AcpAgentCapabilities = Omit<AgentCapabilities, "promptCapabilities"> & {
	promptCapabilities?: AcpPromptCapabilities;
	/** 会话可报告 additionalDirectories（v1 扩展），SDK 1.4 已收录 sessionCapabilities。 */
};

/** SDK 把 agentCapabilities 声明为可选；PiDeck 握手必读，交集恢复必填，消费方不动。 */
export type AcpInitializeResult = InitializeResponse & {
	agentCapabilities: AcpAgentCapabilities;
};

// ── 内容块（prompt 与 tool_call 共用；SDK 派生三臂提取）─────────────────────

/** SDK ContentBlock 含 audio/resource 变体；PiDeck 只产出/消费 text|image|resource_link。 */
export type AcpTextBlock = Extract<ContentBlock, { type: "text" }>;
export type AcpImageBlock = Extract<ContentBlock, { type: "image" }>;
export type AcpResourceLinkBlock = Extract<ContentBlock, { type: "resource_link" }>;
export type AcpContentBlock = AcpTextBlock | AcpImageBlock | AcpResourceLinkBlock;

// ── tool_call 内容（本地：diff 字段名与 SDK 1.4 有代差）─────────────────────

/**
 * tool_call 内容块（在 ContentBlock 之上扩展 diff / terminal）。
 * 本地保留原因：SDK 1.4 的 Diff 用 oldText/newText，而 v1 draft 及部分 CLI 流量
 * 用 oldValue/newValue + kind 扩展；主进程不逐字段读 diff（渲染层走工具参数），
 * 类型以实测流量口径记录。两种字段名的归一在渲染层完成。
 */
export type AcpDiffContent = {
	type: "diff";
	path: string;
	/** null 表示新建文件。 */
	oldValue?: string | null;
	newValue: string;
	/** v1 draft 扩展：diff 类型（missing/add/remove/change）；缺失按 unified diff 文本渲染。 */
	kind?: "missing" | "add" | "remove" | "change";
};
export type AcpTerminalContent = { type: "terminal"; terminalId: string };
export type AcpToolCallContent = { type: "content"; content: AcpContentBlock } | AcpDiffContent | AcpTerminalContent;

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

/** SDK 派生：五值枚举与 v1 完全一致。 */
export type AcpStopReason = StopReason;

export type AcpSessionPromptResult = PromptResponse;

// ── session/update 通知载荷（联合本地：宽容优先）────────────────────────────

/**
 * 本地保留原因：SDK 1.4 联合是新一代 schema（ContentChunk 带 messageId、
 * plan_update/compaction_* 新变体、config_option_update 换判别形状），而 PiDeck
 * 面向 v1 实测流量 + 未知变体透传，末臂宽容必须保留。
 */
export type AcpPlanEntry = {
	content: string;
	/** SDK 1.4 把 priority 定为必填，但实测流量可缺，类型不得撒谎。 */
	priority?: "high" | "medium" | "low";
	status: "pending" | "in_progress" | "completed";
};

/**
 * 工具更新是字段补丁：省略字段保持原值，content/locations 出现则整表替换。
 * 标量字段 SDK 派生；content 载荷保留本地宽容形状（diff 字段名代差，见 AcpDiffContent）。
 */
export type AcpToolCallUpdate = Omit<ToolCallUpdate, "content"> & {
	sessionUpdate: "tool_call" | "tool_call_update";
	content?: AcpToolCallContent[] | null;
};

export type AcpSessionUpdate =
	| { sessionUpdate: "user_message_chunk"; content: AcpContentBlock }
	| { sessionUpdate: "agent_message_chunk"; content: AcpContentBlock }
	| { sessionUpdate: "agent_thought_chunk"; content: AcpTextBlock | { type: "reasoning"; text: string } }
	| AcpToolCallUpdate
	| { sessionUpdate: "plan"; entries: AcpPlanEntry[] }
	| { sessionUpdate: "current_mode_update"; currentModeId: string }
	| { sessionUpdate: "available_commands_update"; commands: Array<{ name: string; description?: string; _meta?: Record<string, unknown> }> }
	| { sessionUpdate: "session_info_update"; title?: string | null; updatedAt?: string | null; _meta?: Record<string, unknown> }
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

// ── permission（agent → client 请求；SDK 派生，形状与 v1 一致）──────────────

export type AcpPermissionKind = PermissionOptionKind;
export type AcpPermissionOption = PermissionOption;
export type AcpPermissionRequestParams = RequestPermissionRequest;
export type AcpPermissionOutcome = RequestPermissionOutcome;
export type AcpPermissionResult = RequestPermissionResponse;

/** load 保留请求中的身份，标准响应不要求 sessionId。 */
export type AcpSessionLoadResult = Omit<AcpSessionSetupResult, "sessionId"> & { sessionId?: string };

// ── session/list（SDK 派生；会话列表消费方容忍额外可选字段）─────────────────

export type AcpSessionInfo = SessionInfo;

/** JSON-RPC 错误码常量（规范/JSON-RPC 2.0 约定）。 */
export const ACP_ERROR_CODE = {
	/** kimi acp 等用 -32000 表示 AUTH_REQUIRED（未登录）。 */
	authRequired: -32000,
} as const;
