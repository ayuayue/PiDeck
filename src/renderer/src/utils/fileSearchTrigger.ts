/**
 * 文件面板「进入搜索」的按键判定（issue #215 补入口）。
 *
 * 背景：抽屉文件面板此前只有工具行上一个 6px 的放大镜图标作为搜索入口，面板本身既不响应
 * Ctrl/Cmd+F，也不能「直接敲字符开始搜索」；叠加 projectId 未接线导致按钮根本没渲染，
 * 用户完全找不到搜索。这里把「什么时候进入搜索」抽成与 React 无关的纯函数，便于单测兜住规则
 * （面板只负责转发事件）。
 */

/** 判定所需的最小按键形态：只取用到的字段，不依赖 DOM 类型，node 测试可直接构造对象 */
export type KeyLike = {
	key: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	/** IME 组字中（中文输入法敲第一个字母时 key 可能是 "Process" 或组字字符）——此时不劫持 */
	isComposing?: boolean;
};

/**
 * Ctrl+F / ⌘F：在面板内打开搜索视图（而不是让宿主弹出查找栏）。
 * 带 Alt 的组合键（如 macOS ⌘⌥F）交给系统/其他层，不在此列。
 */
export function isFileSearchShortcut(event: KeyLike): boolean {
	if (!(event.ctrlKey || event.metaKey)) return false;
	if (event.altKey) return false;
	return event.key.toLowerCase() === "f";
}

/**
 * 输入即搜索：无修饰键的单个可打印字符。
 * 空格排除（文件树里空格常用于翻页/展开，且几乎没人用空格开头搜文件名）；IME 组字中不劫持。
 */
export function isTypeToSearchKey(event: KeyLike): boolean {
	if (event.ctrlKey || event.metaKey || event.altKey) return false;
	if (event.isComposing) return false;
	return event.key.length === 1 && event.key !== " ";
}

/**
 * 事件目标是否为可编辑元素：输入框/文本域/下拉/contenteditable 内敲键不能被劫持成搜索。
 * 用鸭子类型而非 instanceof HTMLElement —— 该判定要能在没有 DOM 的 node 测试环境里直接跑。
 */
export function isEditableTarget(target: unknown): boolean {
	if (!target || typeof target !== "object") return false;
	const element = target as { tagName?: unknown; isContentEditable?: unknown };
	if (typeof element.tagName === "string") {
		const tag = element.tagName.toUpperCase();
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	}
	return element.isContentEditable === true;
}
