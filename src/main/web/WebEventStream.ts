/**
 * WebEventStream — pi RPC 事件 → AI SDK v5 UIMessageStream SSE 帧 翻译器。
 *
 * 背景：PiDeck Web 服务前端原来是 600ms 轮询 /api/state，回复期间没有任何流式反馈。
 * 本模块把主进程收到的 pi agent 事件（agent_start / message_update / tool_execution_* / agent_end）
 * 翻译成 AI SDK v5 的 UIMessageStream 线协议（data: {json}\n\n 帧 + [DONE] 终止），
 * 后端按该协议输出 SSE，前端可先用 vanilla fetch 消费实现打字机效果（A1），
 * 后续升级 React + useChat 时（A2）协议无需改动，直接复用同一端点。
 *
 * 协议参考：https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
 * 需要设置响应头 x-vercel-ai-ui-message-stream: v1 才能被 useChat 识别。
 *
 * DSH 后端没有 pi 的 RPC 事件（agent_start/message_update/agent_settled），它的流式
 * 数据走自己的 IPC 通道，由 DshChannelToPiEvents 先翻译成同形状的 pi 事件再进同一套
 * 适配器（见 bindChannelSource），因此 Web 线协议与前端零分支。
 */
import { DshChannelToPiEvents } from "./DshChannelToPiEvents";

/** AI SDK UIMessageStream 单个 SSE 帧（data: 后的 JSON 对象）。 */
export type UiMessageStreamFrame = Record<string, unknown>;

/** 事件来源 agentId → 目标 sessionId 的路由函数，由装配方注入。 */
export type AgentToSessionRouter = (agentId: string) => string | undefined;

/** 非 pi 后端（DSH）的 agent 通道事件源：由装配方提供订阅句柄。 */
export type AgentChannelEventSource = (handler: (agentId: string, channel: string, payload: unknown) => void) => () => void;

/** SSE 帧写出函数；返回 false 表示连接已失效（对方已断开）。 */
export type SseWriter = (frame: UiMessageStreamFrame) => boolean;

/** 会话级收口基准的保留条数上限（只服务重连窗口，不需要长期记忆）。 */
const CLOSED_RUN_SESSIONS_MAX = 64;

/** 会话级实时状态的保留条数上限（回放源；活跃会话数量远小于此）。 */
const SESSION_STATES_MAX = 64;

/**
 * 单轮回放帧上限：文本/思考增量已就近合并，正常一轮只有几十到几百帧；
 * 超限说明这一轮异常庞大（或事件风暴），放弃回放（降级成「只看后续增量」）而不是吃满内存。
 */
const RUN_REPLAY_MAX_FRAMES = 2000;

/** 单个 pi 事件（与 AgentManager.handlePiEvent 收到的结构一致）。 */
export type PiEvent = {
	type?: string;
	// message_start / message_end / message_update 顶层字段
	message?: Record<string, unknown>;
	assistantMessageEvent?: Record<string, unknown>;
	// tool_execution_*（result/partialResult：工具执行结果，供 Web 端展开详情）
	toolName?: string;
	toolCallId?: string;
	args?: unknown;
	result?: unknown;
	partialResult?: unknown;
	isError?: boolean;
	// agent_end
	stopReason?: string;
	error?: unknown;
};

/** 事件流翻译器：维护消息级游标（text/reasoning/tool 块是否已开启），逐事件产出帧。 */
export class PiEventToUiMessageStream {
	private textBlockId: string | null = null;
	private reasoningBlockId: string | null = null;
	/**
	 * 当前 reasoning 块是否已发过增量 delta。
	 *
	 * pi 的 thinking_end 只带 content（完整思考）不带 delta，而块内此前已由
	 * thinking_delta 增量交付过全文；只看本事件的 delta 会让兜底分支把全文再发一遍，
	 * 客户端按 text += delta 追加 → 思考内容整段翻倍。因此 blockId 铸造时清零、
	 * 每发一条 reasoning-delta 置位，thinking_end 的兜底仅在从未发过增量时补。
	 */
	private reasoningDeltaSent = false;
	private currentMessageId: string | null = null;
	private finished = false;
	/** 已发送过 tool-input 帧的 toolCallId（防重发：message 层 toolcall_start 与顶层 tool_execution_start 双路径去重） */
	private inputSentToolCallIds = new Set<string>();
	/** 已发送过 tool-output 帧的 toolCallId（防重复 settle；settle 后即生命周期完结） */
	private settledToolCallIds = new Set<string>();

