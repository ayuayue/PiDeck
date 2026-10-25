/**
 * Composer 建议菜单锚点 / 光标偏移。
 * TipTap 走 ProseMirror；找不到编辑器时退回容器矩形 / 0。
 * 不依赖 RichInput，不向 controller 暴露 TipTap 类型。
 */

import { getTipTapComposerCaretCoords, isComposerTipTapAtVisualEdge, posToPlainOffset, resolveComposerTipTapEditor } from "./tiptap/caretBridge";

export function getComposerCaretCoords(root: HTMLElement, plainOffset: number): { top: number; left: number } {
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

/**
 * 光标是否已在「视觉边界」：dir="up" 表示光标上方没有视觉行，dir="down" 表示下方没有。
 *
 * 业务背景：历史回填只在首/末**视觉**行触发。软换行（一行超长文本折成多个视觉行）下
 * 逻辑行判定会把视觉第 2 行当成首行，按 ↑ 不回退光标而是直接回填历史，用户无法逐行上移。
 *
 * 注意底层只考察**光标所在 block**（段落）内部的行盒：光标在第 2 段第一视觉行时同样返回 true，
 * 必须与「光标是不是在文档首/末块」相与（见 getComposerCaretBlockEdge），才是「整个编辑器里上方无路可走」。
 *
 * fail-closed：编辑器缺失/已销毁/测量抛错时一律返回 false（不抢键）。
 * 宁可少一次回填，也不要把用户正在写的草稿换成历史消息。
 */
export function isComposerAtVisualEdge(root: HTMLElement | null, dir: "up" | "down"): boolean {
	const editor = resolveComposerTipTapEditor(root);
	if (!editor || editor.isDestroyed) return false;
	try {
		return isComposerTipTapAtVisualEdge(editor, dir);
	} catch {
		return false;
	}
}

/** fail-closed 返回值：不在块边界（共用一个冻结对象，调用方只读）。 */
const NOT_AT_BLOCK_EDGE = Object.freeze({ atFirstBlock: false, atLastBlock: false });

/**
 * 光标所在的**顶层块**是不是文档的第一个/最后一个块。
 *
 * 为什么不用草稿字符串：草稿 atom 在 IME 合成结束后的一帧内可能还没同步
 * （合成期 onUpdate 被跳过，结束才由 rAF 补发），拿滞后的文本算「有没有上一行」
 * 会得出错误结论。ProseMirror state 是权威且即时的，且不受软换行影响。
 *
 * 与 isComposerAtVisualEdge 配合使用：atFirstBlock 回答「是不是首块」，
 * atVisualTop 回答「块内上方还有没有视觉行」，两者相与才是「整个编辑器里上方无路可走」。
 *
 * fail-closed：编辑器缺失/已销毁/处于非常态位置（depth 0，如全选或 gap cursor）时
 * 一律返回 false（不抢键）。
 */
export function getComposerCaretBlockEdge(root: HTMLElement | null): { atFirstBlock: boolean; atLastBlock: boolean } {
	const editor = resolveComposerTipTapEditor(root);
	if (!editor || editor.isDestroyed) return NOT_AT_BLOCK_EDGE;
	try {
		const { selection, doc } = editor.state;
		const { $from } = selection;
		// depth < 1 取不到顶层块边界（全选/gap cursor 等非常态），视为不在边界。
		if ($from.depth < 1) return NOT_AT_BLOCK_EDGE;
		return {
			atFirstBlock: $from.before(1) === 0,
			atLastBlock: $from.after(1) === doc.content.size,
		};
	} catch {
		return NOT_AT_BLOCK_EDGE;
	}
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
