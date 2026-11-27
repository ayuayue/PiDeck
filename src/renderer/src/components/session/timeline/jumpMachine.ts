/**
 * 跳转的单一状态机（纯函数，可单测）。
 *
 * 重构理由（2026-11 真机，636 轮会话点右缘刻度「没反应」）：
 * 旧实现把一次跳转拆在四处状态里 —— pendingJump（state）、browsePinRef（ref）、
 * scrolledWindowTurns（state）、pendingExpandTurnsRef（ref）。任何一处不成立都表现为
 * 「点了没反应」，而且看不出来是哪一处：ref 改了不重渲染、useMemo 依赖漏了就永远不重算、
 * effect 里三个静默 return 各挡一段。三个星期里我修了六处，用户每次仍看到同一句
 * 「没反应」——因为这些不是六个 bug，是**一种结构**：状态没有单一入口，也没有单一出口。
 *
 * 现在一次跳转只有一个状态，转移全部由本函数决定，四个动作各自有判据：
 *
 *   settle  目标已在 DOM 里（可以落位了）
 *   wait    目标在数据里但没挂载，交给渲染层（锚点窗口会把它切进来）
 *   expand  数据里没有，但还有更早的页 —— 继续补页
 *   fail    任何一条路都走不通，给出三种原因之一
 *
 * **有界**：budgetMs 到点必 fail，不会无限重试（旧实现靠 8/40 两个计数，两条路都可能
 * 在计数内空转完而不报错）。
 */

import type { JumpGiveUpReason, JumpPendingAction } from "./jumpWindowPolicy";

export type JumpTick =
	/** 目标已在 DOM 里：落位。 */
	| { kind: "settle" }
	/** 目标在已加载数据里、但还没挂载：渲染层一帧后必挂（锚点窗口），等。 */
	| { kind: "wait" }
	/** 目标不在数据里且还有更早的页：继续补页。 */
	| { kind: "load-page" }
	/** 目标在数据里、窗口也含它，但等了两帧还没挂载：扩窗兜底。 */
	| { kind: "expand" }
	/** 目标在数据里、但可能在折叠区里：先请求揭示（展开所在轮的执行过程折叠栏）。 */
	| { kind: "reveal" }
	/** 无路可走。 */
	| { kind: "fail"; reason: JumpGiveUpReason };

export interface JumpTickInput {
	/** 目标节点的 messageId 是否已在 DOM 里（按 data-message-id 查）。 */
	targetMounted: boolean;
	/** 目标是否已在 combinedMessages 里。 */
	targetInData: boolean;
	/** 是否还有更早的历史页可补。 */
	hasMorePages: boolean;
	/** 本轮跳转是否已经发过揭示请求（同一目标只发一次，避免每帧刷 nonce）。 */
	revealRequested: boolean;
	/** 定位取页是否在途：在途时的 hasMorePages 是取页之前的过期快照。 */
	pageInFlight: boolean;
	/** 上一页是否在路上。 */
	isLoadingPage: boolean;
	/** 已经等了多少帧（目标在数据里却没挂载）。 */
	waitFrames: number;
	/** 已经发起的补页次数（只数真的发出去的）。 */
	loadAttempts: number;
	/**
	 * 连续「请求发出去了、数据却没增长」的次数 —— **进度度量**。
	 *
	 * 这是本次重构的核心：进度只能由可观测的不变量（已加载条数变没变）度量，
	 * 不能由意图（发了几次请求）度量。旧实现只数发出次数，于是 40 次全打在
	 * prepend 被拒上，一次也没推进，仍然走到「40 次用完」（H3）。
	 */
	stalledAttempts: number;
	/** 已经发起的扩窗次数。 */
	expandAttempts: number;
	/** 从点击到现在过了多少毫秒。 */
	elapsedMs: number;
}

/** 等待目标挂载的最大帧数：锚点窗口下目标是同帧挂的，两帧还没出现说明窗口没切过来。 */
export const JUMP_WAIT_FRAMES_BEFORE_EXPAND = 2;
/** 补页次数保险丝（一页 200 轮，636 轮会话最多 4 次；40 是极端长会话的余量）。 */
export const JUMP_MAX_LOAD_ATTEMPTS = 40;
/** 连续「发出但数据没长」的容忍次数：第 2 次就该说实话，不该等到 40 次。 */
export const JUMP_MAX_STALLED_ATTEMPTS = 2;
/** 扩窗次数保险丝。 */
export const JUMP_MAX_EXPAND_ATTEMPTS = 8;
/** 硬超时：到这个时间点必须给出结论，不能继续空转。 */
export const JUMP_BUDGET_MS = 4000;

