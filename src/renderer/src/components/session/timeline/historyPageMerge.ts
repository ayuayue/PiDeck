/**
 * 历史页合并与渲染窗口锚点（纯函数，无 DOM、无 atom）。
 *
 * 为什么单独成文件：这两件事原先埋在 `session-history-atoms.ts` 的 prepend 里，
 * 与守卫、封顶、游标推进缠在一起，只有「跑整个 controller」才知道对不对。抽成纯函数后，
 * 喂一段乱序到达的页就能断言输出，不需要 React。
 *
 * 一个历史页覆盖的文件区间是 (nextBefore, before)：nextBefore 是这页最旧一条之前的位置，
 * before 是请求本页时用的游标（首屏没有，等于文件尾）。区间就是排序的唯一依据——
 * 到达顺序不参与，所以「后页先到」不会把前言接到后面。
 */

/** 一页历史。T 只要求能被 keyOf 认出来，不绑定 ChatMessage。 */
export interface HistorySegment<T> {
	/** 本页最旧一条之前的文件位置；null = 本页已到文件头 */
	nextBefore: number | null;
	/** 请求本页时的游标（本页最新一条之后的位置）；首屏为 null/缺省 = 文件尾 */
	before?: number | null;
	messages: readonly T[];
}

export interface MergedHistory<T> {
	/** 按文件顺序排列（旧 → 新）。到达顺序不参与排序。 */
	messages: T[];
	/** 每处缺口的边界：`before` 处没有数据直接接上，中间缺了 `size` 条。空数组 = 连续。 */
	gaps: Array<{ before: number; size: number }>;
	/** 因重叠而丢弃的条数（同一 entryId 出现在两页里）。 */
	dropped: number;
	/** 到达顺序与文件顺序是否不一致（发生了纠正）。 */
	reordered: boolean;
}

/** nextBefore 的排序键：null（文件头）最旧。 */
function segmentOrder(segment: HistorySegment<unknown>): number {
	return segment.nextBefore === null ? Number.NEGATIVE_INFINITY : segment.nextBefore;
}

/**
 * 合并若干历史页。
 *
 * 不静默填空：缺口只记录不编造——调用方据此决定「继续补页」还是「如实告诉用户这里缺一段」。
 * 去重以 keyOf 为准，保留先出现的那份（即文件位置更旧的一份，它的 id 更稳定）。
 */
export function mergeHistorySegments<T>(segments: readonly HistorySegment<T>[], keyOf: (item: T) => string): MergedHistory<T> {
	if (segments.length === 0) return { messages: [], gaps: [], dropped: 0, reordered: false };

	const ordered = segments.map((segment, position) => ({ segment, position, order: segmentOrder(segment) })).sort((left, right) => left.order - right.order);
	const reordered = ordered.some((entry, index) => entry.position !== index);

	const messages: T[] = [];
	const seen = new Set<string>();
	let dropped = 0;
	const gaps: Array<{ before: number; size: number }> = [];

	for (const entry of ordered) {
		const segment = entry.segment;
		// 缺口：上一段的最新边界（它的 before）与这一页的最旧边界（nextBefore）不相等，
		// 说明中间那一段谁都没加载。两个边界都得是数字才判得了，null 表示已到文件头。
		const previous = ordered[ordered.indexOf(entry) - 1];
		const previousBefore = previous?.segment.before;
		const currentLow = segment.nextBefore;
		if (ordered.indexOf(entry) > 0 && typeof previousBefore === "number" && typeof currentLow === "number" && previousBefore !== currentLow) {
			gaps.push({ before: currentLow, size: currentLow - previousBefore });
		}
		for (const message of segment.messages) {
			const key = keyOf(message);
			if (seen.has(key)) {
				dropped += 1;
				continue;
			}
			seen.add(key);
			messages.push(message);
		}
	}

	return { messages, gaps, dropped, reordered };
}

/**
 * 合并后保持渲染窗口不动。
 *
 * 窗口是「尾部 N 条」切片：历史页接在前头之后，同样的 N 会整体滑向最新，
 * 用户正在看的那批被顶出屏幕——表现是「补一页，视图自己跳了一下」。
 * 这里按窗口首条的身份重新定位，命中了就保住原内容，只有它确实消失才退回尾部切片。
 */
export function reanchorWindow<T>(input: { window: readonly T[]; merged: readonly T[]; keyOf: (item: T) => string }): { window: T[]; kept: boolean } {
	const { window, merged, keyOf } = input;
	if (window.length === 0) return { window: merged.slice(Math.max(0, merged.length - window.length)), kept: true };
	const anchorKey = keyOf(window[0]);
	const found = merged.findIndex((item) => keyOf(item) === anchorKey);
	if (found < 0) return { window: merged.slice(Math.max(0, merged.length - window.length)), kept: false };
	return { window: merged.slice(found, found + window.length), kept: true };
}
