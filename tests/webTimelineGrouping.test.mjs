import assert from "node:assert/strict";
import { test } from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * Web 时间线分组（groupTimelineEntries）回归：
 * 提升规则对齐桌面 buildTurnDisplay——流式中末段正文不提升为最终回答（挂 liveTextId
 * 容器外常显），回合结束且末段为正文才提升；末段为工具/思考时全部正文都是中间回复。
 * 背景（用户反馈）：流式期间先看到「中间回复」被提升，随后过程组出现在它上方，
 * 视觉顺序与桌面端不一致且反复跳动；2027-04 Web 端对齐桌面 isComplete 门控。
 */

const load = createTsSandbox();
const { groupTimelineEntries } = load("src/renderer/src/web/webTimelineGrouping.ts");
// ── 回合前缀缓存（2027-02 性能治理）：流式期每帧只重分组当前回合 ──────────────
const { validTurnPrefix, turnPrefixBoundary, sliceEntriesToBoundary } = load("src/renderer/src/web/webTimelineGrouping.ts");

test("前缀缓存：引用稳定命中；流式中边界=当前回合起点；失稳回退全量", () => {
	const frame1 = [user("u1", "hi"), assistant("a1", [text("回答一")]), user("u2", "again"), assistant("a2", [text("正在打字…")])];
	const entries1 = groupTimelineEntries(frame1, { isStreaming: true });
	// 流式中可缓存边界 = u2 的下标（当前回合起点），不含 u2 气泡本身
	const boundary = turnPrefixBoundary(frame1, true);
	assert.equal(boundary, 2);
	const prefix1 = sliceEntriesToBoundary(entries1, boundary);
	assert.equal(prefix1.length, 2, "前缀 = u1 气泡 + 第一回合");
	const cache = { messages: frame1.slice(0, boundary), entries: prefix1, consumed: boundary };

	// 下一帧：流式尾消息对象重建，前缀引用稳定 → 命中
	const evolvedTail = assistant("a2", [text("正在打字…更长")]);
	const frame2 = [frame1[0], frame1[1], frame1[2], evolvedTail];
	const hit = validTurnPrefix(cache, frame2);
	assert.ok(hit, "前缀引用稳定必须命中");
	assert.equal(hit.consumed, 2);

	// 前缀失稳（u1 被编辑成新对象）：回退全量
	const editedFrame = [user("u1", "编辑后"), frame1[1], frame1[2], evolvedTail];
	assert.equal(validTurnPrefix(cache, editedFrame), null, "前缀失稳必须返回 null");

	// 非流式：边界 = 全量
	assert.equal(turnPrefixBoundary(frame2, false), 4);
	// 空数组/无 user 前导：流式边界为 0（无可缓存前缀）
	assert.equal(turnPrefixBoundary([assistant("a0", [text("x")])], true), 0);
});

test("前缀缓存的 suffix 重分组与全量分组结果一致（含 liveTextId 语义）", () => {
	const frame = [user("u1", "hi"), assistant("a1", [text("回答一")]), user("u2", "again"), assistant("a2", [tool("t2"), text("流式正文")])];
	const full = groupTimelineEntries(frame, { isStreaming: true });
	const boundary = turnPrefixBoundary(frame, true);
	const prefix = sliceEntriesToBoundary(full, boundary);
	const suffix = groupTimelineEntries(frame.slice(boundary), { isStreaming: true });
	const combined = [...prefix, ...suffix];
	assert.equal(combined.length, full.length);
	for (let i = 0; i < full.length; i += 1) {
		assert.equal(combined[i].kind, full[i].kind);
		assert.equal(combined[i].id, full[i].id);
		if (full[i].kind === "turn" && combined[i].kind === "turn") {
			assert.equal(combined[i].turn.finalText, full[i].turn.finalText);
			assert.equal(combined[i].turn.liveTextId, full[i].turn.liveTextId);
			assert.equal(combined[i].turn.segments.length, full[i].turn.segments.length);
		}
	}
});

