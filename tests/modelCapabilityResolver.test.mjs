/**
 * 配置阶段模型规格解析测试（src/main/pi/modelCapabilityResolver.ts）。
 *
 * 策略基线（2026-03「只信官方目录」）：
 * - 唯一数据源是 bundled pi-ai 官方目录；端点 /models 实报字段由渲染层优先合并；
 * - 不再读 `pi --list-models` 的解析值——那是 pi 对 models.json 的回显，
 *   自定义条目会被套上 `?? 128000 / ?? 16384 / ?? false / ?? ["text"]` 兜底，
 *   会让「空字段」和「真的 128K / 不支持思考」无法区分（见 resolver 顶部注释）；
 * - 同家族跨 provider 时取「厂商亲和 > 多家一致 > 完整度」的代表条目，不按字典序取第一个。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveModelSpecFromCatalogs } = loadTsCommonJs("src/main/pi/modelCapabilityResolver.ts");
const { buildPiAiCatalogIndex } = loadTsCommonJs("src/main/pi/piAiBuiltinCatalog.ts");

function indexOf(entries) {
	return buildPiAiCatalogIndex(entries);
}

test("bundled pi-ai catalog fills a renamed third-party GPT model without changing its provider", () => {
	const index = indexOf([
		// Marks openai as a built-in provider and carries the gpt-5.6 template.
		{ provider: "openai", id: "gpt-5.6", name: "GPT-5.6", contextWindow: 400000, maxTokens: 128000, reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
	]);

	const spec = resolveModelSpecFromCatalogs(
		{
			providerName: "luna-relay",
			modelId: "GPT-5.6 Luna",
			modelName: "GPT-5.6 Luna",
		},
		index,
	);

	assert.equal(spec?.source, "pi-ai");
	assert.equal(spec?.matchKind, "name-alias");
	assert.equal(spec?.matchedId, "gpt-5.6");
	assert.equal(spec?.contextWindow, 400000);
	assert.equal(spec?.maxTokens, 128000);
	assert.equal(spec?.reasoning, true);
	assert.deepEqual(JSON.parse(JSON.stringify(spec?.input)), ["text", "image"]);
	assert.equal(spec?.thinkingLevelMap?.max, "max");
});

test("exact model id resolves across a third-party provider from bundled catalog", () => {
	const index = indexOf([{ provider: "openai", id: "gpt-5.6", contextWindow: 400000 }]);

	const spec = resolveModelSpecFromCatalogs({ providerName: "luna-relay", modelId: "gpt-5.6" }, index);

	assert.equal(spec?.source, "pi-ai");
	assert.equal(spec?.matchKind, "model-id");
	assert.equal(spec?.matchedId, "gpt-5.6");
	assert.equal(spec?.contextWindow, 400000);
});

test("unknown model resolves to null instead of guessing", () => {
	const index = indexOf([{ provider: "openai", id: "gpt-4o", contextWindow: 128000 }]);

	const spec = resolveModelSpecFromCatalogs({ providerName: "luna-relay", modelId: "luna-pro-2026-beta" }, index);

	assert.equal(spec, null);
});

// ── 家族键：厂商命名空间 + 服务档位装饰 ─────────────────────────────

test("relay id tail resolves to the vendor-namespaced official family", () => {
	// 官方目录用带命名空间的完整 id；中转只给尾段（deepseek-v4.1-flash）与网关前缀/档位后缀
	const index = indexOf([{ provider: "huggingface", id: "deepseek-ai/DeepSeek-V4.1-Flash", contextWindow: 1048576, maxTokens: 384000, reasoning: true, input: ["text", "image"] }]);

	for (const modelId of ["deepseek-v4.1-flash", "cbcn/deepseek-v4.1-flash", "deepseek-ai/DeepSeek-V4.1-Flash", "deepseek-v4.1-flash:batch", "deepseek-v4.1-flash-latest"]) {
		const spec = resolveModelSpecFromCatalogs({ providerName: "relay", modelId }, index);
		assert.equal(spec?.contextWindow, 1048576, modelId);
		assert.equal(spec?.maxTokens, 384000, modelId);
		assert.deepEqual(JSON.parse(JSON.stringify(spec?.input)), ["text", "image"], modelId);
	}
});

test("same family across providers picks the consensus entry, not the alphabetically first one", () => {
	// 实测数据：同一族 V4.1 Flash 在 baseten 的 maxTokens 是上游截断值 32768，
	// 其余 provider 为 384000。旧实现按 provider 字典序取 baseten（b 最早）→ 写入偏小值。
	const index = indexOf([
		{ provider: "baseten", id: "deepseek-ai/DeepSeek-V4.1-Flash", contextWindow: 1048576, maxTokens: 32768, reasoning: true, input: ["text", "image"] },
		{ provider: "huggingface", id: "deepseek-ai/DeepSeek-V4.1-Flash", contextWindow: 1048576, maxTokens: 384000, reasoning: true, input: ["text", "image"] },
		{ provider: "together", id: "deepseek-ai/DeepSeek-V4.1-Flash", contextWindow: 1048576, maxTokens: 384000, reasoning: true, input: ["text", "image"] },
	]);

	const spec = resolveModelSpecFromCatalogs({ providerName: "relay", modelId: "deepseek-v4.1-flash" }, index);

	assert.equal(spec?.maxTokens, 384000);
	assert.equal(spec?.matchedId, "deepseek-ai/DeepSeek-V4.1-Flash");
});

test("vendor affinity beats consensus when the vendor itself is in the catalog", () => {
	// 官方 deepseek 的条目才是这一族的权威值；openrouter 的镜像条目另有自己的截断值
	const index = indexOf([
		{ provider: "deepseek", id: "deepseek-flash", contextWindow: 1000000, maxTokens: 384000, reasoning: true, input: ["text", "image"] },
		{ provider: "openrouter", id: "~deepseek/deepseek-flash-latest", contextWindow: 1048576, maxTokens: 943718, reasoning: true, input: ["text", "image"] },
		{ provider: "fireworks", id: "accounts/fireworks/routers/deepseek-flash-latest", contextWindow: 1048576, maxTokens: 943718, reasoning: true, input: ["text", "image"] },
	]);

	const spec = resolveModelSpecFromCatalogs({ providerName: "relay", modelId: "deepseek-flash" }, index);

	assert.equal(spec?.contextWindow, 1000000);
	assert.equal(spec?.maxTokens, 384000);
});

test("family representative takes the majority value for a family split across providers", () => {
	// 形状与真实目录一致：V3.2 在多数 provider 是 163840/65536，qwen-token-plan 另有 131072。
	// 并列时取小值（保守：宁可提前压缩，也不向上游发出超限请求），多数不并列时按多数取。
	const index = indexOf([
		{ provider: "amazon-bedrock", id: "deepseek.v3.2", contextWindow: 163840, maxTokens: 81920, reasoning: true, input: ["text"] },
		{ provider: "huggingface", id: "deepseek-ai/DeepSeek-V3.2", contextWindow: 163840, maxTokens: 65536, reasoning: true, input: ["text"] },
		{ provider: "openrouter", id: "deepseek/deepseek-v3.2", contextWindow: 163840, maxTokens: 147456, reasoning: true, input: ["text"] },
		{ provider: "qwen-token-plan", id: "deepseek-v3.2", contextWindow: 131072, maxTokens: 65536, reasoning: true, input: ["text"] },
		{ provider: "qwen-token-plan-cn", id: "deepseek-v3.2", contextWindow: 131072, maxTokens: 65536, reasoning: true, input: ["text"] },
	]);

	const spec = resolveModelSpecFromCatalogs({ providerName: "relay", modelId: "deepseek-v3.2" }, index);

	assert.equal(spec?.contextWindow, 163840);
	assert.equal(spec?.maxTokens, 65536);
});

// ── 值域护栏 ──────────────────────────────────────────────────────

test("implausible catalog capacities are dropped instead of written to models.json", () => {
	// max > ctx 与超大值都是坏数据（实测有中转回 max_output_tokens=32763840008）
	const index = indexOf([
		{ provider: "relay-vendor", id: "junk-model", contextWindow: 1000000, maxTokens: 32763840008 },
		{ provider: "relay-vendor", id: "junk-model-2", contextWindow: 1000000, maxTokens: 2000000 },
	]);

	const first = resolveModelSpecFromCatalogs({ providerName: "relay", modelId: "junk-model" }, index);
	assert.equal(first?.contextWindow, 1000000);
	assert.equal(first?.maxTokens, undefined);

	const second = resolveModelSpecFromCatalogs({ providerName: "relay", modelId: "junk-model-2" }, index);
	assert.equal(second?.maxTokens, undefined);
});
