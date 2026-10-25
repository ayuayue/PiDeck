import { createStreamGateState, isStreamGateSealed, noteAbortSettled, openStreamGateForNewRun, sealStreamGate, type StreamGateState } from "./streamGate";

/**
 * get_state 的三态结果。
 *
 * 为什么不能把「查询 reject/超时」当成「已停」：pi 被 bash 子进程（Windows 下 MS Store
 * shim/python3 等会持有 stdout 管道）堵住时主线程不读 stdin，get_state 根本不会回包
 * ——这正是「点了停止却停不下来」的现场。把它判成 idle 会让升级链在最该生效时收手。
 */
type StreamingProbe = "streaming" | "idle" | "unknown";

/** 未经类型信任的 RPC 返回值：无回包 = unknown（僵死），其余按 isStreamingResponse 判。 */
function probeStreaming(response: unknown): StreamingProbe {
	if (response === undefined) return "unknown";
	return isStreamingResponse(response) ? "streaming" : "idle";
}

/** abort 升级需要的最小 RPC 客户端形状（AgentManager 注入 runtime.process.client）。 */
export interface AbortGateRpcClient {
	request(payload: unknown, timeoutMs: number): Promise<unknown>;
}

/** 宿主注入：RPC 客户端获取、日志与用户可见 notice（AgentManager 适配）。 */
export interface AbortGateHost {
	getRpcClient(agentId: string): AbortGateRpcClient | undefined;
	logInfo(message: string, meta?: Record<string, unknown>): void;
	logWarn(message: string, meta?: Record<string, unknown>): void;
	emitAbortSlowNotice(agentId: string): void;
	/** abort 升级确认 pi 仍在流式：宿主须撤掉本地的乐观 idle（Issue #371）。 */
	noteStillStreamingAfterAbort(agentId: string): void;
}

/** 单次 abort 的身份；RPC 回包只可更新发起它的上下文，不能污染下一轮。 */
interface AbortEscalationContext {
	readonly client: AbortGateRpcClient | undefined;
	readonly hadActiveTool: boolean;
	acked: boolean;
	failed: boolean;
}

/** 未经类型信任的 RPC 返回值，只有成功且明确仍流式才允许升级/警告。 */
function isStreamingResponse(response: unknown): boolean {
	if (!response || typeof response !== "object" || !("success" in response) || response.success !== true || !("data" in response)) return false;
	const data = response.data;
	return Boolean(data && typeof data === "object" && "isStreaming" in data && data.isStreaming === true);
}

/**
 * abort 流闸与升级（从 AgentManager 迁出）。
 *
 * abort 封印当前 generation；须等 abort settled（或超时兜底）后，再由 agent_start
 * 推进 generation 放行，防止残留 thinking/text delta 串台。
 * `recentlyAborted`、thinkingEmitter/messageFlush 清理等跨域编排仍在 AgentManager。
 */
export class AbortStreamGateController {
	/** agent 的 stream gate 状态（封印/等待 settled/放行）。 */
	private readonly gates = new Map<string, StreamGateState>();
	/** abort 后等待 agent_settled 的超时定时器；避免 pi 漠发 settled 导致永久封印。 */
	private readonly settledFallbackTimers = new Map<string, NodeJS.Timeout>();
	/**
	 * 进行中的 abort 升级上下文。pi 的 abort RPC 语义是「中止并等 idle 才响应」，
	 * ack 迟到是正常路径；升级（补 abort_bash / 二次 abort）必须感知 ack 状态，
	 * 否则 WSL 慢链路下 1.5s 兜底会对正在收尾的 pi 补刀（老版本 pi 有崩溃史）。
	 */
	private readonly pendingEscalations = new Map<string, AbortEscalationContext>();
	/** 升级后的验证定时器随 settled/start/关闭回收，禁止跨回合发出迟到警告。 */
	private readonly escalationVerifyTimers = new Map<string, NodeJS.Timeout>();
	/** abort settled 兜底超时：覆盖多数管道残留，同时不让“立刻重发”永久卡死。 */
	private static readonly ABORT_SETTLED_FALLBACK_MS = 1500;
	/** abort 升级验证窗口：abort_bash + 二次 abort 后仍 running 则提示用户。 */
	private static readonly ABORT_ESCALATION_VERIFY_MS = 4000;

	constructor(private readonly host: AbortGateHost) {}

	/** 取/建 agent 的 stream gate 状态。 */
	private getGate(agentId: string): StreamGateState {
		let gate = this.gates.get(agentId);
		if (!gate) {
			gate = createStreamGateState();
			this.gates.set(agentId, gate);
		}
		return gate;
	}

	/** abort 时封印当前 generation。 */
	seal(agentId: string): void {
		const next = sealStreamGate(this.getGate(agentId));
		this.gates.set(agentId, next);
	}

	/** agent_start 时尝试推进 generation；若仍在等 abort settled，则只记 pending。 */
	openForNewRun(agentId: string): void {
		const next = openStreamGateForNewRun(this.getGate(agentId));
		this.gates.set(agentId, next);
	}

