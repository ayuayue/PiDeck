import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const policy = load("src/renderer/src/components/session/timeline/restoreAnchorPolicy.ts");

const step = (overrides = {}) =>
	policy.resolveMissingAnchorNextStep({
		windowExpandable: false,
		hasEarlierPages: true,
		loadingEarlier: false,
		loadAttempts: 0,
		...overrides,
	});

test("已加载数据还有未挂载的轮次时先扩窗（无 I/O，优先于补页）", () => {
	assert.equal(step({ windowExpandable: true, loadingEarlier: true, loadAttempts: 99 }), "expand");
});

test("窗口已覆盖已加载数据且还有更早历史时补一页", () => {
	assert.equal(step(), "load");
});

test("补页在途时等待，不重复请求也不提前落底", () => {
	// 第 3 次补页刚发出时 attempts 已等于上限：必须先等这次结果，否则白读。
	assert.equal(step({ loadingEarlier: true, loadAttempts: 3 }), "wait");
	assert.equal(step({ loadingEarlier: true, loadAttempts: 0 }), "wait");
});

test("没有更早历史或补页预算用完时落底", () => {
	assert.equal(step({ hasEarlierPages: false }), "bottom");
	assert.equal(step({ loadAttempts: 3 }), "bottom");
	assert.equal(step({ loadAttempts: 4 }), "bottom");
});

test("补页上限可覆盖（调用方传更小的预算）", () => {
	assert.equal(step({ loadAttempts: 1, pageLimit: 2 }), "load");
	assert.equal(step({ loadAttempts: 2, pageLimit: 2 }), "bottom");
	// 0 表示这次恢复一次都不补，直接落底（不落顶部）。
	assert.equal(step({ loadAttempts: 0, pageLimit: 0 }), "bottom");
});
