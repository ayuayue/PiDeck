/**
 * 刻度/消息跳转（jumpToMessage）的挂载与补页策略（纯函数，可单测）。
 *
 * 背景：时间线只挂载滚动窗口内的轮次，且更早的历史按页落盘加载。点击刻度时
 * 目标可能（a）已加载但未挂载——扩渲染窗口；（b）尚未加载——跳转驱动补页；
 * （c）无处可寻——放弃。策略集中在这里，controller 只负责执行。
 */
import { TIMELINE_WINDOW_EXPAND_STEP } from "./turnRenderWindow";

/** 补页防呆：一次跳转最多驱动的补页次数。每页 3 轮，40 次 ≈ 120 轮历史深度，
 *  覆盖「点第一条刻度直达会话开头」的长会话；不再与扩窗尝试共用计数
 *  （旧版共用 6 次导致点最上面的刻度经常中途放弃、点第二次才成功）。 */
export const JUMP_MAX_LOAD_ATTEMPTS = 40;
/** 扩窗步长封顶倍数：指数步长 3 → 6 → 12 → 24 后不再增长。 */
export const JUMP_EXPAND_MAX_MULTIPLIER = 8;
/** 扩窗防呆：目标在数据里却始终没挂出节点（被 context_edit 移出展示、轮内节点未渲染）
 *  时最多再扩 8 轮，然后放弃——否则 effect 每轮都在扩窗且窗口已够大，形成空转。 */
export const JUMP_MAX_EXPAND_ATTEMPTS = 8;

export type JumpPendingAction =
	| { kind: "expand"; turns: number }
	| { kind: "load-page" }
	/** 页面在途：保持挂起，isLoadingPage 翻转后由 effect 重跑 */
	| { kind: "wait" }
	| { kind: "give-up" };

/**
 * 目标消息无法挂载时的落点选择（折中：落到包含它的那一轮，而不是报「跳不到」）。
 *
 * 输入是「已渲染行」的起始消息下标（每行取其子树里最靠前的消息下标），目标是命中的
 * 消息下标。优先挑「起始下标 ≤ 目标」里最靠后的一行（目标所在轮，或它前面最近的轮），
 * 没有更早的行才退到最早的一行。返回 entries 下标；-1 = 没有可用落点。
 *
 * 为什么需要：已完成轮的执行过程默认折叠，折叠区里的中间回答/工具节点整块卸载，
 * 扩窗（只多挂轮次）永远挂不出这些节点；旧实现扩到上限就弹「未能跳转」，
 * 用户看到的是「搜到了却点不过去」（2027-02 反馈）。
 */
export function resolveJumpFallbackEntry(entries: ReadonlyArray<{ index: number }>, targetIndex: number): number {
	if (entries.length === 0) return -1;
	let before = -1;
	let earliest = -1;
	for (let position = 0; position < entries.length; position += 1) {
		const index = entries[position].index;
		if (index <= targetIndex && (before < 0 || index > entries[before].index)) before = position;
		if (earliest < 0 || index < entries[earliest].index) earliest = position;
	}
	return before >= 0 ? before : earliest;
}

export function resolveJumpPendingAction(input: {
	targetInLoadedData: boolean;
	hasMorePages: boolean;
	isLoadingPage: boolean;
	/** 指数扩窗的尝试次数（仅 expand 分支消耗）。 */
	expandAttempts: number;
	/** 跳转驱动补页的次数（仅 load-page 分支消耗，与扩窗互不挤占）。 */
	loadAttempts: number;
}): JumpPendingAction {
	if (input.targetInLoadedData) {
		if (input.expandAttempts >= JUMP_MAX_EXPAND_ATTEMPTS) return { kind: "give-up" };
		// 指数步长收敛：仅作「点击时一次到位估算不足」的兜底；窗口大于已加载数据时
		// 等同全量挂载，无害
		const multiplier = Math.min(2 ** input.expandAttempts, JUMP_EXPAND_MAX_MULTIPLIER);
		return { kind: "expand", turns: TIMELINE_WINDOW_EXPAND_STEP * multiplier };
	}
	if (!input.hasMorePages) return { kind: "give-up" };
	if (input.isLoadingPage) return { kind: "wait" };
	if (input.loadAttempts >= JUMP_MAX_LOAD_ATTEMPTS) return { kind: "give-up" };
	return { kind: "load-page" };
}

/**
 * 估算「让目标消息进入挂载窗口」所需的窗口轮数（点击刻度时一次性排满扩窗批次，
 * 替代旧版指数多轮收敛——每轮收敛都要一次完整渲染，表现为「点了要等好几拍」）。
 *
 * 轮次窗口从尾部保留 W 个 run：目标在第 k 轮（1-based，共 T 轮）时需要
 * W ≥ T-k+1，即目标（含）之后还有多少条 turn。轮次以 turn 起点为计数
 * （与主进程 findTurnPageStart 的发言权周期口径一致：连发 user 只算一轮）；
 * +1 轮冗余吸收 system/compaction 等非 run 条目。估算偏大会多挂少量尾部轮次，
 * 不会改变窗口模型；估算不足由 effect 的指数兜底补齐。
 */
export function estimateJumpExpandTurns(messages: ReadonlyArray<{ role?: string }>, targetIndex: number): number {
	if (targetIndex < 0 || targetIndex >= messages.length) return TIMELINE_WINDOW_EXPAND_STEP;
	let turnsFromTargetToEnd = 0;
	let prevUserOrAssistantRole: "user" | "assistant" | undefined;
	for (let index = targetIndex; index < messages.length; index += 1) {
		const role = messages[index]?.role;
		if (role === "user") {
			if (prevUserOrAssistantRole !== "user") turnsFromTargetToEnd += 1;
			prevUserOrAssistantRole = "user";
		} else if (role === "assistant") {
			prevUserOrAssistantRole = "assistant";
		}
	}
	return turnsFromTargetToEnd + 1;
}
