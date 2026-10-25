import { ipcChannels } from "../../shared/ipc";
import { calculateTokensPerSecond, calculateSessionTokensPerSecond, type TaskPerfSpan } from "../../shared/tps";

/** 最近一次 assistant 回复及会话级性能指标（结算后保留，供 getRuntimeState 合并展示）。 */
export interface MessagePerfSnapshot {
	ttftMs?: number;
	totalMs: number;
	endToEndTps?: number;
	/** 首个有效 thinking/text delta 到回复结束期间的速度。 */
	tps?: number;
	/** 会话累计平均流式速度（tokens/s；解码活跃耗时并集）。 */
	sessionTps?: number;
	/** 会话累计平均端到端速度（tokens/s；整体活跃耗时并集）。 */
	sessionEndToEndTps?: number;
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
	/** 进行中的计时器（per agent）。agentStartAt/turnStartAt/messageStartAt 是阶段边界（首遇即记，0=未到）。 */
	private readonly perfByAgent = new Map<string, { startedAt: number; firstDeltaAt: number; firstTextAt: number; agentStartAt: number; turnStartAt: number; messageStartAt: number }>();
	/** sendPrompt 发出的请求时刻（毫秒），供首个 message_start 起表时优先使用（含排队时间）。 */
	private readonly promptRequestedAtByAgent = new Map<string, number>();
	/** 计时器创建前到达的 agent_start 时刻（per agent）：agent_start 先于 turn_start/message_start，
	 * 起表时并入计时器；结算/作废/清理时必须一并清掉，否则串进下一轮的归因。 */
	private readonly pendingAgentStartAtByAgent = new Map<string, number>();
	/** 最近一次 assistant 回复的性能指标。 */
	private readonly lastPerfByAgent = new Map<string, MessagePerfSnapshot>();
	/** 会话内已结算的模型回复与派生任务性能区间（per agent）。 */
	private readonly spansByAgent = new Map<string, TaskPerfSpan[]>();

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
	 * agent_start 到达时刻：此时计时器多半还没建（turn_start/message_start 才起表），
	 * 先挂 pending，ensureTimer 创建时并入——「请求发出 → agent_start」的间隔是 pi 内部
	 * 排队/扩展钩子的耗时，归因日志（见 settle）需要这个边界。
	 */
	noteAgentStart(agentId: string, at = Date.now()): void {
		const perf = this.perfByAgent.get(agentId);
		if (perf) {
			if (perf.agentStartAt === 0) perf.agentStartAt = at;
			return;
		}
		if (!this.pendingAgentStartAtByAgent.has(agentId)) this.pendingAgentStartAtByAgent.set(agentId, at);
	}

	/** turn_start 到达时刻（调用方须在 ensureTimer 之后调用，直接写进已存在的计时器）。 */
	noteTurnStart(agentId: string, at = Date.now()): void {
		const perf = this.perfByAgent.get(agentId);
		if (perf && perf.turnStartAt === 0) perf.turnStartAt = at;
	}

