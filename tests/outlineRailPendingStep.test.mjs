import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { planRailPendingStep, RAIL_PENDING_MAX_ATTEMPTS } = loadTsCommonJs("src/renderer/src/components/session/timeline/outlineRailTicks.ts");

/**
 * 回归：点会话大纲最上面的刻度，弹出「这条提问还在更早的历史里，继续向上翻一会儿再点」，
 * 而不是直接跳过去（2026-10 真机反馈：62 轮会话，最上面那条永远点不到）。
 *
 * 根因：渲染层每 60ms 轮询一次 loadMoreMessages，而它在上一页仍在飞时直接 return
 * （in-flight 守卫）——轮询全部空转，10 次预算烧在等待上，一页 3 轮，实际只补到几页。
 * 现在的判据：加载中只等待、不消耗预算；有更早页就补；确实没有页/补页失败/保险丝烧断才交回。
 */

const BASE = {
	targetLoaded: false,
	isLoadingMore: false,
	hasMoreMessages: true,
	loadFailed: false,
	attempts: 0,
	maxAttempts: RAIL_PENDING_MAX_ATTEMPTS,
};

test("目标已经在已加载消息里：直接跳", () => {
	assert.equal(planRailPendingStep({ ...BASE, targetLoaded: true }), "jump");
});

test("上一页仍在飞：只等待，不消耗预算（旧实现在这里空转烧预算）", () => {
	// 次数已经用尽也还是等——等待不是一次尝试。
	assert.equal(planRailPendingStep({ ...BASE, isLoadingMore: true }), "wait");
	assert.equal(planRailPendingStep({ ...BASE, isLoadingMore: true, attempts: RAIL_PENDING_MAX_ATTEMPTS }), "wait");
	// 坏形状：把 wait 判成 settle（旧 bug 的表现）或 load（重复发页）都会红。
	assert.notEqual(planRailPendingStep({ ...BASE, isLoadingMore: true }), "settle");
	assert.notEqual(planRailPendingStep({ ...BASE, isLoadingMore: true }), "load");
});

test("还有更早的页：继续补", () => {
	assert.equal(planRailPendingStep(BASE), "load");
});

test("没有更早的页：交回落位，不空转", () => {
	assert.equal(planRailPendingStep({ ...BASE, hasMoreMessages: false }), "settle");
});

test("上一次补页失败：不再重复补，直接交回", () => {
	assert.equal(planRailPendingStep({ ...BASE, loadFailed: true }), "settle");
});

test("保险丝：次数用尽才放弃，且深度覆盖整会话", () => {
	assert.equal(planRailPendingStep({ ...BASE, attempts: RAIL_PENDING_MAX_ATTEMPTS - 1 }), "load");
	assert.equal(planRailPendingStep({ ...BASE, attempts: RAIL_PENDING_MAX_ATTEMPTS }), "settle");
	// 一页 3 轮：60 页 ≈ 180 轮，旧值 10 页 ≈ 30 轮不够覆盖长会话。
	assert.ok(RAIL_PENDING_MAX_ATTEMPTS >= 40, "补页保险丝至少要覆盖 120 轮历史");
});
