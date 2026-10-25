/**
 * ACP session/update → PiDeck ChatMessage / TodoItem 投影器(纯函数)。
 *
 * 与 dshEventProjector 同一职责:把 agent 事件流折叠成渲染层时间线消息与
 * runtime 状态。ACP 的流是 JSON-RPC 通知(session/update),无 seq——顺序由
 * stdio 管道天然保序,投影按到达顺序追加。
 *
 * 投影规则(与渲染层既有卡片契约对齐,见 dshEventProjector 的 meta 约定):
 * - user_message_chunk:实时发送由 appendAcpUserPrompt 在 prompt 派发处先落投影(ACP 规范
 *   不保证 agent 回显,OpenCode 等根本不发),回放的 chunk 再按 localUserEchoes 前缀去重,
 *   未命中则视为历史/注入消息并回——规范一次只携带一个 content block,同一 prompt 的
 *   文本+图片分多条 update,必须并回最后一条 user 消息;收口上一轮 assistant 回放。
 * - agent_message_chunk / agent_thought_chunk:聚合进「当前回合」的一条 assistant
 *   流式消息;thoughtChunk 写 thinking 字段(渲染层思考折叠块)。
 * - tool_call/tool_call_update:role="tool" 卡片按 toolCallId 原位应用字段补丁，
 *   省略字段不覆盖，content/locations 出现则整表替换。
 * - plan:整表 last-wins 归一化为 TodoItem[](AgentRuntimeState.todos 同源)。
 * - available_commands_update:listCommands 数据源(PiCommand[])。
 * - unknown update:忽略(前向兼容,规范允许新增 update 类型)。
 */
import type { AcpContentBlock, AcpSessionUpdate, AcpStopReason, AcpToolCallUpdate } from "./acpProtocol";
import { parseUsageUpdate, readAcpCommandsUpdate, readAcpSessionTitle, readAcpPlanEntries, toAcpCommands, type AcpSessionUsage } from "./acpWireTolerance";
import { fallbackSessionTitle } from "../dsh/dshSessionTitleFold";
import { defaultToolDetailTranslate, formatToolDetail, type ToolDetailStatus } from "../../shared/formatToolDetail";
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
	/** 非标准但广泛流传(opencode/kimi)的 usage_update 投影:上下文用量 + 费用,manager 映射进 runtime.state 上下文仪表。 */
	usage?: AcpSessionUsage;
	/**
	 * 本地 prompt 回显待去重队列（文本 + agent 已回显的字符数）。
	 * 见 appendAcpUserPrompt：agent 回显 user_message_chunk 时按前缀消费，
	 * 避免同一条用户消息在时间线上出现两次。
	 */
	localUserEchoes?: Array<{ text: string; echoed: number }>;
	/** 末条由 user_message_chunk 落下的消息下标:多块并回只针对 chunk 连续块,不针对本地 seed/注入消息。 */
	lastUserChunkIndex?: number;
	/**
	 * 投影侧信道：本次 update 触及的 messages 下标（无消息变更时为 undefined）。
	 *
	 * 用途是图片物化（AcpAgentManager.materializeTouchedImages）：ACP 的图片以 base64 随 chunk
	 * 抵达，只有知道「这次更新动了哪条消息」才能只对该条落盘、避免每轮全量扫描。
	 * 语义是「本次 update」而非累计——消费者在每次投影后立刻读取。
	 */
	lastTouched?: number[];
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

/** 工具正文解包标准 content；旧 CLI 的直接文本块也可读，不改变出站协议。 */
function toolContentText(blocks: readonly unknown[]): string {
	const parts: string[] = [];
	for (const candidate of blocks) {
		if (!candidate || typeof candidate !== "object") continue;
		const wrapper = candidate as Record<string, unknown>;
		const block = wrapper.type === "content" ? wrapper.content : wrapper;
		if (!block || typeof block !== "object") continue;
		const value = block as Record<string, unknown>;
		if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
		else if (value.type === "resource_link") parts.push(typeof value.name === "string" ? value.name : typeof value.uri === "string" ? value.uri : "");
		else if (value.type === "diff") parts.push(`[diff ${typeof value.path === "string" ? value.path : ""}]`);
		else if (value.type === "terminal") parts.push("[terminal]");
		else if (value.type === "image") parts.push("[image]");
	}
	return parts.join("\n").trim();
}

