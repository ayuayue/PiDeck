/**
 * AcpChannelToPiEvents — ACP agent 通道载荷 → pi 事件形状 的翻译器。
 *
 * 背景：Web SSE（/api/chat、/api/sessions/:id/stream）的翻译层只认 pi RPC 事件，
 * 而 ACP 会话既没有 pi 的事件流，也没有 DSH 的累积 text-stream：它的流式数据是
 * **投影快照**——AcpUpdatePipeline 每 ≤80ms 把整个 `projection.messages` 推一次
 * （agents:message，全量替换语义），回合终态另经 agents:runtime-state 上报。
 * 缺这一层时 Web 端 ACP 会话就是本次要修的两个症状：正文/工具卡不实时出现、
 * 整轮没有 finish 帧（前端一直显示运行中）。
 *
 * 设计：把快照差分成增量、翻译成 pi 事件形状，交给同一个 PiEventToUiMessageStream
 * 产出 UIMessageStream 帧（见 WebEventStream.bindAcpChannelSource），因此 Web 线协议、
 * 前端合并器与 useChat 链路零改动。
 *
 * 三条不可省的语义：
 * 1) 正文/思考按 `message.id` + 已发长度取差集：快照是全量，重复快照不能重发 delta；
 * 2) 一回合可有多条 assistant 段（工具调用前后各切一段）：每段一次 message_start，
 *    适配器会把它翻成 start-step，同一条 UI 消息里继续画（见 #413 投影切段）；
 * 3) 回合边界只认 runtime-state 的 isStreaming/isTurnActive 翻 false。settleAcpTurn
 *    在工具-only 回合不写任何终态标记，「无 pending 段 + 无 running 工具」这一刻在
 *    「工具已完成、下一段正文还没来」时是合法中间态，用它收口会把回合切断。
 *
 * 载荷约定（见 AcpAgentManager / AcpUpdatePipeline 发射点）：
 *   - agents:message：{ agentId, deckSessionId, messages: ChatMessage[], totalLength, replay?: true }
 *     工具卡是 role:"tool" 且带 meta.{toolCallId,toolName,status,args,fullText,detailText}；
 *     assistant 段 stopReason: "pending"=进行中 / "toolUse"=中间回复 / 其余=回合终态。
 *     replay=true 表示 session/load 重放/投影重建的分块投递（flushMessagesChunked）：
 *     整份窗口都是已结算历史，只更新基线、绝不当增量上屏（否则重放历史会同时以
 *     「历史条目」和「新一轮回复」上屏两次，即 Web 端 ACP 文本重复渲染）；
 *     turnActive 只在 replay 块上出现，true = 重放来自仍在跑的回合（不得收口进行中的流）。
 *   - agents:runtime-state：{ agentId, state: { isStreaming, isTurnActive, ... } }
 *
 * 快照首帧即基线：连接建立前**已经结算**的内容一律不重发（已由历史接口覆盖）；
 * 但进行中的段/工具不预置游标——它们就是这一轮还没上过屏的东西，
 * 基线把待发内容也标成「已发过」会永久吐掉首帧那 ≤80ms 的正文。
 */
import { agentEventTags } from "../../shared/ipc";
import type { PiEvent } from "./WebEventStream";

/** 工具输出预览上限（SSE 帧必须有界，与 DSH 翻译器同量级）。 */
const TOOL_TEXT_MAX_CHARS = 32 * 1024;

/** 只关当前 text/reasoning 块（不结束整条流）的 pi 事件。 */
const CLOSE_BLOCKS: PiEvent = { type: "message_update", assistantMessageEvent: { type: "done" } };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** 最后一条用户消息的下标；-1 表示整段都是历史（没有本轮起点）。 */
function lastUserMessageIndex(messages: readonly unknown[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const raw = messages[index];
		if (isRecord(raw) && raw.role === "user") return index;
	}
	return -1;
}

/** 工具卡身份：投影的 meta.toolCallId 是稳定 id，缺省退回消息 id（工具卡 text 是标题，不能当键）。 */
function toolKeyOf(message: Record<string, unknown>): string {
	const meta = isRecord(message.meta) ? message.meta : undefined;
	return asString(meta?.toolCallId) ?? asString(message.id) ?? "";
}

/** 单段 assistant 的已发游标。closed=本轮这一段已收过（含块关闭与终态）。 */
type SegmentCursor = { text: number; thinking: number; closed: boolean };

export class AcpChannelToPiEvents {
	/** 同一回合内的 assistant 段游标，按 message.id 索引；离开回合窗口即回收（见 pruneCursors）。 */
	private readonly segments = new Map<string, SegmentCursor>();
	/** 工具卡状态：running=已发过 start（等 end），ended=生命周期完结（不再重发）。 */
	private readonly tools = new Map<string, "running" | "ended">();
	/** 本轮是否已发过 message_start（决定首次内容帧前是否需要补开一条 UI 消息）。 */
	private runOpen = false;
	private runSeq = 0;
	/** 首帧快照已建立基线（见文件头「快照首帧即基线」）。 */
	private baselineDone = false;

