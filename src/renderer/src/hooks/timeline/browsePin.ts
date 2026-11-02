import type { VisibleTimelineRow } from "./useVisibleTimelineRows";

/**
 * 浏览历史时的视口钉行（纯函数，无 React/DOM）。
 *
 * 扩窗/翻页/Markdown 后排版会在上方长高。用「正在看的那一轮相对视口顶」
 * 的漂移补 scrollTop，而不是整页 scrollHeight 差——后者会把下方回复变高、
 * 组件后排版都算进「上方历史」，补多或补少都会跳。
 *
 * 人还在滚时不要调用补偿：只更新 expectedViewportTop（见 followBrowsePinAfterUserScroll），
 * 否则会把视口焊回扩窗前那一条，上滑失去跟手惯性。
 */

export const BROWSE_PIN_DRIFT_EPSILON_PX = 0.5;

export type BrowsePin = {
	messageId: string;
	/** 钉住的行顶边相对视口顶的偏移（可负：行顶在视口上方）。 */
	expectedViewportTop: number;
};

/**
 * 可见行里第一条「底部仍压着视口顶边」的轮根（bottom >= 1 才没被视口顶切掉）。
 *
 * computeCurrentAnchor 与 findBrowsePin 的快路径共用这一份判据：各抄一份时，
 * 「>= 1」或轮根条件一旦漂移，锚点与浏览钉会选中不同的行。
 */
export function pickVisibleRootRow(rows: readonly VisibleTimelineRow[]): VisibleTimelineRow | null {
	return rows.find((row) => row.bottom >= 1 && row.isRootRow) ?? null;
}

/** 行相对视口多走了多少：正值 = 行在屏幕上被推下去（上方长高）。 */
export function browsePinDrift(currentViewportTop: number, expectedViewportTop: number): number {
	return currentViewportTop - expectedViewportTop;
}

/** 把漂移加回 scrollTop，让钉住的行回到 expectedViewportTop。 */
export function browsePinScrollTop(scrollTop: number, currentViewportTop: number, expectedViewportTop: number): number {
	return scrollTop + browsePinDrift(currentViewportTop, expectedViewportTop);
}

export function shouldCompensateBrowsePin(input: { following: boolean; currentViewportTop: number | null; expectedViewportTop: number; epsilon?: number }): boolean {
	if (input.following) return false;
	if (input.currentViewportTop === null) return false;
	const epsilon = input.epsilon ?? BROWSE_PIN_DRIFT_EPSILON_PX;
	return Math.abs(input.currentViewportTop - input.expectedViewportTop) > epsilon;
}

/** 用户自己滚了：接受新的视口位置，不要把人焊回旧偏移。 */
export function followBrowsePinAfterUserScroll(pin: BrowsePin, currentViewportTop: number | null): BrowsePin {
	if (currentViewportTop === null) return pin;
	return { messageId: pin.messageId, expectedViewportTop: currentViewportTop };
}

/**
 * 钉行不在 DOM（虚拟区外的行不会被渲染）时的兜底补偿量。
 *
 * 原实现在这种情况下直接 return —— 该补的一次都不补，视口往下掉。但「查不到行」
 * 不能一概按高度差补：
 * - 只有扩窗在途才关心（其它原因导致的 null 是切会话/恢复中/行被折叠，不该碰 scrollTop）；
 * - delta 为正才补（负值是内容缩短，补了反而跳）；
 * - delta 超过半屏多半不是顶部插入，而是内容自身长高（Markdown 异步排版、图片解码、
 *   估算高度换成实测）—— 那些行在钉行的**下方**，补 scrollTop 会把视口推走。
 *   按行对齐天然没有这个问题，因为它对齐的是钉行自身的位置，不看总高。
 */
export function resolvePinnedRowFallback(input: { expanding: boolean; previousHeight: number; nextHeight: number; viewportHeight: number }): number | null {
	if (!input.expanding) return null;
	if (input.previousHeight <= 0) return null;
	const delta = input.nextHeight - input.previousHeight;
	if (delta <= 0) return null;
	if (input.viewportHeight > 0 && delta > input.viewportHeight / 2) return null;
	return delta;
}