	/**
	 * 翻译单个 pi 事件为 0..n 个 UIMessageStream 帧。
	 * 返回空数组表示该事件不需要输出（例如 user 消息、无需展示的辅助事件）。
	 */
	push(event: PiEvent): UiMessageStreamFrame[] {
		const frames: UiMessageStreamFrame[] = [];
		const type = event.type;

		// 消息开始：assistant 消息是流式回复的起点，AI SDK 用它开启一条 UI 消息。
		if (type === "message_start") {
			const role = event.message?.role;
			if (role === "assistant" && !this.finished) {
				if (!this.currentMessageId) {
					this.currentMessageId = String((event.message?.id as string | undefined) ?? `msg_${Date.now()}`);
					frames.push({ type: "start", messageId: this.currentMessageId });
				} else {
					// 工具循环的下一跳：同一条 UI 消息里开新 step，不要再发 start 拆气泡。
					frames.push({ type: "start-step" });
				}
			}
			return frames;
		}

		// 消息更新：文本/思考增量都在 assistantMessageEvent 里。
		if (type === "message_update" && event.assistantMessageEvent) {
			return this.handleAssistantMessageEvent(event.assistantMessageEvent);
		}

		// 工具执行（pi 在 RPC 模式下还会发顶层 tool_execution_start/end）。
		if (type === "tool_execution_start") {
			return this.startTool(event);
		}
		if (type === "tool_execution_end") {
			return this.endTool(event);
		}

		// agent_end 只是本轮 LLM 步结束：后面常接 tool_execution / 下一轮 message_start。
		// 这里关流会让手机端工具卡在 input-available，useChat 标成失败且后续正文丢失。
		// 真失败才收尾；正常结束等 agent_settled。pi 部分路径会带 error: null（无错的
		// 显式空值），与 undefined 同样视为无错，否则整轮工具循环会在第一步就断流。
		if (type === "agent_end") {
			if (event.error !== undefined && event.error !== null) return this.finishMessage(event);
			return frames;
		}

		// agent_settled 是 Pi 最终稳定点；部分版本不会把 agent_end 作为外部流的最后事件。
		if (type === "agent_settled") {
			return this.finishMessage(event);
		}

		// 其余事件（agent_start / tool_execution_start 之前的辅助事件等）不直接产生 UI 帧。
		return frames;
	}

	/** 主动结束当前流（连接断开 / 超时兜底时调用）。 */
	finish(): UiMessageStreamFrame[] {
		return this.finishMessage({});
	}

	/** 是否已发出 finish 帧。 */
	isFinished(): boolean {
		return this.finished;
	}

