/**
 * 启动预热策略单测：只预热已开启的 provider、pi/dsh 反解正确、顺序稳定、错峰延迟递增。
 *
 * 背景：全局开关删除后，是否查询由每个 provider 徽章里的开关决定（默认关）。
 * 启动预热必须只挑 enabled=true 的条目，否则「默认关」就成了摆设。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { selectWarmupProviders, warmupDelayMs, PROVIDER_USAGE_WARMUP_GAP_MS } = loadTsCommonJs(
	"src/renderer/src/hooks/providerUsageWarmup.ts",
);

// loadTsCommonJs 用 vm 加载模块，产物是跨 realm 对象；deepStrictEqual 会按原型判等。
// 统一走 JSON 序列化比较（与 userUsageProbes.test.mjs 同一约定）。
const json = (value) => JSON.stringify(value);

function state(enabled, extra = {}) {
	return {
		enabled,
		configured: enabled,
		recognized: false,
		intervalMinutes: 5,
		...extra,
	};
}

test("只选 enabled=true 的 provider（默认关的不进预热名单）", () => {
	const targets = selectWarmupProviders({
		deepseek: state(true),
		offline: state(false),
		kimi: state(true),
	});
	assert.equal(json(targets.map((t) => `${t.backend}:${t.provider}`)), json(["pi:deepseek", "pi:kimi"]));
});

test("dsh 缓存 key 反解为原始 provider 名 + backend=dsh", () => {
	const targets = selectWarmupProviders({
		"dsh:deepseek": state(true),
		"dsh:opencode-go": state(true),
		deepseek: state(true),
	});
	assert.equal(
		json(targets.map((t) => `${t.backend}:${t.provider}`)),
		json(["pi:deepseek", "dsh:deepseek", "dsh:opencode-go"]),
	);
});

test("顺序稳定：pi 在前、各自按名字排序（每次启动请求顺序可预期）", () => {
	const a = selectWarmupProviders({ z: state(true), a: state(true), "dsh:b": state(true), "dsh:a": state(true) });
	const b = selectWarmupProviders({ "dsh:a": state(true), a: state(true), z: state(true), "dsh:b": state(true) });
	assert.equal(json(a), json(b));
	assert.equal(json(a.map((t) => `${t.backend}:${t.provider}`)), json(["pi:a", "pi:z", "dsh:a", "dsh:b"]));
});

test("空表 / 非法条目不炸", () => {
	assert.equal(json(selectWarmupProviders({})), "[]");
	assert.equal(json(selectWarmupProviders({ x: undefined })), "[]");
});

test("错峰延迟：第 0 个立即、后续按 gap 递增，非法 index 归零", () => {
	assert.equal(warmupDelayMs(0), 0);
	assert.equal(warmupDelayMs(1), PROVIDER_USAGE_WARMUP_GAP_MS);
	assert.equal(warmupDelayMs(3), PROVIDER_USAGE_WARMUP_GAP_MS * 3);
	assert.equal(warmupDelayMs(-5), 0);
	assert.equal(warmupDelayMs(Number.NaN), 0);
	// 自定义间隔可覆盖（便于测试/调整节奏）。
	assert.equal(warmupDelayMs(2, 100), 200);
});
