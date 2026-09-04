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

const { collectProviderOptions } = compile("src/renderer/src/config/providerOptions.ts");

test("默认供应商候选聚合 providers + auth + discovered 三处来源", () => {
	const options = collectProviderOptions(
		{ providers: { tr: {}, opencode: {} } },
		{ bailu: {} },
		{ shangtang: [{ id: "sensenova-6.7-flash-lite" }] },
	);
	assert.deepEqual(
		Array.from(options).map((option) => option.value),
		["tr", "opencode", "bailu", "shangtang"],
	);
});

// 注：TokenDance 不再是内置候选——它由用户在配置页确认后写入 models.json，
// 写入后经 providers 来源自然出现（对应测试见「providers 含 tokendance 时正常聚合」）。
test("providers 含 tokendance 时正常聚合（写入配置后经既有链路出现）", () => {
	const options = collectProviderOptions(
		{ providers: { tokendance: {} } },
		undefined,
		undefined,
	);
	assert.deepEqual([...options.map((o) => o.value)], ["tokendance"]);
});

test("复现：仅 discovered 存在的供应商必须在候选里（漏掉即「无匹配选项」）", () => {
	const options = collectProviderOptions(
		{ providers: { tr: {} } },
		undefined,
		{ shangtang: [{ id: "m1" }] },
	);
	assert.ok(
		options.some((option) => option.value === "shangtang"),
		"discovered-only 供应商必须出现在默认供应商候选里",
	);
});

test("三处来源为空/未加载时返回空候选（无内置注入）", () => {
	// 展开成测试上下文数组再比较（vm 上下文数组原型不同，deepStrictEqual 会报“结构相同但非引用相等”）
	assert.deepEqual([...collectProviderOptions(undefined, undefined, undefined).map((o) => o.value)], []);
	assert.deepEqual([...collectProviderOptions({ providers: {} }, {}, {}).map((o) => o.value)], []);
});

test("同名供应商去重（三处来源都出现只保留一个候选）", () => {
	const options = collectProviderOptions(
		{ providers: { tr: {} } },
		{ tr: {} },
		{ tr: [{ id: "m1" }] },
	);
	assert.equal(options.filter((option) => option.value === "tr").length, 1);
});
