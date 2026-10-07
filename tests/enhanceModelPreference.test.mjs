/**
 * 增强模型偏好（enhanceModelPreference）的纯函数测试。
 *
 * 锁定解析优先级（设置固定模型 > 会话记录 > 引导页点选 > 默认）与形态校验：
 * 真实目录里 provider/modelId 带 `:` `/` URL，曾因校验过严被整体拒掉，
 * 用户点增强直接 Invalid enhance input（2026-06 真机反馈）——这些形态必须放行。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { normalizeEnhanceModel, resolveEnhanceTargetModel } = loadTsCommonJs("src/shared/enhanceModelPreference.ts");

// vm 加载的生产模块与测试宿主原型链不同，deepEqual 会因 realm 不同报 not reference-equal；
// 统一用 JSON round-trip 后再比较结构。
const plain = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

const TRUEISH = [
	{ provider: "builtin:bigmodel-start-plan", modelId: "GLM-5.3-Flash" },
	{ provider: "https://open.mwy.asia", modelId: "gpt-5.6-luna" },
	{ provider: "workbuddy", modelId: "cn:deepseek-v4.1-flash" },
	{ provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" },
];

test("normalizeEnhanceModel：真实目录形态放行，空壳拒绝为 null", () => {
	for (const model of TRUEISH) {
		assert.deepEqual(plain(normalizeEnhanceModel({ ...model })), model);
	}
	assert.equal(normalizeEnhanceModel(null), null);
	assert.equal(normalizeEnhanceModel(undefined), null);
	assert.equal(normalizeEnhanceModel({}), null);
	assert.equal(normalizeEnhanceModel({ provider: "", modelId: "" }), null);
	assert.equal(normalizeEnhanceModel({ provider: 123, modelId: "m" }), null);
});

test("resolveEnhanceTargetModel：固定模型优先级最高", () => {
	const fixed = { provider: "workbuddy", modelId: "cn:deepseek-v4.1-flash" };
	assert.deepEqual(
		plain(
			resolveEnhanceTargetModel({
				configured: fixed,
				recordModel: { provider: "record-p", modelId: "record-m" },
				welcomeModel: { provider: "welcome-p", modelId: "welcome-m" },
				fallback: { provider: "fb-p", modelId: "fb-m" },
			}),
		),
		fixed,
	);
});

test("resolveEnhanceTargetModel：会话记录 > 引导页 > 默认；空壳不截断链条", () => {
	assert.deepEqual(
		plain(
			resolveEnhanceTargetModel({
				configured: null,
				recordModel: { provider: "record-p", modelId: "record-m" },
				welcomeModel: { provider: "welcome-p", modelId: "welcome-m" },
				fallback: { provider: "fb-p", modelId: "fb-m" },
			}),
		),
		{ provider: "record-p", modelId: "record-m" },
	);
	assert.deepEqual(
		plain(
			resolveEnhanceTargetModel({
				configured: null,
				recordModel: undefined,
				welcomeModel: { provider: "welcome-p", modelId: "welcome-m" },
				fallback: { provider: "fb-p", modelId: "fb-m" },
			}),
		),
		{ provider: "welcome-p", modelId: "welcome-m" },
	);
	// 上游曾传过半残形态（provider 有值 modelId 为空）：跳过该级继续向下解析。
	assert.deepEqual(
		plain(
			resolveEnhanceTargetModel({
				configured: null,
				recordModel: { provider: "record-p", modelId: "" },
				welcomeModel: { provider: "welcome-p", modelId: "welcome-m" },
				fallback: { provider: "fb-p", modelId: "fb-m" },
			}),
		),
		{ provider: "welcome-p", modelId: "welcome-m" },
	);
	assert.deepEqual(plain(resolveEnhanceTargetModel({ configured: null, fallback: { provider: "fb-p", modelId: "fb-m" } })), { provider: "fb-p", modelId: "fb-m" });
	assert.equal(resolveEnhanceTargetModel({ configured: null }), null);
});

test("normalizeEnhanceModel 超长截断到 200（防脏数据落盘；IPC 入口另有 160 拒收门）", () => {
	assert.deepEqual(plain(normalizeEnhanceModel({ provider: "p".repeat(300), modelId: "m" })), {
		provider: "p".repeat(200),
		modelId: "m",
	});
	assert.deepEqual(plain(normalizeEnhanceModel({ provider: "p", modelId: "m".repeat(300) })), {
		provider: "p",
		modelId: "m".repeat(200),
	});
});
