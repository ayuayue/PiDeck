/**
 * 分批扩窗的纯计算（从 useSessionTimelineController 提出来）。
 *
 * 为什么单独成模块：这段逻辑原先只有一份「正则扫源码」的测试守着——断言代码长什么样，
 * 对行为零验证（仓库规范禁止这种写法）。抽成纯函数后才能直接喂输入、断言输出。
 *
 * 为什么不设「超过 N 轮就整批推开」：旧实现里 backlog > 24 时一次 setState 挂满
 * 整个待扩量（点大纲最上面的刻度 = 一帧挂 130+ 轮），那一帧必然掉帧，用户描述为
 * 「点跳转不流畅」。旧注释把那次真机崩溃归因成 React #185（嵌套更新上限 50），但
 * rAF 回调里的 setState 不构成嵌套更新，这个归因站不住；更可能是单帧挂载量本身过大。
 * 现在一律按 8 轮切片：130 轮 = 17 帧 ≈ 280ms，既不卡单帧，也不会在一条 rAF 链上
 * 连发上百次 setState（那是 130 次，切到 17 次）。
 */

/** 每帧最多挂载的轮数。8 轮约 80 条消息，是单帧能稳定渲染的量级。 */
export const TURN_WINDOW_EXPAND_BATCH_TURNS = 8;

/** 这一帧该扩几轮：待扩量为 0 返回 0，否则最多 8 轮。 */
export function planWindowExpandBatch(backlog: number): number {
	if (backlog <= 0) return 0;
	return Math.min(TURN_WINDOW_EXPAND_BATCH_TURNS, backlog);
}

/**
 * 扩窗后的轮数：不超过 `windowCap`，但也不把已经超出的当前值缩回去。
 *
 * 为什么要封顶：窗口一路涨到几百轮会让每次扩窗都重挂整表，是 2026-11 那次整窗崩溃的温床。
 * 为什么不缩回：已知超出上限时（例如已加载消息比上限少、随后又补进更多），缩回会造成一次
 * 大幅内容收缩，贴着底部时会连带触发回底/掉底那一串抖动。
 */
export function capWindowTurns(prev: number, batch: number, windowCap: number): number {
	return Math.min(prev + batch, Math.max(prev, windowCap));
}
