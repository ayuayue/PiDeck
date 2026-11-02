/**
 * `role="radiogroup"` 的方向键语义（WAI-ARIA Radio Group 模式）。
 *
 * 原生 `<input type="radio">` 由浏览器负责「整组一个 Tab 停靠点 + 方向键换项」；
 * 用 `role="radio"` 手写色板时这些行为全部要自己实现，否则读屏播报「单选按钮」
 * 但方向键无效、每个按钮各自成为一个 Tab 停靠点。
 *
 * 与 utils/tabActivationKeys 同一套修饰键/输入法口径：子元素事件不处理、IME 组合
 * 与 Alt/Ctrl/Meta/Shift 不拦截，避免抢走组合键与候选词确认。
 */
type RadioGroupKeyEvent = {
	key: string;
	target: unknown;
	currentTarget: unknown;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	nativeEvent?: { isComposing?: boolean };
	preventDefault: () => void;
};

type RadioGroupKeyHandlers = {
	/** 当前项在组内的下标 */
	index: number;
	/** 组内项数 */
	count: number;
	/** 命中方向键时回调目标下标（环绕后的结果），由调用方移动焦点并选中 */
	onMove: (targetIndex: number) => void;
};

/** 方向键 → 目标下标；未处理返回 null。ArrowDown/ArrowUp 与左右等价（ARIA 允许两轴） */
export function radioGroupFocusTarget(key: string, index: number, count: number): number | null {
	if (count <= 0) return null;
	switch (key) {
		case "ArrowRight":
		case "ArrowDown":
			return (index + 1) % count;
		case "ArrowLeft":
		case "ArrowUp":
			return (index - 1 + count) % count;
		case "Home":
			return 0;
		case "End":
			return count - 1;
		default:
			return null;
	}
}

/** 返回 true 表示已消费该事件（调用方无需再处理） */
export function handleRadioGroupKeys(event: RadioGroupKeyEvent, handlers: RadioGroupKeyHandlers): boolean {
	// 事件来自组内子元素（如色块里的图标）时交给子元素自己处理
	if (event.target !== event.currentTarget) return false;
	if (event.nativeEvent?.isComposing) return false;
	if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
	const target = radioGroupFocusTarget(event.key, handlers.index, handlers.count);
	if (target === null) return false;
	event.preventDefault();
	handlers.onMove(target);
	return true;
}

/**
 * roving tabindex：整组只留一个 Tab 停靠点。
 * `activeIndex` 为 null（尚未用键盘进入该组）时停靠在 `fallbackIndex`（通常是已选中项）。
 */
export function radioGroupTabIndex(index: number, activeIndex: number | null, fallbackIndex: number): 0 | -1 {
	const anchor = activeIndex ?? fallbackIndex;
	return index === anchor ? 0 : -1;
}
