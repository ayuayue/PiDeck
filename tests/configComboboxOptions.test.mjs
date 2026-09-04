import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
	return module.exports;
}

const { filterComboboxOptions, isKnownComboboxValue } = compile("src/renderer/src/config/comboboxOptions.ts");

const OPTIONS = [
	{ value: "anthropic", label: "Anthropic" },
	{ value: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
	{ value: "openai/o3", label: "OpenAI o3" },
	{ value: "custom-provider", label: "" },
];

test("空查询返回原数组（不复制）", () => {
	assert.equal(filterComboboxOptions(OPTIONS, ""), OPTIONS);
	assert.equal(filterComboboxOptions(OPTIONS, "   "), OPTIONS);
});

test("大小写不敏感匹配 value 与 label", () => {
	assert.deepEqual(
		filterComboboxOptions(OPTIONS, "DEEPSEEK").map((o) => o.value),
		["deepseek-v4-flash"],
	);
	assert.deepEqual(
		filterComboboxOptions(OPTIONS, "anthropic").map((o) => o.value),
		["anthropic"],
	);
});

test("查询前后空白被 trim 后过滤", () => {
	assert.deepEqual(
		filterComboboxOptions(OPTIONS, "  flash  ").map((o) => o.value),
		["deepseek-v4-flash"],
	);
});

test("label 缺省时用 value 参与匹配", () => {
	const noLabel = [{ value: "qinglong" }, { value: "deepseek" }];
	assert.deepEqual(
		filterComboboxOptions(noLabel, "QING").map((o) => o.value),
		["qinglong"],
	);
});

test("value 与 label 均不匹配时返回空数组", () => {
	assert.equal(filterComboboxOptions(OPTIONS, "不存在").length, 0);
});

test("isKnownComboboxValue：命中返回 true，未命中返回 false，空值返回 false", () => {
	assert.equal(isKnownComboboxValue(OPTIONS, "anthropic"), true);
	assert.equal(isKnownComboboxValue(OPTIONS, "不存在的值"), false);
	assert.equal(isKnownComboboxValue(OPTIONS, ""), false);
});
