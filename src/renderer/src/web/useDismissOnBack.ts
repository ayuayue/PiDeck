import { useEffect, useRef } from "react";

const MARKER = "__pideckDismiss";

/**
 * 移动端覆盖层（全屏预览/抽屉）的系统返回关闭：
 * - 打开时压一条历史记录，popstate（Android 返回键/全面屏手势、浏览器返回、iOS 侧滑）即触发 onClose；
 * - 主动关闭（点 X/遮罩）时在清理里回退该记录，保证历史栈干净——用户按系统返回不会「又回到预览」。
 * 同时监听 Escape（平板/桌面浏览器带键盘的场景）。iOS PWA standalone 无返回手势，靠放大后的 X 按钮兜底。
 *
 * 多层覆盖层（抽屉→预览）各压一条记录，系统返回按后进先出逐层关闭。
 */
export function useDismissOnBack(onClose: () => void, active: boolean) {
	// onClose 用 ref 快照，避免调用方传内联箭头函数导致 effect 重跑、重复压栈
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		if (!active) return;
		history.pushState({ [MARKER]: true }, "");
		const onPop = () => onCloseRef.current();
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onCloseRef.current();
		};
		window.addEventListener("popstate", onPop);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("popstate", onPop);
			window.removeEventListener("keydown", onKey);
			// 浏览器已自行回退（popstate 路径）时 state 不再带 marker，避免二次 back 越过用户真实历史
			if ((history.state as Record<string, unknown> | null)?.[MARKER]) history.back();
		};
	}, [active]);
}
