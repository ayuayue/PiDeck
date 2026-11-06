import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { filterIndexedRows } = loadTsCommonJs("src/renderer/src/utils/configListSearch.ts");

// loadTsCommonJs 在独立 VM realm 执行，跨 realm 对象原型不同，比较前统一 JSON 归一化。
const json = (value) => JSON.stringify(value);

const rows = [
	{ id: "anthropic", name: "Claude" },
	{ id: "google", name: "Gemini" },
	{ id: "deepseek", name: "DeepSeek-V3" },
];
const partsOf = (row) => [row.id, row.name];
const ids = (matches) => matches.map((entry) => entry.row.id);

test("filterIndexedRows：空关键词返回全部行，顺序与下标不变", () => {
	for (const query of ["", "   ", "\t"]) {
		const matches = filterIndexedRows(rows, query, partsOf);
		assert.deepEqual(json(ids(matches)), json(["anthropic", "google", "deepseek"]), query || "<empty>");
		assert.deepEqual(json(matches.map((entry) => entry.index)), json([0, 1, 2]), query || "<empty>");
	}
});

test("filterIndexedRows：命中任一字段、大小写不敏感、忽略首尾空白", () => {
	assert.deepEqual(json(ids(filterIndexedRows(rows, "GEM", partsOf))), json(["google"]));
	assert.deepEqual(json(ids(filterIndexedRows(rows, "  claude ", partsOf))), json(["anthropic"]));
	// 子串匹配：deepseek-v3 的 id 与名称都能命中
	assert.deepEqual(json(ids(filterIndexedRows(rows, "v3", partsOf))), json(["deepseek"]));
});

test("filterIndexedRows：过滤后保留原始下标（组件按下标回写行内编辑）", () => {
	const matches = filterIndexedRows(rows, "deepseek", partsOf);
	assert.equal(matches.length, 1);
	assert.equal(matches[0].index, 2);
	assert.equal(matches[0].row.name, "DeepSeek-V3");
});

test("filterIndexedRows：无命中返回空数组，undefined / null 片段不参与匹配也不报错", () => {
	assert.deepEqual(json(filterIndexedRows(rows, "mistral", partsOf)), json([]));
	const sparse = [
		{ id: undefined, name: null },
		{ id: "openai", name: undefined },
	];
	assert.deepEqual(json(filterIndexedRows(sparse, "openai", (row) => [row.id, row.name]).map((entry) => entry.index)), json([1]));
	assert.deepEqual(json(filterIndexedRows(sparse, "undefined", (row) => [row.id, row.name])), json([]));
});

test("filterIndexedRows：不修改入参", () => {
	const copy = JSON.parse(JSON.stringify(rows));
	filterIndexedRows(rows, "google", partsOf);
	assert.deepEqual(json(rows), json(copy));
});
