import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * DSH 历史分页「轮数 → 消息预算」换算策略的单测。
 *
 * 回归背景（2026-09）：渲染层的分页参数是**轮数**，host 的 session/page 以
 * **消息事件数**计数。单位错配让「加载更多对话」每点一次只前进 3 条消息，
 * 用户必须连点很多次；这里锁住换算口径（轮数 × 24 夹到 [60,120]，单页上限 240，
 * 最多 3 轮补取），避免以后再退回「参数直通」。
 */
const plan = loadTsCommonJs("src/main/dsh/dshHistoryPagePlan.ts");

/**
 * vm 上下文里造出来的数组 prototype 与测试字面量不同，deepStrictEqual 会误报；
 * 统一摊平成本文件上下文的新数组再比较（元素都是原始值）。
 */
const seqs = (entries) => [...entries.map((entry) => entry.event.seq)];

test("normalizeDshTurnPageSize：非法/越界轮数回退缺省并夹到 [1,10]", () => {
	assert.equal(plan.normalizeDshTurnPageSize(undefined), plan.DSH_HISTORY_DEFAULT_TURN_PAGE_SIZE);
	assert.equal(plan.normalizeDshTurnPageSize(Number.NaN), plan.DSH_HISTORY_DEFAULT_TURN_PAGE_SIZE);
	// 字符串是渲染层送来的不可信数据：非数字一律回退缺省值（不做隐式 Number 转换）
	assert.equal(plan.normalizeDshTurnPageSize("4"), plan.DSH_HISTORY_DEFAULT_TURN_PAGE_SIZE);
	assert.equal(plan.normalizeDshTurnPageSize(Number.POSITIVE_INFINITY), plan.DSH_HISTORY_DEFAULT_TURN_PAGE_SIZE);
	assert.equal(plan.normalizeDshTurnPageSize(0), 1, "0 轮也要给一页，不能返回空预算");
	assert.equal(plan.normalizeDshTurnPageSize(-5), 1);
	assert.equal(plan.normalizeDshTurnPageSize(2.7), 2, "小数向下取整");
	assert.equal(plan.normalizeDshTurnPageSize(3), 3);
	assert.equal(plan.normalizeDshTurnPageSize(999), plan.DSH_HISTORY_TURN_PAGE_LIMIT, "越界夹到上界（与 pi 的 MAX_TURN_PAGE_SIZE 对齐）");
});

test("planDshHistoryRounds：轮数 × 24 夹到 [60,120]，单页总量不超 240、最多 3 轮", () => {
	// 1 轮 → 24 条低于下界 → 抬到 60（稀疏会话一次点击也要有可见的一段历史）
	assert.deepEqual([...plan.planDshHistoryRounds(1)], [60, 60, 60]);
	// 3 轮（渲染层「加载更多」）→ 72
	assert.deepEqual([...plan.planDshHistoryRounds(3)], [72, 72, 72]);
	// 10 轮 → 240 超过上界 → 夹到 120；两轮铺满 240 即停
	assert.deepEqual([...plan.planDshHistoryRounds(10)], [120, 120]);
	for (const turns of [1, 2, 3, 5, 9, 10]) {
		const rounds = plan.planDshHistoryRounds(turns);
		assert.ok(rounds.length >= 1 && rounds.length <= plan.DSH_HISTORY_MAX_ROUNDS, `轮数 ${turns}：补取轮数不超上界`);
		assert.ok(rounds.reduce((sum, size) => sum + size, 0) <= plan.DSH_HISTORY_MAX_PAGE_MESSAGES, `轮数 ${turns}：单页预算不超 ${plan.DSH_HISTORY_MAX_PAGE_MESSAGES} 条消息`);
		for (const size of rounds) {
			assert.ok(size >= plan.DSH_HISTORY_MIN_ROUND_MESSAGES && size <= plan.DSH_HISTORY_MAX_ROUND_MESSAGES, `轮数 ${turns}：单轮预算 ${size} 在 [下界, 上界] 内`);
		}
	}
});

