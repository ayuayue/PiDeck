import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 守卫状态不能在自己最深的失败路径上没人清 —— 与 useTimelineHistoryPaging 里那个
 * isLoadingMessagePage 是同一个形状（2026-11 真机）。
 *
 * 这里锁的是 jumpPending：补页失败时 pendingJump 必须留着（重试成功后继续落位），
 * 但对外暴露的 jumpPending 必须是「活跃跳转」。否则 followingForTurnWindow 恒为 false，
 * 贴底跟随永久失效 —— 用户看到的是「加载不完整之后，新消息也不跟着滚了」。
 */

const PATH = "src/renderer/src/hooks/useSessionTimelineController.ts";
/** 跳转链状态机 2026-11-25 搬进 useTimelineJumpChain：两份拼起来看，否则搬迁后恒绿。 */
const CHAIN = "src/renderer/src/hooks/session/timeline/useTimelineJumpChain.ts";
const readSource = () => readFileSync(PATH, "utf8") + readFileSync(CHAIN, "utf8");

test("jumpPending 只报活跃跳转，不报等待重试的挂起跳转", () => {
	const source = readSource();
	const declaration = source.match(/^\s*jumpPending:\s*([^,]+),/m);
	assert.ok(declaration, "必须有 jumpPending 字段");
	assert.match(declaration[1], /pendingJump !== undefined/, "跳转本身仍是挂起判据");
	assert.match(declaration[1], /loadMoreError === null/, "补页失败时必须不再报「在途」，否则跟随永久失效");
});

test("挂起跳转在补页失败时不丢弃（重试后要能继续落位）", () => {
	const source = readSource();
	assert.match(source, /if \(!stillInData && loadMoreError\) return;/, "失败时原地等待，不放弃目标");
	assert.match(source, /pendingJump !== undefined && loadMoreError === null/, "两条判据必须同时存在");
});
