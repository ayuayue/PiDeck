/**
 * 取页成功后，等待目标挂上 DOM 的判据（纯函数 + 选择器）。
 *
 * 为什么需要：取页成功不等于落位成功。数据进缓存后，目标行要等虚拟列表下一帧
 * 才挂出来，而旧实现把「继续落位」全押在 pendingJump effect 重跑上。effect 依赖
 * combinedMessages 的快照，缓存写入与这次快照错位时它根本不重跑 —— 日志实证
 * （2026-11-25，数学组2，点 b6a20c25）：
 *
 *   06.1228  entry  foundIndex=-1  messages=1152
 *   06.1308  merge  pageMessages=57 merged=1209 pageHasTarget=true cacheWrite=true
 *   06.1309  page   outcome=exact anchorEntryId=b6a20c25
 *   ──────── 此后 1.17 秒没有任何 tick / settle ────────
 *   07.3032  entry  foundIndex=56 messages=1209   ← 用户又点了一次才发现数据到了
 *
 * 表现就是「要点好几次」。修法：取页成功后自己盯 DOM，不依赖别的副作用。
 */

/** 目标行的 DOM 选择器：投影 id 恒以 -history-entryId 结尾（见 AgentMessageProjector）。 */
export function jumpTargetSelector(entryId: string): string {
	// 用后缀匹配而不是等拼接出完整投影 id：agentId 在前端不可知，而 entryId 是稳定的。
	return '[data-message-id$="-history-' + entryId + '"]';
}

/** 取页后最多盯多少帧（60Hz 下约 2 秒；虚拟列表挂行通常 1-3 帧）。 */
export const JUMP_TARGET_WAIT_FRAMES = 120;
/**
 * 「认不出目标」的等待上限（帧）。8 帧 ≈ 130ms：虚拟列表挂行通常 1-3 帧，
 * 再多不是慢，是这条根本不在数据里 —— 等它不如如实说出来。
 */
export const JUMP_TARGET_WAIT_UNINDEXED_FRAMES = 8;

export type JumpTargetWaitStep =
	/** 目标行已在 DOM：落位。 */
	| { kind: "found" }
	/** 还没出现，下一帧再看。 */
	| { kind: "wait" }
	/** 帧数用尽：交给状态机报可诊断的失败，不再空转。 */
	| { kind: "exhausted" };

/**
 * 每帧一次的判定。
 *
 * 顺序：先判命中，再判上限 —— 最后一帧恰好挂上时必须算成功（否则差一帧会变成
 * 又一次「点了没反应」）。
 */
export function planJumpTargetWait(input: { found: boolean; frames: number; inData?: boolean }): JumpTargetWaitStep {
	if (input.found) return { kind: "found" };
	// 认不出目标（不在数据里）：补页与扩窗都帮不上它，等满 120 帧只是把「认不出」
	// 拖成 2 秒空白（2026-11-26 真机：row-exhausted frames=120）。8 帧足够虚拟列表挂行，
	// 之后交回状态机给可诊断的原因。inData 只显式传 false 才走短路，老调用行为不变。
	if (input.inData === false && input.frames >= JUMP_TARGET_WAIT_UNINDEXED_FRAMES) return { kind: "exhausted" };
	if (input.frames >= JUMP_TARGET_WAIT_FRAMES) return { kind: "exhausted" };
	return { kind: "wait" };
}

/**
 * 查目标行的选择器：先精确再后缀。
 *
 * 入口 id 有两形：会话文件条目 id（查找面板给），和投影消息 id（形如 agentId-history-entryId）。
 * 数据到了之后能归一，就该用精确 id 查 —— 后缀匹配只是兜底，它会把任何以同一 entryId
 * 结尾的投影行都算命中（不同 agent 前缀、思考组 id 都可能撞）。
 */
export function jumpWaitSelector(input: { entryId: string; resolvedId?: string | null }): string {
	const value = input.resolvedId ?? "";
	if (value.length > 0) {
		const escaped = value.replace(/["\\]/g, "\\$&");
		return '[data-message-id="' + escaped + '"]';
	}
	return jumpTargetSelector(input.entryId);
}

/** 等待期间每隔多少帧尝试推进一次渲染窗口。 */
export const JUMP_WAIT_EXPAND_EVERY_FRAMES = 8;
/** 等待期间最多推进几次窗口。 */
export const JUMP_WAIT_EXPAND_MAX_ATTEMPTS = 3;

/**
 * 数据里有目标、DOM 里没有时要不要主动扩窗。
 *
 * 虚拟列表只挂窗口内的轮次：目标进了数据但不在窗口里，光等是等不出来的 ——
 * 旧实现干等 120 帧（约 2 秒）再交回状态机，用户体感就是「点了没反应，再点一次」。
 * 反例：inData=false（目标还在没取到的历史页里）时扩窗没有意义，只会白挂一堆轮次；
 * 所以必须以「目标已在数据里」为前提，且次数有界 —— 不能靠扩窗把一个不存在的行等出来。
 */
export function shouldExpandWhileWaiting(input: { frames: number; attempts: number; inData: boolean }): boolean {
	if (!input.inData) return false;
	if (input.attempts >= JUMP_WAIT_EXPAND_MAX_ATTEMPTS) return false;
	if (input.frames === 0) return false;
	return input.frames % JUMP_WAIT_EXPAND_EVERY_FRAMES === 0;
}
