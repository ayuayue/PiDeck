import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("resolveDshHistoryWindow：hasMore 时用窗口最旧事件 seq 做续页游标，否则不开放补页", () => {
	// 事件可能乱序：取最小 seq，而不是数组第一个
	const entries = [{ event: { type: "assistant/message", seq: 12 } }, { event: { type: "turn/start", seq: 7 } }, { event: { type: "user/message", seq: 9 } }];
	assert.deepEqual({ ...plan.resolveDshHistoryWindow(entries, true) }, { historyHasOlder: true, historyBeforeSeq: 7 });
	// 已含会话开头：没有更早历史，不开放补页（否则游标原地打转）
	assert.deepEqual({ ...plan.resolveDshHistoryWindow(entries, false) }, { historyHasOlder: false });
	// 没有任何可解析 seq：无法定位边界，宁可不补页
	assert.deepEqual({ ...plan.resolveDshHistoryWindow([{ event: { type: "x", seq: undefined } }], true) }, { historyHasOlder: false });
	assert.deepEqual({ ...plan.resolveDshHistoryWindow([], true) }, { historyHasOlder: false });
});

test("dshRuntimeWindowFields：截断窗口用「有更早历史 = 1」标记 + seq 游标，卡片数恒 0", () => {
	// 有更早历史：windowStart 标记 1，totalLength 同步 +1（len − totalLength + windowStart = 0）
	const truncated = plan.dshRuntimeWindowFields({ messageCount: 173, historyHasOlder: true, historyBeforeSeq: 7 });
	assert.equal(truncated.totalLength, 174);
	assert.equal(truncated.windowStart, 1);
	assert.equal(truncated.windowStartFilePos, 7);
	assert.equal(truncated.totalLength - truncated.windowStart, 173, "卡片数推导必须为 0（否则增量合并偏移会错位）");
	// 已含会话开头：不开放补页，不带任何窗口字段（全窗口语义）
	assert.deepEqual({ ...plan.dshRuntimeWindowFields({ messageCount: 12, historyHasOlder: false, historyBeforeSeq: 7 }) }, { totalLength: 12 });
	// 有更早历史但拿不到游标：不能补页（宁可不给入口，也不让游标原地打转）
	assert.deepEqual({ ...plan.dshRuntimeWindowFields({ messageCount: 12, historyHasOlder: true, historyBeforeSeq: undefined }) }, { totalLength: 12 });
});

test("接线：attach 截断信息进运行时窗口协议（main），渲染层用同一游标补页", () => {
	const read = (file) => readFileSync(file, "utf8");
	const manager = read("src/main/dsh/DshAgentManager.ts");
	// 四个 attach 入口（create/restart/崩溃恢复/fork）都要记录窗口边界
	const recorded = manager.match(/this\.recordDshHistoryWindow\(/g) ?? [];
	assert.equal(recorded.length, 4, `create/restart/崩溃恢复/fork 四个 attach 入口都要记录窗口边界，实际 ${recorded.length}`);
	assert.match(manager, /private recordDshHistoryWindow\(/);
	assert.match(manager, /getMessageWindow\(agentId: string\)/);
	assert.match(manager, /dshRuntimeWindowFields\(\{\s*messageCount: runtime\.messages\.length/);
	// 渲染层：windowStart 决定「还有更早历史」，windowStartFilePos 作为首次补页游标
	const controller = read("src/renderer/src/hooks/useSessionTimelineController.ts");
	assert.match(controller, /cachedEntry\.windowStart\s*\?\?\s*0\)\s*>\s*0/);
	assert.match(controller, /typeof cachedEntry\?\.windowStartFilePos === "number" \? cachedEntry\.windowStartFilePos : undefined/);
});
