import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { MAX_QUICK_MESSAGES, MAX_QUICK_MESSAGE_LENGTH } = loadTsCommonJs("src/shared/quickMessages.ts");
// 测生产策略而非复制算法：合并不应拿 normalize 的结果覆盖仍在输入的个人草稿。
const { appendMissingQuickMessages, reorderQuickMessages } = loadTsCommonJs("src/renderer/src/utils/quickMessageEditorModel.ts");

test("补充内置：只在个人顺序之后追加缺项，去重忽略首尾空白与大小写", () => {
	const rows = ["自用 B", "  ReView  ", "自用 A"];
	const defaults = ["自用 A", "review", " 新条目 ", "新条目", "最后一条"];
	assert.deepEqual(Array.from(appendMissingQuickMessages(rows, defaults)), ["自用 B", "  ReView  ", "自用 A", "新条目", "最后一条"]);
	assert.deepEqual(rows, ["自用 B", "  ReView  ", "自用 A"], "不能清洗或重排个人草稿");
	assert.deepEqual(defaults, ["自用 A", "review", " 新条目 ", "新条目", "最后一条"]);
});

test("补充内置：截断后相同的文本视为重复，与实际落盘规则一致", () => {
	const long = "字".repeat(MAX_QUICK_MESSAGE_LENGTH);
	assert.deepEqual(Array.from(appendMissingQuickMessages([`${long}个人尾部`], [`${long}内置尾部`, "新增"])), [`${long}个人尾部`, "新增"]);
});

test("补充内置：空行和重复行是编辑中间态，保留原文且占用条数预算", () => {
	const rows = ["", "  ", "Review", "review", ...Array.from({ length: MAX_QUICK_MESSAGES - 5 }, (_, i) => `个人 ${i}`)];
	assert.deepEqual(Array.from(appendMissingQuickMessages(rows, ["review", "新增一", "新增二"])), [...rows, "新增一"]);
});

test("补充内置：已有项、空清单及满额均不产生改动；不能为内置条目挤掉个人条目", () => {
	const rows = Array.from({ length: MAX_QUICK_MESSAGES }, (_, i) => `个人 ${i}`);
	assert.equal(appendMissingQuickMessages(rows, ["内置新增"]), rows);
	const short = ["Review"];
	assert.equal(appendMissingQuickMessages(short, [" review "]), short);
	assert.equal(appendMissingQuickMessages(short, []), short);
	assert.deepEqual(
		Array.from(
			appendMissingQuickMessages(
				[],
				Array.from({ length: 40 }, (_, i) => `默认 ${i}`),
			),
		),
		Array.from({ length: MAX_QUICK_MESSAGES }, (_, i) => `默认 ${i}`),
	);
});

test("拖动排序：按目标最终位置移动，双向均保持其余行的相对顺序和原始文本", () => {
	const rows = ["  草稿  ", "", "C", "D"];
	assert.deepEqual(Array.from(reorderQuickMessages(rows, 0, 3)), ["", "C", "D", "  草稿  "]);
	assert.deepEqual(Array.from(reorderQuickMessages(rows, 3, 0)), ["D", "  草稿  ", "", "C"]);
	assert.deepEqual(rows, ["  草稿  ", "", "C", "D"]);
});

test("拖动排序：无效来源、越界目标、非整数及原地放下均保持原数组", () => {
	const rows = ["A", "B", "C"];
	for (const invalid of [-1, rows.length, 0.5, Number.NaN, Infinity]) {
		assert.equal(reorderQuickMessages(rows, invalid, 1), rows);
		assert.equal(reorderQuickMessages(rows, 1, invalid), rows);
	}
	assert.equal(reorderQuickMessages(rows, 1, 1), rows);
	const empty = [];
	assert.equal(reorderQuickMessages(empty, 0, 0), empty);
});
