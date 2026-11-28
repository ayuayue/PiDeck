import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 跳转取页的代价判据：轮数上限，以及不许复用「补历史」那个 200。
 *
 * 跳转慢的根因不是取页（161ms 很便宜），是**载荷**。200 轮在 700 轮级会话里是
 * 3731 条 / 6.6MB，JSON 解析与进 atom 都是白花钱——用户只看那一条。
 * 实测（3 会话 × 5 位置）：200 轮 6784KB/165ms、64 轮 2260KB/61ms、
 * 32 轮 1202KB/28ms、16 轮 506KB/17ms。命中率与轮数无关（12/15，miss 全是
 * position 0 的不可显示条目），所以轮数只买载荷。
 *
 * 反例（这条能红）：把 JUMP_PAGE_TURN_SIZE 改回 200，或让跳转复用
 * HISTORY_BACKFILL_TURN_PAGE_SIZE —— 两种都会让首屏载荷回到 6MB 级。
 */
const POLICY = "src/renderer/src/components/session/timeline/historyPagePolicy.ts";
const HOOK = "src/renderer/src/components/session/timeline/useJumpPageFetch.ts";

test("跳转取页轮数不超过 64（载荷实测：64 轮 2.2MB，200 轮 6.6MB）", () => {
	const { JUMP_PAGE_TURN_SIZE } = loadTsCommonJs(POLICY);
	assert.ok(Number.isFinite(JUMP_PAGE_TURN_SIZE), "JUMP_PAGE_TURN_SIZE 必须是数字");
	assert.ok(JUMP_PAGE_TURN_SIZE <= 64, "跳转取页 " + JUMP_PAGE_TURN_SIZE + " 轮太大：载荷随轮数线性涨");
});

test("跳转取页不复用「补历史」的 200 轮常量", () => {
	const source = readFileSync(HOOK, "utf8");
	const offenders = source
		.split("\n")
		.map((line, index) => ({ line: line.trim(), number: index + 1 }))
		.filter((entry) => /readRecordMessagePage\([^)]*HISTORY_BACKFILL_TURN_PAGE_SIZE/.test(entry.line));
	assert.deepEqual(offenders, [], "跳转取页用了补页常量：补页希望多加载，跳转只要目标");
});
