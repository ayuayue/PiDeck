/**
 * CardRunState — 飞书流式卡片的运行时状态机 v2
 *
 * 参考上游 card-run-state.ts 实现。
 * 把 AgentManager 的事件累积成结构化的 RunState，
 * 便于渲染层无时序地把状态转成 CardKit 2.0 JSON。
 *
 * v2 新增：
 * - trail：活动轨迹（Agent 每一步操作的时间线日志）
 * - outputText：assistant 累积输出文本（用于流式渲染输出区域）
 *
 * 所有 reducer 是纯函数：reduce(state, event) → state。
 */

import { feishuT, type FeishuLocale } from "./FeishuI18n";

export type ToolStatus = "running" | "done" | "error";

export interface ToolEntry {
	id: string;
	name: string;
	input?: unknown;
	status: ToolStatus;
	output?: string;
}

export type Block = { kind: "text"; content: string; streaming: boolean } | { kind: "tool"; tool: ToolEntry };

export type FooterStatus = "thinking" | "tool_running" | "streaming" | null;

export type Terminal = "running" | "done" | "interrupted" | "error";

/** 活动轨迹条目 */
export interface TrailEntry {
	id: string;
	timestamp: number;
	type: "agent" | "tool" | "compaction" | "retry" | "error" | "info";
	text: string;
	detail?: string;
	status: "running" | "done" | "error";
}

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
	/** 活动轨迹：Agent 每一步操作的时间线 */
	trail: TrailEntry[];
	/** assistant 累积输出文本 */
	outputText: string;
}

let _trailSeq = 0;
function nextTrailId(): string {
	return `trail_${Date.now()}_${++_trailSeq}`;
}

export function createInitialState(): RunState {
	return {
		blocks: [],
		reasoning: { content: "", active: false },
		footer: "thinking",
		terminal: "running",
		startedAt: Date.now(),
		meta: {},
		trail: [],
		outputText: "",
	};
}

// ===== Trail helpers =====

function addTrail(state: RunState, type: TrailEntry["type"], text: string, status: TrailEntry["status"] = "running", detail?: string): RunState {
	const entry: TrailEntry = { id: nextTrailId(), timestamp: Date.now(), type, text, status, detail };
	return { ...state, trail: [...state.trail, entry] };
}

function updateLastTrailStatus(state: RunState, status: TrailEntry["status"], detail?: string): RunState {
	if (state.trail.length === 0) return state;
	const last = state.trail[state.trail.length - 1];
	if (last.status === status) return state;
	const updated: TrailEntry = { ...last, status, ...(detail ? { detail } : {}) };
	return { ...state, trail: [...state.trail.slice(0, -1), updated] };
}

/** 按文本匹配更新最后一条匹配条目的状态 */
function updateLastTrailByText(state: RunState, text: string, status: TrailEntry["status"], newText?: string): RunState {
	for (let i = state.trail.length - 1; i >= 0; i--) {
		if (state.trail[i].text === text && state.trail[i].status === "running") {
			const updated: TrailEntry = { ...state.trail[i], status, text: newText ?? state.trail[i].text };
			const trail = [...state.trail];
			trail[i] = updated;
			return { ...state, trail };
		}
	}
	return state;
}

function finalizeAllTrail(state: RunState): RunState {
	const trail = state.trail.map((t) => (t.status === "running" ? { ...t, status: "done" as const } : t));
	return { ...state, trail };
}

// ===== 主 reducer =====

