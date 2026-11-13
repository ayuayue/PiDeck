import { isContextOverflowError } from "../../../shared/contextOverflow";
import { agentEventTags } from "../../../shared/ipc";
import { reasoningText } from "../../../shared/reasoningText";
import type { ChatMessage, ImageContent } from "../../../shared/types";
import { projectDshEvent } from "../dshEventProjector";
import { collectDshProcessEvent, pushDshProcessEvent } from "../dshProcessEvents";
import { applyDshControlEvent, type DshControlState } from "../dshRuntimeControl";
import type { DshAgentRuntime } from "./dshAgentRuntime";
import { applyDshProjectionBaseline, applyDshProjectionFrame, type DshProjectionFrameHost } from "./dshProjectionFrames";

/**
 * 帧分发的宿主出口：会话 map、审批/提问 pending、输出通道等共享状态留在
 * DshAgentManager，这里只经窄接口驱动既有路径。
 */
export type DshMuxFrameHost = DshProjectionFrameHost & {
	findRuntimeBySessionId(sessionId: unknown): DshAgentRuntime | undefined;
	handleServerRequest(runtime: DshAgentRuntime, frame: { rpcId?: unknown; payload?: unknown }, payload: Record<string, unknown>): void;
	applyControl(runtime: DshAgentRuntime, next: DshControlState): void;
	/** agents:* 输出通道（载荷与宿主 emit 同一形态）。 */
	emit(channel: string, payload: unknown): void;
	/** 侧栏状态重发：emit(agentsState, list())。 */
	emitState(): void;
	emitMessages(runtime: DshAgentRuntime): void;
	notifyAgentSettled(agentId: string, title: string): void;
	/** host 会话标题变化（写回 catalog / 侧栏刷新）。 */
	notifyTitleChanged(dshSessionId: string, title: string): void;
	hydrateRuntimeDshImages(runtime: DshAgentRuntime): Promise<void>;
};

