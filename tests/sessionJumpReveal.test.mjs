/**
 * 会话内查找「点了跳不过去」的回归（2027-02 用户反馈）。
 *
 * 背景：命中落在已完成轮的执行过程折叠区里（中间回答/工具），Radix 收起会把节点整块卸载；
 * 旧实现只会扩轮次窗口，节点永远挂不出来，最后弹「未能跳转到这条命中」。
 * 这里钉住两条兜底：TurnRow 按会话级揭示请求展开折叠（runContainsMessage 判定归属），
 * 以及实在挂不出来时退到包含目标的那一轮（resolveJumpFallbackEntry），而不是报错。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { runContainsMessage } = loadTsCommonJs("src/renderer/src/components/session/timeline/runMessageLookup.ts");
const { resolveJumpFallbackEntry } = loadTsCommonJs("src/renderer/src/components/session/timeline/jumpWindowPolicy.ts");

/** 消息工厂：只填归属判定关心的字段。 */
function message(id, role = "assistant") {
	return { id, agentId: "a1", role, text: id, timestamp: 1 };
}

function run(id, items) {
	return { kind: "agent-run", id, items, startedAt: 1, endedAt: 2, askWaitMs: 0, askPending: false };
}

test("runContainsMessage：普通消息 / 工具组 / 思考组 / 重试与错误 / 扩展输出都算本轮", () => {
	const target = run("run-1", [
		{ kind: "message", message: message("m1") },
		{ kind: "thinking-group", id: "msg-thinking-m2", messages: [message("m2")], text: "t", startedAt: 1, endedAt: 2 },
		{ kind: "tool-group", id: "t1", messages: [message("tool-1", "tool")] },
		{ kind: "retry-group", id: "r1", message: message("retry-1", "system") },
		{ kind: "error-group", id: "e1", message: message("err-1", "error") },
		{ kind: "extension-entries", id: "x1", messages: [message("ext-1", "system")] },
	]);
	for (const id of ["m1", "m2", "tool-1", "retry-1", "err-1", "ext-1"]) {
		assert.equal(runContainsMessage(target, id), true, `${id} 应归属本轮`);
	}
	assert.equal(runContainsMessage(target, "other"), false);
	assert.equal(runContainsMessage(target, ""), false);
});

test("resolveJumpFallbackEntry：优先「起始下标 ≤ 目标」里最靠后的一行，没有更早的才退到最早", () => {
	// 目标在第 2 行内部（被折叠卸载）：第 2 行起始 10 是最后一个 ≤ 30 的
	const entries = [{ index: 0 }, { index: 10 }, { index: 40 }, { index: 60 }];
	assert.equal(resolveJumpFallbackEntry(entries, 30), 1);
	assert.equal(resolveJumpFallbackEntry(entries, 10), 1, "等于目标也归到该行");
	// 目标比所有行都早（极端：命中的字符串在第一行之前）：退到最早的行
	assert.equal(resolveJumpFallbackEntry(entries, -5), 0);
	// 顺序无关（DOM 顺序保证有序，但实现不依赖它）
	assert.equal(resolveJumpFallbackEntry([{ index: 40 }, { index: 0 }, { index: 10 }], 35), 2);
	assert.equal(resolveJumpFallbackEntry([], 5), -1);
});

test("接线：controller 发揭示请求并在结算时清空，TurnRow 收到后展开折叠，放弃前先退到轮次行", () => {
	const read = (path) => readFileSync(path, "utf8");
	const atoms = read("src/renderer/src/atoms/timeline-reveal-atoms.ts");
	assert.match(atoms, /export const timelineRevealRequestsAtom = atom</);
	assert.match(atoms, /export const requestTimelineRevealAtom = atom\(null/);
	assert.match(atoms, /export const clearTimelineRevealAtom = atom\(null/);
	const controller = read("src/renderer/src/hooks/useSessionTimelineController.ts");
	assert.match(controller, /requestTimelineReveal\(targetNodeId\)/);
	assert.match(controller, /clearTimelineReveal\(\)/);
	assert.match(controller, /findFallbackJumpRow\(pendingJump\.value\.messageId\)/);
	// 兜底落位必须在 toast 之前：先落到轮次行，仍然找不到才报错
	const giveUp = controller.indexOf('if (action.kind === "give-up")');
	const fallback = controller.indexOf("findFallbackJumpRow(pendingJump.value.messageId)", giveUp);
	const toastAt = controller.indexOf('toast(t("sessionFind.jumpFailed"))', giveUp);
	assert.ok(giveUp > 0 && fallback > giveUp && toastAt > fallback, "give-up：先兜底落位，再 toast");
	// 会话切换必须清掉揭示请求，否则切回来会把旧轮次自动撑开
	assert.match(controller, /setPendingJump\(undefined\);\s*\n\s*clearTimelineReveal\(\);/);
	const turnRow = read("src/renderer/src/components/session/turn/TurnRow.tsx");
	assert.match(turnRow, /timelineRevealRequestsAtom/);
	assert.match(turnRow, /runContainsMessage\(run, revealRequest\.messageId\)/);
	assert.match(turnRow, /setStepsVisibleFromUser\(true\)/);
});
