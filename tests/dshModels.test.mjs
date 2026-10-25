import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isDshModelImageUnsupportedRejection, parseDshModelCatalog, resolveDshModelDirectory, toDshAvailableModels, toDshFetchedModels, unwrapDshDiscoveryModels } = loadTsCommonJs("src/main/dsh/dshModels.ts");

/** 与 DSH host llm.models / session.models 实测一致的组形状。 */
const group = (id, models) => ({ id, name: id, models });

/** 0.2 的目录是 host 能力，当前模型另由会话投影提供。 */
function catalog() {
	return { default: { provider: "host", model: "default" }, routableProviders: ["host", "chosen"], groups: [group("host", [{ id: "default", name: "Default" }])], failures: [] };
}

test("0.2 model catalog validates the response instead of trusting a TypeScript assertion", () => {
	const parsed = parseDshModelCatalog(catalog());
	assert.equal(parsed.default.model, "default");
	assert.equal(parsed.groups[0].models[0].name, "Default");
	for (const input of [null, {}, { ...catalog(), default: undefined }, { ...catalog(), routableProviders: false }, { ...catalog(), routableProviders: [null] }, { ...catalog(), failures: [{ id: "p" }] }]) {
		assert.throws(() => parseDshModelCatalog(input));
	}
});

test("0.2 model catalog validates nested reasoning while allowing empty descriptions", () => {
	const reasoning = { efforts: [{ id: "off", name: "Off", description: "" }], defaultEffort: "off" };
	const input = { ...catalog(), groups: [group("host", [{ id: "default", name: "Default", description: "", reasoning }])] };
	assert.equal(parseDshModelCatalog(input).groups[0].models[0].reasoning.defaultEffort, "off");
	for (const invalid of [null, { efforts: {} }, { efforts: [null] }, { efforts: [{ id: "off" }] }, { efforts: [], defaultEffort: 1 }, { efforts: [{ id: "off", name: "Off", description: false }] }]) {
		assert.throws(() => parseDshModelCatalog({ ...catalog(), groups: [group("host", [{ id: "default", name: "Default", reasoning: invalid }])] }), /Invalid DSH model catalog/);
	}
});

test("0.2 model selection uses next, then lastUsed, then default only for an explicitly empty projection", () => {
	const next = { provider: "chosen", model: "private", reasoningEffort: "high" };
	const lastUsed = { provider: "missing", model: "previous" };
	const projection = (modelSelection) => ({ asOfSeq: 2, values: { modelSelection } });
	const pending = resolveDshModelDirectory(catalog(), projection({ next, lastUsed }));
	assert.equal(pending.current.model, "private");
	assert.equal(pending.current.reasoningEffort, "high");
	assert.equal(pending.routable, true, "provider routing is independent of catalog membership");
	const previous = resolveDshModelDirectory(catalog(), projection({ next: null, lastUsed }));
	assert.equal(previous.current.model, "previous");
	assert.equal(previous.routable, false);
	assert.equal(resolveDshModelDirectory(catalog(), projection({ next: null, lastUsed: null })).current.model, "default");
	for (const input of [null, {}, projection(undefined), projection({ next: {} }), projection({ next: { provider: "", model: "x" } }), projection({ next }), projection({ next, lastUsed: {} }), projection({ next: null })]) {
		assert.throws(() => resolveDshModelDirectory(catalog(), input), /model selection projection/);
	}
});

test("toDshFetchedModels preserves discovery metadata and drops malformed ids", () => {
	const models = toDshFetchedModels([{ id: "  gateway-model ", name: "Gateway Model", contextWindow: 128000, maxTokens: 8192 }, { id: "" }]);
	assert.deepEqual(JSON.parse(JSON.stringify(models)), [{ id: "gateway-model", name: "Gateway Model", contextWindow: 128000, maxTokens: 8192 }]);
});

// 回归（用户反馈「DSH 发图片识别不了」）：适配器 discovery 已声明 inputModalities，
// 配置页丢掉它会把视觉模型落成纯文本；llm-pi-ai 的 model.input 必须原样带过去。
test("toDshFetchedModels carries adapter-declared input modalities", () => {
	const [model] = toDshFetchedModels([{ id: "vision-model", inputModalities: ["text", "image"] }]);
	assert.deepEqual(JSON.parse(JSON.stringify(model.input)), ["text", "image"]);
	// 只接受 DSH 认识的模态，去重；全是噪声时省略而不是写空数组（DSH 里空数组=没声明）。
	assert.deepEqual(JSON.parse(JSON.stringify(toDshFetchedModels([{ id: "noisy", inputModalities: ["image", "image", "audio"] }])[0].input)), ["image"]);
	const textOnly = toDshFetchedModels([{ id: "text-model", inputModalities: ["text"] }])[0];
	assert.deepEqual(JSON.parse(JSON.stringify(textOnly.input)), ["text"]);
	assert.equal("input" in toDshFetchedModels([{ id: "unknown", inputModalities: [] }])[0], false);
});

