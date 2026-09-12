import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { toDshAvailableModels, toDshFetchedModels, unwrapDshDiscoveryModels } = loadTsCommonJs("src/main/dsh/dshModels.ts");

/** 与 DSH host llm.models / session.models 实测一致的组形状。 */
const group = (id, models) => ({ id, name: id, models });


test("toDshFetchedModels preserves discovery metadata and drops malformed ids", () => {
	const models = toDshFetchedModels([
		{ id: "  gateway-model ", name: "Gateway Model", contextWindow: 128000, maxTokens: 8192 },
		{ id: "" },
	]);
	assert.deepEqual(JSON.parse(JSON.stringify(models)), [
		{ id: "gateway-model", name: "Gateway Model", contextWindow: 128000, maxTokens: 8192 },
	]);
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
	assert.deepEqual(models[0].reasoningEfforts?.map((effort) => effort.id), ["off", "high", "max"]);
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
	assert.deepEqual(models[0].reasoningEfforts?.map((effort) => effort.id), ["high", "max"]);
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
	const wire = [
		{ id: "glm-5.2", name: "GLM-5.2", contextWindow: 200000 },
		{ id: "kimi-k2.5" },
	];
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
