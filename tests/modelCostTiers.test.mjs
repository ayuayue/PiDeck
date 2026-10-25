import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { emptyTierDraft, toTierDrafts, normalizeTiers } = loadTsCommonJs("src/renderer/src/config/modelCostTiers.ts");

// vm 沙箱导出的对象跨 realm，assert.deepEqual 会因原型不同而失败：序列化后比较
const plain = (value) => JSON.parse(JSON.stringify(value));

const fullDraft = {
	inputTokensAbove: "272000",
	input: "2.5",
	output: "10",
	cacheRead: "0.25",
	cacheWrite: "2.5",
};

test("normalizeTiers: keeps valid rows and sorts by threshold ascending", () => {
	const result = normalizeTiers([
		{ ...fullDraft, inputTokensAbove: "400000" },
		{ ...fullDraft, inputTokensAbove: "272000" },
	]);
	assert.deepEqual(plain(result), [
		{ inputTokensAbove: 272000, input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 2.5 },
		{ inputTokensAbove: 400000, input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 2.5 },
	]);
});

test("normalizeTiers: drops rows with missing rates (half-typed rows)", () => {
	const result = normalizeTiers([fullDraft, { ...fullDraft, output: "" }, { ...emptyTierDraft(), inputTokensAbove: "100000" }]);
	assert.equal(result.length, 1);
	assert.equal(result[0].inputTokensAbove, 272000);
});

test("normalizeTiers: drops rows with non-finite or negative numbers", () => {
	const result = normalizeTiers([fullDraft, { ...fullDraft, inputTokensAbove: "abc" }, { ...fullDraft, input: "-1" }, { ...fullDraft, cacheRead: "Infinity" }]);
	assert.equal(result.length, 1);
	assert.equal(result[0].inputTokensAbove, 272000);
});

test("normalizeTiers: empty input yields empty list", () => {
	assert.deepEqual(plain(normalizeTiers([])), []);
});

test("toTierDrafts: undefined tiers yields empty drafts; numbers become strings", () => {
	assert.deepEqual(plain(toTierDrafts(undefined)), []);
	assert.deepEqual(plain(toTierDrafts([{ inputTokensAbove: 272000, input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 2.5 }])), [fullDraft]);
});

test("ModelsTable renders tiered pricing UI in the cost dialog (Table + add button + threshold column)", () => {
	// 计费弹框随模型表格一起内聚到共享组件 ModelsTable（ModelsTab 与编辑页共用）
	const table = readFileSync("src/renderer/src/config/ModelsTable.tsx", "utf8");
	const tab = readFileSync("src/renderer/src/config/ModelsTab.tsx", "utf8");
	const source = table + "\n" + tab;
	// 梯度用 shadcn Table 呈现，阈值列带 > 前缀，添加按钮 + 删除按钮
	assert.match(source, /config\.costTiersTitle/);
	assert.match(source, /config\.costTiersHint/);
	assert.match(source, /config\.costTiersAdd/);
	assert.match(source, /config\.costTierThreshold/);
	assert.match(source, /t\("config\.costTierThreshold"\)/);
	assert.match(source, /Trash2/);
	// 计费弹窗加宽以容纳 6 列梯度表
	assert.match(source, /sm:max-w-3xl/);
	// 纯函数与 UI 接线：添加/删除/更新都经 normalizeTiers 落盘
	assert.match(source, /normalizeTiers/);
});
