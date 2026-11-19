/**
 * 「落位前先把目标从嵌套滚动窗口里露出来」。
 *
 * 背景（2026-11）：过程组组体是限高视口（`data-process-group-scroller`），组内成员可能
 * 被滚出可视区。会话跳转（刻度 / 会话内查找 / 宿主插件导航）只移动会话这一层的 scrollTop，
 * 目标行**布局是有的**（rect 正常、`getClientRects()` 非空，所以 `resolveJumpScrollTarget`
 * 不会退到轮次行），却被组体裁掉：Chromium 实测可见高度 0px，用户看到的是「跳到一条空白」。
 * 因此算会话偏移之前，必须先把每一层嵌套窗口滚到位。
 *
 * 为什么不在这里直接写 `scrollTop`：组体那条滚轮由跟底引擎（`lib/stick-to-bottom`）持有
 * 锁底态，裸赋值不会解锁，下一次成员增长又会把视口拽回底部，与跳转互相拉扯。所以组体展开时
 * 把自己的 `restoreAt` 注册进来；本模块优先走注册的回调，未注册的普通滚动容器才退化到赋值。
 */

/** 组体注册进来的定位入口（引擎的 restoreAt：定位 + 解锁锁底 + 取消在途动画）。 */
type NestedScrollerRestore = (scrollTop: number) => void;

const restores = new WeakMap<HTMLElement, NestedScrollerRestore>();

/** 组体展开时注册自己的定位入口；返回注销函数（收起/卸载时调用）。 */
export function registerNestedScrollerRestore(element: HTMLElement, restore: NestedScrollerRestore): () => void {
	restores.set(element, restore);
	return () => {
		if (restores.get(element) === restore) restores.delete(element);
	};
}

/** 亚像素容差：125%/150% 缩放下边缘会留不到 1px 的余量。 */
const EDGE_TOLERANCE_PX = 0.5;

/**
 * 「把目标挪进窗口」需要的新 scrollTop；已经完整可见时返回 null（不动）。
 *
 * 采用 nearest 对齐：目标在上方就贴顶、在下方就贴底，绝不为了一条目标改变读者的相对位置。
 */
export function nearestRevealScrollTop(input: { targetTop: number; targetBottom: number; viewTop: number; viewBottom: number; scrollTop: number; scrollHeight: number; clientHeight: number }): number | null {
	const { targetTop, targetBottom, viewTop, viewBottom, scrollTop, scrollHeight, clientHeight } = input;
	if (![targetTop, targetBottom, viewTop, viewBottom, scrollTop, scrollHeight, clientHeight].every(Number.isFinite)) return null;
	if (targetTop >= viewTop - EDGE_TOLERANCE_PX && targetBottom <= viewBottom + EDGE_TOLERANCE_PX) return null;
	const delta = targetTop < viewTop ? targetTop - viewTop : targetBottom - viewBottom;
	const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
	const next = Math.min(maxScrollTop, Math.max(0, scrollTop + delta));
	return Math.abs(next - scrollTop) <= EDGE_TOLERANCE_PX ? null : next;
}

/** 参与纵向滚动的窗口（`hidden` 不接收滚轮，也不在本模块的处理范围内）。 */
function scrollsVertically(element: HTMLElement): boolean {
	const style = getComputedStyle(element);
	if (style.overflowY !== "auto" && style.overflowY !== "scroll") return false;
	return element.scrollHeight > element.clientHeight + 1;
}

/**
 * 从 `element` 向上逐层把目标露出来，止于 `boundary`（会话滚动区，由调用方自己定位）。
 *
 * 由内向外逐层处理：内层滚完后外层矩形已经变了，再读外层 rect 才算得准（布局读会强制回流，
 * 这里正好需要）。
 *
 * 返回是否动过任何一层——调用方据此决定要不要重算会话偏移。
 */
export function revealInNestedScrollers(element: HTMLElement, boundary: HTMLElement): boolean {
	let moved = false;
	let node = element.parentElement;
	while (node && node !== boundary) {
		if (scrollsVertically(node)) {
			const rect = node.getBoundingClientRect();
			const viewTop = rect.top + node.clientTop;
			const targetRect = element.getBoundingClientRect();
			const next = nearestRevealScrollTop({
				targetTop: targetRect.top,
				targetBottom: targetRect.bottom,
				viewTop,
				viewBottom: viewTop + node.clientHeight,
				scrollTop: node.scrollTop,
				scrollHeight: node.scrollHeight,
				clientHeight: node.clientHeight,
			});
			if (next !== null) {
				const restore = restores.get(node);
				if (restore) restore(next);
				else node.scrollTop = next;
				moved = true;
			}
		}
		node = node.parentElement;
	}
	return moved;
}
