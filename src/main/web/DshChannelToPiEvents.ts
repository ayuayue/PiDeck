/**
 * DshChannelToPiEvents — DSH agent 通道事件 → pi 事件形状 的翻译器。
 *
 * 背景：Web SSE（/api/chat、/api/sessions/:id/stream）原来的翻译器只认 pi RPC 事件
 * （agent_start / message_update / tool_execution_* / agent_settled），而 DSH 会话的
 * 流式数据走自己的通道（agents:text-stream / agents:thinking / agents:message）。
 * 缺这一层时 Web 端 DSH 会话表现为两个症状：
 *   1) 正文只能靠状态轮询 + 磁盘重拉追赶（≥5s 才见字）——「输出很慢」；
 *   2) 整轮没有任何 finish 帧，useChat 永远停在 streaming——「察觉不到结束/停止」。
 *
 * 设计：把 DSH 通道载荷翻译成 pi 事件形状，交给同一个 PiEventToUiMessageStream
 * 产出 UIMessageStream 帧，因此 Web 线协议、前端合并器与 useChat 链路零改动。
 * 状态（正文/思考游标、已发过的工具卡）按连接实例隔离，不跨连接共享。
 *
 * 载荷约定（见 DshAgentManager 发射点）：
 *   - agents:text-stream：{ text: 累积全文, done, reset?, turnEnded?, delta? }
 *     reset=turn/start 新回合；turnEnded=本轮真正结束（正常收口/被停止的迟到 turn/end/abort）；
 *     done 但无 turnEnded=单条 assistant 消息说完（工具循环还会再来一条）。
 *   - agents:thinking：{ id, text: 累积思考全文, done }
 *   - agents:message：{ messages: ChatMessage[] }，工具卡是 role:"tool" 且带
 *     meta.{toolCallId,toolName,status,args,fullText,detailText}
 */
import { ipcChannels } from "../../shared/ipc";
import type { PiEvent } from "./WebEventStream";

/** 只关当前 text/reasoning 块（不结束整条流）的 pi 事件。 */
const CLOSE_BLOCKS: PiEvent = { type: "message_update", assistantMessageEvent: { type: "done" } };
/** 只关思考块（不碰正文）的 pi 事件。翻译器自己用 flag 门控，避免适配器在无块时凭空开一个空块。 */
const CLOSE_THINKING: PiEvent = { type: "message_update", assistantMessageEvent: { type: "thinking_end" } };

/** DSH 工具的展示正文上限（SSE 帧必须有界；桌面端同源截断到 2000 字符内）。 */
const TOOL_TEXT_MAX_CHARS = 32 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** 最后一条用户消息的下标；-1 表示整段都是历史（没有本轮起点）。 */
function lastUserMessageIndex(messages: unknown[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const raw = messages[index];
		if (isRecord(raw) && raw.role === "user") return index;
	}
	return -1;
}

/** 工具结果正文：优先投影保留的全文，退回「工具名: 结果」里剥掉前缀的部分。 */
function toolResultText(text: string | undefined, toolName: string, meta: Record<string, unknown> | undefined): string {
	const fullText = asString(meta?.fullText);
	if (fullText) return fullText.slice(0, TOOL_TEXT_MAX_CHARS);
	const prefix = `${toolName}: `;
	const stripped = text?.startsWith(prefix) ? text.slice(prefix.length) : (text ?? "");
	return stripped.slice(0, TOOL_TEXT_MAX_CHARS);
}

