import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * #560 ③：CodeBuddy ≥2.184 的逐次模型调用指标（usage 的 `model_calls`）。
 * 线格式：`session/update.params.update._meta.usage.model_calls`（不是 update.usage.model_calls）。
 */
const { parseUsageUpdate } = loadTsCommonJs("src/main/acp/acpWireTolerance.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("读取 _meta.usage.model_calls 并映射为稳定字段名", () => {
	const usage = parseUsageUpdate({
		sessionUpdate: "usage_update",
		_meta: {
			usage: {
				model_calls: [
					{ attempt_no: 1, duration_ms: 1200, time_to_first_token_ms: 300, model: "deepseek-flash", result: "ok", finish_reason: "stop", output_tokens: 88 },
					{ attempt_no: 2, duration_ms: 900, time_to_first_token_ms: 250 },
				],
			},
		},
	});
	assert.deepEqual(plain(usage.modelCalls), [
		{ attempt: 1, durationMs: 1200, firstTokenMs: 300, model: "deepseek-flash", result: "ok", finishReason: "stop", outputTokens: 88 },
		{ attempt: 2, durationMs: 900, firstTokenMs: 250 },
	]);
});

test("缺失字段就是未知：不补 0，坏条目跳过而不是整条丢弃", () => {
	const usage = parseUsageUpdate({
		_meta: { usage: { model_calls: [{ attempt_no: "1" }, null, { duration_ms: 500 }] } },
	});
	assert.deepEqual(plain(usage.modelCalls), [{ durationMs: 500 }]);
});

test("基础 usage 不受指标影响：放在顶层/usage 子对象的老位形照旧解析", () => {
	const usage = parseUsageUpdate({ used: 1200, size: 100000, _meta: { usage: { model_calls: [{ attempt_no: 1 }] } } });
	assert.equal(usage.used, 1200);
	assert.equal(usage.size, 100000);
	assert.equal(usage.modelCalls.length, 1);
});

test("没有 model_calls / 只放错位置时不伪造指标", () => {
	for (const update of [
		{ used: 1, size: 2 },
		{ model_calls: [{ attempt_no: 1 }] }, // 错位：规范在 _meta.usage 下
		{ _meta: { usage: { model_calls: [] } } },
		{ _meta: { usage: { model_calls: "nope" } } },
	]) {
		const usage = parseUsageUpdate(update);
		assert.equal(usage?.modelCalls, undefined);
	}
});