	private handleAssistantMessageEvent(ev: Record<string, unknown>): UiMessageStreamFrame[] {
		const frames: UiMessageStreamFrame[] = [];
		const eventType = ev.type;

		// 文本：AI SDK 需要 start/delta/end 三件套；首次 delta 前自动补 text-start。
		if (eventType === "text_start" || eventType === "text_delta" || eventType === "text_end") {
			const delta = String(ev.delta ?? ev.text ?? "");
			if (!this.textBlockId) {
				this.textBlockId = `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				frames.push({ type: "text-start", id: this.textBlockId });
			}
			if (eventType === "text_delta" && delta) {
				frames.push({ type: "text-delta", id: this.textBlockId, delta });
			}
			if (eventType === "text_end" && this.textBlockId) {
				frames.push({ type: "text-end", id: this.textBlockId });
				this.textBlockId = null;
			}
			return frames;
		}

		// 思考：同样 start/delta/end；thinking_end 可能带完整 content（已含全部增量）。
		if (eventType === "thinking_delta" || eventType === "thinking_end") {
			const delta = String(ev.delta ?? ev.thinking ?? "");
			const finalContent = eventType === "thinking_end" ? String(ev.content ?? "") : "";
			if (!this.reasoningBlockId) {
				this.reasoningBlockId = `reasoning_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				this.reasoningDeltaSent = false;
				frames.push({ type: "reasoning-start", id: this.reasoningBlockId });
			}
			if (eventType === "thinking_delta" && delta) {
				this.reasoningDeltaSent = true;
				frames.push({ type: "reasoning-delta", id: this.reasoningBlockId, delta });
			}
			if (eventType === "thinking_end") {
				// 兜底：本块从未发过增量（pi 只给了 content）时才补一段 delta，避免前端空白。
				// 已发过增量再补会让客户端把同一段全文追加两次（思考内容翻倍）。
				if (finalContent && !delta && !this.reasoningDeltaSent) {
					this.reasoningDeltaSent = true;
					frames.push({ type: "reasoning-delta", id: this.reasoningBlockId, delta: finalContent });
				}
				frames.push({ type: "reasoning-end", id: this.reasoningBlockId });
				this.reasoningBlockId = null;
			}
			return frames;
		}

		// 工具调用（message_update 路径：toolcall_start / toolcall_end）。
		if (eventType === "toolcall_start") {
			const toolCall = ev.toolCall as Record<string, unknown> | undefined;
			if (toolCall && typeof toolCall.id === "string" && typeof toolCall.name === "string") {
				// 双路径去重：顶层 tool_execution_start 先到时不重发 input 帧（重发会把 AI SDK 端已 settle 的 part 拍回 running）。
				if (this.inputSentToolCallIds.has(toolCall.id) || this.settledToolCallIds.has(toolCall.id)) return frames;
				this.inputSentToolCallIds.add(toolCall.id);
				frames.push({
					type: "tool-input-start",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
				});
				frames.push({
					type: "tool-input-available",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: toolCall.input ?? {},
				});
			}
			return frames;
		}
		if (eventType === "toolcall_end") {
			const toolCall = ev.toolCall as Record<string, unknown> | undefined;
			if (toolCall && typeof toolCall.id === "string") {
				// 容错：若当前流中途建立或跨端并发输入，未见证过 toolcall_start，
				// 过滤孤儿 toolcall_end，防止 AI SDK 抛出 "No tool invocation found for tool call ID" 导致告警红条。
				if (!this.inputSentToolCallIds.has(toolCall.id)) {
					return [];
				}
				// toolcall_end 只是 LLM 层把调用参数发完，执行尚未开始/结束：
				// 不带 output 时不 settle（保持 running，等顶层 tool_execution_end 带真实结果）；
				// 带 output（pi replay 最终消息）才提前结算，且要防重复。
				const output = toolCall.output;
				if (output === null || output === undefined) return frames;
				if (this.settledToolCallIds.has(toolCall.id)) return frames;
				this.settledToolCallIds.add(toolCall.id);
				this.inputSentToolCallIds.delete(toolCall.id);
				frames.push({
					type: "tool-output-available",
					toolCallId: toolCall.id,
					output,
				});
			}
			return frames;
		}

		// message_update 的 done：这一条 assistant 文本/思考结束，不是整轮 run 结束。
		// 工具调用回合随后还有 tool_execution_* 和下一轮 message_start，绝不能在这里关 SSE。
		if (eventType === "done") {
			return this.closeOpenBlocks();
		}

		return frames;
	}

	private startTool(event: PiEvent): UiMessageStreamFrame[] {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : `tool_${toolName}_${Date.now()}`;
		// 双路径去重：message 层 toolcall_start 已发过 input 时不再重发，避免 state 回退成 running。
		if (this.inputSentToolCallIds.has(toolCallId) || this.settledToolCallIds.has(toolCallId)) return [];
		this.inputSentToolCallIds.add(toolCallId);
		return [
			{ type: "tool-input-start", toolCallId, toolName },
			{ type: "tool-input-available", toolCallId, toolName, input: event.args ?? {} },
		];
	}