	/** message_start（assistant）到达时刻：与 noteTurnStart 同款，写已存在的计时器。 */
	noteMessageStart(agentId: string, at = Date.now()): void {
		const perf = this.perfByAgent.get(agentId);
		if (perf && perf.messageStartAt === 0) perf.messageStartAt = at;
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
			const agentStartAt = this.pendingAgentStartAtByAgent.get(agentId) ?? 0;
			if (agentStartAt > 0) this.pendingAgentStartAtByAgent.delete(agentId);
			this.perfByAgent.set(agentId, {
				startedAt: requestedAt ?? Date.now(),
				firstDeltaAt: 0,
				firstTextAt: 0,
				agentStartAt,
				turnStartAt: 0,
				messageStartAt: 0,
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
	settle(agentId: string, emit: (channel: string, payload: unknown) => void, message?: unknown, log?: (message: string, detail: Record<string, unknown>) => void): void {
		const perf = this.perfByAgent.get(agentId);
		this.perfByAgent.delete(agentId);
		// 没建过计时器的 agent_start 残留（如 prompt 被扩展命令消费、未触发模型调用）一并清掉。
		this.pendingAgentStartAtByAgent.delete(agentId);
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

		if (outputTokens !== undefined && outputTokens >= 0 && totalMs > 0) {
			const span: TaskPerfSpan = {
				startedAt: perf.startedAt,
				firstDeltaAt: perf.firstDeltaAt > 0 ? perf.firstDeltaAt : undefined,
				completedAt: now,
				outputTokens,
			};
			let spans = this.spansByAgent.get(agentId);
			if (!spans) {
				spans = [];
				this.spansByAgent.set(agentId, spans);
			}
			spans.push(span);
		}

		const sessionPerf = calculateSessionTokensPerSecond(this.spansByAgent.get(agentId) ?? []);
		const sessionTps = sessionPerf.sessionTps;
		const sessionEndToEndTps = sessionPerf.sessionEndToEndTps;

		// 归因日志：把「发送 → 首字」拆成 agent_start/turn_start/message_start/firstDelta 边界（均相对起点，
		// 起点=请求发出时刻或续答 turn_start）。用户报「10 秒才思考」时一眼看出耗在 pi 内部还是供应商首包。
		log?.("Model reply phase breakdown", {
			agentId,
			...(perf.agentStartAt > 0 ? { agentStartMs: perf.agentStartAt - perf.startedAt } : {}),
			...(perf.turnStartAt > 0 ? { turnStartMs: perf.turnStartAt - perf.startedAt } : {}),
			...(perf.messageStartAt > 0 ? { messageStartMs: perf.messageStartAt - perf.startedAt } : {}),
			...(perf.firstDeltaAt > 0 ? { firstDeltaMs: perf.firstDeltaAt - perf.startedAt } : {}),
			...(firstContentAt > 0 ? { ttftMs } : {}),
			totalMs,
		});
		this.lastPerfByAgent.set(agentId, { ttftMs, totalMs, endToEndTps, tps, sessionTps, sessionEndToEndTps, at: now });
		emit(ipcChannels.agentsRuntimeState, {
			agentId,
			state: { ttftMs, totalMs, endToEndTps, tps, sessionTps, sessionEndToEndTps, perfAt: now },
		});
	}

	/**
	 * 写入/覆盖一条性能区间，只改区间表，不重算也不推送：
	 * 单条记录与批量同步共用，保证批量同步在整批写入后只重算一次会话级指标。
	 * 返回是否写入（非法区间直接忽略，批次据此判断要不要重算）。
	 */
	private upsertSpan(agentId: string, task: { id?: string; startedAt: number; completedAt: number; tokens: number; firstDeltaAt?: number }): boolean {
		if (!task || !Number.isFinite(task.startedAt) || !Number.isFinite(task.completedAt) || !Number.isFinite(task.tokens)) return false;
		if (task.tokens < 0 || task.completedAt <= task.startedAt) return false;
		let spans = this.spansByAgent.get(agentId);
		if (!spans) {
			spans = [];
			this.spansByAgent.set(agentId, spans);
		}
		const span: TaskPerfSpan = {
			...(task.id ? { id: task.id } : {}),
			startedAt: task.startedAt,
			firstDeltaAt: task.firstDeltaAt && task.firstDeltaAt > 0 ? task.firstDeltaAt : undefined,
			completedAt: task.completedAt,
			outputTokens: task.tokens,
		};
		// 有 id 的记录原地覆盖：列举子代理会反复回放同一批记录，追加会让 token 与耗时重复膨胀。
		const existingIndex = task.id ? spans.findIndex((s) => s.id === task.id) : -1;
		if (existingIndex >= 0) spans[existingIndex] = span;
		else spans.push(span);
		return true;
	}

	/**
	 * 用当前区间重算会话级指标并刷新最近快照。
	 * at 取本次刷新时刻，与随后推送的 perfAt 同源：否则 get_state 会带更旧的结算时刻，
	 * 与已推送的「刚刚更新」自相矛盾。
	 */
	private refreshSessionPerf(agentId: string): MessagePerfSnapshot {
		const sessionPerf = calculateSessionTokensPerSecond(this.spansByAgent.get(agentId) ?? []);
		const last = this.lastPerfByAgent.get(agentId);
		const updated: MessagePerfSnapshot = {
			ttftMs: last?.ttftMs,
			totalMs: last?.totalMs ?? 0,
			endToEndTps: last?.endToEndTps,
			tps: last?.tps,
			sessionTps: sessionPerf.sessionTps,
			sessionEndToEndTps: sessionPerf.sessionEndToEndTps,
			at: Date.now(),
		};
		this.lastPerfByAgent.set(agentId, updated);
		return updated;
	}

	/** 会话级三字段补丁；perfAt 直接取快照 at，两者永远一致。 */
	private sessionStatePatch(snapshot: MessagePerfSnapshot) {
		return { sessionTps: snapshot.sessionTps, sessionEndToEndTps: snapshot.sessionEndToEndTps, perfAt: snapshot.at };
	}

	/**
	 * 记录派生任务（如 subagent 派生执行）的用量与耗时区间，消除重叠并纳入会话级平均 TPS 计算。
	 */
	recordSubagentTask(agentId: string, task: { id?: string; startedAt: number; completedAt: number; tokens: number; firstDeltaAt?: number }, emit?: (channel: string, payload: unknown) => void): void {
		if (!this.upsertSpan(agentId, task)) return;
		const updated = this.refreshSessionPerf(agentId);
		emit?.(ipcChannels.agentsRuntimeState, { agentId, state: this.sessionStatePatch(updated) });
	}

	/**
	 * 批量同步子代理记录（例如从会话持久化条目或列表恢复）。
	 * 整批只重算一次并只推送一次；不传 emit 时静默刷新快照（只读列举路径用，避免读接口推状态事件）。
	 */
	syncSubagentTasks(agentId: string, tasks: ReadonlyArray<{ id?: string; startedAt: number; completedAt?: number; tokens?: number }>, emit?: (channel: string, payload: unknown) => void): void {
		let modified = false;
		for (const t of tasks) {
			if (typeof t.completedAt !== "number" || typeof t.tokens !== "number") continue;
			modified = this.upsertSpan(agentId, { id: t.id, startedAt: t.startedAt, completedAt: t.completedAt, tokens: t.tokens }) || modified;
		}
		if (!modified) return;
		const updated = this.refreshSessionPerf(agentId);
		emit?.(ipcChannels.agentsRuntimeState, { agentId, state: this.sessionStatePatch(updated) });
	}

	/** 获取某 agent 会话已记录的所有性能区间 */
	getSessionSpans(agentId: string): ReadonlyArray<TaskPerfSpan> {
		return this.spansByAgent.get(agentId) ?? [];
	}

	/**
	 * 中止、拒绝、无模型调用的命令或 agent_end 时作废未结算的起点，保留最近已结算的回复。
	 * 自动重试（agent_end.willRetry）也在这里清掉：Pi 退避后经 agent.continue() 重新
	 * turn_start，新尝试从那一刻起表，端到端只计最后一次请求。
	 */
	discardInFlight(agentId: string): void {
		this.perfByAgent.delete(agentId);
		this.promptRequestedAtByAgent.delete(agentId);
		this.pendingAgentStartAtByAgent.delete(agentId);
	}

	/** agent 生命周期结束：进行中计时与最近指标一并清理（数值游标漏删 = 慢泄漏）。 */
	clearAgent(agentId: string): void {
		this.discardInFlight(agentId);
		this.lastPerfByAgent.delete(agentId);
		this.spansByAgent.delete(agentId);
	}
}
