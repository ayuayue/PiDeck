/**
 * 轮末文件 chip 行「单行装箱」纯规则。
 *
 * 背景：一轮可能改几十个文件，全铺开会把轮末撑成一坨；但也不能只横向滚动
 * （滚动条隐藏后用户不知道右边还有东西，且鼠标滚轮默认不动横向）。
 * 规则与用户确认：**只显示一行，放不下的收进 `+N`，点 `+N` 就地展开成多行**。
 *
 * 为什么抽成纯函数：宽度是运行时测量的，但「放几个」是产品规则。
 * 规则只活在 JSX lambda 里就只能靠肉眼验收；这里是纯函数，可以拿几千组
 * 随机宽度做属性测试（见 tests/sessionFileSummary.test.mjs）。
 */

/**
 * 计算第一行能放下几个 chip。
 *
 * 贪心从左往右累加；判断第 i 个能不能放时，要给「更多」按钮留位置：
 * - 若放下第 i 个后还有剩余（i < total - 1），预算 = available - moreWidth - gap；
 * - 若第 i 个就是最后一个，预算 = available（不再需要「更多」按钮）。
 *
 * 「更多」按钮的宽度依赖剩余数量（`+3` 比 `+12` 窄），形成自引用。这里迭代收敛：
 * 从「一个都放不下」这个最保守假设出发（remaining = total，按钮显示最大数字），
 * 每轮用上一轮的 remaining 量出的按钮宽度重新装箱，remaining 不再变化即收敛。
 * 实践上 2 轮就稳定；上限 3 轮是为了防浮点/测量抖动导致不收敛。
 *
 * @param widths      每个 chip 的自然宽度（px，已含自身的 padding）
 * @param gap         chip 之间的间距（px）
 * @param available   可用总宽度（px）
 * @param measureMore 给定剩余数量，返回「更多」按钮宽度（px）
 * @returns 第一行应显示的 chip 数量（0 = 一个都放不下，此时只显示「更多」按钮）
 */
export function fitOneRow(widths: readonly number[], gap: number, available: number, measureMore: (remaining: number) => number): number {
	const total = widths.length;
	if (total === 0 || available <= 0) return 0;

	let remaining = total;
	let count = 0;
	for (let iteration = 0; iteration < 3; iteration += 1) {
		// 最保守假设下一个能放进来：按钮显示当前剩余数量
		const moreWidth = measureMore(remaining);
		let used = 0;
		let placed = 0;
		for (let index = 0; index < total; index += 1) {
			const next = used + (placed > 0 ? gap : 0) + widths[index];
			const hasRemainder = index < total - 1;
			const budget = hasRemainder ? available - moreWidth - gap : available;
			if (next > budget) break;
			used = next;
			placed += 1;
		}
		const nextRemaining = total - placed;
		count = placed;
		if (nextRemaining === remaining) break;
		remaining = nextRemaining;
	}
	return count;
}
