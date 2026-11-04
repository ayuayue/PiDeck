/**
 * 编辑器「查找」的全局快捷键判定（Ctrl/Cmd+F）。
 *
 * 背景：CodeMirror 自带的 searchKeymap 只在编辑器持有 DOM 焦点时才跑。从文件树、标签栏
 * 或会话里的文件链接打开文件后，焦点仍停在原处，Ctrl+F 既进不了编辑器 keymap，也没有
 * 别的监听者（窗口没有原生菜单，Electron 也不提供内置查找栏），表现就是「按了完全没反应」。
 * 这里把「该不该由编辑器兜底接管」抽成与 React 无关的纯函数，便于单测兜住规则。
 */

/** 判定所需的最小按键形态：不依赖 DOM 类型，node 测试可直接构造对象 */
export type FindKeyLike = {
	key: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	/** 上游（编辑器自身 keymap / 文件面板搜索）已处理过的按键不再重复接管 */
	defaultPrevented?: boolean;
};

/** Ctrl+F / ⌘F：把查找面板拉到最近活动的编辑器上。带 Alt 的组合键交给系统，不在此列。 */
export function isEditorFindShortcut(event: FindKeyLike): boolean {
	if (event.defaultPrevented) return false;
	if (!(event.ctrlKey || event.metaKey)) return false;
	if (event.altKey) return false;
	return event.key.toLowerCase() === "f";
}
