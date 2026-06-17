/**
 * CardRunState — 飞书流式卡片的运行时状态机
 *
 * 参考 Proma 的 card-run-state.ts 实现。
 * 把 AgentManager 的事件累积成结构化的 RunState，
 * 便于渲染层无时序地把状态转成 CardKit 2.0 JSON。
 *
 * 所有 reducer 是纯函数：reduce(state, event) → state。
 */

export type ToolStatus = "running" | "done" | "error";

export interface ToolEntry {
	id: string;
	name: string;
	input?: unknown;
	status: ToolStatus;
	output?: string;
}

export type Block =
	| { kind: "text"; content: string; streaming: boolean }
	| { kind: "tool"; tool: ToolEntry };

export type FooterStatus = "thinking" | "tool_running" | "streaming" | null;

export type Terminal = "running" | "done" | "interrupted" | "error";

export interface RunState {
	blocks: Block[];
	reasoning: { content: string; active: boolean };
	footer: FooterStatus;
	terminal: Terminal;
	errorMsg?: string;
	startedAt: number;
	meta: {
		durationMs?: number;
		model?: string;
	};
}

export function createInitialState(): RunState {
	return {
		blocks: [],
		reasoning: { content: "", active: false },
		footer: "thinking",
		terminal: "running",
		startedAt: Date.now(),
		meta: {},
	};
}

/** 从 AgentManager 事件 reduce 状态 */
export function reduceFromPiEvent(state: RunState, event: Record<string, unknown>): RunState {
	switch (event.type) {
		case "agent_start":
			return { ...state, footer: "thinking" };

		case "message_start": {
			const msg = event.message as Record<string, unknown> | undefined;
			if (msg?.role === "assistant") {
				return appendText(state, "");
			}
			return state;
		}

		case "message_update": {
			const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
			if (!assistantEvent) return state;

			if (assistantEvent.type === "text_delta") {
				const text = (assistantEvent as { text?: string }).text ?? "";
				if (text) return appendText(state, text);
			}
			if (assistantEvent.type === "thinking_delta") {
				const thinking = (assistantEvent as { thinking?: string }).thinking ?? "";
				if (thinking) return appendThinking(state, thinking);
			}
			if (assistantEvent.type === "toolcall_start") {
				const toolCall = (assistantEvent as { toolCall?: Record<string, unknown> }).toolCall;
				if (toolCall && typeof toolCall.id === "string" && typeof toolCall.name === "string") {
					return startTool(state, toolCall.id, toolCall.name, toolCall.input);
				}
			}
			if (assistantEvent.type === "toolcall_end") {
				const toolCall = (assistantEvent as { toolCall?: Record<string, unknown> }).toolCall;
				if (toolCall && typeof toolCall.id === "string") {
					return completeTool(state, toolCall.id, "", toolCall.isError === true);
				}
			}
			if (assistantEvent.type === "done") {
				return { ...state, footer: null };
			}
			return state;
		}

		case "tool_execution_start": {
			const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
			const toolId = `tool_${toolName}_${Date.now()}`;
			return startTool(state, toolId, toolName, event.args);
		}

		case "tool_execution_end": {
			const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
			// 找到最近的同名 running tool
			const toolBlock = [...state.blocks].reverse().find(
				(b) => b.kind === "tool" && b.tool.name === toolName && b.tool.status === "running",
			);
			if (toolBlock && toolBlock.kind === "tool") {
				return completeTool(state, toolBlock.tool.id, "", event.isError === true);
			}
			return state;
		}

		case "agent_end": {
			if (event.stopReason === "error" || event.error) {
				return markError(state, String(event.error || event.errorMessage || "Agent 运行出错"));
			}
			return markDone(state);
		}

		default:
			return state;
	}
}

// ===== 内部 reducer =====

function closeStreamingText(blocks: Block[]): Block[] {
	return blocks.map((b) =>
		b.kind === "text" && b.streaming ? { ...b, streaming: false } : b,
	);
}

function appendText(state: RunState, delta: string): RunState {
	const last = state.blocks[state.blocks.length - 1];
	if (last && last.kind === "text" && last.streaming) {
		const next: Block = { ...last, content: last.content + delta };
		return {
			...state,
			blocks: [...state.blocks.slice(0, -1), next],
			reasoning: { ...state.reasoning, active: false },
			footer: "streaming",
		};
	}
	return {
		...state,
		blocks: [...closeStreamingText(state.blocks), { kind: "text", content: delta, streaming: true }],
		reasoning: { ...state.reasoning, active: false },
		footer: delta ? "streaming" : "thinking",
	};
}

function appendThinking(state: RunState, delta: string): RunState {
	return {
		...state,
		reasoning: { content: state.reasoning.content + delta, active: true },
		footer: "thinking",
	};
}

function startTool(state: RunState, id: string, name: string, input?: unknown): RunState {
	const tool: ToolEntry = { id, name, input, status: "running" };
	return {
		...state,
		blocks: [...closeStreamingText(state.blocks), { kind: "tool", tool }],
		reasoning: { ...state.reasoning, active: false },
		footer: "tool_running",
	};
}

function completeTool(state: RunState, id: string, output: string, isError: boolean): RunState {
	const blocks = state.blocks.map((b) => {
		if (b.kind !== "tool" || b.tool.id !== id) return b;
		return {
			...b,
			tool: { ...b.tool, status: isError ? ("error" as const) : ("done" as const), output },
		};
	});
	return { ...state, blocks };
}

export function markDone(state: RunState): RunState {
	return {
		...state,
		blocks: closeStreamingText(state.blocks),
		reasoning: { ...state.reasoning, active: false },
		terminal: "done",
		footer: null,
		meta: { ...state.meta, durationMs: Date.now() - state.startedAt },
	};
}

export function markInterrupted(state: RunState): RunState {
	return {
		...state,
		blocks: closeStreamingText(state.blocks),
		reasoning: { ...state.reasoning, active: false },
		terminal: "interrupted",
		footer: null,
	};
}

export function markError(state: RunState, message: string): RunState {
	return {
		...state,
		blocks: closeStreamingText(state.blocks),
		reasoning: { ...state.reasoning, active: false },
		terminal: "error",
		footer: null,
		errorMsg: message,
	};
}
