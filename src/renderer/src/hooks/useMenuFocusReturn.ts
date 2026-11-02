import { useEffect, useRef } from "react";
import { shouldRestoreMenuFocus } from "../utils/menuFocusReturn";

/**
 * 行菜单关闭后把焦点还给打开它的元素（背景说明见 utils/menuFocusReturn.ts）。
 *
 * 用法：把返回值挂到 Radix 菜单的 `onCloseAutoFocus` 上。
 *
 * 时序（必须照抄这个顺序，否则焦点还是会掉到 body）：Radix 的 DropdownMenuContent 会先跑
 * `props.onCloseAutoFocus`（= 本函数），紧接着**同步**执行自己的 `context.triggerRef.current?.focus()`
 * （node_modules/@radix-ui/react-dropdown-menu/dist/index.mjs:114-118）。而坐标菜单的触发器是
 * 菜单一起挂载/卸载的 0×0 占位元素，所以那次聚焦要么被忽略、要么随卸载一起失效，
 * 最终 `document.activeElement` 是 body。因此这里把归还动作排到本帧之后，
 * 并在真正聚焦前重新确认焦点没被别的元素接手。
 */
export function useMenuFocusReturn(): (event: { preventDefault: () => void }) => void {
	const openerRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		// 菜单挂载那一刻的焦点持有者就是打开者：键盘流程是文件树行；鼠标右键流程里
		// Chromium 也会先把行聚焦。菜单每次打开都重新挂载，所以捕获一次就够。
		const active = document.activeElement;
		openerRef.current = active instanceof HTMLElement ? active : null;
	}, []);
	return (event: { preventDefault: () => void }) => {
		// 挡掉 Radix 之后那次「还给隐藏触发器」的聚焦
		event.preventDefault();
		const opener = openerRef.current;
		requestAnimationFrame(() => {
			if (shouldRestoreMenuFocus({ opener, activeElement: document.activeElement })) opener?.focus();
		});
	};
}