	/** 翻译一个 ACP 通道载荷为 0..n 个 pi 事件；无关通道原样忽略。 */
	push(channel: string, payload: unknown): PiEvent[] {
		if (channel === agentEventTags.agentsMessage) return this.pushSnapshot(payload);
		if (channel === agentEventTags.agentsRuntimeState) return this.pushRuntimeState(payload);
		return [];
	}

	/** 投影快照 → 增量正文/思考/工具卡事件。 */
	private pushSnapshot(raw: unknown): PiEvent[] {
		const payload = isRecord(raw) ? raw : undefined;
		const messages = payload && Array.isArray(payload.messages) ? payload.messages : undefined;
		if (!messages) return [];
		const lastUser = lastUserMessageIndex(messages);
		// 激活重放（session/load 重建投影）：内容全部是历史，客户端已由历史接口拿到。
		// 重建后的消息 id 全变，若照增量翻译会把整段历史当成新一轮回复再画一遍。
		if (payload?.replay === true) return this.absorbReplay(messages, lastUser, payload.turnActive === true);
		if (!this.baselineDone) {
			this.baselineDone = true;
			// 基线只锁「已结算」的部分；不在本轮窗口里的项照样会走翻译，
			// 因此这里不能提前返回（否则首张快照里进行中的正文会永久丢失）。
			this.seedBaseline(messages, lastUser);
		}
		// 只翻译本轮窗口（最后一条用户消息之后）：本回合内的段游标才有意义。
		const windowStart = lastUser + 1;
		this.pruneCursors(messages, windowStart);

		const events: PiEvent[] = [];
		for (let index = windowStart; index < messages.length; index += 1) {
			const message = messages[index];
			if (!isRecord(message)) continue;
			if (message.role === "assistant") this.pushAssistant(message, events);
			else if (message.role === "tool") this.pushTool(message, events);
		}
		return events;
	}

	/** 回合边界（权威信号）：isStreaming 翻 true 即开流，翻 false 即收口。 */
	private pushRuntimeState(raw: unknown): PiEvent[] {
		const state = isRecord(raw) && isRecord(raw.state) ? raw.state : undefined;
		if (!state) return [];
		const streaming = state.isStreaming === true || state.isTurnActive === true;
		if (streaming) {
			// 立刻给出 start 帧：发送后前端马上进「运行中」，空白回合也有可收口的气泡。
			return this.openRunOnly();
		}
		if (!this.runOpen) return [];
		this.runOpen = false;
		// 工具-only 回合没有终态段：这里统一关块，再走适配器的 agent_settled 收口。
		for (const cursor of this.segments.values()) cursor.closed = true;
		return [CLOSE_BLOCKS, { type: "agent_settled" }];
	}

	/**
	 * 重放块：只把内容吸收进基线（已结算=已发过），不产任何增量。
	 * 若此刻还有一条未收口的流（运行时重建会中断进行中的回合），先关块收口，
	 * 让前端切回历史视图，而不是把重建后的历史追加到旧气泡上；重放来自仍在跑的
	 * 回合时（握手期间就发了 prompt）不得收口，那一条流是活的。
	 */
	private absorbReplay(messages: readonly unknown[], lastUser: number, liveTurn: boolean): PiEvent[] {
		this.baselineDone = true;
		this.seedBaseline(messages, lastUser);
		this.pruneCursors(messages, lastUser + 1);
		if (liveTurn || !this.runOpen) return [];
		this.runOpen = false;
		for (const cursor of this.segments.values()) cursor.closed = true;
		return [CLOSE_BLOCKS, { type: "agent_settled" }];
	}

	/**
	 * 首帧基线：本次状态创建之前就已结算的内容标为「已发过」（历史接口已覆盖）。
	 * 进行中的 assistant 段与在跑的工具**不预置**：它们属于还没上过屏的本轮内容，
	 * 下一张快照会当新段/新卡补发。只处理本轮窗口，历史条目不必进游标表。
	 */
	private seedBaseline(messages: readonly unknown[], lastUser: number): void {
		for (let index = lastUser + 1; index < messages.length; index += 1) {
			const message = messages[index];
			if (!isRecord(message)) continue;
			const id = asString(message.id);
			if (message.role === "assistant" && id) {
				if (message.stopReason === "pending") continue;
				this.segments.set(id, {
					text: (asString(message.text) ?? "").length,
					thinking: (asString(message.thinking) ?? "").length,
					closed: true,
				});
			} else if (message.role === "tool") {
				const key = toolKeyOf(message);
				if (!key) continue;
				// 在跑的工具卡片要补发（start → end），已结束的卡片只置标记不重发。
				const meta = isRecord(message.meta) ? message.meta : {};
				const status = asString(meta.status) ?? "completed";
				if (status !== "running") this.tools.set(key, "ended");
			}
		}
	}

