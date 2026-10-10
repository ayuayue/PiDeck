import { ipcChannels } from "../../shared/ipc";
import { calculateTokensPerSecond } from "../../shared/tps";

/** 最近一次 assistant 回复的性能指标（结算后保留，供 getRuntimeState 合并展示）。 */
export interface MessagePerfSnapshot {
	ttftMs?: number;
	totalMs: number;
	endToEndTps?: number;
	/** 首个有效 thinking/text delta 到回复结束期间的速度。 */
	tps?: number;
	at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * 单次模型回复的性能计时。首轮以 sendPrompt 请求为起点，工具续答在
 * turn_start 起表（模型调用前、工具执行后）；旧 Pi 缺该事件时回退到 message_start。
 * 首个非空 thinking/text delta 记 firstDeltaAt，正文首 delta 记 firstTextAt，
 * message_end/done/error 同时结算流式与端到端 TPS，切换设置不影响采样。
 * pi 不暴露耗时字段，只能由本地事件时间戳推算。
 */
export class MessagePerfTracker {
	/** 进行中的计时器（per agent）。 */
	private readonly perfByAgent = new Map<string, { startedAt: number; firstDeltaAt: number; firstTextAt: number }>();
	/** sendPrompt 发出的请求时刻（毫秒），供首个 message_start 起表时优先使用（含排队时间）。 */
	private readonly promptRequestedAtByAgent = new Map<string, number>();
	/** 最近一次 assistant 回复的性能指标。 */
	private readonly lastPerfByAgent = new Map<string, MessagePerfSnapshot>();

	/**
	 * sendPrompt 请求发出时刻：把 pi 内部排队与模型服务端等待计入用户体感的
	 * 首 token 延迟，避免统计系统性偏短。ensureTimer 起表时消费并删除。
	 */
	notePromptRequested(agentId: string, requestedAt: number): void {
		this.promptRequestedAtByAgent.set(agentId, requestedAt);
	}

	/** 最近一次结算结果（getRuntimeState 合并展示用）。 */
	getLast(agentId: string): MessagePerfSnapshot | undefined {
		return this.lastPerfByAgent.get(agentId);
	}

	/**
	 * 记录首个内容 delta 时刻（text/thinking 均算首 token，用户最先感知到的是二者之一）。
	 * 只记一次：思考切正文时 text_delta 不会覆盖已有的 firstDeltaAt。
	 */
	markFirstDelta(agentId: string): void {
		const perf = this.perfByAgent.get(agentId);
		if (perf && perf.firstDeltaAt === 0) {
			perf.firstDeltaAt = Date.now();
		}
	}

	/**
	 * 记录正文首 delta 时刻：思考模式下 thinking_delta 先到，用户感知的「首字」是正文首字，
	 * 因此 text_delta 单独记一次（只在 text_delta 分支调用）；无思考时即首个 text_delta。
	 */
	markFirstText(agentId: string): void {
		const perf = this.perfByAgent.get(agentId);
		if (perf && perf.firstTextAt === 0) {
			perf.firstTextAt = Date.now();
		}
	}

	/**
	 * 幂等起表：turn_start、message_start 与 message_update start 都可能先到，
	 * 只在尚无计时器时创建，避免消息事件覆盖模型调用前的 startedAt。
	 * 起点优先取 sendPrompt 记录的请求发出时刻（消费后删除，防止工具后续答回合
	 * 误用上一次请求起点）；无请求起点（续答/内部触发）时回退到事件到达时刻。
	 */
	ensureTimer(agentId: string): void {
		if (!this.perfByAgent.has(agentId)) {
			const requestedAt = this.promptRequestedAtByAgent.get(agentId);
			if (requestedAt !== undefined) this.promptRequestedAtByAgent.delete(agentId);
			this.perfByAgent.set(agentId, {
				startedAt: requestedAt ?? Date.now(),
				firstDeltaAt: 0,
				firstTextAt: 0,
			});
		}
	}

	/**
	 * message_end/done/error：结算本次回复的性能指标并边沿推送渲染层（不触发 RPC，
	 * 避免流式热路径上叠加 get_state/get_session_stats 开销）。
	 * - ttftMs = 首字（正文首 delta，思考模式下用户感知的首字；无正文退回首 delta）− 请求发出时刻；
	 * - totalMs = 终态 − 请求发出时刻（本轮回复总耗时）；
	 * - tps = output tokens ÷ 首 delta → 终态；endToEndTps = 同一 output tokens ÷ totalMs。
	 * 无 text/thinking delta 时不估算流式速度；只要用量和总耗时有效，端到端速度仍可计算。
	 */
	settle(agentId: string, emit: (channel: string, payload: unknown) => void, message?: unknown): void {
		const perf = this.perfByAgent.get(agentId);
		this.perfByAgent.delete(agentId);
		if (!perf) return;
		const now = Date.now();
		const totalMs = now - perf.startedAt;
		// 首字延迟：正文首 delta 优先；纯思考/中途 abort 无正文时退回首 delta，保证有值可展示
		const firstContentAt = perf.firstTextAt > 0 ? perf.firstTextAt : perf.firstDeltaAt > 0 ? perf.firstDeltaAt : 0;
		const ttftMs = firstContentAt > 0 ? firstContentAt - perf.startedAt : undefined;
		// message_end 携带完整 assistant 消息，usage 兼容多种命名提取 output tokens
		const usage = isRecord(message) && isRecord(message.usage) ? message.usage : undefined;
		const outputTokens = [usage?.output, usage?.outputTokens, usage?.completion, usage?.completionTokens].find((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
		const streamingMs = perf.firstDeltaAt > 0 ? now - perf.firstDeltaAt : undefined;
		const tps = calculateTokensPerSecond(outputTokens, streamingMs);
		const endToEndTps = calculateTokensPerSecond(outputTokens, totalMs);
		this.lastPerfByAgent.set(agentId, { ttftMs, totalMs, endToEndTps, tps, at: now });
		emit(ipcChannels.agentsRuntimeState, {
			agentId,
			state: { ttftMs, totalMs, endToEndTps, tps, perfAt: now },
		});
	}

	/**
	 * 中止、拒绝、无模型调用的命令或 agent_end 时作废未结算的起点，保留最近已结算的回复。
	 * 自动重试（agent_end.willRetry）也在这里清掉：Pi 退避后经 agent.continue() 重新
	 * turn_start，新尝试从那一刻起表，端到端只计最后一次请求。
	 */
	discardInFlight(agentId: string): void {
		this.perfByAgent.delete(agentId);
		this.promptRequestedAtByAgent.delete(agentId);
	}

	/** agent 生命周期结束：进行中计时与最近指标一并清理（数值游标漏删 = 慢泄漏）。 */
	clearAgent(agentId: string): void {
		this.discardInFlight(agentId);
		this.lastPerfByAgent.delete(agentId);
	}
}
