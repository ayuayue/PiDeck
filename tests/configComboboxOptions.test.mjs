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

const { filterComboboxOptions, groupComboboxOptions, isKnownComboboxValue } = compile("src/renderer/src/config/comboboxOptions.ts");
const configSharedSource = readFileSync("src/renderer/src/config/ConfigShared.tsx", "utf8");

test("combobox 分组标题渲染翻译后的组名，而不是字面量 section.group", () => {
	// 回归：组标题曾写成 >section.group<（漏了 JSX 花括号），
	// User-Agent 下拉里会直接显示字面量 "section.group" 而不是「官方 CLI / SDK / 通用客户端」。
	assert.match(configSharedSource, /\{section\.group\}/);
	assert.doesNotMatch(configSharedSource, />\s*section\.group\s*</);
});

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

// ── groupComboboxOptions：下拉分段展示（ProviderConnectionForm 的 User-Agent 用）──

test("groupComboboxOptions：按相邻 group 切段，未分组的归入无标题段", () => {
	const sections = groupComboboxOptions([{ value: "unset" }, { value: "a", group: "CLI" }, { value: "b", group: "CLI" }, { value: "c", group: "SDK" }]);
	assert.equal(sections.length, 3);
	assert.equal(sections[0].group, undefined);
	// 注意：选项由 vm 内的模块创建，数组原型与宿主 realm 不同，
	// 必须 [...arr] 摊回本 realm 才能用 assert/strict 做结构化比较。
	assert.deepEqual(
		[...sections[0].items].map((o) => o.value),
		["unset"],
	);
	assert.equal(sections[1].group, "CLI");
	assert.deepEqual(
		[...sections[1].items].map((o) => o.value),
		["a", "b"],
	);
	assert.equal(sections[2].group, "SDK");
});

test("groupComboboxOptions：保持传入顺序，不按 group 值重排", () => {
	// 选项数组本身就是展示顺序（如「不写入」置顶）；按值分组会把顺序洗完。
	const sections = groupComboboxOptions([
		{ value: "b", group: "SDK" },
		{ value: "a", group: "CLI" },
		{ value: "c", group: "SDK" },
	]);
	assert.deepEqual(
		[...sections].map((s) => s.group),
		["SDK", "CLI", "SDK"],
	);
});

test("groupComboboxOptions：过滤后中间组被筛空时不遗留空标题", () => {
	// 真实场景：搜索 "claude" 时 SDK 组可能整组消失，不应留下无项的标题段。
	const all = [{ value: "unset" }, { value: "claude-cli/2.1.161", group: "CLI" }, { value: "OpenAI/JS 6.26.0", group: "SDK" }];
	const sections = groupComboboxOptions(filterComboboxOptions(all, "claude"));
	assert.deepEqual(
		[...sections].map((s) => s.group),
		["CLI"],
	);
	assert.deepEqual(
		[...sections[0].items].map((o) => o.value),
		["claude-cli/2.1.161"],
	);
});

test("groupComboboxOptions：空数组返回空分段", () => {
	assert.equal(groupComboboxOptions([]).length, 0);
});
