import assert from "node:assert/strict";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

// 直接 import .ts 时 Node 不做扩展名解析：生产模块里的本地 import 会 ERR_MODULE_NOT_FOUND。
// 统一走仓库沙箱（按源文件目录解析依赖）。
const { findAgentRunIndexByItemId, resolveAnchoredTurnWindow, selectTimelineTurnWindow, sliceAgentRunsAround } = createTsSandbox()("src/renderer/src/components/session/timeline/turnRenderWindow.ts");

const run = (id) => ({ kind: "agent-run", items: [{ id }] });
const makeRuns = (count) => Array.from({ length: count }, (_, index) => run("m" + (index + 1)));

test("锚点窗口：636 轮里锚在第 351 轮，只返回它周围的几轮", () => {
	const runs = makeRuns(636);
	const anchorIndex = findAgentRunIndexByItemId(runs, "m351");
	assert.equal(anchorIndex, 350);
	const window = sliceAgentRunsAround(runs, anchorIndex);
	assert.ok(window);
	assert.ok(window.length <= 6, "窗口必须很小，实际 " + window.length);
	assert.ok(window.some((item) => item.items[0].id === "m351"));
	assert.ok(window.length < 636);
});

test("锚点窗口：目标在最后一轮时不越界", () => {
	const runs = makeRuns(10);
	const window = sliceAgentRunsAround(runs, 9);
	assert.ok(window);
	assert.ok(window.some((item) => item.items[0].id === "m10"));
});

test("锚点找不到时返回 null，不猜位置", () => {
	const runs = makeRuns(5);
	assert.equal(sliceAgentRunsAround(runs, -1), null);
	assert.equal(sliceAgentRunsAround(runs, 5), null);
	// 样本要换成**真正不可锚**的 kind：message 后来被允许当锚点（用户提问占命中 22%，
	// 见 efa2a848f），再拿它当反例就是把正确行为判成红。判的是「不可锚的项不猜位置」。
	assert.equal(sliceAgentRunsAround([{ kind: "summary", items: [] }], 0), null);
});

test("selectTimelineTurnWindow：给了锚点走锚点，没给走尾部", () => {
	const runs = makeRuns(636);
	const anchored = selectTimelineTurnWindow(runs, 3, 350);
	assert.ok(anchored.some((item) => item.items[0].id === "m351"));

	const tail = selectTimelineTurnWindow(runs, 3);
	assert.ok(!tail.some((item) => item.items[0].id === "m351"));
	assert.ok(tail.some((item) => item.items[0].id === "m636"));

	const fallback = selectTimelineTurnWindow(runs, 3, null);
	assert.ok(fallback.some((item) => item.items[0].id === "m636"));
});

test("findAgentRunIndexByItemId：同 id 多处时取最靠后那一轮", () => {
	const runs = [
		{ kind: "agent-run", items: [{ id: "dup" }] },
		{ kind: "agent-run", items: [{ id: "other" }] },
		{ kind: "agent-run", items: [{ id: "dup" }] },
	];
	assert.equal(findAgentRunIndexByItemId(runs, "dup"), 2);
	assert.equal(findAgentRunIndexByItemId(runs, "missing"), -1);
	assert.equal(findAgentRunIndexByItemId(runs, null), -1);
});

test("锚点窗口不把非 run 条目切成孤儿", () => {
	const items = [
		{ kind: "agent-run", items: [{ id: "m1" }] },
		{ kind: "message", items: [{ id: "sys" }] },
		{ kind: "agent-run", items: [{ id: "m2" }] },
		{ kind: "agent-run", items: [{ id: "m3" }] },
	];
	const window = sliceAgentRunsAround(items, 2, 1, 1);
	assert.ok(window);
	assert.equal(window[0].kind, "agent-run");
});

/** 真实形状：MessageItem 的 id 在 message 里，顶层没有（renderTypes.ts）。 */
const messageRun = (id) => ({ kind: "agent-run", items: [{ kind: "message", message: { id } }] });

