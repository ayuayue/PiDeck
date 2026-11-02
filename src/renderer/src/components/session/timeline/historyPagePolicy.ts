/**
 * 历史翻页的每页轮数口径。
 *
 * 抽成独立模块的原因：这两个数字一行写错就是「点一次只多一屏不到」的用户可见缺陷，
 * 但它埋在 controller 三千行里，无法被纯函数测试覆盖。放在这里后，页大小与窗口增长
 * 都能直接喂输入断言输出。
 *
 * host 侧各有上限，不是我们可以随便调的（超出不报错，只会被静默夹到上界，
 * 所以「传大了没收益、传小了才是缺陷」）：
 * - pi：SessionHistoryReader.MAX_TURN_PAGE_SIZE = 200（2026-11 由 10 放开，
 *   理由是跳转补页一次补十几次太慢；见该常量上的推演）
 * - DSH：DSH_HISTORY_TURN_PAGE_LIMIT 仍是 10 —— DSH 的读页走另一条 host 路径，
 *   没做同样的实测，不跟着放宽。DSH 会话的 backfill 会被夹到 10，回退成多次补页。
 */

import { countUserTurns } from "./turnRenderWindow";

/** 显式点「加载更多对话」时的单页轮数：取 host 上限，一次点击给足 10 轮。
 *  过去传 3：用户点一次只多一屏不到，观感等于「按钮没反应」（2026-11 真机反馈）。 */
export const HISTORY_TURN_PAGE_SIZE = 10;

/** 滚动到顶自动翻页的单页轮数：仍取 3。
 *  滚动触发是连续事件，一次多要 10 轮会让视口被顶出很远，反而像「跳了一下」。
 *  按钮是单次明确意图，只有它用 10。 */
export const HISTORY_SCROLL_TURN_PAGE_SIZE = 3;

/** 跳转补页（backfill）的单页轮数：取 host 上限，一次给足 10 轮。
 *
 *  这个 source 只有一个用途 —— 用户点右缘刻度跳还没加载的历史。两个调用方
 *  （SessionSurfaceStage 的刻度 pending 链、controller 的 pendingJump effect）都是它。
 *  曾经写成 3，理由是「回填在后台连续补页，一次 10 轮会让单批负载翻三倍」——
 *  那个调用方已经不存在了（grep "backfill" 只有这两处跳转），注释是过期的。
 *  页面高度除以 12 决定刻度数（约 90 根），147 轮的会话一根刻度背后可能差几十轮，
 *  每次只补 3 轮 = 用户要点十几次才落地。
 *
 *  2026-11 真机再修：10 轮仍要补十几次（156 轮会话 = 每次 10 轮 = 16 次读盘，每次约 0.5s，
 *  用户看到的就是「一直在加载」）。取 200 —— host 的 MAX_TURN_PAGE_SIZE 同步放到 200，
 *  **一次读盘覆盖一整份 156 轮会话**。数字推演：每轮约 33 条消息（本机实测 5156 条 / 156 轮），
 *  200 轮 ≈ 6600 条 ≈ 13-26MB，落在渲染层 DISK_HISTORY_MESSAGE_LIMIT(8000) 之内，
 *  所以这一页不会被整页丢弃（真被丢弃就会「点了没反应」）。 */
export const HISTORY_BACKFILL_TURN_PAGE_SIZE = 200;

/**
 * 一次翻页最多把 DOM 窗口开大多少轮。
 *
 * 这是「数据」与「窗口」两个量的分界：页大小决定**数据**到齐多少轮（backfill 现在一次
 * 200 轮），这个上限只决定**真实挂载**多少轮。两者曾经是同一个数（页大小 10 → 开 10 轮），
 * 页大小一放到 200，若沿用同一个数就是一次挂载 200 轮 —— 那正是「点了就卡死」的形状。
 * 剩余轮次由跳转链的指数扩窗（resolveJumpPendingAction）与滚动展开接管，代价只是
 * 几帧的增量挂载，而不是一次性几百个组件树。
 */
export const HISTORY_MOUNTED_TURN_GROWTH_LIMIT = 10;

export type HistoryLoadSource = "scroll" | "button" | "backfill";

/** 按来源取页大小。写成函数而不是三处三元表达式：页大小是唯一真值，
 *  调用点只声明「这是哪条路径」，避免以后改常量时漏改某一条链。 */
export function resolveHistoryPageSize(source: HistoryLoadSource): number {
	if (source === "button") return HISTORY_TURN_PAGE_SIZE;
	if (source === "scroll") return HISTORY_SCROLL_TURN_PAGE_SIZE;
	return HISTORY_BACKFILL_TURN_PAGE_SIZE;
}

/** 翻页成功后开放的 DOM 窗口轮数。
 *
 *  必须按「页内实际轮数」放，不能让窗口比数据小：窗口小于返回的轮数时，新加载的
 *  轮会被尾部窗口裁掉 —— 数据已加载但看不见，表现为「点了没反应」。
 *  也不能超过页大小：窗口比数据大没有内容可填，只是多一次 turn 窗口重算。
 *
 *  disk 消息页不一定以 user 消息开头（可能在长回答中间切断），所以只要页非空就至少
 *  开放 1 轮，否则这一页会整页落在窗口外。
 */
export function resolvePageWindowGrowth(messages: readonly { role?: string }[], pageSize: number = HISTORY_TURN_PAGE_SIZE, mountedLimit: number = HISTORY_MOUNTED_TURN_GROWTH_LIMIT): number {
	if (messages.length === 0) return 0;
	const turns = countUserTurns(messages);
	return Math.min(pageSize, mountedLimit, Math.max(1, turns));
}
