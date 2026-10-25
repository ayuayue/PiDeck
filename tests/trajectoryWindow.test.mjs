import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 轨迹渲染预算纯函数（计划 §5 S3）：账本窗口与概览聚合。
 * 判定目标：挂载量只随窗口走、不随会话长度走；概览标记数服从像素预算。
 */

const { buildTrajectoryWindow, bucketOverviewTicks, TRAJECTORY_TURN_COHORT, TRAJECTORY_TURN_STEP_LIMIT, TRAJECTORY_EXTRA_RECORD_BUDGET } = loadTsCommonJs("src/renderer/src/components/session/trajectory/trajectoryWindow.ts");

const LANES = ["input", "model", "tools", "process"];

function makeRecords({ turns, perTurn }) {
	const records = [];
	for (let turn = 0; turn < turns; turn += 1) {
		for (let step = 0; step < perTurn; step += 1) {
			records.push({
				id: `t${turn}-${step}`,
				kind: "process",
				lane: LANES[step % LANES.length],
				turnIndex: turn,
				title: "x",
				summary: "x",
				startedAt: turn * 1000 + step,
			});
		}
	}
	return records;
}

test("15k 消息样本只挂载尾部 3 轮且单轮不超 120 条", () => {
	const records = makeRecords({ turns: 100, perTurn: 150 });
	const windowed = buildTrajectoryWindow(records);
	assert.ok(windowed.records.length <= TRAJECTORY_TURN_COHORT * TRAJECTORY_TURN_STEP_LIMIT + TRAJECTORY_EXTRA_RECORD_BUDGET);
	assert.equal(windowed.endTurn, 99);
	assert.equal(windowed.startTurn, 97);
	assert.equal(windowed.hasEarlier, true);
	assert.equal(windowed.trimmed, true, "单轮 150 条超过步数预算，必须标记 trimmed");
	// 尾部内容必须在（最新一轮的末尾记录不能丢）。
	assert.equal(windowed.records[windowed.records.length - 1].id, "t99-149");
});

test("短会话不裁剪，hasEarlier=false", () => {
	const records = makeRecords({ turns: 2, perTurn: 10 });
	const windowed = buildTrajectoryWindow(records);
	assert.equal(windowed.records.length, 20);
	assert.equal(windowed.hasEarlier, false);
	assert.equal(windowed.trimmed, false);
});

test("空会话返回空窗口", () => {
	const windowed = buildTrajectoryWindow([]);
	assert.equal(windowed.records.length, 0);
	assert.equal(windowed.hasEarlier, false);
});

test("概览每 lane 刻度不超过像素预算，且选中项一定有刻度", () => {
	const records = makeRecords({ turns: 100, perTurn: 150 });
	const ticks = bucketOverviewTicks(records, { lanes: LANES, width: 300 });
	const perLane = Math.max(1, Math.min(250, Math.ceil(300 / 4)));
	assert.ok(ticks.length <= LANES.length * perLane + 1, `刻度数 ${ticks.length} 超出预算`);
	for (const lane of LANES) {
		assert.ok(ticks.filter((tick) => tick.lane === lane).length <= perLane);
	}
	const selected = bucketOverviewTicks(records, { lanes: LANES, width: 300, selectedId: "t50-3" });
	assert.ok(selected.some((tick) => tick.selected && tick.recordId === "t50-3") || selected.some((tick) => tick.selected));
});

test("概览桶内计数守恒（聚合不吞记录）", () => {
	const records = makeRecords({ turns: 20, perTurn: 40 });
	const ticks = bucketOverviewTicks(records, { lanes: LANES, width: 1200 });
	const total = ticks.reduce((sum, tick) => sum + tick.count, 0);
	assert.equal(total, records.length);
});

test("宽度极小也不出现 0 刻度", () => {
	const records = makeRecords({ turns: 1, perTurn: 4 });
	const ticks = bucketOverviewTicks(records, { lanes: LANES, width: 1 });
	assert.ok(ticks.length > 0);
});

test("导轨目录合并：已加载项保留原标题，未加载项用索引预览（不是序号占位）", async () => {
	const { mergeOutlineRailItems, isPendingRailItemId, pendingEntryIdOf } = loadTsCommonJs("src/renderer/src/components/session/timeline/outlineRailTicks.ts");
	const loaded = [
		{ id: "m1", entryId: "e1", role: "user", title: "第一条提问", time: "10:00" },
		{ id: "m3", entryId: "e3", role: "user", title: "第二条提问", time: "10:05" },
	];
	const directory = [
		// 标题来自索引里持久化的 preview：加载前后是同一句话，不再显示 #序号。
		{ entryId: "e1", title: "第一条提问", time: "10/21 10:00" },
		{ entryId: "e2", title: "中间那条还没加载的提问", time: "10/21 10:01" },
		{ entryId: "e3", title: "第二条提问", time: "10/21 10:05" },
	];
	const merged = mergeOutlineRailItems(loaded, directory);
	assert.equal(merged.length, 3);
	assert.equal(merged[0].id, "m1", "已加载项必须复用原对象（标题以时间线为准）");
	assert.equal(merged[1].pending, true);
	assert.equal(merged[1].title, "中间那条还没加载的提问");
	assert.equal(merged[1].time, "10/21 10:01", "时间必须是格式化后的展示文本，不是原始 ISO");
	assert.equal(isPendingRailItemId(merged[1].id), true);
	assert.equal(pendingEntryIdOf(merged[1].id), "e2");
	assert.equal(merged[2].id, "m3");
});

