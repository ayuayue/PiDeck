import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 补页预算必须计「真的发出的请求」，不能计「策略要求补页的次数」。
 *
 * 2026-11 真机：点第 1 条弹「未能跳转（H3）：补页 40 次仍未把这条拉进来」。
 * 实际一次请求都没发出去 —— loadMoreMessages 在「游标已到文件头 / 无 diskPage /
 * 无 cursor」时静默 return，而 effect 无条件 loadAttempts + 1，40 次空转烧断保险丝。
 *
 * 判据：返回值携带「是否发出」这个证据，调用方只在 true 时消耗预算。
 */

const PAGING = "src/renderer/src/hooks/session/timeline/useTimelineHistoryPaging.ts";
const CONTROLLER = "src/renderer/src/hooks/useSessionTimelineController.ts";
const CONTRACT = "src/renderer/src/hooks/session/timeline/sessionTimelineControllerContract.ts";

test("loadMoreMessages 返回 boolean：发出 = true，发不出 = false", () => {
	const src = readFileSync(PAGING, "utf8");
	assert.equal(src.includes("): boolean => {"), true, "实现必须声明 boolean");
	assert.equal(src.includes('lastPrependResultRef.current = "unsent";'), true, "发不出去要记具名结果");
	assert.equal(src.includes("return false;"), true, "两分支都没进也要 return false");
	assert.match(src, /return true;/, "成功发出必须 return true");
});

test("契约三处都声明 boolean（不许有一处还是 void）", () => {
	for (const p of [CONTRACT, PAGING]) {
		const src = readFileSync(p, "utf8");
		assert.match(src, /loadMoreMessages: \(source\?:[^)]*\) => boolean;/, p + " 必须 boolean");
	}
});

test("跳转走一次性路径：索引定位 + 一次取页，不再逐页往前补", () => {
	// 一次性取页 2026-11-25 搬进 useTimelineJumpChain（控制器只剩装配）：两份拼接。
	const src = readFileSync(CONTROLLER, "utf8") + readFileSync("src/renderer/src/hooks/session/timeline/useTimelineJumpChain.ts", "utf8");
	// 2026-11 用户原话：「直接全部建立 index 索引，跳转过去不就完了」。
	// 补页链（loadMoreMessages 循环 + stalledAttempts + 可重试性分类）在「一次性取页」
	// 这一步之后全部退化成兜底，主线只该有一个调用点。
	assert.equal(src.includes("loadPageAroundEntry"), true, "必须走一次性取页");
	assert.equal(src.includes("jumpFailed.not-in-branch"), true, "取不到要说「不在活动分支」，不是无限补页");
});
