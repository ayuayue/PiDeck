/**
 * Composer 纯文本粘贴：把剪贴板字符串拆成 text + hardBreak，
 * 不走 TipTap 的 HTML 解析，避免 &amp; / mention 标签把正文搅乱。
 */

import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";

export type ComposerPlainInsertStep = { type: "text"; text: string } | { type: "hardBreak" };

/**
 * 将任意剪贴板纯文本规范成编辑器可插入的步骤。
 * Windows \r\n 收成 \n；空行保留为连续 hardBreak（与 plainTextCodec 一致）。
 */
export function composerPlainTextInsertSteps(text: string): ComposerPlainInsertStep[] {
	const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const steps: ComposerPlainInsertStep[] = [];
	for (let i = 0; i < parts.length; i++) {
		if (i > 0) steps.push({ type: "hardBreak" });
		if (parts[i]) steps.push({ type: "text", text: parts[i] });
	}
	return steps;
}

/** 在当前选区插入纯文本（替换选区，光标落在插入末尾）。 */
export function insertComposerPlainText(view: EditorView, text: string): void {
	const steps = composerPlainTextInsertSteps(text);
	const { from, to } = view.state.selection;
	let tr = view.state.tr.delete(from, to);
	let pos = from;
	const hardBreak = view.state.schema.nodes.hardBreak;
	for (const step of steps) {
		if (step.type === "hardBreak") {
			if (hardBreak) {
				tr = tr.insert(pos, hardBreak.create());
				pos += 1;
			}
			continue;
		}
		tr = tr.insertText(step.text, pos);
		pos += step.text.length;
	}
	view.dispatch(tr.scrollIntoView());
}

/** 右键菜单等只有 Editor 实例时的入口。 */
export function insertComposerPlainTextFromEditor(editor: Editor, text: string): void {
	if (!text || editor.isDestroyed) return;
	insertComposerPlainText(editor.view, text);
}
