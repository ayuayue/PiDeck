/**
 * Composer 建议菜单锚点 / 光标偏移。
 * TipTap 走 ProseMirror；找不到编辑器时退回容器矩形 / 0。
 * 不依赖 RichInput，不向 controller 暴露 TipTap 类型。
 */

import {
	getTipTapComposerCaretCoords,
	posToPlainOffset,
	resolveComposerTipTapEditor,
} from "./tiptap/caretBridge";

export function getComposerCaretCoords(
	root: HTMLElement,
	plainOffset: number,
): { top: number; left: number } {
	const editor = resolveComposerTipTapEditor(root);
	if (editor) {
		const coords = getTipTapComposerCaretCoords(editor, plainOffset);
		if (coords) return { top: coords.top, left: coords.left };
	}
	const rect = root.getBoundingClientRect();
	return { top: rect.top, left: rect.left };
}

/** 当前选区在纯文本模型中的偏移（与 draft string 对齐）。 */
export function getComposerCaretOffset(root: HTMLElement): number {
	const editor = resolveComposerTipTapEditor(root);
	if (!editor) return 0;
	return posToPlainOffset(editor, editor.state.selection.from);
}

/** Current selection range in the same plain-text offsets as the draft. */
export function getComposerSelectionRange(root: HTMLElement): { from: number; to: number } {
	const editor = resolveComposerTipTapEditor(root);
	if (!editor) return { from: 0, to: 0 };
	const { from, to } = editor.state.selection;
	return {
		from: posToPlainOffset(editor, from),
		to: posToPlainOffset(editor, to),
	};
}