test("目录为空时退回已加载大纲（非 pi 后端）", async () => {
	const { mergeOutlineRailItems } = loadTsCommonJs("src/renderer/src/components/session/timeline/outlineRailTicks.ts");
	const loaded = [{ id: "m1", role: "user", title: "只有已加载", time: "10:00" }];
	assert.equal(mergeOutlineRailItems(loaded, []).length, 1);
});

test("窗口外的会话开头（初始提示词）不被裁掉", () => {
	const records = [{ id: "sys", kind: "systemPrompt", lane: "input", turnIndex: 0, title: "初始提示词", summary: "initial", startedAt: 0 }, ...makeRecords({ turns: 40, perTurn: 30 })];
	const windowed = buildTrajectoryWindow(records);
	assert.ok(
		windowed.records.some((record) => record.id === "sys"),
		"初始提示词必须留在账本开头",
	);
	assert.ok(windowed.records.length <= TRAJECTORY_TURN_COHORT * TRAJECTORY_TURN_STEP_LIMIT + TRAJECTORY_EXTRA_RECORD_BUDGET);
});

test("轮摘要只统计已有数据（步数/工具数/耗时/token），不引入新来源", async () => {
	const { summarizeTurn } = loadTsCommonJs("src/renderer/src/components/session/trajectory/trajectoryFold.ts");
	const records = [
		{ id: "u", kind: "user", lane: "input", turnIndex: 0, title: "", summary: "", startedAt: 0 },
		{ id: "t1", kind: "tool", lane: "tools", turnIndex: 0, title: "", summary: "", startedAt: 1 },
		{ id: "t2", kind: "tool", lane: "tools", turnIndex: 0, title: "", summary: "", startedAt: 2 },
		{ id: "a", kind: "assistant", lane: "model", turnIndex: 0, title: "", summary: "", startedAt: 3, usage: { inputTokens: 1200, outputTokens: 300, reasoningTokens: 40 } },
	];
	const summary = summarizeTurn({ index: 0, id: "t0", startedAt: 0, inFlight: false, durationMs: 3400, records }, records);
	assert.equal(summary.steps, 4);
	assert.equal(summary.toolCalls, 2);
	assert.equal(summary.inputTokens, 1200);
	assert.equal(summary.outputTokens, 300);
	assert.equal(summary.reasoningTokens, 40);
	assert.equal(summary.durationMs, 3400);
	// 没有 usage 时不编造 token
	const bare = summarizeTurn(undefined, [records[0]]);
	assert.equal(bare.inputTokens, 0);
	assert.equal(bare.durationMs, undefined);
});

test("连续工具调用超过阈值才折叠，未超过原样输出", async () => {
	const { foldTurnRecords, TRAJECTORY_STEP_GROUP_LIMIT } = loadTsCommonJs("src/renderer/src/components/session/trajectory/trajectoryFold.ts");
	const tools = (count, prefix) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, kind: "tool", lane: "tools", turnIndex: 0, title: "", summary: "", startedAt: index }));
	const short = foldTurnRecords(tools(TRAJECTORY_STEP_GROUP_LIMIT, "a"));
	assert.equal(short.filter((item) => item.type === "group").length, 0);
	const long = foldTurnRecords(tools(TRAJECTORY_STEP_GROUP_LIMIT + 1, "b"));
	assert.equal(long.length, 1);
	assert.equal(long[0].type, "group");
	assert.equal(long[0].toolCalls, TRAJECTORY_STEP_GROUP_LIMIT + 1);
});

test("默认折叠除最后一轮以外全部轮次，折叠时露出该轮首条用户消息", async () => {
	const { defaultFoldedTurns, foldedTurnPeek } = loadTsCommonJs("src/renderer/src/components/session/trajectory/trajectoryFold.ts");
	const turns = [0, 1, 2].map((index) => ({ index, id: `t${index}`, startedAt: index, inFlight: false, records: [] }));
	assert.equal(defaultFoldedTurns(turns).join(","), "0,1");
	const peek = foldedTurnPeek([
		{ id: "t1", kind: "tool", lane: "tools", turnIndex: 0, title: "", summary: "", startedAt: 1 },
		{ id: "u", kind: "user", lane: "input", turnIndex: 0, title: "", summary: "", startedAt: 2 },
	]);
	assert.equal(peek.id, "u");
});