/** 共享 mux 帧按 sessionId 分发给对应 runtime。 */
export function dispatchDshMuxFrame(host: DshMuxFrameHost, frame: { rpcId?: unknown; payload?: unknown }): void {
	const payload = (frame?.payload ?? frame) as Record<string, unknown> | undefined;
	if (!payload || typeof payload !== "object") return;
	const runtime = host.findRuntimeBySessionId(payload.sessionId);
	if (!runtime) return;
	if (payload.type === "approval/requested" || payload.type === "question/requested") {
		host.handleServerRequest(runtime, frame, payload);
		return;
	}
	if (payload.type === "session/projection-baseline") {
		// session/control 的 baseline 是全会话投影快照，按 sessionId 拆帧后到这里。
		applyDshProjectionBaseline(host, runtime, payload.block);
		return;
	}
	if (payload.type === "session/projection") {
		applyDshProjectionFrame(host, runtime, payload);
		return;
	}
	if (payload.type !== "session/event") return;
	// journal 回放（follow 的 snapshot.records）不是实时事件：投影照旧（历史要显示），
	// 但不得触发「回合完成」——否则打开历史会话会把每条历史 turn/end 都提醒一遍。
	const replayed = payload.replay === true;
	const event = payload.event as { type?: string; seq?: number; time?: number; data?: unknown } | undefined;
	// 轨迹过程事件：模型切换/权限/plan/goal/压缩命令等非对话记录
	// （pi 会话文件过程事件的 DSH 等价物；与消息投影并行收集）。
	runtime.processEvents = pushDshProcessEvent(runtime.processEvents, collectDshProcessEvent(runtime.processEvents, event));
	// DSH host 会话标题（dsh-session-title 的 session/title 事件）：
	// 更新 runtime tab + 写回 catalog（侧栏运行中行实时、历史行/重启后持久），
	// 不投影消息、不影响流式状态机。
	if (event?.type === "session/title" && event.data !== null && typeof event.data === "object" && typeof (event.data as { title?: unknown }).title === "string" && (event.data as { title: string }).title.trim()) {
		const title = (event.data as { title: string }).title.trim();
		if (runtime.tab.title !== title) {
			runtime.tab.title = title;
			host.emitState();
			host.notifyTitleChanged(String(runtime.sessionId), title);
		}
		return;
	}
	const eventView = (payload as { view?: unknown }).view;
	const eventGeneration = runtime.control.cancelGeneration;
	const controlled = applyDshControlEvent(runtime.control, event?.type, eventGeneration, event?.data);
	host.applyControl(runtime, controlled.next);
	if (controlled.ignoreStream) {
		// 停止后的迟到流：只投影 turn/end（把已流式的部分文本落回骨架，
		// 并收口 cancelled）。assistant/message、chunk、tool 等旧回合残留
		// 一律不投影——否则停止后完整回答/工具卡片继续上屏（「还在跑」），
		// 或被拼进下一条消息（「串台」）。
		if (event?.type === "turn/end") {
			// D8：停止后的迟到 turn/end 不追加 error 气泡（停止 ≠ 回合失败）
			runtime.projection = projectDshEvent(runtime.projection, event, runtime.tab.id, undefined, { skipErrorTurnEnd: true });
			runtime.messages = mergeDshProjectedMessages(runtime.messages, runtime.projection.messages);
			// 收口时带上已累积正文，避免空 done 把渲染层 live 槽抹成空白。
			// turnEnded：停止后迟到的 turn/end 同样是「本轮终点」，Web SSE 在此收流。
			host.emit(agentEventTags.agentsTextStream, {
				agentId: runtime.tab.id,
				text: lastAssistantText(runtime.messages),
				done: true,
				turnEnded: true,
			});
			host.emitMessages(runtime);
			if (runtime.isCompacting) {
				runtime.isCompacting = false;
				host.emitRuntimeState(runtime.tab.id);
			}
		}
		return;
	}
	runtime.projection = projectDshEvent(runtime.projection, event, runtime.tab.id, eventView);
	runtime.messages = mergeDshProjectedMessages(runtime.messages, runtime.projection.messages);
	// todo/write / turn/start 折叠进 projection.todos：实时同步到 runtime，
	// 随 p.stateChanged 的 emitRuntimeState 一起推给渲染层 todo 条。
	runtime.todos = runtime.projection.todos;
	if (typeof event?.seq === "number" && event.seq > (runtime.lastProjectedSeq ?? 0)) {
		runtime.lastProjectedSeq = event.seq;
	}
	const p = runtime.projection;
	const eventSeq = typeof event?.seq === "number" ? event.seq : 0;
	const eventTime = typeof event?.time === "number" ? event.time : Date.now();
	if (event?.type === "turn/start") {
		// 与 pi agent_start 对齐：新回合丢掉上一轮 held live 槽。
		host.emit(agentEventTags.agentsTextStream, {
			agentId: runtime.tab.id,
			text: "",
			done: true,
			reset: true,
		});
	}
	if (p.deltaText !== undefined) {
		host.emit(agentEventTags.agentsTextStream, {
			agentId: runtime.tab.id,
			text: p.pendingAssistantText,
			done: false,
		});
	}
	if (p.deltaReasoning !== undefined) {
		runtime.thinkingId ??= `msg-thinking-${p.pendingAssistantId ?? `dsh:${eventSeq}`}`;
		runtime.thinkingStartedAt ??= eventTime;
		host.emit(agentEventTags.agentsThinking, {
			agentId: runtime.tab.id,
			id: runtime.thinkingId,
			// 累积文本保留签名，下发前跑展示净化（未闭合的签名块下发空串，行自然隐藏）。
			text: reasoningText(p.pendingAssistantThinking),
			startedAt: runtime.thinkingStartedAt,
			done: false,
		});
	}
	if (runtime.thinkingId && p.deltaReasoning === undefined && p.pendingAssistantThinking === "") {
		host.emit(agentEventTags.agentsThinking, {
			agentId: runtime.tab.id,
			id: runtime.thinkingId,
			text: "",
			startedAt: runtime.thinkingStartedAt ?? 0,
			endedAt: eventTime,
			done: true,
		});
		runtime.thinkingId = undefined;
		runtime.thinkingStartedAt = undefined;
	}
	if (p.stateChanged) {
		runtime.executingTool = p.executingTool;
		if (p.model) runtime.model = p.model;
		if (p.contextWindow !== undefined) runtime.contextWindow = p.contextWindow;
		if (p.usage) runtime.usage = p.usage;
		if ((event as { type?: string } | undefined)?.type === "goal/change") runtime.goal = p.goal;
		if (p.permissionPreset !== undefined) runtime.permissionPreset = p.permissionPreset;
		runtime.planModeActive = p.planModeActive;
		host.emitRuntimeState(runtime.tab.id);
	}
	if (p.turnEnded) {
		const wasCompacting = runtime.isCompacting === true;
		const turnEndReason = event?.data && typeof event.data === "object" && (event.data as { reason?: unknown }).reason;
		const reasonMessage = turnEndReason && typeof turnEndReason === "object" && "error" in turnEndReason && typeof (turnEndReason as { error?: { message?: unknown } }).error?.message === "string" ? (turnEndReason as { error: { message: string } }).error.message : "";
		const reasonKind = turnEndReason && typeof turnEndReason === "object" && "kind" in turnEndReason ? String((turnEndReason as { kind?: unknown }).kind) : "";
		// control.cancelled 在 turn/end 已被复位，用户停止只能靠 abort() 置的独立标记判断。
		const userStopped = runtime.userStoppedTurn === true;
		runtime.userStoppedTurn = false;
		if (reasonMessage) {
			runtime.contextOverflow = isContextOverflowError(reasonMessage);
		} else if (wasCompacting) {
			// /compact 回合正常收口后，清掉之前的超限恢复态；普通回答收口不改写该标记。
			runtime.contextOverflow = false;
		}
		// turnEnded：正常回合终点（含被停止的 cancelled 收口），Web SSE 在此收流。
		host.emit(agentEventTags.agentsTextStream, {
			agentId: runtime.tab.id,
			text: lastAssistantText(runtime.messages),
			done: true,
			turnEnded: true,
		});
		host.emitMessages(runtime);
		// 回合结束必须推 runtime：sessionStats 投影帧可能稍后才到，
		// 消息兜底的轮数/步数要在 turn/end 当帧更新输入框底下的 StatsLine。
		if (runtime.isCompacting) runtime.isCompacting = false;
		host.emitRuntimeState(runtime.tab.id);
		// 成功收口：通知装配层（会话完成通知 / 桌宠 done 气泡）。
		// 用户停止、失败回合与 /compact 命令回合都不算「回答完成」（与 pi 的 settled 同口径）；
		// 回放的历史回合同理不算——它们早就提醒过了。
		if (!replayed && !userStopped && !wasCompacting && reasonKind !== "error") host.notifyAgentSettled(runtime.tab.id, runtime.tab.title);
	}
	if (p.messagesChanged && !p.turnEnded) {
		host.emitMessages(runtime);
		if (event?.type === "assistant/message") {
			host.emit(agentEventTags.agentsTextStream, {
				agentId: runtime.tab.id,
				text: lastAssistantText(runtime.messages),
				done: true,
			});
		}
	}
	// 实时 mux 中 canonical 图片只有 attachment ref，先推文本、再异步拉字节补图。
	if (p.messagesChanged) {
		void host.hydrateRuntimeDshImages(runtime);
	}
}

