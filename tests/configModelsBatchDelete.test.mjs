import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const modal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("Pi model management wires batch model deletion through the existing confirmation dialog", () => {
	assert.match(modal, /onDeleteModels=\{handleDeleteModels\}/);
	assert.match(modal, /const handleDeleteModels = \(providerName: string, indexes: number\[\]\)/);
	assert.match(modal, /validIndexes = \[\.\.\.new Set\(indexes\)\]/);
	assert.match(modal, /t\("config\.deleteModelsBatchConfirm"/);
	assert.match(modal, /removeSelectedModelIndexes\(currentProvider\.models, new Set\(validIndexes\)\)/);
	assert.match(modal, /markDirty\("config:models"\)/);
});

test("batch model deletion copy is localized in both supported dictionaries", () => {
	assert.match(zh, /"config\.deleteModelsBatchConfirm":/);
	assert.match(zh, /"config\.modelBatchSelected":/);
	assert.match(zh, /"config\.selectAllModels":/);
	assert.match(zh, /"config\.selectModel":/);
	assert.match(en, /"config\.deleteModelsBatchConfirm":/);
	assert.match(en, /"config\.modelBatchSelected":/);
	assert.match(en, /"config\.selectAllModels":/);
	assert.match(en, /"config\.selectModel":/);
});