	/** abort 后的 agent_settled：结束 waiting，必要时解封 pending start。 */
	noteAbortSettled(agentId: string): void {
		this.clearSettledFallback(agentId);
		this.clearEscalation(agentId);
		const next = noteAbortSettled(this.getGate(agentId));
		this.gates.set(agentId, next);
	}

	/** 当前 generation 是否已封印，封印期间所有流式事件应丢弃。 */
	isSealed(agentId: string): boolean {
		return isStreamGateSealed(this.getGate(agentId));
	}

	/** settled 兜底定时器是否在等（agent_settled 判定用，见 AgentManager settled 分支）。 */
	hasSettledFallback(agentId: string): boolean {
		return this.settledFallbackTimers.has(agentId);
	}

	/**
	 * pi 偶发不发 agent_settled 时的兜底：超时后按 settled 处理，
	 * 避免用户立刻重发时新一轮永远无法接收流式事件。
	 * 同时触发 abort 升级检查：若 pi 仍未停稳，补发 abort_bash / 二次 abort。
	 */
	scheduleSettledFallback(agentId: string): void {
		this.clearSettledFallback(agentId);
		const timer = setTimeout(() => {
			if (this.settledFallbackTimers.get(agentId) !== timer) return;
			this.settledFallbackTimers.delete(agentId);
			// 超时仅解除流闸等待，不能把它当作 pi 已 settled；升级仍须核实原 abort。
			const gate = this.getGate(agentId);
			if (gate.waitingForAbortSettled) {
				this.gates.set(agentId, noteAbortSettled(gate));
			}
			// 工具执行中 abort 偶发不被 pi 及时处理（长 bash/扩展工具阻塞），
			// 若不升级，agent 会继续跑到工具结束，用户看到“停止不了”。
			void this.escalateIfStillRunning(agentId);
		}, AbortStreamGateController.ABORT_SETTLED_FALLBACK_MS);
		timer.unref?.();
		this.settledFallbackTimers.set(agentId, timer);
	}

	/**
	 * abort 升级：兜底窗口已过但 pi 仍在流式/执行，按 ack 状态决定是否补命令。
	 * pi 的 abort RPC 语义是「中止当前操作并等到会话空闲才响应」（上游 rpc.md），
	 * 因此 ack 迟到是正常路径，不代表卡死；对正在收尾 abort 的 pi 补二次中止，
	 * 在老版本 pi 上有 unhandled rejection 直接杀进程的崩溃史（上游 #2716），
	 * WSL 慢链路下 1.5s 兜底几乎必误触发（Issue #218 WSL 终止必挂）。
	 *
	 * 策略：
	 * - bash 工具确实在执行 → 补 abort_bash（升级的本意：解卡被 bash 阻塞的 abort）；
	 * - abort RPC 已失败/超时（pi 可能没收到）→ 补二次 abort；
	 * - get_state 自身无响应（unknown）→ 与「仍在运行」同判：僵死的 pi 恰恰不回包，
	 *   此时补 abort_bash + 二次 abort，否则永远等不到 settled；
	 * - 其余（ack pending / acked 且无工具）→ 不补刀，等 pi 自然 settle。
	 * - 仍卡死则通过 notice 明确告知用户（stop 慢是可见问题，不能只写日志）
	 */
	private async escalateIfStillRunning(agentId: string): Promise<void> {
		const escalation = this.pendingEscalations.get(agentId);
		const client = escalation?.client;
		if (!escalation || !client || !this.isCurrentEscalation(agentId, escalation)) return;
		try {
			const response = await client.request({ type: "get_state" }, 5_000).catch(() => undefined);
			// get_state/abort_bash 等 await 期间可能开始新回合或重建进程，旧查询没有补刀权限。
			if (!this.isCurrentEscalation(agentId, escalation)) return;
			// 三态：无回包（僵死）不当「已停」，否则被子进程堵住的 pi 永远收不到升级命令。
			const probe = probeStreaming(response);
			if (probe === "idle") {
				// pi 已确认空闲，升级目标达成：清掉上下文，否则它会一直把「可能仍在忙碌」
				// 钉在本地判定上（sendPrompt 据此补 streamingBehavior，见 Issue #371）。
				this.clearEscalation(agentId);
				return;
			}
			const stuck = probe === "unknown";
			if (stuck) {
				this.host.logWarn("Abort escalation: get_state did not answer, treating agent as stuck", { agentId });
			}
			const shouldSendAbortBash = escalation.hadActiveTool || stuck;
			const shouldResendAbort = escalation.failed || stuck;
			if (!shouldSendAbortBash && !shouldResendAbort) {
				// ack pending / acked 且无工具在跑：pi 正在按语义收敛到 idle，不补刀。
				this.host.logInfo("Abort escalation skipped: abort RPC ack pending/acked, waiting for idle", { agentId, acked: escalation.acked });
				return;
			}
			this.host.logWarn("Abort escalation: pi still streaming after abort", { agentId, abortBash: shouldSendAbortBash, resendAbort: shouldResendAbort, stuck });
			if (shouldSendAbortBash) {
				await client.request({ type: "abort_bash" }, 5_000).catch(() => undefined);
				if (!this.isCurrentEscalation(agentId, escalation)) return;
			}
			if (shouldResendAbort) {
				await client.request({ type: "abort" }, 5_000).catch(() => undefined);
				if (!this.isCurrentEscalation(agentId, escalation)) return;
			}
			// 第二轮必须重新查询，而不是四秒后无条件声称仍在运行。
			this.clearEscalationVerifyTimer(agentId);
			const verifyTimer = setTimeout(() => {
				if (this.escalationVerifyTimers.get(agentId) !== verifyTimer) return;
				this.escalationVerifyTimers.delete(agentId);
				void this.verifyStillRunning(agentId, escalation);
			}, AbortStreamGateController.ABORT_ESCALATION_VERIFY_MS);
			verifyTimer.unref?.();
			this.escalationVerifyTimers.set(agentId, verifyTimer);
		} catch {
			// RPC 失败（进程退出等）不再升级；agent 生命周期由 exit 路径接管。
		}
	}

