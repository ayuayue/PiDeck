/**
 * 模型规格自动补全纯函数测试（utils/modelSpecAutoFill.ts）。
 *
 * 与 dsh-web 对齐：只填空字段；listing/pi-ai 没给的容量留空，不写 128k/8k。
 * 例外：自适应未匹配时默认开放思考（reasoning:true + 全部档位），用户至少有得选。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
void join;

function compileModule(filePath) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: nodeRequire, console }, { filename: filePath });
	return module.exports;
}

const mod = compileModule("src/renderer/src/utils/modelSpecAutoFill.ts");
const { computeModelSpecPatches, collectModelSpecPatches, deriveProviderCompat } = mod;

function assertUpdates(updates, expected) {
	assert.equal(updates.length, expected.length);
	for (let i = 0; i < expected.length; i++) {
		assert.equal(updates[i][0], expected[i][0], `字段 ${expected[i][0]}`);
		const value = updates[i][1];
		const want = expected[i][1];
		if (Array.isArray(want)) {
			assert.ok(Array.isArray(value), `${expected[i][0]} 应为数组`);
			assert.equal(value.length, want.length);
			for (let j = 0; j < want.length; j++) assert.equal(value[j], want[j]);
		} else if (want && typeof want === "object") {
			assert.deepEqual(JSON.parse(JSON.stringify(value)), want);
		} else {
			assert.equal(value, want);
		}
	}
}

const DEFAULT_MAP = { xhigh: "xhigh", max: "max" };

function fullSpec(overrides = {}) {
	return {
		contextWindow: 128000,
		maxTokens: 16384,
		reasoning: true,
		images: true,
		source: "pi-ai",
		matchedId: "gpt-4o",
		...overrides,
	};
}

test("computeModelSpecPatches: 全空字段填满", () => {
	const updates = computeModelSpecPatches({ id: "gpt-4o" }, fullSpec());
	assertUpdates(updates, [
		["contextWindow", 128000],
		["maxTokens", 16384],
		["input", ["text", "image"]],
		["reasoning", true],
		["thinkingLevelMap", DEFAULT_MAP],
	]);
});

test("computeModelSpecPatches: 手填值不覆盖（未填思考档位时补默认开放）", () => {
	const updates = computeModelSpecPatches(
		{ id: "gpt-4o", contextWindow: 999, maxTokens: 111, input: ["text"] },
		fullSpec(),
	);
	assertUpdates(updates, [
		["reasoning", true],
		["thinkingLevelMap", DEFAULT_MAP],
	]);
});

test("computeModelSpecPatches: 用户明确关掉的 reasoning=false 不覆盖", () => {
	const updates = computeModelSpecPatches({ id: "gpt-4o", reasoning: false }, fullSpec());
	assertUpdates(updates, [
		["contextWindow", 128000],
		["maxTokens", 16384],
		["input", ["text", "image"]],
	]);
});

test("computeModelSpecPatches: 规格缺 context/maxTokens → 留空，不填默认值", () => {
	const updates = computeModelSpecPatches(
		{ id: "sensenova-6.7-flash-lite" },
		fullSpec({ contextWindow: undefined, maxTokens: undefined }),
	);
	assertUpdates(updates, [
		["input", ["text", "image"]],
		["reasoning", true],
		["thinkingLevelMap", DEFAULT_MAP],
	]);
});

test("computeModelSpecPatches: 规格完全未命中 → 默认开放思考档位（不猜容量）", () => {
	assertUpdates(computeModelSpecPatches({ id: "my-custom-model" }, null), [
		["reasoning", true],
		["thinkingLevelMap", DEFAULT_MAP],
	]);
	assertUpdates(
		computeModelSpecPatches({ id: "my-custom-model" }, { source: "pi-ai", matchedId: "my-custom-model" }),
		[
			["reasoning", true],
			["thinkingLevelMap", DEFAULT_MAP],
		],
	);
});

test("computeModelSpecPatches: 目录未收录的视觉 ID 补图片能力", () => {
	// deepseek-v4-flash-vision-exp 未被目录收录时，ID 本身声明了视觉能力：
	// 补 input [text,image]，避免模型被当成 text-only（图片会退化为视觉桥）。
	const updates = computeModelSpecPatches({ id: "deepseek-v4-flash-vision-exp" }, null);
	assert.equal(updates.find(([field]) => field === "input")?.[1][1], "image");
	assertUpdates(computeModelSpecPatches({ id: "qwen2.5-vl-72b" }, null), [
		["input", ["text", "image"]],
		["reasoning", true],
		["thinkingLevelMap", DEFAULT_MAP],
	]);
});

test("computeModelSpecPatches: 非视觉 ID 不触发图片猜测，已有 input 不覆盖", () => {
	// 普通 ID 未命中目录：不猜 input（保持旧行为）
	assert.equal(computeModelSpecPatches({ id: "my-deepseek-r1" }, null).some(([field]) => field === "input"), false);
	// 已手填 input 时目录声明 image 也不覆盖（填空语义；覆盖走「重置为自适应」）
	const protectedUpdates = computeModelSpecPatches(
		{ id: "gpt-4o-vision", input: ["text"] },
		fullSpec({ input: ["text", "image"] }),
	);
	assert.equal(protectedUpdates.some(([field]) => field === "input"), false);
});

test("isVisionModelId: 只认独立视觉 token，避免子串误判", () => {
	const { isVisionModelId } = mod;
	assert.equal(isVisionModelId("deepseek-v4-flash-vision-exp"), true);
	assert.equal(isVisionModelId("qwen2.5-vl"), true);
	assert.equal(isVisionModelId("glm-4v"), true);
	assert.equal(isVisionModelId("revision-extended"), false);
	assert.equal(isVisionModelId("visual-qwen"), false);
	assert.equal(isVisionModelId("deepseek-r1"), false);
});

test("computeModelSpecPatches: 纯文本规格不填 input", () => {
	const updates = computeModelSpecPatches({ id: "deepseek-chat" }, fullSpec({ images: undefined }));
	assertUpdates(updates, [
		["contextWindow", 128000],
		["maxTokens", 16384],
		["reasoning", true],
		["thinkingLevelMap", DEFAULT_MAP],
	]);
});

test("computeModelSpecPatches: 规格未声明推理 → 默认支持思考并开放档位", () => {
	const updates = computeModelSpecPatches({ id: "x" }, fullSpec({ reasoning: undefined }));
	assert.equal(updates.some(([field, value]) => field === "reasoning" && value === true), true);
	assert.equal(updates.some(([field]) => field === "thinkingLevelMap"), true);
});

test("computeModelSpecPatches: 规格明确非推理 → reasoning:false 且不开放档位", () => {
	const updates = computeModelSpecPatches({ id: "x" }, fullSpec({ reasoning: false }));
	assert.equal(updates.some(([field]) => field === "thinkingLevelMap"), false);
	assert.equal(updates.find(([field]) => field === "reasoning")?.[1], false);
});

test("computeModelSpecPatches: 完整 thinkingLevelMap 与输入模态只补空字段", () => {
	const thinkingLevelMap = { off: null, high: "high", xhigh: "xhigh", max: "max" };
	const updates = computeModelSpecPatches(
		{ id: "gpt-5.6-luna" },
		fullSpec({ input: ["text", "image"], thinkingLevelMap }),
	);
	assertUpdates(updates, [
		["contextWindow", 128000],
		["maxTokens", 16384],
		["input", ["text", "image"]],
		["reasoning", true],
		["thinkingLevelMap", thinkingLevelMap],
	]);
	const protectedUpdates = computeModelSpecPatches(
		{ id: "gpt-5.6-luna", reasoning: false, thinkingLevelMap: { off: null }, input: ["text"] },
		fullSpec({ input: ["text", "image"], thinkingLevelMap }),
	);
	assert.equal(protectedUpdates.some(([field]) => field === "thinkingLevelMap" || field === "input"), false);
});

test("deriveProviderCompat: 有档位映射的 provider 自动开启 reasoning_effort", () => {
	const compat = deriveProviderCompat({
		models: [{ id: "m", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }],
	});
	assert.deepEqual(JSON.parse(JSON.stringify(compat)), {
		supportsDeveloperRole: false,
		supportsReasoningEffort: true,
	});
	// reasoning 未声明（默认支持）同样联动
	const compat2 = deriveProviderCompat({
		models: [{ id: "m", thinkingLevelMap: { off: null } }],
	});
	assert.equal(compat2.supportsReasoningEffort, true);
});

test("deriveProviderCompat: 无映射或明确非推理时不开启", () => {
	assert.equal(
		deduceSupportsReasoningEffort(deriveProviderCompat({ models: [{ id: "m" }] })),
		false,
	);
	assert.equal(
		deduceSupportsReasoningEffort(
			deriveProviderCompat({ models: [{ id: "m", reasoning: false, thinkingLevelMap: { xhigh: "xhigh" } }] }),
		),
		false,
	);
	assert.equal(
		deduceSupportsReasoningEffort(
			deriveProviderCompat({ models: [{ id: "m", thinkingLevelMap: {} }] }),
		),
		false,
	);
});

test("deriveProviderCompat: 旧保存写入的陈旧 false 被联动覆盖，显式 true 保留", () => {
	// 旧版本无条件写 false → 现在有映射时应自动纠正为 true
	assert.equal(
		deduceSupportsReasoningEffort(
			deriveProviderCompat({
				models: [{ id: "m", thinkingLevelMap: { high: "high" } }],
				compat: { supportsReasoningEffort: false },
			}),
		),
		true,
	);
	// 无映射时显式 true 保留
	assert.equal(
		deduceSupportsReasoningEffort(
			deriveProviderCompat({
				models: [{ id: "m" }],
				compat: { supportsReasoningEffort: true },
			}),
		),
		true,
	);
	// 其他 compat 键原样透传
	const compat = deriveProviderCompat({
		models: [{ id: "m", thinkingLevelMap: { high: "high" } }],
		compat: { customFlag: "keep", supportsReasoningEffort: false },
	});
	assert.equal(compat.customFlag, "keep");
});

function deduceSupportsReasoningEffort(compat) {
	return compat.supportsReasoningEffort === true;
}

test("collectModelSpecPatches: 批量补全、计数、不修改入参、未命中留空", async () => {
	const models = {
		providers: {
			relay: {
				baseUrl: "https://relay.example",
				models: [
					{ id: "gpt-4o" },
					{ id: "filled", contextWindow: 999, reasoning: false },
					{ id: "" },
				],
			},
			other: {
				models: [{ id: "glm-5" }],
			},
		},
	};
	const lookedUp = [];
	const { providers, filledCount } = await collectModelSpecPatches(models, async (providerName, modelId) => {
		lookedUp.push(`${providerName}:${modelId}`);
		return modelId === "gpt-4o" ? fullSpec() : modelId === "glm-5" ? fullSpec({ contextWindow: undefined }) : null;
	});
	assert.equal(filledCount, 2);
	assert.deepEqual(lookedUp, ["relay:gpt-4o", "relay:filled", "other:glm-5"]);
	assert.equal(providers.relay.models[0].contextWindow, 128000);
	assert.equal(providers.relay.models[0].input[1], "image");
	assert.equal(providers.relay.models[0].reasoning, true);
	assert.equal(providers.relay.models[0].maxTokens, 16384);
	// 用户明确 reasoning:false 且未命中规格 → 不补任何字段
	assert.equal(providers.relay.models[1].contextWindow, 999);
	assert.equal(providers.relay.models[1].reasoning, false);
	assert.equal(providers.relay.models[1].maxTokens, undefined);
	assert.equal(providers.relay.models[1].thinkingLevelMap, undefined);
	assert.equal(providers.relay.models[2].id, "");
	assert.equal(providers.other.models[0].reasoning, true);
	assert.equal(providers.other.models[0].contextWindow, undefined);
	assert.equal(models.providers.relay.models[0].contextWindow, undefined);
	assert.equal(models.providers.other.models[0].reasoning, undefined);
	assert.equal(providers.relay.baseUrl, "https://relay.example");
});

test("collectModelSpecPatches: lookup 抛错按未命中处理，不阻断保存，只补默认思考开放", async () => {
	const models = { providers: { a: { models: [{ id: "x" }, { id: "y" }] } } };
	const { providers, filledCount } = await collectModelSpecPatches(models, async (p, id) => {
		if (id === "x") throw new Error("boom");
		return fullSpec();
	});
	assert.equal(filledCount, 2);
	// 抛错模型：容量/模态不猜，但默认开放思考档位
	assert.equal(providers.a.models[0].contextWindow, undefined);
	assert.equal(providers.a.models[0].reasoning, true);
	assert.deepEqual(JSON.parse(JSON.stringify(providers.a.models[0].thinkingLevelMap)), DEFAULT_MAP);
	assert.equal(providers.a.models[1].contextWindow, 128000);
	assert.equal(providers.a.models[1].reasoning, true);
});
