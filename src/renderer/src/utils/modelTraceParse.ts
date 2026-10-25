/**
 * 模型请求轨迹（model trace）解析器：把 pi 发给供应商的原始请求体（payloadJson）
 * 解析成统一的视图模型，供 RPC 日志面板的轨迹详情结构化展示。
 *
 * 兼容两种方言（pi 按供应商选择 wire 格式）：
 * - OpenAI：system 在 messages[0].role="system"；assistant 的工具调用在 tool_calls；
 *   工具结果以 role="tool" 消息回传。
 * - Anthropic：system 是顶层字段（string 或 [{type:"text"}]）；content 是块数组，
 *   工具调用/结果分别是 tool_use / tool_result 块。
 *
 * 纯函数、无副作用：截断/畸形 payload 不抛异常，降级为 truncated 视图模型，
 * 由 UI 兜底显示原始 JSON。
 */

/** 单个内容块（按展示形态分类，原始方言差异在此抹平） */
export type TraceBlock = { type: "text"; text: string } | { type: "thinking"; text: string } | { type: "image"; label: string } | { type: "tool_call"; id?: string; name: string; args: string } | { type: "tool_result"; id?: string; name?: string; text: string; isError?: boolean };

export type TraceRole = "user" | "assistant" | "tool";

export interface TraceMessage {
	role: TraceRole;
	blocks: TraceBlock[];
	/** 全部文本块的总字符数（行摘要里的体量指标） */
	chars: number;
}

export interface ModelTraceView {
	dialect: "openai" | "anthropic" | "unknown";
	model?: string;
	stream?: boolean;
	maxTokens?: number;
	reasoningEffort?: string;
	/** 系统提示词（含技能上下文等装配产物）；分段按空行切，便于折叠展示 */
	system?: { text: string; segments: string[] };
	messages: TraceMessage[];
	tools: Array<{ name: string; description?: string }>;
	/** payload 被桥截断（>1.5MB）或 JSON 不完整：结构化视图不完整，UI 显示原始 JSON 兜底 */
	truncated: boolean;
	parseError?: string;
}

/** 提取块里的可读文本（tool_result 内容可能是 string 或块数组，统一拼成文本） */
function flattenContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content == null ? "" : safeJsonStringify(content);
	return content.map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "")).join("\n");
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return "";
	}
}

/** 工具调用参数：对象直接格式化，字符串（OpenAI arguments 是 JSON 字符串）原样透出 */
function formatToolArgs(args: unknown): string {
	if (typeof args === "string") return args;
	if (args == null) return "";
	return safeJsonStringify(args);
}

function blockChars(blocks: TraceBlock[]): number {
	return blocks.reduce((total, block) => total + (block.type === "text" || block.type === "thinking" || block.type === "tool_result" ? block.text.length : block.type === "tool_call" ? block.args.length : 0), 0);
}

function buildMessage(role: TraceRole, blocks: TraceBlock[]): TraceMessage {
	return { role, blocks, chars: blockChars(blocks) };
}

/** OpenAI 方言：messages[].content 为 string 或 [{type:"text"|"image_url"}]，工具调用在 assistant.tool_calls */
function parseOpenAiMessage(raw: Record<string, unknown>): TraceMessage | undefined {
	const role = raw.role;
	const content = raw.content;
	const blocks: TraceBlock[] = [];
	if (typeof content === "string") {
		if (content) blocks.push({ type: "text", text: content });
	} else if (Array.isArray(content)) {
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const entry = part as Record<string, unknown>;
			if (entry.type === "text" && typeof entry.text === "string") blocks.push({ type: "text", text: entry.text });
			else if (entry.type === "image_url") blocks.push({ type: "image", label: typeof entry.image_url === "object" && entry.image_url !== null ? "image" : "image_url" });
			else blocks.push({ type: "text", text: safeJsonStringify(entry) });
		}
	}
	// assistant 的工具调用：tool_calls[{id, function:{name, arguments}}]
	if (Array.isArray(raw.tool_calls)) {
		for (const call of raw.tool_calls) {
			if (!call || typeof call !== "object") continue;
			const entry = call as Record<string, unknown>;
			const fn = (entry.function ?? {}) as Record<string, unknown>;
			blocks.push({ type: "tool_call", id: typeof entry.id === "string" ? entry.id : undefined, name: typeof fn.name === "string" ? fn.name : "unknown", args: formatToolArgs(fn.arguments) });
		}
	}
	if (blocks.length === 0) return undefined;
	if (role === "user") return buildMessage("user", blocks);
	if (role === "assistant") return buildMessage("assistant", blocks);
	// role === "tool"：工具结果回传（content 即结果文本）
	return buildMessage("tool", [...blocks.map((block) => (block.type === "text" ? ({ type: "tool_result", text: block.text } satisfies TraceBlock) : block))]);
}

/** Anthropic 方言：content 为块数组（text/image/tool_use/tool_result/thinking），system 在顶层 */
function parseAnthropicMessage(raw: Record<string, unknown>): TraceMessage | undefined {
	const role = raw.role === "assistant" ? "assistant" : "user";
	const content = raw.content;
	const blocks: TraceBlock[] = [];
	if (typeof content === "string") {
		if (content) blocks.push({ type: "text", text: content });
	} else if (Array.isArray(content)) {
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const entry = part as Record<string, unknown>;
			switch (entry.type) {
				case "text":
					if (typeof entry.text === "string" && entry.text) blocks.push({ type: "text", text: entry.text });
					break;
				case "thinking":
					if (typeof entry.thinking === "string" && entry.thinking) blocks.push({ type: "thinking", text: entry.thinking });
					break;
				case "image":
					blocks.push({ type: "image", label: "image" });
					break;
				case "tool_use":
					blocks.push({ type: "tool_call", id: typeof entry.id === "string" ? entry.id : undefined, name: typeof entry.name === "string" ? entry.name : "unknown", args: formatToolArgs(entry.input) });
					break;
				case "tool_result":
					blocks.push({ type: "tool_result", id: typeof entry.tool_use_id === "string" ? entry.tool_use_id : undefined, text: flattenContentText(entry.content), isError: entry.is_error === true });
					break;
				default:
					blocks.push({ type: "text", text: safeJsonStringify(entry) });
			}
		}
	}
	if (blocks.length === 0) return undefined;
	// tool_result 块出现在 user 角色消息里（Anthropic 协议），展示角色统一归为 tool 更直观
	const hasToolResult = blocks.some((block) => block.type === "tool_result");
	return buildMessage(hasToolResult ? "tool" : role, blocks);
}

