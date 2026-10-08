/**
 * ACP session/update → PiDeck ChatMessage / TodoItem 投影器(纯函数)。
 *
 * 与 dshEventProjector 同一职责:把 agent 事件流折叠成渲染层时间线消息与
 * runtime 状态。ACP 的流是 JSON-RPC 通知(session/update),无 seq——顺序由
 * stdio 管道天然保序,投影按到达顺序追加。
 *
 * 投影规则(与渲染层既有卡片契约对齐,见 dshEventProjector 的 meta 约定):
 * - user_message_chunk:user 消息回显(渲染层对 acp 后端不本地 append,靠投影回显,
 *   与 DSH 同策略——避免发送方与 agent 回显双条)。
 * - agent_message_chunk / agent_thought_chunk:聚合进「当前回合」的一条 assistant
 *   流式消息;thoughtChunk 写 thinking 字段(渲染层思考折叠块)。
 * - tool_call:role="tool" 卡片消息,meta.status 驱动旋转动画;同一 toolCallId 的
 *   in_progress/completed/failed 更新原卡片(按 callId 精确匹配,非最后一条)。
 * - plan:整表 last-wins 归一化为 TodoItem[](AgentRuntimeState.todos 同源)。
 * - available_commands_update:listCommands 数据源(PiCommand[])。
 * - unknown update:忽略(前向兼容,规范允许新增 update 类型)。
 */
import type { AcpSessionUpdate, AcpToolCallUpdate } from "./acpProtocol";
import type { TodoItem } from "../../shared/types/todo";
import type { ChatMessage } from "../../shared/types/session";
import type { PiCommand } from "../../shared/types/app";

/** 工具卡展开区截断上限(对齐 dshEventProjector 的 TOOL_RESULT_MAX_CHARS 契约)。 */
export const ACP_TOOL_RESULT_MAX_CHARS = 2000;

export type AcpProjectionState = {
	messages: ChatMessage[];
	/** 当前回合流式 assistant 消息下标(messages 内);无活动回合为 undefined。 */
	activeAssistantIndex?: number;
	/** toolCallId → messages 下标,收口更新按 callId 精确回写。 */
	toolCardIndex: Map<string, number>;
	todos?: TodoItem[];
	commands: PiCommand[];
	/** 最近一次 session_info_update 的标题(供 catalog 回写)。 */
	title?: string;
	/** 任意 update 到达过(load 重放也置位)。 */
	replayed: boolean;
};

export function initialAcpProjection(): AcpProjectionState {
	return {
		messages: [],
		toolCardIndex: new Map(),
		commands: [],
		replayed: false,
	};
}

let messageCounter = 0;
function nextMessageId(): string {
	messageCounter += 1;
	return `acp-${Date.now().toString(36)}-${messageCounter.toString(36)}`;
}

/** 工具卡内容块 → 展示文本:文本直拼;diff/terminal/图片等特殊块给占位描述。 */
function toolContentText(update: AcpToolCallUpdate): { text: string; fullText?: string } {
	let text = "";
	let special = "";
	for (const block of update.content ?? []) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") {
			text += block.text;
		} else if (block.type === "resource_link") {
			special += `${(block as { name?: string }).name ?? (block as { uri?: string }).uri ?? "resource"}\n`;
		} else if (block.type === "image") {
			special += "[image]\n";
		} else if (block.type === "diff") {
			const diff = block as { path?: string };
			special += `[diff ${diff.path ?? ""}]\n`;
		} else if (block.type === "terminal") {
			special += "[terminal]\n";
		}
	}
	const combined = (text + (special ? `\n${special.trim()}` : "")).trim();
	if (combined.length <= ACP_TOOL_RESULT_MAX_CHARS) return { text: combined };
	return { text: combined.slice(0, ACP_TOOL_RESULT_MAX_CHARS), fullText: combined };
}

/** tool_call kind → 工具卡渲染形态:read 类对齐只读工具样式。 */
function toolDisplayKind(update: AcpToolCallUpdate): string {
	return update.kind === "read" ? "read" : "execute";
}

function toolStatus(status: AcpToolCallUpdate["status"]): "running" | "completed" | "failed" {
	if (status === "completed") return "completed";
	if (status === "failed") return "failed";
	return "running";
}