	private endTool(event: PiEvent): UiMessageStreamFrame[] {
		const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
		if (!toolCallId) return [];
		// 容错：若当前流中途建立或跨端并发输入，未见证过 tool_execution_start，
		// 过滤孤儿 tool_execution_end，防止 AI SDK 抛出 "No tool invocation found for tool call ID" 导致告警红条。
		// 已结算（message 层 toolcall_end 带 output 先到过）不重复发；从未见过 start 的孤儿同样滤掉。
		if (this.settledToolCallIds.has(toolCallId) || !this.inputSentToolCallIds.has(toolCallId)) {
			return [];
		}
		this.settledToolCallIds.add(toolCallId);
		this.inputSentToolCallIds.delete(toolCallId);
		if (event.isError) {
			return [
				{
					type: "tool-output-error",
					toolCallId,
					errorText: typeof event.error === "string" ? event.error : "Tool failed",
				},
			];
		}
		// 工具真实结果（P2 工具卡展开）：优先 result，退 partialResult，都没有时空对象。
		// 超大输出截断到 64KB 预览（SSE 帧必须有界，与桌面 timeline 截断同源考量）。
		const rawOutput = event.result ?? event.partialResult ?? {};
		let output: unknown = {};
		try {
			const serialized = JSON.stringify(rawOutput) ?? "{}";
			output = serialized.length > 64 * 1024 ? { truncated: true, preview: `${serialized.slice(0, 32 * 1024)}…` } : rawOutput;
		} catch {
			output = {};
		}
		return [{ type: "tool-output-available", toolCallId, output }];
	}

	/** 只关当前 text/reasoning 块，不结束整条 SSE。 */
	private closeOpenBlocks(): UiMessageStreamFrame[] {
		const frames: UiMessageStreamFrame[] = [];
		if (this.textBlockId) {
			frames.push({ type: "text-end", id: this.textBlockId });
			this.textBlockId = null;
		}
		if (this.reasoningBlockId) {
			frames.push({ type: "reasoning-end", id: this.reasoningBlockId });
			this.reasoningBlockId = null;
		}
		return frames;
	}

	private finishMessage(event: PiEvent): UiMessageStreamFrame[] {
		if (this.finished) return [];
		this.finished = true;
		const frames = this.closeOpenBlocks();
		if (event.error !== undefined) {
			const errorText = typeof event.error === "string" ? event.error : "Agent 运行失败";
			frames.push({ type: "error", errorText });
		}
		frames.push({ type: "finish" });
		return frames;
	}
}

/** SSE 协议固定头，useChat 依赖它识别 UIMessageStream。 */
export const UI_MESSAGE_STREAM_HEADER = "x-vercel-ai-ui-message-stream";

/** 把单条 SSE 帧序列化为 wire 格式（data: {json}\n\n）。 */
export function serializeSseFrame(frame: UiMessageStreamFrame): string {
	return `data: ${JSON.stringify(frame)}\n\n`;
}

/** [DONE] 终止标记。 */
export const SSE_DONE = "data: [DONE]\n\n";

/**
 * 每个 session 一条活跃流的连接状态（只带连接自身的东西）。
 * 翻译器与回放帧是**会话级**的（见 SessionRunState）：同一会话的多条连接收到完全相同的帧，
 * 这样中途接入的连接回放历史 + 继续收增量不会和别的连接错位。
 * keepAlive：外部流（GET /stream，EventSource 常驻订阅）在一轮 finish+[DONE] 后
 * 不关连接，而是等下一轮——消除轮与轮之间的重连空窗
 * （Ask 续答/桌面发起的下一轮若落在重连窗口内，事件全部丢失、前端只能等磁盘追赶）。
 * /api/chat（useChat 一次性 fetch）不用 keepAlive：AI SDK 语义要求流随 [DONE] 结束。
 */
export type SessionStreamEntry = {
	sessionId: string;
	/** 写出原始 wire 文本（含 data: 前缀）；返回是否成功。 */
	writeRaw: (wire: string) => boolean;
	closed: boolean;
	/** 一轮结束后不结束响应，继续等下一轮（外部流）。 */
	keepAlive?: boolean;
	onFinish?: () => void;
};

/**
 * 会话级实时状态：一个会话一份翻译器 + 本轮已产出的帧（回放源）。
 *
 * 为什么要有这一层：外部流是「中途接入」的（手机点开一个桌面端正在跑的会话、
 * 切后台断流后回来重连）。只转发订阅之后的增量，前端就只能看到本轮尾巴——
 * 工具卡数量从 1 重算、已渲染内容消失（用户反馈的实际故障）。
 * 这里无条件翻译（即使没有订阅者），新连接接入时把本轮帧整段回放，前端从零重建即可对齐。
 */
type SessionRunState = {
	/** pi 事件 → 帧 的会话级翻译器（跨连接共享，收口时替换）。 */
	adapter: PiEventToUiMessageStream;
	/** 非 pi 后端（DSH）通道载荷 → pi 事件 的会话级翻译器。 */
	channels: DshChannelToPiEvents;
	/** 本轮回放帧（text/reasoning 增量已合并）。 */
	runFrames: UiMessageStreamFrame[];
	/** 本轮已收口（收口后不回放，等下一轮 start 重建）。 */
	runClosed: boolean;
	/** 回放帧超上限：放弃回放。 */
	runOverflow: boolean;
};