	/** 验证窗口结束后，仅对仍属于同一进程/同一次 abort 的 running 状态提示。 */
	private async verifyStillRunning(agentId: string, escalation: AbortEscalationContext): Promise<void> {
		if (!escalation.client || !this.isCurrentEscalation(agentId, escalation)) return;
		let probe: StreamingProbe;
		try {
			probe = probeStreaming(await escalation.client.request({ type: "get_state" }, 5_000));
		} catch {
			// 二次中止后 get_state 仍无响应 = pi 彻底僵死：子进程持着管道、pi 读不到 stdin。
			// 这是「停止不了」最需要用户介入的时刻，静默吞掉等于永久转圈。
			probe = "unknown";
		}
		if (!this.isCurrentEscalation(agentId, escalation)) return;
		if (probe === "idle") {
			this.clearEscalation(agentId);
			return;
		}
		this.host.logWarn("Abort escalation: still running after second attempt", { agentId, probe });
		// pi 权威回复「仍在流式」：abort 超时后本地已被复位 idle，必须纠正后才发 notice，
		// 否则用户看到空闲、发消息却被 pi 以忙碌拒收（Issue #371）。
		this.host.noteStillStreamingAfterAbort(agentId);
		this.host.emitAbortSlowNotice(agentId);
	}

	/** await 前后都核对上下文及客户端身份，不把上一轮结果移交给新进程。 */
	isCurrentEscalation(agentId: string, escalation: AbortEscalationContext): boolean {
		return this.pendingEscalations.get(agentId) === escalation && this.host.getRpcClient(agentId) === escalation.client;
	}

	/** 记录并返回本次 abort 的身份，RPC 完成回调须带回这个原始上下文。 */
	beginEscalation(agentId: string, hadActiveTool: boolean): AbortEscalationContext {
		this.clearEscalation(agentId);
		const escalation = { client: this.host.getRpcClient(agentId), hadActiveTool, acked: false, failed: false };
		this.pendingEscalations.set(agentId, escalation);
		return escalation;
	}

	/** abort RPC 成功 ack（迟到是正常路径，仅更新自己的升级判据）。 */
	markAbortAcked(agentId: string, escalation: AbortEscalationContext): void {
		if (this.isCurrentEscalation(agentId, escalation)) escalation.acked = true;
	}

	/** abort RPC 失败/超时（升级时允许补二次 abort）。 */
	markAbortFailed(agentId: string, escalation: AbortEscalationContext): void {
		if (this.isCurrentEscalation(agentId, escalation)) escalation.failed = true;
	}

	/**
	 * abort 升级是否仍在进行（abort RPC 发出后、pi 未确认 idle 之前）。
	 * 供发送链路判定「pi 可能仍在流式」：abort 超时后本地 tab 已被复位 idle，
	 * 只信本地状态会漏传 streamingBehavior（Issue #371）。
	 */
	isEscalationPending(agentId: string): boolean {
		return this.pendingEscalations.has(agentId);
	}

	/** settled/agent_start：当前 abort 结束，查询与验证定时器同时失效。 */
	clearEscalation(agentId: string): void {
		this.clearEscalationVerifyTimer(agentId);
		this.pendingEscalations.delete(agentId);
	}

	/** agent 关闭/重建时清理 gate/兜底定时器/升级上下文，避免泄漏到新生命周期。 */
	clearAgent(agentId: string): void {
		this.clearSettledFallback(agentId);
		this.clearEscalation(agentId);
		this.gates.delete(agentId);
	}

	/** 当前持有 gate 的 agent id 快照（stopAll 遍历清闸用）。 */
	gateAgentIds(): string[] {
		return [...this.gates.keys()];
	}

	/** 定时器 owner 与登记位置配对，正常结束也不能遗留迟到 notice。 */
	private clearEscalationVerifyTimer(agentId: string): void {
		const timer = this.escalationVerifyTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this.escalationVerifyTimers.delete(agentId);
		}
	}

	private clearSettledFallback(agentId: string): void {
		const timer = this.settledFallbackTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this.settledFallbackTimers.delete(agentId);
		}
	}
}