export function projectAcpSessionUpdate(state: AcpProjectionState, update: AcpSessionUpdate, agentId: string): AcpProjectionState {
	const next: AcpProjectionState = { ...state, messages: state.messages, toolCardIndex: state.toolCardIndex, commands: state.commands, replayed: true, activeAssistantIndex: state.activeAssistantIndex };
	switch (update.sessionUpdate) {
		case "user_message_chunk": {
			// 一次一个 content block:文本块拼 text;图片块进 images(回显路径)。
			const content = update.content as { type?: string; text?: string; data?: string; mimeType?: string } | undefined;
			if (!content || typeof content !== "object") return state;
			if (content.type === "text" && typeof content.text === "string" && content.text) {
				next.messages = [...state.messages, { id: nextMessageId(), agentId, role: "user", text: content.text, timestamp: Date.now() }];
				return next;
			}
			if (content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string") {
				next.messages = [
					...state.messages,
					{
						id: nextMessageId(),
						agentId,
						role: "user",
						text: "",
						images: [{ type: "image", mimeType: content.mimeType, data: content.data }],
						timestamp: Date.now(),
					},
				];
				return next;
			}
			return state;
		}
		case "agent_message_chunk":
		case "agent_thought_chunk": {
			const content = update.content as { type: string; text?: string } | undefined;
			const text = typeof content?.text === "string" ? content.text : "";
			if (!text) return state;
			const active = state.activeAssistantIndex !== undefined ? state.messages[state.activeAssistantIndex] : undefined;
			if (active && active.role === "assistant") {
				const merged: ChatMessage = update.sessionUpdate === "agent_message_chunk" ? { ...active, text: active.text + text } : { ...active, thinking: (active.thinking ?? "") + text, thinkingStartedAt: active.thinkingStartedAt ?? active.timestamp };
				next.messages = [...state.messages];
				next.messages[state.activeAssistantIndex as number] = merged;
			} else {
				const created: ChatMessage = {
					id: nextMessageId(),
					agentId,
					role: "assistant",
					text: update.sessionUpdate === "agent_message_chunk" ? text : "",
					...(update.sessionUpdate === "agent_thought_chunk" ? { thinking: text, thinkingStartedAt: Date.now() } : {}),
					timestamp: Date.now(),
					stopReason: "pending",
				};
				next.messages = [...state.messages, created];
				next.activeAssistantIndex = next.messages.length - 1;
			}
			return next;
		}
		case "tool_call": {
			// switch 判别被 fallback 宽类型(sessionUpdate: string)击穿，显式收窄。
			const toolUpdate = update as AcpToolCallUpdate;
			const cardIndex = state.toolCardIndex.get(toolUpdate.toolCallId);
			if (cardIndex !== undefined && state.messages[cardIndex]?.role === "tool") {
				const existing = state.messages[cardIndex];
				const contentText = toolContentText(toolUpdate);
				next.messages = [...state.messages];
				next.messages[cardIndex] = {
					...existing,
					meta: {
						...(existing.meta ?? {}),
						toolName: toolUpdate.title,
						status: toolStatus(toolUpdate.status),
						...(toolUpdate.kind ? { kind: toolDisplayKind(toolUpdate) } : {}),
						...(contentText.text ? { fullText: contentText.fullText ?? contentText.text, truncated: contentText.fullText !== undefined } : {}),
						...(toolUpdate.locations?.length ? { locations: toolUpdate.locations } : {}),
					},
				};
			} else {
				const contentText = toolContentText(toolUpdate);
				const card: ChatMessage = {
					id: nextMessageId(),
					agentId,
					role: "tool",
					text: toolUpdate.title,
					timestamp: Date.now(),
					meta: {
						toolCallId: toolUpdate.toolCallId,
						toolName: toolUpdate.title,
						status: toolStatus(toolUpdate.status),
						...(toolUpdate.kind ? { kind: toolDisplayKind(toolUpdate) } : {}),
						...(contentText.text ? { fullText: contentText.fullText ?? contentText.text, truncated: contentText.fullText !== undefined } : {}),
						...(toolUpdate.locations?.length ? { locations: toolUpdate.locations } : {}),
					},
				};
				next.messages = [...state.messages, card];
				next.toolCardIndex = new Map(state.toolCardIndex);
				next.toolCardIndex.set(toolUpdate.toolCallId, next.messages.length - 1);
			}
			return next;
		}
		case "plan": {
			const planUpdate = update as { plan?: Array<{ content?: unknown; status?: unknown }> };
			next.todos = (Array.isArray(planUpdate.plan) ? planUpdate.plan : []).map((entry) => ({
				content: typeof entry?.content === "string" ? entry.content : "",
				status: entry?.status === "in_progress" ? "in_progress" : entry?.status === "completed" ? "completed" : "pending",
			}));
			return next;
		}
		case "available_commands_update": {
			const commandsUpdate = update as { commands?: Array<{ name?: unknown; description?: unknown }> };
			next.commands = (Array.isArray(commandsUpdate.commands) ? commandsUpdate.commands : []).map((command) => ({
				name: typeof command?.name === "string" ? command.name : "",
				...(typeof command?.description === "string" && command.description ? { description: command.description } : {}),
				source: "acp",
			}));
			return next;
		}
		case "session_info_update": {
			const infoUpdate = update as { sessionTitle?: unknown };
			if (typeof infoUpdate.sessionTitle === "string" && infoUpdate.sessionTitle.trim()) next.title = infoUpdate.sessionTitle.trim();
			return next;
		}
		case "current_mode_update":
		case "config_option_update":
			// 首版不消费(无 mode/config UI);不报错,静默忽略。
			return state;
		default:
			// 未知 update 类型:规范允许前向扩展,忽略。
			return state;
	}
}

/** session/prompt 结算(stopReason 回填 + 活动流式消息收口)。 */
export function settleAcpTurn(state: AcpProjectionState, stopReason: "end_turn" | "cancelled" | "aborted" | "error"): AcpProjectionState {
	const active = state.activeAssistantIndex !== undefined ? state.messages[state.activeAssistantIndex] : undefined;
	if (!active || state.activeAssistantIndex === undefined) return { ...state, activeAssistantIndex: undefined };
	const reason = stopReason === "end_turn" ? "stop" : stopReason === "cancelled" || stopReason === "aborted" ? "aborted" : "error";
	const messages = [...state.messages];
	messages[state.activeAssistantIndex] = { ...active, stopReason: reason };
	return { ...state, messages, activeAssistantIndex: undefined };
}

/** user 消息内容构造:文本 + 图片块(SendPromptInput.images → AcpContentBlock[])。 */
export function acpPromptBlocks(text: string, images?: ReadonlyArray<{ type: string; mimeType?: string; data?: string }> | null): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	const blocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{ type: "text", text }];
	for (const image of images ?? []) {
		if (image?.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string") {
			blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
		}
	}
	return blocks;
}
