import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveInsertCaret, insertFileReferences } = loadTsCommonJs("src/renderer/src/components/session/composer/insertCaret.ts");
const { formatFilePathRef } = loadTsCommonJs("src/renderer/src/components/session/composer/chips.ts");
const { plainTextToComposerDoc, composerDocToPlainText } = loadTsCommonJs("src/renderer/src/components/session/composer/tiptap/plainTextCodec.ts");

/** #564：第二次拖放时，DOM 选区可能还停在第一次更新之前。 */
test("consecutive drops use the pending caret instead of a stale DOM selection", () => {
	const refs = ["/tmp/a.txt", "/tmp/b notes.md", "/tmp/c.txt"].map((path) => formatFilePathRef(path, { alwaysQuote: true }));
	const first = insertFileReferences("", 0, refs.slice(0, 2));
	const caret = resolveInsertCaret({ pending: first, liveDraft: first.forValue, domCaret: 0, fallback: 0 });
	const next = insertFileReferences(first.forValue, caret, refs.slice(2));
	const text = next.forValue.slice(0, next.pos) + "对比 docs/summary.md" + next.forValue.slice(next.pos);
	const doc = plainTextToComposerDoc(text, { validFilePaths: new Set() });
	const nodes = doc.content[0].content;
	assert.deepEqual(
		Array.from(
			nodes.filter((node) => node.type === "mentionChip"),
			(node) => node.attrs.raw,
		),
		refs,
	);
	assert.equal(nodes.at(-1).text, " 对比 docs/summary.md");
	assert.equal(composerDocToPlainText(doc), refs.join(" ") + " 对比 docs/summary.md");
});

test("dropping into the middle of a draft preserves text on both sides and leaves a typing gap", () => {
	for (const [draft, caret] of [
		["前文后文", 2],
		["前文 后文", 2],
	]) {
		const next = insertFileReferences(draft, caret, ["@project/result.txt"]);
		assert.equal(next.forValue.slice(0, next.pos), "前文 @project/result.txt ");
		assert.equal(next.forValue.slice(next.pos), "后文");
	}
});

test("a stale request is not trusted: DOM caret, then the controlled cursor", () => {
	// forValue 与当前草稿不一致 = 过期请求（编辑器已丢弃），不能拿它的 pos 去拼。
	assert.equal(resolveInsertCaret({ pending: { pos: 9, forValue: "旧草稿" }, liveDraft: "新草稿", domCaret: 3, fallback: 7 }), 3);
	assert.equal(resolveInsertCaret({ pending: null, liveDraft: "abc", domCaret: 1, fallback: 2 }), 1);
	// 编辑器未挂载（草稿态/引导页）：退回受控 cursor。
	assert.equal(resolveInsertCaret({ pending: null, liveDraft: "abc", domCaret: null, fallback: 2 }), 2);
});