export class DshChannelToPiEvents {
	/** 正文游标：DSH 推累积全文，UIMessageStream 要增量，差量由这里算。 */
	private textCursor = "";
	/** 思考游标：同上。 */
	private thinkingCursor = "";
	/** 当前是否已有开着的思考块（决定收口是否发 thinking_end）。 */
	private thinkingOpen = false;
	/** 本轮是否已发过 message_start（决定首次正文/工具帧前是否需要补开一条 UI 消息）。 */
	private runOpen = false;
	private runSeq = 0;
	/** 已发过 tool-input 帧 / 已结算的工具卡（跨工具循环去重，防止同一条卡片被打回 running）。 */
	private readonly startedTools = new Set<string>();
	private readonly settledTools = new Set<string>();
	/** 首帧 messages 携带的是整会话历史（含连接前的老工具卡），过期过滤只在这一帧生效。 */
	private baselinePending = true;
	/**
	 * 已收口那一轮的累积正文。停止的握手是「abort 先收口，host 迟到的 turn/end 再收一次」：
	 * 两次携带同一份全文，若不拦，keepAlive 连接上会多出一个重复/空气泡——
	 * 收口后同一文本的事件一律丢弃（turn/start 的 reset 帧会清掉该基准）。
	 * 连接关闭后重连会换新实例，基准由路由层 seed 进来（见 WebEventStreamRouter.closedRunTextBySession）。
	 */
	private closedRunText: string | null = null;

	constructor(seedClosedRun: string | null = null) {
		this.closedRunText = seedClosedRun;
	}

	/** 当前收口基准（路由层持久化用：给后续新建的连接做 seed）。 */
	baseline(): string | null {
		return this.closedRunText;
	}

	/** 翻译一个 DSH 通道事件为 0..n 个 pi 事件。 */
	push(channel: string, payload: unknown): PiEvent[] {
		if (!isRecord(payload)) return [];
		if (channel === ipcChannels.agentsTextStream) return this.pushText(payload);
		if (channel === ipcChannels.agentsThinking) return this.pushThinking(payload);
		if (channel === ipcChannels.agentsMessage) return this.pushMessages(payload);
		return [];
	}

	private openRun(): PiEvent[] {
		if (this.runOpen) return [];
		this.runOpen = true;
		this.runSeq += 1;
		return [{ type: "message_start", message: { role: "assistant", id: `dsh-run-${this.runSeq}` } }];
	}

	private closeThinking(events: PiEvent[]): void {
		if (!this.thinkingOpen) return;
		events.push(CLOSE_THINKING);
		this.thinkingOpen = false;
	}

