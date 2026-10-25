import { isMobileViewport } from "./webViewport";

export type HeaderAutoHideInput = {
	scrollTop: number;
	delta: number;
	viewportWidth: number;
	forceVisible: boolean;
};

// 阈值刻意不对称：向上 8px 即露出（用户开始回读），向下 24px 才收起（手指微抖不闪烁）
const REVEAL_DELTA = -8;
const HIDE_DELTA = 24;

export function resolveHeaderHidden(previous: boolean, input: HeaderAutoHideInput): boolean {
	if (!isMobileViewport(input.viewportWidth)) return false;
	if (input.forceVisible) return false;
	if (input.scrollTop <= 0) return false;
	if (input.delta < REVEAL_DELTA) return false;
	if (input.delta > HIDE_DELTA) return true;
	return previous;
}

export type HeaderAutoHideState = {
	hidden: boolean;
	/** 当前累计方向：1 向下、-1 向上、0 无 */
	direction: number;
	distance: number;
};

export const INITIAL_HEADER_AUTO_HIDE_STATE: HeaderAutoHideState = { hidden: false, direction: 0, distance: 0 };

export function stepHeaderAutoHide(state: HeaderAutoHideState, input: HeaderAutoHideInput): HeaderAutoHideState {
	if (input.delta === 0) return state;
	const direction = input.delta > 0 ? 1 : -1;
	const distance = (direction === state.direction ? state.distance : 0) + Math.abs(input.delta);
	const hidden = resolveHeaderHidden(state.hidden, { ...input, delta: distance * direction });
	return hidden === state.hidden ? { hidden, direction, distance } : { hidden, direction, distance: 0 };
}
