/**
 * 行菜单（文件树右键菜单）关闭后要不要把焦点还给「打开它的那个元素」。
 *
 * 背景：菜单是受控打开、没有真实 Trigger——Radix 的坐标菜单模式在 Trigger 位置钉一个
 * 0×0、`aria-hidden` 的占位元素（见 ComposerOverlayComponents.FileContextMenu 的注释），
 * Radix 关闭时会把焦点还给那个触发器，于是键盘用户按 Esc 后焦点落在一个不可见元素上，
 * 紧接着的 Tab 从文档头开始。这里改为还给打开菜单的行。
 *
 * 不抢焦点的情况：菜单项被选中后打开了对话框等新焦点目标（此时焦点已被接管），
 * 硬把焦点拉回行会让对话框的输入框失去焦点。
 */
export type MenuFocusReturnInput = {
	/** 打开菜单那一刻持有焦点的元素（键盘流程里就是文件树行） */
	opener: { isConnected: boolean; focus: () => void } | null;
	/** 关闭菜单那一刻的 document.activeElement */
	activeElement: { tagName?: string; closest?: (selector: string) => Element | null } | null;
};

export function shouldRestoreMenuFocus(input: MenuFocusReturnInput): boolean {
	const { opener, activeElement } = input;
	// 行可能已经随树重渲被卸载（远端树刷新）：聚焦已卸载的元素是空操作，先判掉
	if (!opener || !opener.isConnected) return false;
	if (!activeElement) return true;
	// 没有任何元素持有焦点（Radix 把焦点还给已卸载的隐藏触发器后就会落到 body）→ 还给行
	if (activeElement.tagName === "BODY") return true;
	// 焦点还在（正在关闭的）菜单里：没有别的元素接手 → 还给行
	if (typeof activeElement.closest === "function" && activeElement.closest('[role="menu"]') !== null) return true;
	// 焦点已被对话框等接管 → 不抢
	return false;
}
