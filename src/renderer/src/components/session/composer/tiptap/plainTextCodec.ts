/**
 * Composer TipTap：string ↔ ProseMirror doc 往返。
 * 换行有两种来源，序列化必须同时覆盖：
 * - 受控同步 / 粘贴写入的「单段落 + hardBreak」（Shift+Enter 也是 hardBreak）；
 * - 用户按 Enter 换行时 ProseMirror splitBlock 产生的「多段落」
 *   （发送快捷键设为 Ctrl/Cmd+Enter 或 Shift+Enter 时 Enter 不再是发送键，走这条路）。
 * 段落之间补一个 \n，与 caretBridge 的偏移换算共用同一规则。
 * mention 原子节点用 data-raw 还原。
 */

import type { JSONContent } from "@tiptap/core";
import { parseRichInputChips, type ComposerChip } from "../chips";

/** 段落之间的纯文本分隔符。caretBridge 的偏移换算必须与序列化同用这一个值。 */
export const COMPOSER_PARAGRAPH_SEPARATOR = "\n";

export type ComposerChipWhitelist = {
	validCommandNames?: Set<string>;
	validFilePaths?: Set<string>;
	validSessionRefs?: Set<string>;
	/** 引用 chip 白名单：id → 展示 label（截断后的快照预览）。 */
	validQuotes?: Map<string, string>;
};

function mentionNode(chip: ComposerChip): JSONContent {
	return {
		type: "mentionChip",
		attrs: {
			kind: chip.kind,
			raw: chip.raw,
			label: chip.label,
		},
	};
}

/** 将一行（不含 \\n）拆成 text + mention 内联节点。 */
function inlineNodesForLine(line: string, lineOffset: number, chips: ComposerChip[]): JSONContent[] {
	const lineChips = chips
		.filter((c) => c.start >= lineOffset && c.end <= lineOffset + line.length)
		.map((c) => ({
			...c,
			start: c.start - lineOffset,
			end: c.end - lineOffset,
		}));
	if (lineChips.length === 0) {
		return line.length > 0 ? [{ type: "text", text: line }] : [];
	}
	const nodes: JSONContent[] = [];
	let cursor = 0;
	for (const chip of lineChips) {
		if (chip.start > cursor) {
			nodes.push({ type: "text", text: line.slice(cursor, chip.start) });
		}
		nodes.push(mentionNode(chip));
		cursor = chip.end;
	}
	if (cursor < line.length) {
		nodes.push({ type: "text", text: line.slice(cursor) });
	}
	return nodes;
}

/** 纯字符串 → TipTap JSON（单 paragraph，换行用 hardBreak）。 */
export function plainTextToComposerDoc(text: string, whitelist: ComposerChipWhitelist = {}): JSONContent {
	const chips = parseRichInputChips(text, whitelist.validCommandNames, whitelist.validFilePaths, whitelist.validSessionRefs, whitelist.validQuotes);
	const lines = text.split("\n");
	const content: JSONContent[] = [];
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (i > 0) content.push({ type: "hardBreak" });
		content.push(...inlineNodesForLine(line, offset, chips));
		offset += line.length + 1; // +1 for the split \n
	}
	return {
		type: "doc",
		content: [
			{
				type: "paragraph",
				content: content.length > 0 ? content : undefined,
			},
		],
	};
}

/** TipTap JSON / 节点 → 纯字符串（发信 / draft 真相）。 */
export function composerDocToPlainText(doc: JSONContent): string {
	const parts: string[] = [];
	// 段落计数：只有第一个段落不补分隔符，空段落也必须补——否则用户敲的空行
	// 会在发送时被静默吞掉，且草稿行号会与编辑器里的行错位。
	let paragraphCount = 0;
	const walk = (node: JSONContent): void => {
		if (node.type === "text" && typeof node.text === "string") {
			parts.push(node.text);
			return;
		}
		if (node.type === "hardBreak") {
			parts.push("\n");
			return;
		}
		if (node.type === "mentionChip") {
			const raw = node.attrs?.raw;
			if (typeof raw === "string") parts.push(raw);
			return;
		}
		if (node.type === "paragraph") {
			if (paragraphCount++ > 0) parts.push(COMPOSER_PARAGRAPH_SEPARATOR);
			node.content?.forEach(walk);
			return;
		}
		node.content?.forEach(walk);
	};
	walk(doc);
	return parts.join("");
}

/** 从 Editor storage / getJSON 得到的 doc 序列化。 */
export function serializeComposerEditorJson(json: JSONContent): string {
	return composerDocToPlainText(json);
}
