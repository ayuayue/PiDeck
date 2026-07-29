/**
 * 流式事件世代闸门。
 *
 * 业务规则：
 * - 每个 agent 维护单调递增的 stream generation
 * - 用户 abort 时 seal 当前 generation，并要求先看到 abort 后的 agent_settled
 * - 只有「abort 已 settled」之后的 agent_start 才会推进 generation 并重新放行
 * - 这样可同时覆盖两种竞态：
 *   1) settled 前的管道残留 delta（点一次停止仍继续思考）
 *   2) 用户立刻发下一条导致 agent_start 早于旧 run 残留事件（新旧回答串台）
 */
export type StreamGateState = {
	/** 当前活跃 generation，从 0 起；合法解封时 +1 */
	currentGeneration: number;
	/** 已封印的 generation；currentGeneration <= sealedGeneration 时拒绝流式事件 */
	sealedGeneration: number | undefined;
	/**
	 * abort 后是否仍在等待 agent_settled。
	 * true 时即使收到 agent_start 也不解封，只记 pendingOpen；
	 * settled 到达后再真正 open。
	 */
	waitingForAbortSettled: boolean;
	/**
	 * abort 尚未 settled 时已收到 agent_start：settled 后应立即 open。
	 * 覆盖“用户停止后立刻重发”的快路径。
	 */
	pendingOpenAfterSettled: boolean;
};

export function createStreamGateState(): StreamGateState {
	return {
		currentGeneration: 0,
		sealedGeneration: undefined,
		waitingForAbortSettled: false,
		pendingOpenAfterSettled: false,
	};
}

/** 用户 abort：封印当前 generation，并等待 abort 对应的 agent_settled。 */
export function sealStreamGate(state: StreamGateState): StreamGateState {
	return {
		...state,
		sealedGeneration: state.currentGeneration,
		waitingForAbortSettled: true,
		// 新的 abort 覆盖旧的 pending open，避免误用更早的 start
		pendingOpenAfterSettled: false,
	};
}

/**
 * 新一轮 agent run 开始。
 * - 若仍在等待 abort settled：只记 pendingOpen，保持封印
 * - 否则推进 generation 解封
 */
export function openStreamGateForNewRun(state: StreamGateState): StreamGateState {
	if (state.waitingForAbortSettled) {
		return {
			...state,
			pendingOpenAfterSettled: true,
		};
	}
	return {
		...state,
		currentGeneration: state.currentGeneration + 1,
		pendingOpenAfterSettled: false,
	};
}

/**
 * abort 后的 agent_settled（或兜底超时）到达。
 * - 若期间已有 agent_start：立即推进 generation 解封
 * - 否则保持封印，等待下一次 agent_start
 */
export function noteAbortSettled(state: StreamGateState): StreamGateState {
	if (!state.waitingForAbortSettled) {
		return state;
	}
	const cleared: StreamGateState = {
		...state,
		waitingForAbortSettled: false,
	};
	if (cleared.pendingOpenAfterSettled) {
		return {
			...cleared,
			currentGeneration: cleared.currentGeneration + 1,
			pendingOpenAfterSettled: false,
		};
	}
	return {
		...cleared,
		pendingOpenAfterSettled: false,
	};
}

/** 当前 generation 是否仍被封印（应丢弃所有流式事件）。 */
export function isStreamGateSealed(state: StreamGateState): boolean {
	return (
		state.sealedGeneration != null &&
		state.currentGeneration <= state.sealedGeneration
	);
}
