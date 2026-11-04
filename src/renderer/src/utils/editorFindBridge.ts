/**
 * 文件面板 ↔ 编辑器的查找快捷键仲裁。
 *
 * 背景：抽屉文件面板自己占用了 Ctrl/Cmd+F（issue #215，打开文件名搜索），而用户从文件树点开
 * 一个文件后焦点仍停在树行上——此时按 Ctrl+F 得到的是「按文件名搜文件」，不是「在当前文件里
 * 查找」，用户感受就是「编辑器里根本没有搜索」。
 *
 * 规则：有文件在编辑器里打开时，Ctrl+F 归编辑器；没有编辑器可查时，面板保留自己的搜索语义。
 * 桥只做「有没有人接管」这一件事——不 import CodeMirror，避免把编辑器全家桶拉进主 chunk
 * （懒加载守卫见 tests/fileDiffPreview.test.mjs）。
 */

let handler: (() => boolean) | null = null;

/** 由 CodeMirrorEditor 在模块加载时登记；返回 false 表示当前没有可查找的编辑器实例。 */
export function setEditorFindHandler(next: (() => boolean) | null): void {
	handler = next;
}

/** 请求在活动编辑器里打开查找面板；true = 已接管，调用方应让出快捷键。 */
export function requestEditorFind(): boolean {
	return handler?.() ?? false;
}
