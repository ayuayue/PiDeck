/**
 * Codex rollout 的“非标准工具行”归一（custom_tool_call / web_search_call /
 * tool_search_call / image_generation_call / agent_message）。
 *
 * ── 为什么需要单独一层 ─────────────────────────────────────────
 * pi 只认 `assistant.content[].toolCall{id,name,arguments}` + 独立 toolResult 行；
 * 而 Codex 除标准 function_call 外还有一批语义化工具行，形态各不相同：
 *   - custom_tool_call{name,input}：apply_patch / exec（**主力工具，量最大**）
 *   - web_search_call{action:{query,queries}}：联网检索（只有查询词，没有结果正文）
 *   - tool_search_call{arguments} / tool_search_output{tools}：工具目录检索
 *   - image_generation_call{revised_prompt,result}：生图（result 是 base64）
 *   - agent_message{author,recipient,content}：多代理协作消息
 * 这些行过去被整段跳过 —— 会话打开后中间的工具调用凭空消失，与 Codex 原生界面
 * 看到的轨道对不上。本模块把它们统一映射成 (toolCall, toolResult) 对。
 *
 * 纯函数、无 Node 依赖，node:test 可直接加载。
 */

export type CodexNormalizedToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type CodexNormalizedToolResult = { id: string; name: string; text: string; isError: boolean };

export type CodexToolLine = {
	call: CodexNormalizedToolCall;
	result?: Omit<CodexNormalizedToolResult, "id" | "name"> & { text?: string; isError?: boolean };
	/** 该行不需要独立的 toolResult 行（如 tool_search_output 自带成对输出） */
	skipResult?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** 解析 custom_tool_call.input（apply_patch 是裸文本，exec 可能是 JSON 字符串）。 */
export function parseCodexToolInput(value: unknown): Record<string, unknown> {
	if (isRecord(value)) return value;
	if (typeof value !== "string") return {};
	const text = value.trim();
	if (!text) return {};
	try {
		const parsed = JSON.parse(text) as unknown;
		if (isRecord(parsed)) return parsed;
		if (typeof parsed === "string") return { input: parsed };
		return { input: parsed };
	} catch {
		// apply_patch 的 patch 正文不是 JSON：原样保留，工具卡按 input 文本展示
		return { input: value };
	}
}

/** custom_tool_call_output.output：通常是 {"output":…,"metadata":{…}} 的 JSON 字符串。 */
export function parseCodexToolOutput(value: unknown): { text: string; isError: boolean } {
	let text = "";
	let isError = false;
	let payload: unknown = value;
	if (typeof value === "string") {
		const trimmed = value.trim();
		try {
			payload = JSON.parse(trimmed) as unknown;
		} catch {
			return { text: value, isError: false };
		}
	}
	if (isRecord(payload)) {
		const output = payload.output ?? payload.content ?? payload.text;
		text = typeof output === "string" ? output : output === undefined ? "" : safeStringify(output);
		const metadata = isRecord(payload.metadata) ? payload.metadata : undefined;
		const exitCode = metadata?.exit_code ?? payload.exit_code ?? payload.exitCode;
		if (typeof exitCode === "number" && exitCode !== 0) isError = true;
		if (payload.is_error === true || payload.isError === true) isError = true;
	} else if (payload === undefined || payload === null) {
		text = "";
	} else {
		text = typeof payload === "string" ? payload : safeStringify(payload);
	}
	return { text, isError };
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/**
 * 把一条 Codex response_item 归一成 pi 的工具调用（可选自带结果）。
 * 不是工具行返回 null（调用方继续按普通消息处理）。
 *
 * @param payload response_item 的 payload
 * @param fallbackId 源缺 call_id 时用的兜底 id（调用方按 session 序号生成）
 */
export function normalizeCodexToolLine(payload: Record<string, unknown>, fallbackId: string): CodexToolLine | null {
	const type = readString(payload.type);

	if (type === "custom_tool_call") {
		const name = readString(payload.name) || "tool";
		const id = readString(payload.call_id) || readString(payload.id) || fallbackId;
		return { call: { id, name, arguments: parseCodexToolInput(payload.input) } };
	}

	if (type === "web_search_call") {
		const action = isRecord(payload.action) ? payload.action : {};
		const query = readString(action.query);
		const queries = Array.isArray(action.queries) ? action.queries.map((q) => String(q)).filter(Boolean) : [];
		return {
			call: {
				id: readString(payload.call_id) || readString(payload.id) || fallbackId,
				name: "web_search",
				arguments: {
					...(query ? { query } : {}),
					...(queries.length > 0 ? { queries } : {}),
				},
			},
			// web_search_call 只记录检索动作，结果正文不落在 rollout 里：留空结果行保持轨道完整。
			skipResult: false,
			result: { text: "（Codex 未在会话文件中保存联网检索结果正文）", isError: false },
		};
	}

	if (type === "tool_search_call") {
		const args = isRecord(payload.arguments) ? payload.arguments : {};
		return {
			call: {
				id: readString(payload.call_id) || readString(payload.id) || fallbackId,
				name: "tool_search",
				arguments: args,
			},
			// 结果在随后的 tool_search_output 行里（用同一 call_id 配对），这里不补空结果。
			skipResult: true,
		};
	}

	if (type === "image_generation_call") {
		const prompt = readString(payload.revised_prompt) || readString(payload.prompt);
		const id = readString(payload.call_id) || readString(payload.id) || fallbackId;
		return {
			call: {
				id,
				name: "image_generation",
				arguments: prompt ? { prompt } : {},
			},
			skipResult: true,
		};
	}

	if (type === "agent_message") {
		const author = readString(payload.author);
		const recipient = readString(payload.recipient);
		const content = Array.isArray(payload.content) ? payload.content : [];
		// 正文多数是 encrypted_content（不可读），只有 input_text 段能还原
		const text = content
			.map((item) => (isRecord(item) ? readString(item.text) : ""))
			.filter(Boolean)
			.join("\n")
			.trim();
		const id = readString(payload.call_id) || readString(payload.id) || fallbackId;
		return {
			call: {
				id,
				name: "agent_message",
				arguments: { ...(author ? { author } : {}), ...(recipient ? { recipient } : {}) },
			},
			skipResult: !text,
			...(text ? { result: { text, isError: false } } : {}),
		};
	}

	return null;
}

/** tool_search_output 的结果正文：把工具清单压成人类可读的一行行。 */
export function codexToolSearchOutputText(payload: Record<string, unknown>): string {
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const names: string[] = [];
	for (const item of tools) {
		if (!isRecord(item)) continue;
		if (item.type === "namespace") {
			const namespace = readString(item.name);
			const nested = Array.isArray(item.tools) ? item.tools : [];
			for (const child of nested) {
				if (!isRecord(child)) continue;
				const name = readString(child.name);
				if (name) names.push(namespace ? `${namespace}.${name}` : name);
			}
			continue;
		}
		const name = readString(item.name);
		if (name) names.push(name);
	}
	if (names.length === 0) return "（无匹配工具）";
	return `匹配到 ${names.length} 个工具：\n${names.map((name) => `- ${name}`).join("\n")}`;
}

/** image_generation_call 的 base64 图片结果（result 字段）是否可用。 */
export function codexImageGenerationResult(payload: Record<string, unknown>): string {
	const result = payload.result;
	return typeof result === "string" ? result.replace(/\s+/g, "") : "";
}