/** 从 AgentManager 事件 reduce 状态 */
export function reduceFromPiEvent(state: RunState, event: Record<string, unknown>, locale: FeishuLocale = "zh-CN"): RunState {
	switch (event.type) {
		case "agent_start":
			return addTrail({ ...state, footer: "thinking" }, "agent", feishuT(locale, "run.agentStarted"), "done");

		// turn_start 已移除，轮次信息对用户感知价值不大，且计数容易不准

		case "message_start": {
			const msg = event.message as Record<string, unknown> | undefined;
			if (msg?.role === "assistant") {
				return appendText(state, "", locale);
			}
			return state;
		}

		case "message_update": {
			const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
			if (!assistantEvent) return state;

			if (assistantEvent.type === "text_delta") {
				// AgentManager 发出的字段是 delta，兼容 delta 和 text 两种格式
				const text = (assistantEvent as { delta?: string; text?: string }).delta ?? (assistantEvent as { text?: string }).text ?? "";
				if (text) return appendText(state, text, locale);
			}
			if (assistantEvent.type === "thinking_delta") {
				// AgentManager 发出的字段是 delta，兼容 delta 和 thinking 两种格式
				const thinking = (assistantEvent as { delta?: string; thinking?: string }).delta ?? (assistantEvent as { thinking?: string }).thinking ?? "";
				if (thinking) return appendThinking(state, thinking, locale);
			}
			if (assistantEvent.type === "toolcall_start") {
				const toolCall = (assistantEvent as { toolCall?: Record<string, unknown> }).toolCall;
				if (toolCall && typeof toolCall.id === "string" && typeof toolCall.name === "string") {
					return startToolInState(state, toolCall.id, toolCall.name, toolCall.input as Record<string, unknown> | undefined, locale);
				}
			}
			if (assistantEvent.type === "toolcall_end") {
				const toolCall = (assistantEvent as { toolCall?: Record<string, unknown> }).toolCall;
				if (toolCall && typeof toolCall.id === "string") {
					return completeToolInState(state, toolCall.id, toolCall.isError === true, locale);
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
			return startToolInState(state, toolId, toolName, event.args as Record<string, unknown> | undefined, locale);
		}

		case "tool_execution_end": {
			const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
			// 找到最近的同名 running tool
			const toolBlock = [...state.blocks].reverse().find((b) => b.kind === "tool" && b.tool.name === toolName && b.tool.status === "running");
			if (toolBlock && toolBlock.kind === "tool") {
				return completeToolInState(state, toolBlock.tool.id, event.isError === true, locale);
			}
			return state;
		}

		case "compaction_start": {
			return addTrail(state, "compaction", feishuT(locale, "run.compacting"), "running");
		}

		case "auto_retry_start": {
			const attempt = typeof event.attempt === "number" ? event.attempt : "?";
			const max = typeof event.maxAttempts === "number" ? event.maxAttempts : "?";
			return addTrail(state, "retry", feishuT(locale, "run.autoRetry", { attempt, max }), "running");
		}

		case "auto_retry_end": {
			return updateLastTrailStatus(state, event.success === false ? "error" : "done");
		}

		case "agent_end": {
			if (event.stopReason === "error" || event.error) {
				return markError(finalizeAllTrail(state), feishuT(locale, "agent.failed"));
			}
			return markDone(finalizeAllTrail(state));
		}

		default:
			return state;
	}
}

// ===== 内部 reducer =====

function closeStreamingText(blocks: Block[]): Block[] {
	return blocks.map((b) => (b.kind === "text" && b.streaming ? { ...b, streaming: false } : b));
}

function appendText(state: RunState, delta: string, locale: FeishuLocale): RunState {
	const last = state.blocks[state.blocks.length - 1];
	const newOutputText = state.outputText + delta;
	const isFirstOutput = state.outputText.length === 0 && delta.length > 0;

	let next: RunState;
	if (last && last.kind === "text" && last.streaming) {
		const nextBlock: Block = { ...last, content: last.content + delta };
		next = {
			...state,
			blocks: [...state.blocks.slice(0, -1), nextBlock],
			reasoning: { ...state.reasoning, active: false },
			footer: "streaming",
			outputText: newOutputText,
		};
	} else {
		next = {
			...state,
			blocks: [...closeStreamingText(state.blocks), { kind: "text", content: delta, streaming: true }],
			reasoning: { ...state.reasoning, active: false },
			footer: delta ? "streaming" : "thinking",
			outputText: newOutputText,
		};
	}

	// 首次输出时：标记思考完成 + 添加输出轨迹
	if (isFirstOutput) {
		next = addTrail(next, "agent", feishuT(locale, "run.startOutput"), "running");
		// 标记上一个"开始思考"为完成
		next = updateLastTrailByText(next, feishuT(locale, "run.startThinking"), "done", feishuT(locale, "run.thinkingDone"));
	}
	return next;
}

function appendThinking(state: RunState, delta: string, locale: FeishuLocale): RunState {
	const isFirstThinking = state.reasoning.content.length === 0;
	const next = {
		...state,
		reasoning: { content: state.reasoning.content + delta, active: true },
		footer: "thinking" as FooterStatus,
	};
	// 第一次思考时追加轨迹条目
	if (isFirstThinking) {
		return addTrail(next, "agent", feishuT(locale, "run.startThinking"), "running");
	}
	return next;
}

function startToolInState(state: RunState, id: string, name: string, input: Record<string, unknown> | undefined, locale: FeishuLocale): RunState {
	const detail = toolInputSummary(name, input);
	const tool: ToolEntry = { id, name, input, status: "running" };
	return addTrail(
		{
			...state,
			blocks: [...closeStreamingText(state.blocks), { kind: "tool", tool }],
			reasoning: { ...state.reasoning, active: false },
			footer: "tool_running",
		},
		"tool",
		feishuT(locale, "run.toolCall", { name }),
		"running",
		detail,
	);
}

function completeToolInState(state: RunState, id: string, isError: boolean, locale: FeishuLocale): RunState {
	const blocks = state.blocks.map((b) => {
		if (b.kind !== "tool" || b.tool.id !== id) return b;
		return {
			...b,
			tool: { ...b.tool, status: isError ? ("error" as const) : ("done" as const as ToolStatus) },
		};
	});
	// 也更新 trail 中最后一个对应状态的 tool
	const completedTool = blocks.find((block) => block.kind === "tool" && block.tool.id === id);
	const toolName = completedTool?.kind === "tool" ? completedTool.tool.name : "tool";
	const trail = state.trail.map((t, i) => {
		if (t.type === "tool" && t.status === "running" && i === lastRunningToolIndex(state.trail)) {
			return {
				...t,
				status: isError ? ("error" as const) : ("done" as const),
				text: feishuT(locale, isError ? "run.toolFailed" : "run.toolDone", { name: toolName }),
			};
		}
		return t;
	});
	return { ...state, blocks, trail };
}

function lastRunningToolIndex(trail: TrailEntry[]): number {
	for (let i = trail.length - 1; i >= 0; i--) {
		if (trail[i].type === "tool" && trail[i].status === "running") return i;
	}
	return -1;
}

function toolInputSummary(name: string, input: Record<string, unknown> | undefined): string | undefined {
	if (!input) return undefined;
	if (name === "read" && typeof input.filePath === "string") return truncate(input.filePath, 80);
	if (name === "bash" && typeof input.command === "string") return truncate(input.command, 80);
	if (name === "write" && typeof input.filePath === "string") return truncate(input.filePath, 80);
	if (name === "edit" && typeof input.filePath === "string") return truncate(input.filePath, 80);
	if (name === "grep" && typeof input.pattern === "string") return truncate(input.pattern, 80);
	return undefined;
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max) + "…";
}

// ===== 终态标记 =====

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
