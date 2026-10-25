/**
 * TipTap Composer 编辑器实例注册：建议菜单坐标可从 ProseMirror coordsAtPos 取值，
 * 同时兼容旧 getRichInputCaretCoords(root, offset) 调用约定。
 *
 * 偏移换算必须与 composerDocToPlainText 的序列化规则逐字符对齐：文档里既有
 * plainTextCodec 生成的「单段落 + hardBreak」，也有 ProseMirror splitBlock 生成的
 * 「多段落」（发送快捷键不是 Enter 时按 Enter 换行）。漏算段落边界那个 \n 会让
 * 光标偏移比真实值小 1，把第二行判成首行，上键就会误触发历史回填。
 */

import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { COMPOSER_PARAGRAPH_SEPARATOR } from "./plainTextCodec";

const editorByDom = new WeakMap<HTMLElement, Editor>();

/**
 * 光标是否已在「视觉边界」：dir="up" 表示上方没有视觉行，dir="down" 表示下方没有。
 *
 * 复用 ProseMirror 自己的 endOfTextblock（按行盒 client rects 判定、自带 2 倍容差，
 * Chromium 上不会相信 collapsed range 的空 rect，PM 内部也用同一函数判断视觉顶部），
 * 因此不需要自写测量，也不受字体/缩放带来的像素抖动影响。
 *
 * 但**必须传入用 DOM 真实插入点构造的 state**：PM 的 state.selection 由 selectionchange
 * 异步同步，快速连按方向键（含长按重复）时比 DOM 真实光标落后一拍，
 * 而 endOfTextblock 读 state.selection —— 用滞后的位置判断会表现为
 * 「已经到首视觉行了还要多按一次才回填」（e2e 里复现并确认）。
 */
export function isComposerTipTapAtVisualEdge(editor: Editor, dir: "up" | "down"): boolean {
	const view = editor.view;
	syncSelectionFromDom(view);
	return view.endOfTextblock(dir);
}

/**
 * 把 DOM 里的真实插入点同步进 PM state。
 *
 * 必须同步而不能直接把临时 state 传给 endOfTextblock：PM 的 withFlushedState 会
 * 临时 view.updateState(我们传的 state)、量完再 updateState 回去，那两次更新会把
 * DOM 选区写回旧位置 —— 实测表现为连续按 ↑ 时先能上移几行，然后光标被钉住不再动。
 * 这里改成派发一次真实的选区事务：与 PM 自己收到 selectionchange 时做的事一致，
 * 不会和浏览器抢光标，也不会进 undo 历史（选区变更不计入历史）。
 */
function syncSelectionFromDom(view: EditorView): void {
	try {
		// 用 window.getSelection() 而不是 view.domSelectionRange()：后者是 PM 内部 API，不在公开类型里。
		const selection = window.getSelection();
		const node = selection?.focusNode;
		// 非折叠选区（选中文本/节点）不参与边界判定：调用方本来就会放行这类按键。
		if (!selection || !node || !selection.isCollapsed) return;
		const pos = view.posAtDOM(node, selection.focusOffset);
		if (pos < 0 || pos > view.state.doc.content.size) return;
		if (pos === view.state.selection.from) return;
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
	} catch {
		// 选区不在编辑器内（或节点无法映射）：保持现状，交给 endOfTextblock 用当前 state 判断
	}
}

export function registerComposerTipTapEditor(dom: HTMLElement, editor: Editor | null): void {
	if (editor) editorByDom.set(dom, editor);
	else editorByDom.delete(dom);
}

export function resolveComposerTipTapEditor(root: HTMLElement | null): Editor | null {
	if (!root) return null;
	const direct = editorByDom.get(root);
	if (direct) return direct;
	const pm = root.classList.contains("ProseMirror") ? root : root.querySelector<HTMLElement>(".ProseMirror");
	if (pm) {
		const fromPm = editorByDom.get(pm);
		if (fromPm) return fromPm;
	}
	return null;
}