/** 使用既有卡片的 error/running/completed 状态，避免 failed 被 UI 当作成功。 */
function toolStatus(status: AcpToolCallUpdate["status"]): "running" | "completed" | "error" {
	if (status === "completed") return "completed";
	if (status === "failed") return "error";
	return "running";
}

/** 工具正文里的图片结果(截图/生图工具):保进消息 images 走物化链落 ref,不随占位文本丢弃。 */
function toolContentImages(blocks: readonly unknown[]): NonNullable<ChatMessage["images"]> {
	const images: NonNullable<ChatMessage["images"]> = [];
	for (const candidate of blocks) {
		if (!candidate || typeof candidate !== "object") continue;
		const wrapper = candidate as Record<string, unknown>;
		const block = (wrapper.type === "content" ? wrapper.content : wrapper) as Record<string, unknown> | undefined;
		if (!block || typeof block !== "object") continue;
		const value = block as Record<string, unknown>;
		if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") images.push({ type: "image", data: value.data, mimeType: value.mimeType });
	}
	return images;
}

/** 仅应用出现的字段；正文空数组是清空，不能用 truthy 判断丢掉。 */
function patchToolCard(existing: ChatMessage | undefined, update: AcpToolCallUpdate, agentId: string): ChatMessage {
	const meta: NonNullable<ChatMessage["meta"]> = { ...(existing?.meta ?? {}), toolCallId: update.toolCallId };
	const title = typeof update.title === "string" ? update.title : typeof meta.toolName === "string" ? meta.toolName : update.toolCallId;
	meta.toolName = title;
	if (update.status != null || !existing) meta.status = toolStatus(update.status);
	if (typeof update.kind === "string") meta.kind = update.kind;
	if (update.rawInput !== undefined) meta.args = update.rawInput;
	if (update.rawOutput !== undefined) meta.result = update.rawOutput;
	if (Array.isArray(update.locations)) meta.locations = update.locations;
	if (Array.isArray(update.content)) {
		const text = toolContentText(update.content);
		meta.fullText = text;
		meta.truncated = text.length > ACP_TOOL_RESULT_MAX_CHARS;
	}
	// content 是整表替换语义:图片随表替换(0 图即清空);省略 content 的补丁保留旧图。
	const contentImages = Array.isArray(update.content) ? toolContentImages(update.content) : undefined;
	const isError = meta.status === "error";
	meta.isError = isError;
	const result = typeof meta.fullText === "string" && meta.fullText ? meta.fullText : meta.result;
	// 状态段取真实运行态：tool_call（pending/in_progress）也会烘焙 detailText，
	// 只按 isError 二分会把还在跑的工具印成「完成」（与 PI 侧同一修复）。
	const detailStatus: ToolDetailStatus = meta.status === "error" ? "error" : meta.status === "running" ? "running" : "done";
	meta.detailText = formatToolDetail(title, meta.args, result, detailStatus, defaultToolDetailTranslate);
	const base = existing ?? { id: nextMessageId(), agentId, role: "tool" as const, timestamp: Date.now() };
	return { ...base, ...(contentImages !== undefined ? { images: contentImages.length > 0 ? contentImages : undefined } : {}), text: title, meta };
}

/**
 * 迟到 chunk 的归属判据：末尾仍是 assistant 消息时返回其下标。
 * session/prompt 响应可能先于末尾 chunk 到达（opencode 实测），此时 settleAcpTurn 已清空
 * activeAssistantIndex；若不管末尾直接开新消息，同一条回复会被拆成两个气泡。
 * 新回合会先落本地 seed/回放的 user 消息，末尾不再是 assistant，判据自然失效。
 */
function trailingAssistantIndex(messages: ReadonlyArray<ChatMessage>): number | undefined {
	const last = messages.length - 1;
	return last >= 0 && messages[last]?.role === "assistant" ? last : undefined;
}