export function nextJumpTick(input: JumpTickInput): JumpTick {
	// ① 已挂载：立刻落位。这是唯一能让用户看到结果的出口，优先于一切。
	if (input.targetMounted) return { kind: "settle" };

	// ② 硬超时：到点必须说话。放在数据判断之前 —— 否则「数据在但永远挂不上」会一直等。
	if (input.elapsedMs >= JUMP_BUDGET_MS) {
		return {
			kind: "fail",
			reason: input.targetInData ? "target-not-mountable" : input.hasMorePages ? "load-attempts-exhausted" : "no-earlier-pages",
		};
	}

	// ③ 数据里有、还没挂载：先请求揭示。
	// 目标多半在已完成轮的执行过程折叠区里；Radix 收起时整块卸载，扩窗只多挂轮次、
	// 永远挂不出这些节点。旧顺序 wait→expand→fail 就是 H1 的来源（2026-11-25 真机：
	// 通知历史 19 条全是 H1，而扩窗 8 次一次也没让节点出现）。
	if (input.targetInData) {
		if (!input.revealRequested) return { kind: "reveal" };
		if (input.waitFrames < JUMP_WAIT_FRAMES_BEFORE_EXPAND) return { kind: "wait" };
		if (input.expandAttempts >= JUMP_MAX_EXPAND_ATTEMPTS) return { kind: "fail", reason: "target-not-mountable" };
		return { kind: "expand" };
	}

	// ③′ 定位取页在途：此刻的 hasMorePages 是取页之前的过期快照，不能当判据。
	// 反例（2026-11-25 日志，同一条链 14ms 内）：
	//   tick    stillInData=false hasMorePages=false pageRequested=true
	//   give-up no-earlier-pages
	//   merge   pageMessages=58 merged=918 pageHasTarget=true
	// 页取到了，提示已经弹完 —— 用户看到的就是「搜到了却跳不过去」。
	if (input.pageInFlight) return { kind: "wait" };

	// ④ 数据里没有：看还能不能补页。
	if (!input.hasMorePages) return { kind: "fail", reason: "no-earlier-pages" };
	if (input.isLoadingPage) return { kind: "wait" };
	// 连续两次「发出去但数据没长」= 补页在空转（revision/游标被拒），立刻给真实原因。
	// 不等 40 次：40 次空转要花十几秒，而且期间界面毫无反馈。
	if (input.stalledAttempts >= JUMP_MAX_STALLED_ATTEMPTS) return { kind: "fail", reason: "backfill-not-advancing" };
	if (input.loadAttempts >= JUMP_MAX_LOAD_ATTEMPTS) return { kind: "fail", reason: "load-attempts-exhausted" };
	return { kind: "load-page" };
}

/**
 * tick → 调用方动作的映射。放在这里而不是 controller 里：controller 已经贴着 1122 行基线，
 * 而且这段映射本身就是状态机的一部分（每个 tick 唯一对应一个动作）。
 */
export function toPendingAction(tick: JumpTick, expandTurns: number): JumpPendingAction {
	if (tick.kind === "fail") return { kind: "give-up", reason: tick.reason };
	if (tick.kind === "wait") return { kind: "wait" };
	if (tick.kind === "load-page") return { kind: "load-page" };
	if (tick.kind === "reveal") return { kind: "reveal" };
	if (tick.kind === "settle") return { kind: "wait" };
	return { kind: "expand", turns: expandTurns };
}

/**
 * 进度计数的更新规则（纯函数）。
 *
 * 「有进展」的唯一判据是**已加载条数变长**，不是「请求发出去了」。这条规则放在这里
 * 而不是 controller 里，是因为它是状态机语义的一部分；controller 只负责把观测值读出来。
 */
export function nextStalledAttempts(previous: number, dataGrew: boolean): number {
	return dataGrew ? 0 : previous + 1;
}
