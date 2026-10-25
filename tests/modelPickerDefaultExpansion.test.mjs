import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { computeModelPickerDefaultExpanded } = loadTsCommonJs("src/renderer/src/components/session/sessionPickerOptions.ts");

const PROVIDERS = ["anthropic", "deepseek", "openai"];

function run(overrides = {}) {
	return computeModelPickerDefaultExpanded({
		favorites: [],
		providers: PROVIDERS,
		...overrides,
	});
}

function assertEqual(actual, expected) {
	// vm 上下文数组的原型与宿主不同，deepStrictEqual 会误报；与 modelPendingDisplay 测试一致用 JSON 比较。
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test("当前模型在收藏栏：仅展开收藏栏，提供商全部折叠", () => {
	assertEqual(
		run({
			favorites: [{ provider: "openai", id: "gpt-5" }],
			current: { provider: "openai", modelId: "gpt-5" },
		}),
		["favorites"],
	);
});

test("当前模型不在收藏栏：展开收藏栏 + 当前模型所在提供商", () => {
	assertEqual(
		run({
			favorites: [{ provider: "openai", id: "gpt-5" }],
			current: { provider: "anthropic", modelId: "claude-3" },
		}),
		["favorites", "provider:anthropic"],
	);
});

test("收藏为 0：展开当前模型所在提供商", () => {
	assertEqual(run({ current: { provider: "deepseek", modelId: "r1" } }), ["provider:deepseek"]);
});

test("收藏为 0 且无当前模型：回退展开第一个提供商，避免空列表", () => {
	assertEqual(run({}), ["provider:anthropic"]);
});

test("收藏为 0 且当前提供商不在列表：回退展开第一个提供商", () => {
	assertEqual(run({ current: { provider: "unknown", modelId: "x" } }), ["provider:anthropic"]);
});

test("有收藏但无当前模型（欢迎页草稿期）：仅展开收藏栏", () => {
	assertEqual(run({ favorites: [{ provider: "openai", id: "gpt-5" }] }), ["favorites"]);
});

test("当前模型缺 provider 或 modelId：视为无当前模型", () => {
	assertEqual(
		run({
			favorites: [{ provider: "openai", id: "gpt-5" }],
			current: { provider: "openai", modelId: "" },
		}),
		["favorites"],
	);
	assertEqual(run({ current: { provider: "", modelId: "gpt-5" } }), ["provider:anthropic"]);
});

test("expandAll：收藏栏与所有供应商分组都展开（外部连接挑模型场景）", () => {
	assertEqual(
		run({
			favorites: [{ provider: "openai", id: "gpt-5" }],
			current: { provider: "deepseek", modelId: "chat" },
			expandAll: true,
		}),
		["favorites", "provider:anthropic", "provider:deepseek", "provider:openai"],
	);
	// 无收藏时只展开供应商分组，不加空的收藏栏
	assertEqual(run({ expandAll: true }), ["provider:anthropic", "provider:deepseek", "provider:openai"]);
	// 空目录（模型列表未到达）不产生任何分组，避免误展开不存在的分组
	assertEqual(run({ providers: [], expandAll: true }), []);
});
