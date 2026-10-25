/**
 * 模型匹配语料回归（真实官方目录 + 真实中转站命名）。
 *
 * 这里断言的是**规则**而不是某一版目录里的具体数字：能稳定跨目录升级的用「同族 / 模态 / 量级」，
 * 需要断言权威性时就从 live 目录里取对照条目（如 openai 自己的 gpt-* 条目）比对。
 *
 * 背景（2026-03 调研实测）：
 * - 旧实现把 `pi --list-models` 的解析值当事实：那是 pi 对 models.json 的回显，自定义条目会被套上
 *   `?? 128000 / ?? 16384 / ?? false / ?? ["text"]`，于是中转新行被写成 128K/16.4K/不支持思考；
 * - 旧实现同 id 跨 provider 时按 provider 名字典序取第一个，取到 baseten 的 maxTokens=32768
 *   而不是官方 384000；
 * - 旧实现别名要求「候选必须短于目标且含数字」，`-latest` / `-free` / 厂商命名空间改写大面积落空。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveModelSpecFromCatalogs } = loadTsCommonJs("src/main/pi/modelCapabilityResolver.ts");
const { buildPiAiCatalogIndex, parsePiAiCatalogArtifact } = loadTsCommonJs("src/main/pi/piAiBuiltinCatalog.ts");
const { modelFamilyKey, FAMILY_VENDOR_PROVIDERS } = loadTsCommonJs("src/main/pi/modelCapabilityMatch.ts");
const { computeModelSpecPatches } = loadTsCommonJs("src/renderer/src/utils/modelSpecAutoFill.ts");

const entries = parsePiAiCatalogArtifact(readFileSync("resources/pi-ai-catalog.json", "utf8"), readFileSync("resources/pi-ai-catalog.manifest.json", "utf8"));
assert.ok(entries.length > 0, "内置 pi-ai 目录应能解析出条目");
const index = buildPiAiCatalogIndex(entries);
const catalogEntry = (provider, id) => entries.find((entry) => entry.provider === provider && entry.id === id);

const resolve = (modelId, providerName = "relay", modelName) => resolveModelSpecFromCatalogs({ providerName, modelId, ...(modelName ? { modelName } : {}) }, index);

// ── 1. 家族身份：中转命名（命名空间 / 服务档位改写）必须命中同一家族 ──

test("中转站命中的家族与官方目录一致", () => {
	const cases = [
		// 用户真实配置里的行（2026-03 采集）
		["deepseek-ai/DeepSeek-V4.1-Flash", "deepseek-v4.1-flash"],
		["cbcn/deepseek-v4.1-flash", "deepseek-v4.1-flash"],
		["deepseek-v4.1-flash:batch", "deepseek-v4.1-flash"],
		["deepseek-v4-flash-latest", "deepseek-v4-flash"],
		["deepseek-v4-flash-free", "deepseek-v4-flash"],
		["cbcn/glm-5.3-flash", "glm-5.3-flash"],
		["glm-5.3-flashx", "glm-5.3-flashx"],
		["kimi-k3", "kimi-k3"],
		["gemini-3.8-flash", "gemini-3.8-flash"],
		["gpt-5.6-luna", "gpt-5.6-luna"],
		// 老一代 DeepSeek API 名与厂商命名空间
		["deepseek-chat", "deepseek-chat"],
		["deepseek-v3", "deepseek-v3"],
		["deepseek-v3.2", "deepseek-v3.2"],
		["deepseek-v3.2-exp-free", "deepseek-v3.2-exp"],
		["deepseek-r1-0528", "deepseek-r1-0528"],
		["deepseek-ai/DeepSeek-V3.2", "deepseek-ai/DeepSeek-V3.2"],
		["DeepSeek-V3.1-Terminus", "deepseek-v3.1-terminus"],
		["Pro/deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-V3"],
		// 第三方改写
		["MiniMax-M3-free", "MiniMax-M3"],
		["claude-opus-4-6-free", "claude-opus-4-6"],
		["glm-4.6v", "glm-4.6v"],
	];
	for (const [modelId, expectedFamilySource] of cases) {
		const spec = resolve(modelId);
		assert.ok(spec, `${modelId} 应命中官方目录`);
		assert.equal(modelFamilyKey(spec.matchedId), modelFamilyKey(expectedFamilySource), `${modelId} 应命中同族条目`);
	}
});

// ── 2. 权威取值：不被平台的异常容量带偏 ──

test("DeepSeek V4.1 Flash 取官方量级并保留图片能力", () => {
	// 旧实现取 baseten（provider 字典序 b 最早）的 maxTokens=32768，比官方小一个数量级
	for (const modelId of ["deepseek-v4.1-flash", "deepseek-ai/DeepSeek-V4.1-Flash", "cbcn/deepseek-v4.1-flash", "deepseek-v4.1-flash:batch"]) {
		const spec = resolve(modelId);
		assert.ok(spec, modelId);
		assert.ok(spec.contextWindow !== undefined && spec.contextWindow >= 1000000, `${modelId} ctx=${spec.contextWindow}`);
		assert.ok(spec.maxTokens !== undefined && spec.maxTokens >= 262144, `${modelId} max=${spec.maxTokens}`);
		assert.deepEqual(JSON.parse(JSON.stringify(spec.input)), ["text", "image"], modelId);
	}
});

test("厂商自己的条目在上下文窗口上压过平台的 SKU 值", () => {
	// 同一家族里 azure/cloudflare 等平台条目给出自家 SKU 的窗口，openai 自己的条目才是标准 API 值
	const vendorEntry = catalogEntry("openai", "gpt-5.6-luna");
	assert.ok(vendorEntry, "目录应含 openai 的 gpt-5.6-luna");
	const spec = resolve("gpt-5.6-luna");
	assert.equal(spec?.contextWindow, vendorEntry.contextWindow);
	assert.equal(spec?.maxTokens, vendorEntry.maxTokens);
});

test("视觉变体声明图片能力，text-only 家族不被顶替", () => {
	const vision = resolve("deepseek-v4-flash-vision-exp");
	assert.deepEqual(JSON.parse(JSON.stringify(vision?.input)), ["text", "image"]);
	assert.equal(vision?.reasoning, true);

	const base = resolve("deepseek-v4-flash");
	assert.deepEqual(JSON.parse(JSON.stringify(base?.input)), ["text"]);
});

test("容量护栏：maxTokens 不得超过上下文窗口", () => {
	for (const modelId of ["deepseek-v4.1-flash", "deepseek-v3.2", "gpt-5.6-luna", "kimi-k3", "glm-5.3"]) {
		const spec = resolve(modelId);
		assert.ok(spec?.contextWindow, modelId);
		assert.ok(spec.maxTokens === undefined || spec.maxTokens <= spec.contextWindow, `${modelId} max=${spec.maxTokens} ctx=${spec.contextWindow}`);
	}
});

// ── 3. 空行填充：不得写入 pi 的兜底值 ──

test("中转新行不会被写成 pi 的兜底值（128K / 16.4K / 不支持思考）", () => {
	const model = { id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash" };
	const updates = computeModelSpecPatches(model, resolve(model.id, "relay", model.name));
	const patches = new Map(updates);
	assert.notEqual(patches.get("contextWindow"), 128000);
	assert.notEqual(patches.get("maxTokens"), 16400);
	assert.notEqual(patches.get("reasoning"), false);
	assert.ok(Number(patches.get("contextWindow")) >= 1000000);
	assert.deepEqual(JSON.parse(JSON.stringify(patches.get("input"))), ["text", "image"]);
});

test("未命中时只写默认思考档位，不猜容量", () => {
	// 官方目录确实没有这些名字（老 API 别名 / 自定义模型名）：留空让用户手填，
	// 而不是拿兄弟家族或 pi 的兜底值顶上。
	for (const [modelId, modelName] of [
		["deepseek-reasoner", undefined],
		["deepseek-v4", undefined],
		["qd/qfmodel", "qwen-3.8-flash"],
	]) {
		assert.equal(resolve(modelId, "relay", modelName), null, modelId);
		const patches = new Map(computeModelSpecPatches({ id: modelId, name: modelName ?? modelId }, null));
		assert.deepEqual([...patches.keys()].sort(), ["reasoning", "thinkingLevelMap"], modelId);
	}
});

// ── 4. 架构守卫：不要重新引入「自回显」数据源 ──

test("解析链不再读 pi --list-models 的解析视图", () => {
	// 这是本轮修复的核心：那条链是 pi 对 models.json 的解析结果，空字段会被兜底成
	// 128000/16384/false/text-only，与真实声明无法区分（见 modelCapabilityResolver 注释）。
	const resolverSource = readFileSync("src/main/pi/modelCapabilityResolver.ts", "utf8");
	assert.doesNotMatch(resolverSource, /getCachedModelList|pi-runtime|AvailableModel/, "resolver 不应再读取运行时模型列表");

	const systemSource = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	const handler = /projectsGetModelSpec[\s\S]*?\n\t\}\);/.exec(systemSource)?.[0] ?? "";
	assert.ok(handler.includes("resolveModelSpecFromCatalogs"), "systemIpc 仍应调用目录解析");
	assert.doesNotMatch(handler, /getCachedModelList|runtimeModels/, "spec 查询不应再传运行时模型列表");
});

test("家族厂商表里的 provider 仍存在于官方目录（防表过期）", () => {
	const providers = new Set(entries.map((entry) => entry.provider));
	for (const [familyHead, vendorProviders] of Object.entries(FAMILY_VENDOR_PROVIDERS)) {
		for (const provider of vendorProviders) {
			assert.ok(providers.has(provider), `家族 ${familyHead} 的厂商 provider ${provider} 不在目录里，需更新 FAMILY_VENDOR_PROVIDERS`);
		}
	}
});
