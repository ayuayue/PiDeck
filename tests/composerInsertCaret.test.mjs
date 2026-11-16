import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveInsertCaret } = loadTsCommonJs("src/renderer/src/components/session/composer/insertCaret.ts");

/** #564：连续拖入文件时，第二次插入按过期的 DOM 选区拼接，把第一次的引用挤掉。 */
test("a pending programmatic caret wins over a stale DOM selection", () => {
	// 第一次 drop：草稿从 "" 变成 "@A"，编辑器还没跑 layout pass，DOM 选区仍是 0。
	const afterFirst = "@A";
	const first = resolveInsertCaret({ pending: { pos: 2, forValue: afterFirst }, liveDraft: afterFirst, domCaret: 0, fallback: 0 });
	assert.equal(first, 2);
	// 第二次 drop 在这个窗口里到达：按 2 拼接得到 "@A @B"，而不是被覆盖成 "@B"。
	const next = afterFirst.slice(0, first) + " " + "@B" + afterFirst.slice(first);
	assert.equal(next, "@A @B");
});

test("a stale request is not trusted: DOM caret, then the controlled cursor", () => {
	// forValue 与当前草稿不一致 = 过期请求（编辑器已丢弃），不能拿它的 pos 去拼。
	assert.equal(resolveInsertCaret({ pending: { pos: 9, forValue: "旧草稿" }, liveDraft: "新草稿", domCaret: 3, fallback: 7 }), 3);
	assert.equal(resolveInsertCaret({ pending: null, liveDraft: "abc", domCaret: 1, fallback: 2 }), 1);
	// 编辑器未挂载（草稿态/引导页）：退回受控 cursor。
	assert.equal(resolveInsertCaret({ pending: null, liveDraft: "abc", domCaret: null, fallback: 2 }), 2);
});