test("isDshMessageEventType：只有 user/assistant 消息计入分页单位（与 host MESSAGE_TYPES 同源）", () => {
	assert.equal(plan.isDshMessageEventType("user/message"), true);
	assert.equal(plan.isDshMessageEventType("assistant/message"), true);
	assert.equal(plan.isDshMessageEventType("turn/start"), false);
	assert.equal(plan.isDshMessageEventType("tool/result"), false);
	assert.equal(plan.isDshMessageEventType(undefined), false);
});

test("countDshUserMessages：只数 user/message（assistant 与工具事件不计）", () => {
	const entries = [{ event: { type: "turn/start", seq: 1 } }, { event: { type: "user/message", seq: 2 } }, { event: { type: "assistant/message", seq: 3 } }, { event: { type: "user/message", seq: 4 } }, { event: { type: "tool/result", seq: 5 } }];
	assert.equal(plan.countDshUserMessages(entries), 2);
	assert.equal(plan.countDshUserMessages([]), 0);
});

test("assembleDshHistoryEntries：多批合并去重、按 seq 升序、丢弃越界事件", () => {
	// 批内新→旧（host 分页语义），合并后必须是全局升序
	const merged = plan.assembleDshHistoryEntries(
		[
			[{ event: { type: "user/message", seq: 7 } }, { event: { type: "assistant/message", seq: 8 } }],
			[{ event: { type: "turn/start", seq: 4 } }, { event: { type: "user/message", seq: 5 } }],
		],
		undefined,
	);
	assert.deepEqual(seqs(merged.entries), [4, 5, 7, 8]);
	assert.equal(merged.droppedByContract, 0);

	// 重叠 seq 去重 + 缺 seq 的异常事件按原顺序保留（不参与去重）
	const deduped = plan.assembleDshHistoryEntries([[{ event: { type: "user/message", seq: 5 } }, { event: { type: "x", seq: undefined } }], [{ event: { type: "assistant/message", seq: 5 } }]], undefined);
	assert.equal(deduped.entries.length, 2, "seq 5 只保留一次");
	// 合并顺序是「最旧的一批先放入」：跨批重名（seq 5）保留更旧的那条，
	// 缺 seq 的异常事件按 seq 缺省 0 排在最前（不参与去重）
	assert.equal(deduped.entries[0].event.type, "x");
	assert.equal(deduped.entries[1].event.type, "assistant/message");
	assert.ok(!deduped.entries.some((entry) => entry.event.type === "user/message"), "较新批次里的重复事件被丢弃");

	// 契约防御：host 回了 seq ≥ beforeSeq（排除边界）的事件 → 丢弃并计数，
	// 否则渲染层拿到的游标会在原地打转（再点一次拿到同一页）
	const bounded = plan.assembleDshHistoryEntries([[{ event: { type: "user/message", seq: 9 } }, { event: { type: "assistant/message", seq: 8 } }, { event: { type: "user/message", seq: 5 } }]], 9);
	assert.deepEqual(seqs(bounded.entries), [5, 8]);
	assert.equal(bounded.droppedByContract, 1);
});

test("trimToOldestTurnStart：只在 hasMore 时把页首裁到完整轮起点", () => {
	const entries = [
		{ event: { type: "assistant/message", seq: 1 } }, // 上一轮的后半截
		{ event: { type: "assistant/message", seq: 2 } },
		{ event: { type: "turn/start", seq: 3 } },
		{ event: { type: "user/message", seq: 4 } },
	];
	assert.deepEqual(seqs(plan.trimToOldestTurnStart(entries, true)), [3, 4], "页首半轮剪掉，下次点击会重新取到（游标已指向裁剪后的起点）");
	assert.equal(plan.trimToOldestTurnStart(entries, false).length, 4, "已到会话开头（hasMore=false）时不裁剪，否则前言会被吃掉");
	assert.equal(plan.trimToOldestTurnStart([{ event: { type: "user/message", seq: 1 } }], true).length, 1, "老日志没有 turn/start 时保持 host 切点");
	assert.deepEqual(seqs(plan.trimToOldestTurnStart(entries.slice(2), true)), [3, 4], "页首本身就是 turn/start 时不动（index=0）");
});
