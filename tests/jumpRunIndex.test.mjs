import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 判据：消息 → run 序号的换算只有一处，且边界正确。
 *
 * 为什么单独钉它（组 2 列的「两套下标要对同一个数组算」）：
 * `resolveJumpMessageIndex` 给 messages 下标，`sliceByRunStarts` 吃 run 序号。
 * 换算散落在调用点时，错一位的症状是「跳到上一轮」—— 用户看不出是 bug，
 * 只觉得「落位不准」。这类错不会报红，只能靠一条针对换算本身的判据。
 *
 * 反例：把 `if (run.kind === "agent-run") runIndex += 1;` 挪到内层循环之后
 * （先归属再递增），第 0 轮的消息会返回 1 —— 差一轮。
 */

const load = () => loadTsCommonJs("src/renderer/src/components/session/timeline/jumpTarget.ts");

/** 三轮，每轮 2 条；runs 的 kind 与 sliceByRunStarts 认的是同一个 "agent-run"。 */
function runs() {
	return [
		{ kind: "agent-run", items: [{ id: "m0" }, { id: "m1" }] },
		{ kind: "agent-run", items: [{ id: "m2", meta: { entryId: "e2" } }, { id: "m3" }] },
		{ kind: "agent-run", items: [{ id: "m4" }, { id: "m5" }] },
	];
}

test("按 messageId 定位到所属轮", () => {
	const { runIndexOfMessage } = load();
	assert.equal(runIndexOfMessage(runs(), "m0"), 0);
	assert.equal(runIndexOfMessage(runs(), "m3"), 1);
	assert.equal(runIndexOfMessage(runs(), "m5"), 2);
});

test("按 entryId 也能定位（跳转命中给的是文件条目 id）", () => {
	const { runIndexOfMessage } = load();
	assert.equal(runIndexOfMessage(runs(), "e2"), 1);
});

test("找不到返回 -1（未加载 / 被 context_edit 移出），不返回 0 冒充第一轮", () => {
	const { runIndexOfMessage } = load();
	assert.equal(runIndexOfMessage(runs(), "nope"), -1);
	assert.equal(runIndexOfMessage(runs(), ""), -1);
});

test("非 agent-run 条目不计轮（附属消息随所属轮，不推高序号）", () => {
	const { runIndexOfMessage } = load();
	const withDiag = [
		{ kind: "message", items: [{ id: "sys" }] },
		{ kind: "agent-run", items: [{ id: "m0" }] },
		{ kind: "message", items: [{ id: "diag" }] },
		{ kind: "agent-run", items: [{ id: "m1" }] },
	];
	assert.equal(runIndexOfMessage(withDiag, "m0"), 0, "轮起点前的 system 不该让它变成第 1 轮");
	assert.equal(runIndexOfMessage(withDiag, "m1"), 1);
});

test("结果可直接当 sliceByRunStarts 的起点用（两套下标接得上）", () => {
	const { runIndexOfMessage } = load();
	const { buildAgentRunStarts, sliceByRunStarts } = loadTsCommonJs("src/renderer/src/components/session/timeline/turnRenderWindow.ts");
	const items = [{ kind: "agent-run" }, { kind: "message" }, { kind: "agent-run" }, { kind: "message" }, { kind: "agent-run" }, { kind: "message" }];
	const starts = buildAgentRunStarts(items);
	const runIndex = runIndexOfMessage(runs(), "m4");
	assert.equal(runIndex, 2);
	const window = sliceByRunStarts(items, starts, runIndex, 1);
	assert.equal(window.length, 2, "第 2 轮 = 1 个 run + 1 条 message");
	assert.equal(window[0].kind, "agent-run");
});
