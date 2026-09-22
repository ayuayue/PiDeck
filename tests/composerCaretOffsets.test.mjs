import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);
// 用真实 prosemirror-model 构造文档，位置运算与运行时完全同源，避免自建假 doc 漂移。
const { Schema } = require("@tiptap/pm/model");

const codec = loadTsCommonJs("src/renderer/src/components/session/composer/tiptap/plainTextCodec.ts");
const bridge = loadTsCommonJs("src/renderer/src/components/session/composer/tiptap/caretBridge.ts");

const composerSchema = new Schema({
	nodes: {
		doc: { content: "block+" },
		paragraph: { content: "inline*", group: "block" },
		text: { group: "inline" },
		hardBreak: { inline: true, group: "inline", selectable: false },
	},
});

/** caretBridge 只用 editor.state.doc，不需要真实 Editor 实例。 */
const editorOf = (doc) => ({ state: { doc } });
const docFromJson = (json) => composerSchema.nodeFromJSON(json);
const paragraph = (text) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : undefined });

/**
 * 复现（用户反馈）：把「发送快捷键」设成 Ctrl/Cmd+Enter 或 Shift+Enter 后，
 * 按 Enter 换行走的是 ProseMirror 默认 splitBlock —— 文档变成多段落，
 * 而不是 plainTextCodec 假设的「单段落 + hardBreak」。
 * caretBridge 的偏移换算漏算段落边界那一个 \n，光标偏移比真实值小 1，
 * 第二行的光标因此被判成「首行」，上键不回退光标而是回填上一条历史消息。
 */
test("caret on the second paragraph is not treated as the first line", () => {
	// 用户输入 "hello" 后按 Enter：文档 = [段落 hello, 空段落]
	const doc = docFromJson({ type: "doc", content: [paragraph("hello"), paragraph("")] });
	const text = codec.composerDocToPlainText(doc.toJSON());
	assert.equal(text, "hello\n");

	// 空段落内容起点：段落 1 nodeSize 7 → 第二段内容起点 8
	const caretPos = 8;
	const offset = bridge.posToPlainOffset(editorOf(doc), caretPos);
	// 判据是「偏移落在换行之后」：漏算段落分隔符时偏移会停在换行之前（长度 5），
	// 第二行就会被当成首行，↑ 不回退光标而是回填历史消息。
	assert.equal(offset, text.length, "第二行光标偏移必须落在换行之后");
	assert.equal(text[offset - 1], "\n");
});

test("caret on a paragraph after a hardBreak keeps history navigation on the first line only", () => {
	// 混合形状：Shift+Enter 产生的 hardBreak 与 Enter 产生的段落并存
	const doc = docFromJson({
		type: "doc",
		content: [{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] }, paragraph("c")],
	});
	const text = codec.composerDocToPlainText(doc.toJSON());
	assert.equal(text, "a\nb\nc");

	// 第二行（hardBreak 之后）的偏移必须落在 hardBreak 那个 \n 之后
	const hardBreakLineOffset = text.indexOf("b");
	assert.equal(hardBreakLineOffset, 2);
	assert.equal(text[hardBreakLineOffset - 1], "\n");
	// 第三行（新段落）在纯文本里偏移 4，且双向换算一致
	const thirdLineOffset = text.indexOf("c");
	assert.equal(thirdLineOffset, 4);
	assert.equal(text[thirdLineOffset - 1], "\n");
	const editor = editorOf(doc);
	assert.equal(bridge.posToPlainOffset(editor, bridge.plainOffsetToPos(editor, thirdLineOffset)), thirdLineOffset);
});

test("plain offset and ProseMirror position roundtrip for every caret slot", () => {
	const samples = [
		// 单段落 + hardBreak（历史回填 / 粘贴 / 受控同步的形状）
		codec.plainTextToComposerDoc("hello\nworld"),
		codec.plainTextToComposerDoc("line\n"),
		codec.plainTextToComposerDoc(""),
		// 多段落（Enter 换行）
		{ type: "doc", content: [paragraph("hello"), paragraph("")] },
		{ type: "doc", content: [paragraph("a"), paragraph("b")] },
		{ type: "doc", content: [paragraph("a"), paragraph(""), paragraph("b")] },
	];

	for (const json of samples) {
		const doc = docFromJson(json);
		const text = codec.composerDocToPlainText(json);
		const editor = editorOf(doc);
		for (let offset = 0; offset <= text.length; offset++) {
			const pos = bridge.plainOffsetToPos(editor, offset);
			assert.equal(bridge.posToPlainOffset(editor, pos), offset, `offset ${offset} of ${JSON.stringify(text)}`);
		}
	}
});

test("empty paragraphs survive serialization instead of being silently collapsed", () => {
	// 用户敲的空行必须在草稿里保留，否则发送时被吞掉、行号也会与光标错位。
	const doc = docFromJson({ type: "doc", content: [paragraph("a"), paragraph(""), paragraph("b")] });
	assert.equal(codec.composerDocToPlainText(doc.toJSON()), "a\n\nb");
});
