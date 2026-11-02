/**
 * 跳转事务与贴底引擎之间的两处仲裁。
 *
 * 背景（用户四次反馈「输出时点刻度跳不回去、停止输出后又能跳」）：
 * 流式输出时贴底引擎每帧都在 resize，会上报 following=true。三个消费点各自会造成跳转失效：
 *
 * 1. 跟底上报会把 autoScroll 拉回 true，而 autoScroll=true 的 effect 会清空
 *    分批扩窗预算（pendingExpandTurnsRef）并 cancel 扩窗帧 —— 挂起中的跳转永远等不到
 *    目标轮挂载，表现就是「点了没反应」。
 * 2. 同一 effect 还会把浏览 pin 全部清掉，扩窗后补位移的依据没了，落位会偏移。
 * 3. **跳转落位后**（目标行本来就在 DOM 里，不需要 pendingJump —— 流式时用户点的
 *    常常就是最新那几轮），没有任何事务标记在挡引擎上报：目标恰在底部附近时引擎判定
 *    following=true，autoScroll 被拉回 true，下一帧就跟着新内容滚回底部，用户看到的是
 *    「跳过去了又弹回来」。所以仲裁必须以**浏览 pin 存在**为准：pin 存在 = 视口被钉在
 *    某一行，此时引擎的「已跟底」是过期判定，接受它必然把视口拽走。
 *
 * 抽成纯函数是为了用测试钉住这三条判定，而不是靠「读源码里有没有那个 if」。
 */

/**
 * 跳转期间 / 浏览钉行期间：忽略引擎的跟底上报（true = 忽略）。
 *
 * @param following 引擎本次上报「用户仍在实时尾部」
 * @param hasPendingJump 有挂起的跳转事务（目标行还没挂载、正在扩窗/补页）
 * @param hasBrowsePin 视口被钉在某一行（跳转落位、或用户上滚后浏览历史）
 */
export function shouldIgnoreFollowReport(following: boolean, hasPendingJump: boolean, hasBrowsePin = false): boolean {
	return following && (hasPendingJump || hasBrowsePin);
}

/** 回底时是否应清空扩窗预算与浏览 pin（true = 清）。跳转期间不清。 */
export function shouldResetExpandBudget(autoScroll: boolean, hasPendingJump: boolean): boolean {
	return autoScroll && !hasPendingJump;
}
