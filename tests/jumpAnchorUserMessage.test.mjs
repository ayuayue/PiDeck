import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const compile = (filePath) => createTsSandbox()(filePath);

const P = "src/renderer/src/components/session/timeline/turnRenderWindow.ts";
const w = compile(P);

/** 真实形状（照抄 groupMessages 的输出）：用户提问是顶级 message 项，不属任何 agent-run。 */
const userTurn = (i) => ({ kind: "message", message: { id: "_viewer-history-u" + i, meta: { entryId: "u" + i } } });
const run = (i) => ({ kind: "agent-run", id: "run" + i, items: [{ kind: "message", message: { id: "_viewer-history-a" + i, meta: { entryId: "a" + i } } }] });
/** 20 组：user0 run1 user2 run3 ... */
function timeline() {
	const out = [];
	for (let i = 0; i < 20; i += 1) {
		out.push(userTurn(i));
		out.push(run(i));
	}
	return out;
}

test("用户提问能当锚点：findAgentRunIndexByItemId 命中顶级 message 项", () => {
	// 反例（2026-11-25 真机，722 轮会话搜「的」3173 条命中）：用户提问不在任何 agent-run 里，
	// 只扫 run 的 items 时它恒返回 -1 → resolveAnchoredTurnWindow 退回尾部 → 点一次滚到底部。
	// 抽样 103 条命中里 23 条（22%）落在用户提问上，全部落点错误。
	const items = timeline();
	assert.equal(w.findAgentRunIndexByItemId(items, "u4"), 8, "user4 在 items 下标 8（每组两项，user 在 2i）");
	assert.equal(w.findAgentRunIndexByItemId(items, "a4"), 9, "agent-run 内的消息仍走 items（run_i 在 2i+1）");
});

test("锚点在用户提问上：窗口围住它，不得退回尾部", () => {
	const items = timeline();
	const idx = w.findAgentRunIndexByItemId(items, "u10");
	const win = w.resolveAnchoredTurnWindow(items, 3, "u10");
	const runCount = win.filter((r) => r.kind === "agent-run").length;
	assert.ok(runCount <= 12, "窗口轮数有界（上下各 6），实际 " + runCount);
	assert.ok(
		win.some((r) => r.kind === "message" && r.message?.meta?.entryId === "u10"),
		"窗口必须包含被点的用户提问",
	);
	assert.notEqual(win[win.length - 1].id, "run19", "不得退回尾部窗口");
	assert.ok(idx > 0);
});

test("窗口含目标后紧邻的那一轮答复（落在提问上也能看到回答）", () => {
	const items = timeline();
	const win = w.resolveAnchoredTurnWindow(items, 3, "u10");
	const hasAnswer = win.some((r) => r.kind === "agent-run" && r.id === "run10");
	assert.ok(hasAnswer, "u10 后面那一轮 run10 必须在窗口里");
});

test("非 message 非 agent-run 的项仍返回 null（不能让窗口切到工具组上）", () => {
	const items = [{ kind: "tool-group", id: "t1" }, run(0)];
	assert.equal(w.sliceAgentRunsAround(items, 0), null);
});