/**
 * WebEventStreamRouter — 管理「sessionId → SSE 连接」并接收全量 pi 事件按 agentId 路由。
 * 用法：
 *   1. subscribe 时创建 entry，写响应头并注册到 sessionStreams；外部流（keepAlive）
 *      额外整段回放本轮已产出的帧（中途接入也能拿到完整一轮）
 *   2. 全局只订阅一次 pi 事件源，事件到达后按 agentId→sessionId 路由：会话级翻译器产出帧
 *      → 存入本轮回放源 → 写给该会话的所有连接
 *   3. 连接断开（response close）时 remove，最后一个连接断开时取消全局订阅
 */
export class WebEventStreamRouter {
	private readonly sessionStreams = new Map<string, Set<SessionStreamEntry>>();
	private unsubscribePi: (() => void) | null = null;
	private unsubscribeChannels: (() => void) | null = null;
	/**
	 * 会话级「已收口正文」基准：每条连接一份翻译器，连接重建时基准必须延续——
	 * 停止的握手是「abort 先收口，host 迟到的 turn/end 再带同一份全文收一次」，
	 * 中间断开重连（Web 端 stop 后外部流重建）会让新翻译器把重复收口当成新一轮上屏。
	 * key 按会话保留，值在下一轮 turn/start（reset）时被翻译器清空。
	 */
	private readonly closedRunTextBySession = new Map<string, string>();
	/** 会话级实时状态（翻译器 + 本轮回放帧）；无订阅者也维护，见 SessionRunState。 */
	private readonly sessionStates = new Map<string, SessionRunState>();

	constructor(private readonly resolveSession: AgentToSessionRouter) {}

	/** 注册一个 session 的 SSE 连接。返回关闭函数。 */
	add(sessionId: string, writeRaw: (wire: string) => boolean, onClose: () => void, onFinish?: () => void, options?: { keepAlive?: boolean }): () => void {
		const entry: SessionStreamEntry = {
			sessionId,
			writeRaw,
			closed: false,
			keepAlive: options?.keepAlive === true,
			onFinish,
		};
		let set = this.sessionStreams.get(sessionId);
		if (!set) {
			set = new Set();
			this.sessionStreams.set(sessionId, set);
		}
		set.add(entry);

		const close = () => {
			if (entry.closed) return;
			entry.closed = true;
			set?.delete(entry);
			if (set && set.size === 0) this.sessionStreams.delete(sessionId);
			onClose();
		};
		// 外部流中途接入（手机点开桌面端正在跑的会话 / 切后台回来重连）：先整段回放本轮已产出的帧，
		// 再继续收增量。同步执行，事件循环不会插进新的 pi 事件，所以不会重复也不会漏。
		if (entry.keepAlive) this.replayRun(sessionId, entry, set);
		return close;
	}

	/** 供后端绑定：从 pi 事件源订阅全量事件（应只订阅一次）。 */
	bindPiSource(subscribe: ((handler: (agentId: string, event: PiEvent) => void) => () => void) | undefined): void {
		this.unsubscribePi?.();
		if (!subscribe) {
			// 装配方未提供订阅器（例如测试/受限环境）：不订阅也不抛错，路由器保持空闲。
			this.unsubscribePi = null;
			return;
		}
		this.unsubscribePi = subscribe((agentId, event) => this.onPiEvent(agentId, event));
	}

	/** 解绑 pi 事件源（服务停止时调用）；会话级回放源一并丢弃，避免重启后回放上一轮的幽灵内容。 */
	unbindPiSource(): void {
		this.unsubscribePi?.();
		this.unsubscribePi = null;
		this.sessionStates.clear();
	}

	/**
	 * 供后端绑定：订阅非 pi 后端（DSH）的 agent 通道事件。
	 * 没有这一层时 DSH 会话在 Web 端只能靠状态轮询 + 磁盘重拉追赶（输出很慢），
	 * 且整轮没有 finish 帧（察觉不到结束/停止）。
	 */
	bindChannelSource(subscribe: AgentChannelEventSource | undefined): void {
		this.unsubscribeChannels?.();
		if (!subscribe) {
			this.unsubscribeChannels = null;
			return;
		}
		this.unsubscribeChannels = subscribe((agentId, channel, payload) => this.onChannelEvent(agentId, channel, payload));
	}