export function projectAcpSessionUpdate(state: AcpProjectionState, update: AcpSessionUpdate, agentId: string): AcpProjectionState {
	const next: AcpProjectionState = { ...state, messages: state.messages, toolCardIndex: state.toolCardIndex, commands: state.commands, replayed: true, activeAssistantIndex: state.activeAssistantIndex, lastTouched: undefined };
	switch (update.sessionUpdate) {
		case "user_message_chunk": {
			// 回放没有 prompt 响应作为轮次边界；下一条 user 消息收口上一轮 assistant。
			const settled = settleAcpTurn(state, "end_turn");
			next.activeAssistantIndex = undefined;
			// 规范一次只携带一个 content block:同一 prompt 的文本+图片分多条 update 回放,
			// 必须并回最后一条 user 消息,否则图文 prompt 恢复后被拆成多个气泡。
			const content = update.content as { type?: string; text?: string; data?: string; mimeType?: string } | undefined;
			if (!content || typeof content !== "object") return state;
			const previous = settled.messages.length > 0 ? settled.messages[settled.messages.length - 1] : undefined;
			// 多块并回仅限「上一条也是 user_message_chunk 落下的消息」:规范一条 update 只带一个 content block,
			// 同一消息的多块连续到达;本地 seed(appendAcpUserPrompt)与 agent 注入的独立消息不是续块,
			// 并回会误吞上下文消息(保持独立气泡)。
			const mergeInto = previous?.role === "user" && state.lastUserChunkIndex === settled.messages.length - 1 ? previous : undefined;
			if (content.type === "text" && typeof content.text === "string" && content.text) {
				const chunkText = content.text;
				// 本地回显去重：prompt 派发时 appendAcpUserPrompt 已把用户消息写进投影，
				// agent 再把同文回显一遍就会双条。按「前缀」匹配而不是整串相等——
				// 有的 agent 把用户消息也按 chunk 分片流式回显。
				const pending = state.localUserEchoes ?? [];
				const echoIndex = pending.findIndex((entry) => entry.text.slice(entry.echoed).startsWith(chunkText));
				if (echoIndex >= 0) {
					const entry = pending[echoIndex];
					const echoed = entry.echoed + chunkText.length;
					// 回显完就出队；未回完保留进度，后续分片继续消费。
					next.localUserEchoes = echoed >= entry.text.length ? [...pending.slice(0, echoIndex), ...pending.slice(echoIndex + 1)] : [...pending.slice(0, echoIndex), { text: entry.text, echoed }, ...pending.slice(echoIndex + 1)];
					// 回显不是轮次边界：本分支上方已把流式指针清空，必须还原——
					// 否则去重命中后到达的 chunk 会另起气泡（回复被拆成两处渲染）。
					next.activeAssistantIndex = state.activeAssistantIndex;
					return next;
				}
				// 与本地条目都不同文：是历史回放或 agent 自己的用户侧消息(如注入的上下文)，照常落条目；
				// 本地未回显条目不再期待回显（否则后续同文回显会被误吞），只留下回显到一半的。
				next.localUserEchoes = pending.filter((entry) => entry.echoed > 0);
				// 多块并回：同一 prompt 的文本块分多条 update 到达时并回最后一条 user 消息。
				next.messages = mergeInto ? [...settled.messages.slice(0, -1), { ...mergeInto, text: mergeInto.text + chunkText }] : [...settled.messages, { id: nextMessageId(), agentId, role: "user", text: chunkText, timestamp: Date.now() }];
				next.lastTouched = [next.messages.length - 1];
				next.lastUserChunkIndex = next.messages.length - 1;
				return next;
			}
			if (content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string") {
				const image = { type: "image" as const, mimeType: content.mimeType, data: content.data };
				next.messages = mergeInto ? [...settled.messages.slice(0, -1), { ...mergeInto, images: [...(mergeInto.images ?? []), image] }] : [...settled.messages, { id: nextMessageId(), agentId, role: "user", text: "", images: [image], timestamp: Date.now() }];
				next.lastTouched = [next.messages.length - 1];
				next.lastUserChunkIndex = next.messages.length - 1;
				return next;
			}
			return state;
		}
		case "agent_message_chunk":
		case "agent_thought_chunk": {
			const isThought = update.sessionUpdate === "agent_thought_chunk";
			const content = update.content as { type?: string; text?: string; data?: string; mimeType?: string } | undefined;
			const text = typeof content?.text === "string" ? content.text : "";
			// 思考流是纯文本(图块按契约丢弃)；助手正文允许图块——生图结果只有图没有字，
			// 按 text 为空就丢弃会让生成结果整条消失，所以「无文本但有图」也要建消息／并入。
			const image = !isThought && content?.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string" ? { type: "image" as const, mimeType: content.mimeType, data: content.data } : undefined;
			if (!text && !image) return state;
			// 指针已清但末尾仍是本回合的 assistant 消息：响应先于末尾 chunk 到达，并回它
			const activeIndex = state.activeAssistantIndex ?? trailingAssistantIndex(state.messages);
			const active = activeIndex !== undefined ? state.messages[activeIndex] : undefined;
			if (active && active.role === "assistant" && activeIndex !== undefined) {
				const merged: ChatMessage = isThought ? { ...active, thinking: (active.thinking ?? "") + text, thinkingStartedAt: active.thinkingStartedAt ?? active.timestamp } : { ...active, text: active.text + text, ...(image ? { images: [...(active.images ?? []), image] } : {}) };
				// 并回「已 settle 的末尾消息」说明该回合其实还在续写：恢复流式态，等真正结束时再 settle；
				// aborted/error 是终态，不因迟到 chunk 翻案。
				const continued: ChatMessage = state.activeAssistantIndex === undefined && merged.stopReason !== "pending" && merged.stopReason !== "aborted" && merged.stopReason !== "error" ? { ...merged, stopReason: "pending" } : merged;
				next.messages = [...state.messages];
				next.messages[activeIndex] = continued;
				// 迟到的尾部续写后指针回到该消息：后续 tool 卡后的正文沿用同一约定并入同一气泡。
				next.activeAssistantIndex = activeIndex;
				next.lastTouched = [activeIndex];
			} else {
				const created: ChatMessage = {
					id: nextMessageId(),
					agentId,
					role: "assistant",
					text: isThought ? "" : text,
					...(image ? { images: [image] } : {}),
					...(isThought ? { thinking: text, thinkingStartedAt: Date.now() } : {}),
					timestamp: Date.now(),
					stopReason: "pending",
				};
				next.messages = [...state.messages, created];
				const createdIndex = next.messages.length - 1;
				next.activeAssistantIndex = createdIndex;
				next.lastTouched = [createdIndex];
			}
			return next;
		}
		case "tool_call":
		case "tool_call_update": {
			// fallback 宽类型容纳未知 update，已知帧仍要校验工具身份。
			const toolUpdate = update as AcpToolCallUpdate;
			if (typeof toolUpdate.toolCallId !== "string" || !toolUpdate.toolCallId) return state;
			const cardIndex = state.toolCardIndex.get(toolUpdate.toolCallId);
			const existing = cardIndex !== undefined ? state.messages[cardIndex] : undefined;
			const card = patchToolCard(existing?.role === "tool" ? existing : undefined, toolUpdate, agentId);
			next.messages = [...state.messages];
			const index = existing?.role === "tool" && cardIndex !== undefined ? cardIndex : next.messages.length;
			next.messages[index] = card;
			next.toolCardIndex = new Map(state.toolCardIndex);
			next.toolCardIndex.set(toolUpdate.toolCallId, index);
			next.lastTouched = [index];
			return next;
		}
		case "plan": {
			next.todos = readAcpPlanEntries(update as unknown as Record<string, unknown>).map((entry) => ({
				content: typeof entry?.content === "string" ? entry.content : "",
				status: entry?.status === "in_progress" ? "in_progress" : entry?.status === "completed" ? "completed" : "pending",
			}));
			return next;
		}
		case "available_commands_update": {
			// 键名宽容读取（commands | availableCommands 双键）收拢在 acpWireTolerance；两者都缺则清空。
			next.commands = toAcpCommands(readAcpCommandsUpdate(update as unknown as Record<string, unknown>));
			return next;
		}
		case "usage_update": {
			const parsed = parseUsageUpdate(update as unknown as Record<string, unknown>);
			if (parsed) next.usage = parsed;
			return next;
		}
		case "session_info_update": {
			const title = readAcpSessionTitle(update as unknown as Record<string, unknown>);
			if (title) next.title = title;
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
export function settleAcpTurn(state: AcpProjectionState, stopReason: AcpStopReason | "aborted" | "error"): AcpProjectionState {
	const active = state.activeAssistantIndex !== undefined ? state.messages[state.activeAssistantIndex] : undefined;
	if (!active || state.activeAssistantIndex === undefined) return { ...state, activeAssistantIndex: undefined };
	const reason = stopReason === "end_turn" || stopReason === "refusal" ? "stop" : stopReason === "max_tokens" || stopReason === "max_turn_requests" ? "length" : stopReason === "cancelled" || stopReason === "aborted" ? "aborted" : "error";
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

export function rollbackAcpUserPrompt(state: AcpProjectionState, index: number): AcpProjectionState {
	// 撤回条件：本次 prompt 落的条目仍是最后一条，且 agent 没有在回显中途
	// （有回显进度说明它已经收到 prompt，撤掉本地条目会与 agent 侧会话不一致）。
	if (index < 0 || state.messages.length !== index + 1) return state;
	if (state.messages[index]?.role !== "user") return state;
	const echoes = state.localUserEchoes ?? [];
	if (echoes.some((entry) => entry.echoed > 0)) return state;
	return { ...state, messages: state.messages.slice(0, index), localUserEchoes: echoes.slice(0, -1), lastTouched: undefined };
}

/**
 * 把用户发出的 prompt 写进投影（本地回显）+ 首条提示兜底标题。
 *
 * 为什么主进程要自己写：ACP 的 `user_message_chunk` 是 agent 的**可选**回显
 * （规范只说 agent 需要时把用户输入回放给 client），OpenCode 等实现根本不发，
 * 而 ACP 的 `agents:message` 是**全量替换**语义（渲染层缓存整段被覆盖），
 * 于是渲染层发出的乐观用户气泡会被第一次 flush 抹掉——表现为「只显示 AI 回复，
 * 用户消息不见了」。条目落在主进程侧，时间线（含渲染层、导出、重载）才与
 * agent 是否回显无关。
 *
 * 标题：ACP 会话没有本地文件，agent 只在自己愿意时发 `session_info_update`，
 * 因此首条 prompt 就按确定性规则兜底一个标题（与 DSH 的回退标题同一套截断规则，
 * 不另起第二套），agent 后续给出的标题仍会覆盖它（last-wins）。
 *
 * 调用方在派发失败且 agent 未产出任何内容时用 rollbackAcpUserPrompt 撤回本条。
 */
export function appendAcpUserPrompt(state: AcpProjectionState, text: string, images: ReadonlyArray<{ type: string; mimeType?: string; data?: string }> | null | undefined, agentId: string): AcpProjectionState {
	const imageBlocks: Array<{ type: "image"; mimeType: string; data: string }> = [];
	for (const image of images ?? []) {
		if (image?.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string") imageBlocks.push({ type: "image", mimeType: image.mimeType, data: image.data });
	}
	if (!text && imageBlocks.length === 0) return state;
	const message: ChatMessage = {
		id: nextMessageId(),
		agentId,
		role: "user",
		text,
		...(imageBlocks.length ? { images: imageBlocks } : {}),
		timestamp: Date.now(),
	};
	const title = state.title ?? (text ? fallbackSessionTitle(text) : "");
	return {
		...state,
		messages: [...state.messages, message],
		// 队列只保留「回显到一半」的条目 + 本条：agent 全程不回显时（OpenCode 等）
		// 不会每条 prompt 都留一个永不消费的条目。
		localUserEchoes: [...(state.localUserEchoes ?? []).filter((entry) => entry.echoed > 0), { text, echoed: 0 }],
		// seed 不是 user_message_chunk 落下的消息,后续 chunk 不得并回进它。
		lastUserChunkIndex: undefined,
		// 新回合开始：上一轮的流式指针作废，避免新回合 chunk 并回上一条 assistant 消息。
		activeAssistantIndex: undefined,
		...(title ? { title } : {}),
		lastTouched: [state.messages.length],
		replayed: true,
	};
}
