import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { splitVisibleAndHiddenProviders, toggleHiddenProvider, filterModelsByHiddenProviders } = loadTsCommonJs("src/renderer/src/config/providerVisibility.ts");

// loadTsCommonJs 在独立 VM realm 执行，数组原型不同导致 deepStrictEqual 报
// “same structure but not reference-equal”，统一用 JSON 比较跨 realm 结果。
const json = (value) => JSON.stringify(value);

test("splitVisibleAndHiddenProviders: 隐藏项进 hidden 列表、其余保持 visible", () => {
	const result = splitVisibleAndHiddenProviders(["openai", "anthropic", "deepseek", "groq"], ["deepseek", "groq"]);
	assert.equal(json(result), json({ visible: ["openai", "anthropic"], hidden: ["deepseek", "groq"] }));
});

test("splitVisibleAndHiddenProviders: 空隐藏列表 = 全部可见", () => {
	const result = splitVisibleAndHiddenProviders(["openai", "anthropic"], []);
	assert.equal(json(result), json({ visible: ["openai", "anthropic"], hidden: [] }));
});

test("splitVisibleAndHiddenProviders: 隐藏列表包含不存在的名字时安全忽略", () => {
	const result = splitVisibleAndHiddenProviders(["openai"], ["ghost", "openai"]);
	assert.equal(json(result), json({ visible: [], hidden: ["openai"] }));
});

test("toggleHiddenProvider: 未隐藏 → 加入隐藏列表", () => {
	assert.equal(json(toggleHiddenProvider(["openai"], "deepseek")), json(["openai", "deepseek"]));
});

test("toggleHiddenProvider: 已隐藏 → 从列表移除（恢复显示）", () => {
	assert.equal(json(toggleHiddenProvider(["openai", "deepseek"], "deepseek")), json(["openai"]));
});

test("filterModelsByHiddenProviders: 隐藏 provider 的模型被过滤", () => {
	const models = [
		{ provider: "openai", id: "gpt-4o" },
		{ provider: "deepseek", id: "deepseek-chat" },
		{ provider: "openai", id: "gpt-5" },
	];
	const result = filterModelsByHiddenProviders(models, ["deepseek"]);
	assert.equal(
		json(result),
		json([
			{ provider: "openai", id: "gpt-4o" },
			{ provider: "openai", id: "gpt-5" },
		]),
	);
});

test("filterModelsByHiddenProviders: 空隐藏列表原样返回（零开销路径）", () => {
	const models = [{ provider: "openai", id: "gpt-4o" }];
	assert.equal(filterModelsByHiddenProviders(models, []), models);
});