	/** 解绑通道事件源（服务停止时调用）。 */
	unbindChannelSource(): void {
		this.unsubscribeChannels?.();
		this.unsubscribeChannels = null;
	}

	private onPiEvent(agentId: string, event: PiEvent): void {
		const sessionId = this.resolveSession(agentId);
		if (!sessionId) return;
		// 即使没有任何订阅者也要翻译：这里的帧就是新连接接入时的回放源（见 SessionRunState）。
		const state = this.sessionStateFor(sessionId);
		const frames = state.adapter.push(event);
		this.recordRunFrames(state, frames);
		this.emitToSession(sessionId, frames);
		// 收口放在写出之后：finish/[DONE] 要先送到现有连接，再清空回放源、换新翻译器。
		if (frames.some((frame) => frame.type === "finish")) this.endRun(state);
	}

	/**
	 * 非 pi 后端的通道事件：先翻译成 pi 事件形状，再走同一个适配器产出 UI 帧。
	 * 与 pi 事件一致，无订阅者也翻译——回放源必须连续，否则中途接入的连接看不到本轮前半段。
	 */
	private onChannelEvent(agentId: string, channel: string, payload: unknown): void {
		const sessionId = this.resolveSession(agentId);
		if (!sessionId) return;
		const state = this.sessionStateFor(sessionId);

		const frames: UiMessageStreamFrame[] = [];
		for (const event of state.channels.push(channel, payload)) {
			frames.push(...state.adapter.push(event));
		}
		// 会话级记住收口基准，供状态被淘汰后重建的翻译器 seed（见字段注释）。
		const baseline = state.channels.baseline();
		if (baseline === null) this.closedRunTextBySession.delete(sessionId);
		else this.rememberClosedRun(sessionId, baseline);

		this.recordRunFrames(state, frames);
		this.emitToSession(sessionId, frames);
		if (frames.some((frame) => frame.type === "finish")) this.endRun(state);
	}

	/**
	 * 取（或创建）会话级实时状态；超上限时优先淘汰没有活跃连接的最旧会话。
	 * 命中即刷新顺序（LRU）：长时间在跑的会话不能被新会话挤掉，否则翻译器状态丢失，
	 * 在跑的工具会变成孤儿事件被丢掉、卡片卡在 running。
	 */
	private sessionStateFor(sessionId: string): SessionRunState {
		const existing = this.sessionStates.get(sessionId);
		if (existing) {
			this.sessionStates.delete(sessionId);
			this.sessionStates.set(sessionId, existing);
			return existing;
		}
		if (this.sessionStates.size >= SESSION_STATES_MAX) this.evictIdleSessionState();
		const state: SessionRunState = {
			adapter: new PiEventToUiMessageStream(),
			channels: new DshChannelToPiEvents(this.closedRunTextBySession.get(sessionId) ?? null),
			runFrames: [],
			runClosed: true,
			runOverflow: false,
		};
		this.sessionStates.set(sessionId, state);
		return state;
	}

	/** 淘汰一个没有活跃连接的状态；全都有连接时退化为淘汰最旧的。 */
	private evictIdleSessionState(): void {
		let oldest: string | undefined;
		for (const key of this.sessionStates.keys()) {
			if (oldest === undefined) oldest = key;
			const streams = this.sessionStreams.get(key);
			if (!streams || streams.size === 0) {
				this.sessionStates.delete(key);
				return;
			}
		}
		if (oldest !== undefined) this.sessionStates.delete(oldest);
	}

	/**
	 * 累积本轮回放帧。新的一轮（上一轮已收口后的第一批帧）先清空再累积；
	 * 文本/思考增量就近合并成一段 delta，避免长回复把回放源撑成几千条。
	 */
	private recordRunFrames(state: SessionRunState, frames: UiMessageStreamFrame[]): void {
		if (frames.length === 0) return;
		if (state.runClosed) {
			state.runFrames = [];
			state.runOverflow = false;
			state.runClosed = false;
		}
		if (state.runOverflow) return;
		for (const frame of frames) {
			const type = frame.type;
			if (type === "text-delta" || type === "reasoning-delta") {
				const last = state.runFrames.at(-1);
				if (last && last.type === type && last.id === frame.id) {
					last.delta = `${String(last.delta ?? "")}${String(frame.delta ?? "")}`;
					continue;
				}
			}
			state.runFrames.push(frame);
			if (state.runFrames.length > RUN_REPLAY_MAX_FRAMES) {
				state.runOverflow = true;
				state.runFrames = [];
				return;
			}
		}
	}