	/** 回收离开本轮窗口的游标：会话再长，游标表也只保留一回合的量。 */
	private pruneCursors(messages: readonly unknown[], windowStart: number): void {
		const active = new Set<string>();
		for (let index = Math.max(0, windowStart); index < messages.length; index += 1) {
			const message = messages[index];
			if (!isRecord(message)) continue;
			const id = asString(message.id);
			if (id) active.add(id);
			if (message.role === "tool") {
				const key = toolKeyOf(message);
				if (key) active.add(key);
			}
		}
		for (const id of this.segments.keys()) if (!active.has(id)) this.segments.delete(id);
		for (const id of this.tools.keys()) if (!active.has(id)) this.tools.delete(id);
	}

	/** 一段 assistant 正文/思考：按游标发增量，终态段补块关闭（不在此收口整轮）。 */
	private pushAssistant(message: Record<string, unknown>, events: PiEvent[]): void {
		const id = asString(message.id);
		if (!id) return;
		const text = asString(message.text) ?? "";
		const thinking = asString(message.thinking) ?? "";
		const pending = message.stopReason === "pending";

		let cursor = this.segments.get(id);
		if (!cursor) {
			// 新段（工具循环的下一跳）：补一条 message_start，适配器会翻成 start-step。
			cursor = { text: 0, thinking: 0, closed: false };
			this.segments.set(id, cursor);
			events.push(...this.beginSegment(id));
		} else if (cursor.closed && (text.length > cursor.text || thinking.length > cursor.thinking)) {
			// 迟到 chunk 并回了已收口的段（trailingAssistantIndex）：重开块继续画，不丢内容。
			cursor.closed = false;
			events.push(...this.beginSegment(id));
		}

		if (thinking.length > cursor.thinking) {
			events.push({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: thinking.slice(cursor.thinking) } });
			cursor.thinking = thinking.length;
		}
		if (text.length > cursor.text) {
			events.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text.slice(cursor.text) } });
			cursor.text = text.length;
		}
		if (!pending && !cursor.closed) {
			// 中间回复（toolUse）与回合终态都关块：下一段正文要开新块，不能接着上一段追加。
			cursor.closed = true;
			events.push(CLOSE_BLOCKS);
		}
	}

	/** 一张工具卡：首次进入发 start，状态收敛后发一次 end（结果正文有界）。 */
	private pushTool(message: Record<string, unknown>, events: PiEvent[]): void {
		const key = toolKeyOf(message);
		if (!key) return;
		const meta = isRecord(message.meta) ? message.meta : {};
		const status = asString(meta.status) ?? "completed";
		const toolName = asString(meta.toolName) ?? asString(message.text) ?? "tool";

		const known = this.tools.get(key);
		if (known === "ended") return;
		if (!known) {
			this.tools.set(key, "running");
			events.push(...this.openRunOnly());
			events.push({ type: "tool_execution_start", toolCallId: key, toolName, args: meta.args ?? {} });
		}
		if (status === "running") return;

		this.tools.set(key, "ended");
		const detail = asString(meta.detailText);
		const resultText = (asString(meta.fullText) ?? detail ?? "").slice(0, TOOL_TEXT_MAX_CHARS);
		events.push({
			type: "tool_execution_end",
			toolCallId: key,
			toolName,
			isError: status === "error" || meta.isError === true,
			result: {
				toolName,
				// 与 DSH 翻译器同形状：Web 时间线的工具卡按 text 展示正文。
				text: resultText,
				status,
				...(detail ? { detailText: detail } : {}),
				...(meta.truncated === true ? { truncated: true } : {}),
			},
		});
	}

	/** 开一条 UI 消息（本轮首帧）：适配器翻成 start；已有本回合时什么都不做。 */
	private openRunOnly(): PiEvent[] {
		if (this.runOpen) return [];
		this.runOpen = true;
		this.runSeq += 1;
		return [{ type: "message_start", message: { role: "assistant", id: `acp-run-${this.runSeq}` } }];
	}

	/**
	 * 开一段 assistant 段：段 id 作 message.id。本轮首帧时适配器据此发 start，
	 * 已开的回合里同一条 UI 消息发 start-step（工具循环不拆气泡）。
	 */
	private beginSegment(id: string): PiEvent[] {
		this.runOpen = true;
		return [{ type: "message_start", message: { role: "assistant", id } }];
	}
}