const user = (id, text) => ({ id, role: "user", parts: [{ type: "text", text }] });
const assistant = (id, parts) => ({ id, role: "assistant", parts });
const text = (t) => ({ type: "text", text: t });
const reasoning = (t, state = "done") => ({ type: "reasoning", text: t, state });
const tool = (callId, state = "output") => ({ type: "tool-bash", toolCallId: callId, toolName: "bash", state, input: {} });

const turnOf = (entries, index) => entries.filter((entry) => entry.kind === "turn")[index]?.turn;

test("回合结束：末段正文提升为 finalText 并从过程组剔除", () => {
	const entries = groupTimelineEntries([user("u1", "hi"), assistant("a1", [tool("t1"), text("最终回答")])]);
	const turn = turnOf(entries, 0);
	assert.equal(turn.finalText, "最终回答");
	assert.equal(turn.interimCount, 0);
	assert.ok(!turn.segments.some((segment) => segment.kind === "interim" && segment.text === "最终回答"));
	assert.equal(turn.toolCount, 1);
});

test("流式中：末段正文不提升，改挂 liveTextId（桌面 isComplete 门控）", () => {
	const streaming = groupTimelineEntries([user("u1", "hi"), assistant("a1", [tool("t1"), text("正在打字…")])], { isStreaming: true });
	const turn = turnOf(streaming, 0);
	assert.equal(turn.finalText, "", "流式中不得提升 finalText");
	assert.equal(turn.liveTextId, "a1:p1");
	assert.equal(turn.interimCount, 1, "live 文本仍在过程组参与计数");
	// 同一数据流结束后重分组 → 提升，且过程组剔除
	const settled = groupTimelineEntries([user("u1", "hi"), assistant("a1", [tool("t1"), text("正在打字…")])]);
	const settledTurn = turnOf(settled, 0);
	assert.equal(settledTurn.finalText, "正在打字…");
	assert.equal(settledTurn.liveTextId, undefined);
});

test("末段是工具时：无论是否流式都不提升（工具回合中的文本都是中间回复）", () => {
	for (const isStreaming of [false, true]) {
		const entries = groupTimelineEntries([user("u1", "hi"), assistant("a1", [text("中间说明"), tool("t1", "input")])], { isStreaming });
		const turn = turnOf(entries, 0);
		assert.equal(turn.finalText, "", `isStreaming=${isStreaming} 末段为工具不提升`);
		assert.equal(turn.liveTextId, undefined);
		assert.equal(turn.interimCount, 1);
	}
});

test("用户消息断开的完整回合不受后续流式影响（提升正常）", () => {
	const entries = groupTimelineEntries([user("u1", "hi"), assistant("a1", [text("回答一")]), user("u2", "again"), assistant("a2", [reasoning("想"), text("流式中…")])], { isStreaming: true });
	const first = turnOf(entries, 0);
	const second = turnOf(entries, 1);
	assert.equal(first.finalText, "回答一", "被用户消息断开的回合视为完成");
	assert.equal(second.finalText, "");
	assert.equal(second.liveTextId, "a2:p1");
});

test("跨消息连续 reasoning 合并同一思考块，状态取最后一个 part", () => {
	const entries = groupTimelineEntries([user("u1", "hi"), assistant("a1", [reasoning("第一段", "done")]), assistant("a2", [reasoning("第二段", "streaming")])]);
	const turn = turnOf(entries, 0);
	const thinking = turn.segments.filter((segment) => segment.kind === "thinking");
	assert.equal(thinking.length, 1);
	assert.deepEqual([...thinking[0].texts], ["第一段", "第二段"]);
	assert.equal(thinking[0].running, true, "新 part 仍在流 → 合并块继续 sweep");
	assert.equal(turn.thinkingCount, 2);
	assert.equal(turn.messageIds.length, 2);
});

test("末段是思考块时不提升（正文全部是中间回复）", () => {
	const entries = groupTimelineEntries([user("u1", "hi"), assistant("a1", [text("中间"), reasoning("还在想", "streaming")])], { isStreaming: true });
	const turn = turnOf(entries, 0);
	assert.equal(turn.finalText, "");
	assert.equal(turn.liveTextId, undefined);
	assert.equal(turn.interimCount, 1);
});