test("isDshModelImageUnsupportedRejection recognizes the prompt-admission rejection", () => {
	assert.equal(isDshModelImageUnsupportedRejection({ code: "session/attachment-invalid", message: 'Model "x" does not support image input.', details: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" } }), true);
	// 旧宿主只带稳定 message，没有 details.reason 时仍要识别。
	assert.equal(isDshModelImageUnsupportedRejection({ code: "session/attachment-invalid", message: 'Model "x" does not support image input.' }), true);
	assert.equal(isDshModelImageUnsupportedRejection({ code: "session/attachment-invalid", message: "attachment too large", details: {} }), false);
	assert.equal(isDshModelImageUnsupportedRejection({ code: "session/writer-held", message: "locked", details: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" } }), false);
	assert.equal(isDshModelImageUnsupportedRejection(null), false);
});

test("toDshAvailableModels 透传 reasoningEfforts（按模型过滤思考档位）", () => {
	const models = toDshAvailableModels([
		group("llm-deepseek", [
			{
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				reasoning: {
					efforts: [
						{ id: "off", name: "Off" },
						{ id: "high", name: "High" },
						{ id: "max", name: "Max" },
					],
					defaultEffort: "high",
				},
			},
		]),
		group("opencode-go", [
			// 无 reasoning 元数据的模型：不带 reasoningEfforts 字段
			{ id: "plain-model", name: "Plain" },
		]),
	]);
	assert.equal(models.length, 2);
	assert.equal(models[0].provider, "llm-deepseek");
	assert.equal(models[0].id, "deepseek-v4-flash");
	assert.deepEqual(
		models[0].reasoningEfforts?.map((effort) => effort.id),
		["off", "high", "max"],
	);
	assert.equal(models[0].reasoningEfforts?.[1].name, "High");
	assert.equal(models[0].defaultEffort, "high");
	// 无 reasoning 字段的模型不声明档位（选择器对 pi 语义不适用，DSH 侧原样透传）
	assert.equal("reasoningEfforts" in models[1], false);
	assert.equal("defaultEffort" in models[1], false);
});

test("toDshAvailableModels 过滤掉缺失 id 的档位条目", () => {
	const models = toDshAvailableModels([
		group("opencode-go", [
			{
				id: "glm-5.2",
				name: "GLM-5.2",
				reasoning: {
					efforts: [
						{ id: "high", name: "High" },
						// 形状异常的档位（无 id）不应进入结果
						{ name: "Broken" },
						{ id: "max", name: "Max" },
					],
				},
			},
		]),
	]);
	assert.deepEqual(
		models[0].reasoningEfforts?.map((effort) => effort.id),
		["high", "max"],
	);
});

test("toDshAvailableModels 空目录 / 空组返回空列表", () => {
	// loadTsCommonJs 编译产物在 VM realm，数组跨 realm 不能 deepStrictEqual，断言长度
	assert.equal(toDshAvailableModels([]).length, 0);
	assert.equal(toDshAvailableModels([group("opencode-go", [])]).length, 0);
});

test("toDshAvailableModels 组缺 models 字段时安全跳过", () => {
	assert.equal(toDshAvailableModels([{ id: "no-models" }]).length, 0);
});

test("unwrapDshDiscoveryModels：0.1.5 线上结果是纯数组，直接透传", () => {
	// dsh-llm typert：z.array(z.object({ id, ... })) —— 曾误写成 value.models ?? []
	// 对数组取 .models 恒 undefined，配置页「获取模型列表」永远「已获取 0 个模型」。
	const wire = [{ id: "glm-5.2", name: "GLM-5.2", contextWindow: 200000 }, { id: "kimi-k2.5" }];
	const models = unwrapDshDiscoveryModels(wire);
	assert.equal(models.length, 2);
	assert.equal(models[0].id, "glm-5.2");
	assert.equal(models[1].id, "kimi-k2.5");
});

test("unwrapDshDiscoveryModels：{ models: [...] } 包装形态仍兼容", () => {
	const models = unwrapDshDiscoveryModels({ models: [{ id: "a" }, { id: "b" }] });
	assert.equal(models.length, 2);
});

test("unwrapDshDiscoveryModels：null / 无 models 字段的对象安全返回空", () => {
	assert.equal(unwrapDshDiscoveryModels(null).length, 0);
	assert.equal(unwrapDshDiscoveryModels(undefined).length, 0);
	assert.equal(unwrapDshDiscoveryModels({}).length, 0);
});
