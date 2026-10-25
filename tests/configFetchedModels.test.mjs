import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// modelsUtils 现在依赖 shared/modelOrder（保存顺序与下拉列表对齐）；
// 旧内联 loader 把非白名单 require 一律抛错，改用真实依赖图加载。
function loadModelsTabModule() {
	return loadTsCommonJs("src/renderer/src/config/modelsUtils.ts", {
		stubs: {
			"../i18n": { t: (key) => key },
		},
	});
}

test("builds multiple fetched models and skips duplicates", () => {
	const { buildModelsFromFetchedSelection } = loadModelsTabModule();

	const models = buildModelsFromFetchedSelection([{ id: "gpt-4o", name: "GPT 4o" }, { id: "gpt-4o-mini", name: "GPT 4o mini" }, { id: "reasoner" }], ["gpt-4o", "gpt-4o-mini", "gpt-4o", "already-added"], [{ id: "already-added" }]);

	assert.deepEqual(JSON.parse(JSON.stringify(models)), [
		{ id: "gpt-4o", name: "GPT 4o" },
		{ id: "gpt-4o-mini", name: "GPT 4o mini" },
	]);
});

test("carries listing capacities onto new models and leaves missing fields empty", () => {
	const { buildModelsFromFetchedSelection } = loadModelsTabModule();
	const models = buildModelsFromFetchedSelection(
		[
			{
				id: "listed",
				name: "Listed",
				contextWindow: 64000,
				maxTokens: 4096,
				reasoning: true,
				thinkingLevelMap: { off: null, high: "high", max: "max" },
				input: ["text", "image"],
			},
			{ id: "empty" },
		],
		["listed", "empty"],
		[],
	);
	assert.deepEqual(JSON.parse(JSON.stringify(models)), [
		{
			id: "empty",
			name: "empty",
		},
		{
			id: "listed",
			name: "Listed",
			contextWindow: 64000,
			maxTokens: 4096,
			reasoning: true,
			thinkingLevelMap: { off: null, high: "high", max: "max" },
			input: ["text", "image"],
		},
	]);
});
