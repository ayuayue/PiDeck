/**
 * Tab 本体的键盘激活键（会话 Tab / 文件 Tab / 插件伪 Tab / 页面式 Tab 共用）。
 *
 * 契约：
 * - 只处理落在 Tab 本体上的按键：关闭钮等子元素的事件不冒泡进来（否则 Enter 会先被
 *   `preventDefault` 掉，浏览器的原生 click 被取消 → 关闭钮「回车没反应、反而选中了 Tab」）。
 * - 输入法组合中、带 alt/ctrl/meta/shift 的组合键不拦截（留给宿主快捷键）。
 * - Enter/Space 选中；Delete 关闭（不可关闭的 Tab 不吞事件，交给浏览器默认行为）。
 *
 * 返回 true 表示已处理（单测据此断言，组件不依赖返回值）。
 */
type TabActivationEvent = {
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

export function handleTabActivationKeys(event: TabActivationEvent, options: { canClose: boolean; onSelect: () => void; onClose: () => void }): boolean {
	if (event.target !== event.currentTarget) return false;
	if (event.nativeEvent?.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault();
		options.onSelect();
		return true;
	}
	if (event.key === "Delete" && options.canClose) {
		event.preventDefault();
		options.onClose();
		return true;
	}
	return false;
}

/**
 * Tab 关闭钮要吞掉的键：它们在按钮上会走原生 click（Enter/Space 触发 click），
 * 必须拦住冒泡，否则外层 Tab 的 Enter 处理会先 preventDefault，原生 click 被取消。
 */
export function isTabCloseActivationKey(key: string): boolean {
	return key === "Enter" || key === " ";
}
