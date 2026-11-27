import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 判据：锚点 run id 找不到时返回 undefined（退回尾窗），绝不 clamp 到 0。
 *
 * 为什么这条必须存在（组 2 的第 8 件）：runIndexOfMessage 找不到返回 -1，
 * 而 -1 喂进 selectTimelineTurnWindow 会 Math.max(0, -1) -> 0 -> **跳到会话开头**。
 * 真会发生的两类：context_edit 把那条移出展示；prepend 时基线重算、锚点那轮被合并。
 *
 * 反例（能红）：`return runIndex >= 0 ? runIndex : undefined;` 改成 `Math.max(0, runIndex)`。
 */

const load = () => loadTsCommonJs("src/renderer/src/components/session/timeline/jumpTarget.ts");

const runs = () => [
	{ kind: "agent-run", items: [{ id: "r0" }] },
	{ kind: "agent-run", items: [{ id: "r1" }] },
	{ kind: "agent-run", items: [{ id: "r2" }] },
];

test("找得到：返回 0-based 序号（0 也是合法值，不能与 undefined 混）", () => {
	const { resolveAnchorStartRun } = load();
	assert.equal(resolveAnchorStartRun(runs(), "r0"), 0);
	assert.equal(resolveAnchorStartRun(runs(), "r2"), 2);
});

test("找不到：返回 undefined，绝不返回 0", () => {
	const { resolveAnchorStartRun } = load();
	const got = resolveAnchorStartRun(runs(), "gone");
	assert.equal(got, undefined, "返回 " + got + " —— 0 会让窗口跳到会话开头");
	assert.notEqual(got, 0);
});

test("没有锚点 id：返回 undefined（尾窗语义）", () => {
	const { resolveAnchorStartRun } = load();
	assert.equal(resolveAnchorStartRun(runs(), undefined), undefined);
	assert.equal(resolveAnchorStartRun(runs(), ""), undefined);
});

test("接上取窗：undefined 走尾窗，不抛、不越界", () => {
	const { resolveAnchorStartRun } = load();
	const { buildAgentRunStarts, sliceByRunStarts, selectTimelineTurnWindow } = loadTsCommonJs("src/renderer/src/components/session/timeline/turnRenderWindow.ts");
	const items = [{ kind: "agent-run" }, { kind: "message" }, { kind: "agent-run" }, { kind: "message" }, { kind: "agent-run" }, { kind: "message" }];
	const starts = buildAgentRunStarts(items);
	const tail = selectTimelineTurnWindow(items, 1);
	assert.equal(tail.length, 2, "尾窗 1 轮 = 2 条");
	assert.equal(sliceByRunStarts(items, starts, 2, 1).length, 2);
	assert.equal(resolveAnchorStartRun(runs(), "gone"), undefined);
});