function parseSystemField(system: unknown): { text: string; segments: string[] } | undefined {
	let text: string | undefined;
	if (typeof system === "string") text = system;
	else if (Array.isArray(system)) text = flattenContentText(system);
	if (!text) return undefined;
	return { text, segments: text.split(/\n\s*\n/).filter(Boolean) };
}

/**
 * 解析完整请求体 JSON。失败（截断/畸形）返回 truncated 视图模型而不是抛异常——
 * 采集端对超限 payload 只保头部，展开时 UI 要能兜底显示原始文本。
 */
export function parseModelTracePayload(payloadJson: string): ModelTraceView {
	let payload: unknown;
	try {
		payload = JSON.parse(payloadJson);
	} catch (error) {
		return { dialect: "unknown", messages: [], tools: [], truncated: true, parseError: error instanceof Error ? error.message : String(error) };
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return { dialect: "unknown", messages: [], tools: [], truncated: true, parseError: "payload is not an object" };
	}
	const body = payload as Record<string, unknown>;
	const rawMessages = Array.isArray(body.messages) ? body.messages : [];
	// 方言判定按特异性特征（不能用「content 是否为数组」：OpenAI 的多模态 user 消息也是块数组，且块里同样有 type:"text"）：
	// - OpenAI 独有：role="tool" 消息、assistant.tool_calls、content 块 type="image_url"、messages[0].role="system"
	// - Anthropic 独有：顶层 system 字段、content 块 type ∈ {tool_use, tool_result, thinking}
	const hasOpenAiMarker =
		rawMessages.some((m) => {
			if (!m || typeof m !== "object") return false;
			const entry = m as Record<string, unknown>;
			if (entry.role === "tool" || Array.isArray(entry.tool_calls)) return true;
			return Array.isArray(entry.content) && (entry.content as unknown[]).some((b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "image_url");
		}) ||
		(rawMessages.length > 0 && (rawMessages[0] as Record<string, unknown> | null)?.role === "system");
	const hasAnthropicMarker =
		body.system !== undefined ||
		rawMessages.some((m) => {
			if (!m || typeof m !== "object" || !Array.isArray((m as Record<string, unknown>).content)) return false;
			return ((m as Record<string, unknown>).content as unknown[]).some((b) => {
				if (!b || typeof b !== "object") return false;
				const type = (b as Record<string, unknown>).type;
				return type === "tool_use" || type === "tool_result" || type === "thinking";
			});
		});
	const isAnthropic = !hasOpenAiMarker && hasAnthropicMarker;

	const view: ModelTraceView = {
		dialect: isAnthropic ? "anthropic" : "openai",
		model: typeof body.model === "string" ? body.model : undefined,
		stream: body.stream === true,
		maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : typeof body.max_completion_tokens === "number" ? (body.max_completion_tokens as number) : undefined,
		reasoningEffort: typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined,
		messages: [],
		tools: [],
		truncated: false,
	};

	if (isAnthropic) {
		view.system = parseSystemField(body.system);
		for (const raw of rawMessages) {
			if (!raw || typeof raw !== "object") continue;
			const message = parseAnthropicMessage(raw as Record<string, unknown>);
			if (message) view.messages.push(message);
		}
	} else {
		// OpenAI：system/developer 消息抽出来做系统提示词区，其余进消息流
		const systemTexts: string[] = [];
		for (const raw of rawMessages) {
			if (!raw || typeof raw !== "object") continue;
			const entry = raw as Record<string, unknown>;
			if ((entry.role === "system" || entry.role === "developer") && typeof entry.content === "string") {
				systemTexts.push(entry.content);
				continue;
			}
			const message = parseOpenAiMessage(entry);
			if (message) view.messages.push(message);
		}
		if (systemTexts.length > 0) view.system = parseSystemField(systemTexts.join("\n\n"));
	}

	// 工具定义：Anthropic [{name,description}] / OpenAI [{function:{name,description}}]
	if (Array.isArray(body.tools)) {
		for (const raw of body.tools) {
			if (!raw || typeof raw !== "object") continue;
			const entry = raw as Record<string, unknown>;
			const fn = (entry.function ?? entry) as Record<string, unknown>;
			const name = typeof fn.name === "string" ? fn.name : undefined;
			if (!name) continue;
			view.tools.push({ name, description: typeof fn.description === "string" ? fn.description : undefined });
		}
	}
	return view;
}

/** 消息行的折叠摘要（单行，供列表态快速扫读） */
export function summarizeTraceMessage(message: TraceMessage): string {
	const first = message.blocks.find((block) => block.type === "text" || block.type === "tool_call" || block.type === "tool_result");
	if (!first) return "";
	const text = first.type === "tool_call" ? `${first.name}(${first.args.replace(/\s+/g, " ").slice(0, 60)})` : first.type === "tool_result" ? first.text : first.text;
	return text.replace(/\s+/g, " ").trim().slice(0, 96);
}