/** plain-text 偏移 → ProseMirror 文档位置（单段 hardBreak 与多段落两种文档形状都覆盖）。 */
export function plainOffsetToPos(editor: Editor, plainOffset: number): number {
	const doc = editor.state.doc;
	let remaining = Math.max(0, plainOffset);
	let pos = 0;
	let paragraphCount = 0;
	let found = false;
	doc.descendants((node, nodePos) => {
		if (found) return false;
		if (node.type.name === "paragraph") {
			// 非首段前面有一个段落分隔符（与 composerDocToPlainText 同规则）
			const firstParagraph = paragraphCount === 0;
			paragraphCount += 1;
			if (!firstParagraph && remaining > 0) remaining -= COMPOSER_PARAGRAPH_SEPARATOR.length;
			if (remaining === 0) {
				// 偏移落在段落边界上：贴到本段内容起点（空段落也必须是段内位置）
				pos = nodePos + 1;
				found = true;
				return false;
			}
			return true;
		}
		if (node.isText) {
			const len = node.text?.length ?? 0;
			if (remaining <= len) {
				pos = nodePos + remaining;
				found = true;
				return false;
			}
			remaining -= len;
			return true;
		}
		if (node.type.name === "hardBreak") {
			if (remaining === 0) {
				pos = nodePos;
				found = true;
				return false;
			}
			remaining -= 1;
			return true;
		}
		if (node.type.name === "mentionChip") {
			const rawLen = String(node.attrs.raw ?? "").length;
			if (remaining < rawLen) {
				// 落在 chip 内：贴到 chip 前
				pos = nodePos;
				found = true;
				return false;
			}
			if (remaining === rawLen) {
				pos = nodePos + node.nodeSize;
				found = true;
				return false;
			}
			remaining -= rawLen;
			return true;
		}
		return true;
	});
	// 偏移走到文末（例如草稿以 hardBreak 结尾）时没有节点可匹配：光标必须停在最后一个
	// 块的内容末尾，doc.content.size 是块外位置，setTextSelection 会拿到非法选区。
	if (!found) pos = Math.max(0, doc.content.size - 1);
	return pos;
}

export function posToPlainOffset(editor: Editor, pos: number): number {
	const doc = editor.state.doc;
	let offset = 0;
	let paragraphCount = 0;
	let done = false;
	doc.descendants((node, nodePos) => {
		if (done) return false;
		// 段落起始位置本身也要计入（nodePos === pos 时是段落内容起点），
		// 否则第二段的光标会落在换行之前。
		if (nodePos > pos) {
			done = true;
			return false;
		}
		if (node.type.name === "paragraph") {
			if (paragraphCount++ > 0) offset += COMPOSER_PARAGRAPH_SEPARATOR.length;
			return true;
		}
		if (node.isText) {
			const len = node.text?.length ?? 0;
			const end = nodePos + len;
			if (pos <= end) {
				offset += pos - nodePos;
				done = true;
				return false;
			}
			offset += len;
			return true;
		}
		if (node.type.name === "hardBreak") {
			if (pos <= nodePos) {
				done = true;
				return false;
			}
			offset += 1;
			return true;
		}
		if (node.type.name === "mentionChip") {
			const rawLen = String(node.attrs.raw ?? "").length;
			const end = nodePos + node.nodeSize;
			if (pos < end) {
				done = true;
				return false;
			}
			offset += rawLen;
			return true;
		}
		return true;
	});
	return offset;
}

export function getTipTapComposerCaretCoords(editor: Editor, plainOffset: number): { top: number; left: number; bottom: number } | null {
	try {
		const pos = plainOffsetToPos(editor, plainOffset);
		const coords = editor.view.coordsAtPos(pos);
		return { top: coords.top, left: coords.left, bottom: coords.bottom };
	} catch {
		return null;
	}
}
