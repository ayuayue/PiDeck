import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { modelPickerSearchFilter } = loadTsCommonJs("src/renderer/src/components/session/sessionPickerOptions.ts");

/**
 * 模型选择器搜索过滤的回归测试。
 *
 * 背景：cmdk 1.1 默认 fuzzy 过滤对「任意子序列」返回 >0 即显示，而每个模型的
 * keywords 都含供应商名（如 tokendance），1-2 字符搜索词会命中全部模型——表现为
 * 「搜索了但 tokendance 没被过滤」。自定义 filter 改为子串匹配，此处验证关键行为。
 */

/** 构造 ModelPicker 传给 CommandItem 的参数（keywords 与 renderModelRow 一致）。 */
function itemArgs(model) {
	const modelKey = `${model.provider}/${model.id}`;
	return {
		value: modelKey,
		keywords: [model.name ?? "", model.id, model.provider, modelKey],
	};
}

test("空搜索词返回 1（全部显示）", () => {
	const { value, keywords } = itemArgs({ provider: "tokendance", id: "gpt-4o" });
	assert.equal(modelPickerSearchFilter(value, "", keywords), 1);
	assert.equal(modelPickerSearchFilter(value, "   ", keywords), 1);
});

test("搜索模型 ID 子串精确命中，不再误匹配子序列", () => {
	const deepseek = itemArgs({ provider: "tokendance", id: "deepseek-v3", name: "DeepSeek V3" });
	const claude = itemArgs({ provider: "tokendance", id: "claude-opus-4-1", name: "Claude Opus 4.1" });
	// 搜 deepseek：只命中 deepseek 模型（默认 fuzzy 会误匹配 claude-opus-4-1/glm 等）
	assert.equal(modelPickerSearchFilter(deepseek.value, "deepseek", deepseek.keywords), 1);
	assert.equal(modelPickerSearchFilter(claude.value, "deepseek", claude.keywords), 0);
});

test("搜索供应商名命中该供应商全部模型", () => {
	const a = itemArgs({ provider: "tokendance", id: "gpt-4o" });
	const b = itemArgs({ provider: "tokendance", id: "qwen-max" });
	assert.equal(modelPickerSearchFilter(a.value, "tokendance", a.keywords), 1);
	assert.equal(modelPickerSearchFilter(b.value, "tokendance", b.keywords), 1);
});

test("分隔符归一化：gpt4o / gpt-4o / gpt 4o 互相命中", () => {
	const { value, keywords } = itemArgs({ provider: "openai", id: "gpt-4o", name: "GPT-4o" });
	assert.equal(modelPickerSearchFilter(value, "gpt4o", keywords), 1);
	assert.equal(modelPickerSearchFilter(value, "gpt-4o", keywords), 1);
	assert.equal(modelPickerSearchFilter(value, "gpt 4o", keywords), 1);
	assert.equal(modelPickerSearchFilter(value, "GPT-4O", keywords), 1);
});

test("大小写不敏感", () => {
	const { value, keywords } = itemArgs({ provider: "tokendance", id: "deepseek-v3" });
	assert.equal(modelPickerSearchFilter(value, "DeepSeek", keywords), 1);
	assert.equal(modelPickerSearchFilter(value, "DEEPSEEK-V3", keywords), 1);
});

test("不相关词返回 0", () => {
	const { value, keywords } = itemArgs({ provider: "tokendance", id: "gpt-4o" });
	assert.equal(modelPickerSearchFilter(value, "qwen", keywords), 0);
	assert.equal(modelPickerSearchFilter(value, "claude", keywords), 0);
});

test("搜索模型显示名（中文）命中", () => {
	const { value, keywords } = itemArgs({
		provider: "tokendance",
		id: "qwen-max",
		name: "通义千问 Max",
	});
	assert.equal(modelPickerSearchFilter(value, "通义", keywords), 1);
});

test("keywords 缺省（undefined）不抛错", () => {
	assert.equal(modelPickerSearchFilter("tokendance/gpt-4o", "gpt-4o", undefined), 1);
	assert.equal(modelPickerSearchFilter("tokendance/gpt-4o", "claude", undefined), 0);
});
