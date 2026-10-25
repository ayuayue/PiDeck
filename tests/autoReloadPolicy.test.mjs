import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { computeCrashReloadPlan, MAX_AUTO_RELOAD_ATTEMPTS, CRASH_AUTO_RELOAD_WINDOW_MS } = loadTsCommonJs("src/renderer/src/utils/autoReloadPolicy.ts");

// vm 上下文对象的原型与宿主不同，deepStrictEqual 会误报；与 modelPickerDefaultExpansion 测试一致用 JSON 比较。
function assertEqual(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test("无存储：首次崩溃 count=1，允许自动刷新", () => {
	assertEqual(computeCrashReloadPlan({ stored: null, now: 1000 }), {
		count: 1,
		shouldAutoReload: true,
	});
});

test("窗口内连续崩溃累计，前 3 次均允许自动刷新", () => {
	let plan = computeCrashReloadPlan({ stored: null, now: 1000 });
	assert.equal(plan.shouldAutoReload, true);
	for (let i = 2; i <= 3; i++) {
		plan = computeCrashReloadPlan({ stored: { count: i - 1, at: 1000 + (i - 1) * 1000 }, now: 1000 + i * 1000 });
		assertEqual(plan, { count: i, shouldAutoReload: true });
	}
});

test("第 4 次崩溃（窗口内）停止自动刷新", () => {
	const plan = computeCrashReloadPlan({
		stored: { count: 3, at: 5000 },
		now: 6000,
	});
	assertEqual(plan, { count: 4, shouldAutoReload: false });
});

test("窗口外崩溃：重置计数重新允许自动刷新", () => {
	// 距上次崩溃已超过窗口（60s），重新从 1 计数
	const plan = computeCrashReloadPlan({
		stored: { count: 3, at: 0 },
		now: CRASH_AUTO_RELOAD_WINDOW_MS + 1,
	});
	assertEqual(plan, { count: 1, shouldAutoReload: true });
});

test("窗口边界：恰好 60s 视为窗口外（严格小于才累计）", () => {
	const plan = computeCrashReloadPlan({
		stored: { count: 3, at: 0 },
		now: CRASH_AUTO_RELOAD_WINDOW_MS,
	});
	assertEqual(plan, { count: 1, shouldAutoReload: true });
});

test("MAX_AUTO_RELOAD_ATTEMPTS 为 3（刷新 3 次后停止）", () => {
	assert.equal(MAX_AUTO_RELOAD_ATTEMPTS, 3);
});