	private pushText(payload: Record<string, unknown>): PiEvent[] {
		const done = payload.done === true;
		const events: PiEvent[] = [];

		if (payload.reset === true) {
			// turn/start：新回合起点。收口上一轮遗留的块并清游标，但不算 finish——
			// 真正的收口只认 turnEnded 标记，否则工具循环的中间态会被误判成整轮结束。
			events.push(CLOSE_BLOCKS);
			this.textCursor = "";
			this.thinkingCursor = "";
			this.thinkingOpen = false;
			this.runOpen = false;
			this.closedRunText = null;
		}

		// 增量协议（delta）与快照（text）统一成累积全文，再与游标比对取增量。
		const next = typeof payload.delta === "string" ? this.textCursor + payload.delta : typeof payload.text === "string" ? payload.text : this.textCursor;
		if (this.closedRunText !== null && next === this.closedRunText) return [];
		this.closedRunText = null;
		if (!next.startsWith(this.textCursor)) {
			// 累积文本与游标不连贯（换轮/重放/中途接入）：先收口旧块，整段当新块重发，避免拼串。
			events.push(CLOSE_BLOCKS);
			this.textCursor = "";
			this.thinkingOpen = false;
		}
		const delta = next.slice(this.textCursor.length);
		if (delta) {
			events.push(...this.openRun(), { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
			this.textCursor = next;
		}
		if (done) {
			// 单条 assistant 消息说完：关块即可，工具循环随后还会再开（同一轮不结束流）。
			if (this.textCursor || this.thinkingOpen) events.push(CLOSE_BLOCKS);
			// 收口基准：停止（abort）先收一次，host 迟到的 turn/end 随后再带同一份全文
			// 收一次；两次之间不能把同一文本当成新一轮重发。
			if (payload.turnEnded === true) this.closedRunText = next;
			this.textCursor = "";
			this.thinkingCursor = "";
			this.thinkingOpen = false;
		}
		events.push(...this.pushTurnEnd(payload));
		return events;
	}

	private pushThinking(payload: Record<string, unknown>): PiEvent[] {
		const done = payload.done === true;
		const events: PiEvent[] = [];

		const next = typeof payload.delta === "string" ? this.thinkingCursor + payload.delta : typeof payload.text === "string" ? payload.text : this.thinkingCursor;
		if (!next.startsWith(this.thinkingCursor)) {
			// 收口帧常带 text:""（abort 把思考正文抹空）：游标非空但载荷为空，不能当成
			// 「换了新思考」重发，先关掉当前思考块再清游标。
			this.closeThinking(events);
			this.thinkingCursor = "";
		}
		const delta = next.slice(this.thinkingCursor.length);
		if (delta) {
			events.push(...this.openRun(), { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } });
			this.thinkingCursor = next;
			this.thinkingOpen = true;
		}
		if (done) {
			this.closeThinking(events);
			this.thinkingCursor = "";
		}
		return events;
	}

	private pushMessages(payload: Record<string, unknown>): PiEvent[] {
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		const events: PiEvent[] = [];
		// 首个 messages 帧携带整会话历史（含连接前的老工具卡）：Web 端历史由磁盘加载负责，
		// 重播会把满屏旧卡片追加进当前回复。只保留两类：正在跑的卡，以及（已见证本轮
		// 开始时的）最后一条用户消息之后的新卡——中途刷新页面时本轮已完成的工具卡不丢。
		const baseline = this.baselinePending;
		this.baselinePending = false;
		const lastUserIndex = baseline ? lastUserMessageIndex(messages) : -1;
		for (const [index, raw] of messages.entries()) {
			if (!isRecord(raw) || raw.role !== "tool") continue;
			const meta = isRecord(raw.meta) ? raw.meta : undefined;
			const toolCallId = asString(meta?.toolCallId);
			if (!toolCallId) continue;
			const toolName = asString(meta?.toolName) ?? "tool";
			const status = asString(meta?.status) ?? "running";
			const text = asString(raw.text);
			if (!this.startedTools.has(toolCallId)) {
				const liveBaseline = this.runOpen && index > lastUserIndex;
				if (baseline && status !== "running" && !liveBaseline) {
					this.settledTools.add(toolCallId);
					continue;
				}
				this.startedTools.add(toolCallId);
				events.push(...this.openRun(), { type: "tool_execution_start", toolCallId, toolName, args: meta?.args ?? {} });
			}
			if (status !== "running" && !this.settledTools.has(toolCallId)) {
				this.settledTools.add(toolCallId);
				const isError = status === "error";
				const resultText = toolResultText(text, toolName, meta);
				events.push({
					type: "tool_execution_end",
					toolCallId,
					toolName,
					isError,
					...(isError ? { error: resultText || "Tool failed" } : {}),
					result: {
						toolName,
						text: resultText,
						status,
						...(asString(meta?.detailText) ? { detailText: meta?.detailText } : {}),
						...(typeof meta?.durationMs === "number" ? { durationMs: meta.durationMs } : {}),
						...(meta?.truncated === true ? { truncated: true } : {}),
					},
				});
			}
		}
		return events;
	}

	private pushTurnEnd(payload: Record<string, unknown>): PiEvent[] {
		if (payload.turnEnded !== true) return [];
		// 整轮结束（正常收口/被停止）：发 pi 的 agent_settled，翻译器产出 finish + [DONE]，
		// Web 端据此把 useChat 状态收回 ready。游标复位等待下一轮（收口基准由 pushText 记）。
		const events = [...this.openRun(), { type: "agent_settled" }];
		this.textCursor = "";
		this.thinkingCursor = "";
		this.thinkingOpen = false;
		this.runOpen = false;
		return events;
	}
}
