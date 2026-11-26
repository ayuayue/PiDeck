/**
 * 分批扩窗的纯计算（从 useSessionTimelineController 提出来）。
 *
 * 为什么不设「超过 N 轮就整批推开」：旧实现里 backlog > 24 时一次 setState 挂满
 * 整个待扩量（点大纲最上面的刻度 = 一帧挂 130+ 轮），那一帧必然掉帧。现在一律按 8 轮
 * 切片：130 轮 = 17 帧，既不卡单帧，也不会在一条 rAF 链上连发上百次 setState。
 */

/** 每帧最多挂载的轮数。8 轮约 80 条消息，是单帧能稳定渲染的量级。 */
export const TURN_WINDOW_EXPAND_BATCH_TURNS = 8;

/** 这一帧该扩几轮：待扩量为 0 返回 0，否则最多 8 轮。 */
export function planWindowExpandBatch(backlog: number): number {
	if (backlog <= 0) return 0;
	return Math.min(TURN_WINDOW_EXPAND_BATCH_TURNS, backlog);
}

/**
 * 扩窗后的轮数：不超过 windowCap；已经超过时不缩回。
 *
 * 「不缩回」是 2026-11 之前就有的取舍：缩回会触发一次大幅内容收缩，贴底时会连带抖动。
 * 曾短暂改成硬上限（怕 636 轮会话越滚越多），结果把「扩窗到目标」这条唯一能自己走到位的
 * 路径一起掐断 —— 用户当场的原话是「自从改了上下 15 轮后就一直跳不了」。硬上限已撤销。
 */
export function capWindowTurns(prev: number, batch: number, windowCap: number): number {
	// 硬上限已撤销（见上方注释）：窗口大小不是产品语义，定位由虚拟列表的 pin + 滚动完成。
	return Math.min(prev + batch, Math.max(prev, windowCap));
}