	/** 本轮收口：清空回放帧（已结束的一轮不再回放），换新翻译器等下一轮。 */
	private endRun(state: SessionRunState): void {
		state.runFrames = [];
		state.runOverflow = false;
		state.runClosed = true;
		state.adapter = new PiEventToUiMessageStream();
	}

	/** 新连接的回放：把本轮已产出的帧整段写给它，之后继续收增量。 */
	private replayRun(sessionId: string, entry: SessionStreamEntry, set: Set<SessionStreamEntry>): void {
		const state = this.sessionStates.get(sessionId);
		if (!state || state.runClosed || state.runOverflow || state.runFrames.length === 0) return;
		for (const frame of state.runFrames) {
			if (entry.writeRaw(serializeSseFrame(frame))) continue;
			// 写出失败（对方已断开）：与 emitFrames 同口径，标记关闭并摘掉。
			entry.closed = true;
			set.delete(entry);
			if (set.size === 0) this.sessionStreams.delete(sessionId);
			return;
		}
	}

	/** 把一批帧写到该会话的所有存活连接。 */
	private emitToSession(sessionId: string, frames: UiMessageStreamFrame[]): void {
		if (frames.length === 0) return;
		const set = this.sessionStreams.get(sessionId);
		if (!set || set.size === 0) return;
		// 复制一份再遍历：emitFrames 会从原集合里删掉已断开的连接。
		for (const entry of [...set]) {
			if (entry.closed) continue;
			this.emitFrames(entry, set, frames);
		}
		if (set.size === 0) this.sessionStreams.delete(sessionId);
	}

	/** 记录会话的收口基准；上限只兜底（真实场景是少量活跃会话）。 */
	private rememberClosedRun(sessionId: string, text: string): void {
		if (!this.closedRunTextBySession.has(sessionId) && this.closedRunTextBySession.size >= CLOSED_RUN_SESSIONS_MAX) {
			const oldest = this.closedRunTextBySession.keys().next().value;
			if (oldest !== undefined) this.closedRunTextBySession.delete(oldest);
		}
		this.closedRunTextBySession.set(sessionId, text);
	}

	/** 把一批 UI 帧写到单条连接上；finish 帧按 keepAlive 语义收尾或保活。 */
	private emitFrames(entry: SessionStreamEntry, set: Set<SessionStreamEntry>, frames: UiMessageStreamFrame[]): void {
		for (const frame of frames) {
			if (!entry.writeRaw(serializeSseFrame(frame))) {
				// 写出失败（对方断开）：立即标记关闭，避免持续写已失效的 socket。
				entry.closed = true;
				set.delete(entry);
				return;
			}
			// AI SDK 协议：finish 帧后必须跟 [DONE] 终止标记，前端据此关闭连接。
			if (frame.type !== "finish") continue;
			if (!entry.writeRaw(SSE_DONE)) {
				entry.closed = true;
				set.delete(entry);
				return;
			}
			// keepAlive（外部流）：连接保留，等下一轮；客户端在下一轮的 start 帧上自行重置合并器。
			// 会话级翻译器已由调用方（onPiEvent/onChannelEvent）在收口时替换，这里不动它。
			// 非 keepAlive（/api/chat）：[DONE] 后显式 end，否则 useChat 可能继续等待 HTTP body
			// 关闭，界面会一直显示运行中。
			if (entry.keepAlive) return;
			entry.closed = true;
			set.delete(entry);
			entry.onFinish?.();
			return;
		}
	}
}

/** 生成 SSE 响应头。 */
export function writeSseHeaders(setHeader: (name: string, value: string) => void, writeHead: (status: number, headers: Record<string, string>) => void): void {
	writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
		[UI_MESSAGE_STREAM_HEADER]: "v1",
	});
	// writeHead 已带 header；setHeader 仅作类型占位兼容，实际不会重复调用。
	void setHeader;
}