test("真实形状（MessageItem）：636 轮里锚在第 351 轮必须找得到", () => {
	const runs = Array.from({ length: 636 }, (_, i) => messageRun("m" + (i + 1)));
	assert.equal(findAgentRunIndexByItemId(runs, "m351"), 350);
	assert.equal(findAgentRunIndexByItemId(runs, "m1"), 0);
	assert.equal(findAgentRunIndexByItemId(runs, "missing"), -1);
});

test("真实形状：锚点窗口切出目标那一轮（这是「跳不跳得过去」的最小充分条件）", () => {
	const runs = Array.from({ length: 636 }, (_, i) => messageRun("m" + (i + 1)));
	const anchor = findAgentRunIndexByItemId(runs, "m1");
	const window = resolveAnchoredTurnWindow(runs, 31, "m1");
	const ids = window.map((r) => r.items[0].message.id);
	assert.ok(ids.includes("m1"), "目标必须在窗口内，实际 " + ids[0] + ".." + ids[ids.length - 1]);
	assert.ok(window.length <= 19, "窗口必须小，实际 " + window.length);
	assert.equal(anchor, 0);
});

test("两种子项形状都能匹配（顶层 id 与 message.id）", () => {
	const runs = [
		{ kind: "agent-run", items: [{ kind: "tool-group", id: "t1" }] },
		{ kind: "agent-run", items: [{ kind: "message", message: { id: "m2" } }] },
	];
	assert.equal(findAgentRunIndexByItemId(runs, "t1"), 0);
	assert.equal(findAgentRunIndexByItemId(runs, "m2"), 1);
});

/**
 * 窗口起点落在「轮首用户提问」上时必须保留它。
 *
 * 反例（2026-11-25 真机，9 轮会话）：每轮的开头都不见了——只剩一个空的
 * 「执行过程 13 步」折叠块，下面直接是结论。原因是切窗口的第二个 while 把 start 处的
 * 非 run 条目一律向内推，而用户提问（kind:"message"）恰恰是轮首那一条。
 */
test("窗口起点是轮首用户提问时保留它（否则每轮开头都不见）", () => {
	const items = [{ kind: "message", id: "u1" }, run("a1"), { kind: "message", id: "u2" }, run("a2"), { kind: "message", id: "u3" }, run("a3")];
	// 锚在第 3 轮、往前 1 轮：起点应落在 u3（那一轮的提问），而不是被推到 a3。
	const window = sliceAgentRunsAround(items, 5, 1, 1);
	assert.ok(window);
	const labels = window.map((item) => (item.kind === "message" ? item.id : item.items[0].id));
	assert.ok(labels.includes("u3"), "轮首提问必须在窗口内；被推掉就是「开头不见」（修复前实际返回 " + JSON.stringify(labels) + "）");
	assert.ok(labels.indexOf("u3") < labels.indexOf("a3"), "提问必须排在它所属轮之前");
});

test("窗口起点落到数组首且首条是用户提问时保留它（否则第一轮开头不见）", () => {
	// 触发条件：往前取轮数超过索引，start 一路走到 0，而 items[0] 不是 agent-run。
	// 旧实现无条件「推到下一个 run」，于是首条用户提问被吃掉——界面只剩时间戳与
	// 执行过程折叠块，正文从第二条开始（2026-11-25 真机截图）。
	const items = [{ kind: "message", id: "u1" }, run("a1"), run("a2")];
	const window = sliceAgentRunsAround(items, 2, 9, 0);
	const label = (item) => item.items?.[0]?.id ?? item.id;
	const labels = window?.map(label) ?? [];
	assert.equal(labels[0], "u1", "首条用户提问必须在窗口内；实际 " + JSON.stringify(labels));
});

test("窗口起点落到数组首且首条是孤儿附属条目时向内推", () => {
	// 同理触发 start=0，但 items[0] 既不是 run 也不是 message：它是上一轮的尾巴，
	// 留在窗口首会把那一轮切成一半，所以推进到下一个 run。
	const items = [{ kind: "tool-group", id: "t0" }, run("a1"), run("a2")];
	const window = sliceAgentRunsAround(items, 2, 9, 0);
	const label = (item) => item.items?.[0]?.id ?? item.id;
	const labels = window?.map(label) ?? [];
	assert.notEqual(labels[0], "t0", "孤儿条目不能出现在窗口首；实际 " + JSON.stringify(labels));
});
