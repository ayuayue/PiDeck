/**
 * 跳转策略：目标落在虚拟区时，钉住它，还是扩窗把它拉进实心区？
 *
 * 为什么需要这一步：现在跳转只有「扩窗」一条路。窗口是尾部的，跳到越早的位置，
 * 需要扩的轮数越多——1000 轮会话点最上面那条要 126 帧 ≈ 2.1 秒（2026-11 实测）。
 * 而 virtualizer 本身已经有 pinned 机制（rangeExtractor 强制挂载指定 run），
 * 钉住一条只需挂一行，与窗口大小无关。
 *
 * 判据：本函数是纯的，输入窗口结构 + 目标位置，输出策略；test/jumpStrategy.test.mjs 覆盖四条分支。
 */

export type JumpStrategy = "pinned" | "expand";

export interface JumpWindowShape {
	/** 列表总条目数。 */
	total: number;
	/** 进入虚拟区（可回收）的条目数，从列表头部算起。 */
	virtualCount: number;
	/** 实心区起始下标（含），到末尾为止。 */
	solidStart: number;
}

/**
 * 目标已经在实心区 → 直接滚（expand），不需要动窗口。
 * 目标在虚拟区 → 钉住（pinned）：挂一行 vs 扩到目标位置，后者在长会话上是平方级代价。
 * 目标下标非法 → expand（保守：让调用方走原来的路径）。
 */
export function planJumpStrategy(shape: JumpWindowShape, targetIndex: number): JumpStrategy {
	if (!Number.isFinite(targetIndex) || targetIndex < 0 || targetIndex >= shape.total) return "expand";
	// virtualCount === 0 表示整表都是实心的：目标一定在实心区。
	if (shape.virtualCount <= 0) return "expand";
	return targetIndex < shape.virtualCount ? "pinned" : "expand";
}
