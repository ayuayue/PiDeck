/**
 * 模型/思考强度「循环切换」纯策略单测（快捷键 Ctrl+M / Ctrl+T 的核心规则）。
 *
 * 覆盖：收藏候选的目录/隐藏供应商过滤与去重、环绕方向、当前项不在候选里的兜底、
 * 单项/空候选返回 undefined、思考档位随模型能力裁剪后的环绕。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const cycle = loadTsCommonJs("src/renderer/src/utils/preferenceCycle.ts");

/** 跨 VM realm 的数组/对象先 JSON 归一化再断言（原型不同，直接 deepEqual 恒失败）。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/** AvailableModel 工厂：测试只关心身份字段，其余字段保持类型完整。 */
function model(provider, id, extra = {}) {
	return { id, provider, ...extra };
}

const MODELS = [model("anthropic", "claude-sonnet-4"), model("deepseek", "deepseek-v4-pro"), model("openai", "gpt-5.6")];

test("resolveFavoriteCycleCandidates：按收藏顺序返回，过滤目录中不存在的收藏", () => {
	const candidates = cycle.resolveFavoriteCycleCandidates({
		favorites: ["deepseek/deepseek-v4-pro", "anthropic/claude-sonnet-4", "gone/model"],
		models: MODELS,
	});
	assert.deepEqual(plain(candidates.map((item) => `${item.provider}/${item.id}`)), ["deepseek/deepseek-v4-pro", "anthropic/claude-sonnet-4"]);
});

test("resolveFavoriteCycleCandidates：重复收藏去重，空串与空白忽略", () => {
	const candidates = cycle.resolveFavoriteCycleCandidates({
		favorites: ["openai/gpt-5.6", "openai/gpt-5.6", "  ", "", "  anthropic/claude-sonnet-4  "],
		models: MODELS,
	});
	assert.deepEqual(plain(candidates.map((item) => `${item.provider}/${item.id}`)), ["openai/gpt-5.6", "anthropic/claude-sonnet-4"]);
});

test("resolveFavoriteCycleCandidates：pi 过滤被隐藏的供应商，DSH 不过滤", () => {
	const favorites = ["deepseek/deepseek-v4-pro", "openai/gpt-5.6"];
	const pi = cycle.resolveFavoriteCycleCandidates({
		favorites,
		models: MODELS,
		hiddenProviders: ["deepseek"],
		backend: "pi",
	});
	assert.deepEqual(plain(pi.map((item) => item.provider)), ["openai"]);
	const dsh = cycle.resolveFavoriteCycleCandidates({
		favorites,
		models: MODELS,
		hiddenProviders: ["deepseek"],
		backend: "dsh",
	});
	assert.equal(dsh.length, 2);
});

test("resolveFavoriteCycleCandidates：过滤用户单独隐藏的模型（Ctrl+M 不切到隐藏模型）", () => {
	const favorites = ["deepseek/deepseek-v4-pro", "openai/gpt-5.6"];
	const pi = cycle.resolveFavoriteCycleCandidates({
		favorites,
		models: MODELS,
		hiddenModels: ["openai/gpt-5.6"],
		backend: "pi",
	});
	assert.deepEqual(plain(pi.map((item) => `${item.provider}/${item.id}`)), ["deepseek/deepseek-v4-pro"]);
	// DSH 没有「隐藏模型」概念（目录由 host 给），不应因此被过滤
	const dsh = cycle.resolveFavoriteCycleCandidates({
		favorites,
		models: MODELS,
		hiddenModels: ["openai/gpt-5.6"],
		backend: "dsh",
	});
	assert.equal(dsh.length, 2);
});

test("pickCycleModel：环绕前进/后退，当前项不在候选里时前进取首个、后退取末个", () => {
	const candidates = cycle.resolveFavoriteCycleCandidates({
		favorites: ["anthropic/claude-sonnet-4", "deepseek/deepseek-v4-pro", "openai/gpt-5.6"],
		models: MODELS,
	});
	const key = (m) => `${m.provider}/${m.id}`;
	assert.equal(key(cycle.pickCycleModel({ candidates, currentKey: "anthropic/claude-sonnet-4" })), "deepseek/deepseek-v4-pro");
	assert.equal(
		key(
			cycle.pickCycleModel({
				candidates,
				currentKey: "openai/gpt-5.6",
				direction: "forward",
			}),
		),
		"anthropic/claude-sonnet-4",
	);
	assert.equal(
		key(
			cycle.pickCycleModel({
				candidates,
				currentKey: "anthropic/claude-sonnet-4",
				direction: "backward",
			}),
		),
		"openai/gpt-5.6",
	);
	// 当前模型没收藏：前进落到第一个收藏（pi 在这条路径上会落到第二个，是刻意偏差）
	assert.equal(key(cycle.pickCycleModel({ candidates, currentKey: "other/not-favorited" })), "anthropic/claude-sonnet-4");
	assert.equal(
		key(
			cycle.pickCycleModel({
				candidates,
				currentKey: "other/not-favorited",
				direction: "backward",
			}),
		),
		"openai/gpt-5.6",
	);
});

test("pickCycleModel：候选 <= 1 个返回 undefined（由调用方提示），无当前模型同样可算", () => {
	assert.equal(cycle.pickCycleModel({ candidates: [] }), undefined);
	const single = cycle.resolveFavoriteCycleCandidates({
		favorites: ["anthropic/claude-sonnet-4"],
		models: MODELS,
	});
	assert.equal(cycle.pickCycleModel({ candidates: single, currentKey: undefined }), undefined);
	// 无当前模型（引导页草稿）：两个以上候选时前进取第一个
	const two = cycle.resolveFavoriteCycleCandidates({
		favorites: ["anthropic/claude-sonnet-4", "openai/gpt-5.6"],
		models: MODELS,
	});
	assert.equal(cycle.pickCycleModel({ candidates: two })?.id, "claude-sonnet-4");
});

test("pickCycleThinkingLevel：按模型能力表环绕，未知当前档案位取首/末档", () => {
	const levels = ["off", "low", "high"].map((value) => ({ value }));
	assert.equal(cycle.pickCycleThinkingLevel({ levels, current: "off" }), "low");
	assert.equal(cycle.pickCycleThinkingLevel({ levels, current: "high" }), "off");
	assert.equal(cycle.pickCycleThinkingLevel({ levels, current: "off", direction: "backward" }), "high");
	// 当前档位不在表里（刚切模型）：前进取首档、后退取末档
	assert.equal(cycle.pickCycleThinkingLevel({ levels, current: "max" }), "off");
	assert.equal(cycle.pickCycleThinkingLevel({ levels, current: undefined, direction: "backward" }), "high");
});

test("pickCycleThinkingLevel：单档位/空档位返回 undefined（不支持思考的模型）", () => {
	assert.equal(cycle.pickCycleThinkingLevel({ levels: [{ value: "off" }], current: "off" }), undefined);
	assert.equal(cycle.pickCycleThinkingLevel({ levels: [], current: "off" }), undefined);
	// 空 value 视为无效档位，不参与循环
	assert.equal(cycle.pickCycleThinkingLevel({ levels: [{ value: "" }, { value: "high" }], current: "" }), undefined);
});