/** Merge image bytes already available in a newer runtime snapshot into projection messages. */
export function mergeDshProjectedMessages(previous: ChatMessage[], projected: ChatMessage[]): ChatMessage[] {
	const previousImagesById = new Map<string, ImageContent[]>();
	for (const message of previous) {
		if (message.images && message.images.length > 0) previousImagesById.set(message.id, message.images);
	}
	if (previousImagesById.size === 0) return projected;
	let changed = false;
	const merged = projected.map((message) => {
		const previousImages = previousImagesById.get(message.id);
		if (!previousImages) return message;
		const images = mergeDshImageArrays(message.images, previousImages);
		if (images === message.images) return message;
		changed = true;
		return { ...message, images };
	});
	return changed ? merged : projected;
}

/** Merge attachment hydration into the newest runtime list without dropping newer messages. */
export function mergeDshHydratedMessages(current: ChatMessage[], hydrated: ChatMessage[]): ChatMessage[] {
	const hydratedById = new Map(hydrated.map((message) => [message.id, message]));
	let changed = false;
	const merged = current.map((message) => {
		const hydratedMessage = hydratedById.get(message.id);
		if (!hydratedMessage?.images) return message;
		const images = mergeDshImageArrays(message.images, hydratedMessage.images);
		if (images === message.images) return message;
		changed = true;
		return { ...message, images };
	});
	return changed ? merged : current;
}

function mergeDshImageArrays(existing: ImageContent[] | undefined, additions: ImageContent[]): ImageContent[] | undefined {
	if (additions.length === 0) return existing;
	const merged = [...(existing ?? [])];
	let changed = false;
	for (const image of additions) {
		let duplicate = false;
		for (const known of merged) {
			if (known.mimeType !== image.mimeType) continue;
			if (known.data !== image.data) continue;
			duplicate = true;
			break;
		}
		if (!duplicate) {
			merged.push(image);
			changed = true;
		}
	}
	return changed ? merged : existing;
}

/** 本轮最后一条助手正文；收口 text-stream 时带上，避免空 done 抹掉 live 槽。 */
export function lastAssistantText(messages: ChatMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "user") return "";
		if (message.role === "assistant" && message.text.trim()) return message.text;
	}
	return "";
}
