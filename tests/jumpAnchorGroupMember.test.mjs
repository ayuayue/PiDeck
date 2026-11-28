import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 手写 vm 加载器把 require 一律换成 `() => ({})`：生产模块一新增本地 import，取到的就是 undefined，
 * 用例整片报「x is not a function」（2026-11-26 撞到 matchesJumpMessage）。统一走 createTsSandbox，
 * 相对 import 按源文件目录解析。
 */
const w = createTsSandbox()("src/renderer/src/components/session/timeline/turnRenderWindow.ts");

const msg = (entryId) => ({ id: "_viewer-history-" + entryId, meta: { entryId } });

/** 真实形状（照抄 groupMessages.ts）：折叠组的成员在 messages，不在 items、也不在顶层 id。 */
function runsWithGroups() {
	return [
		{
			kind: "agent-run",
			id: "_viewer-history-a0",
			items: [
				{ kind: "message", message: msg("a0") },
				// ThinkingGroupItem：id 是 msg-thinking-<首条 id>，成员在 messages
				{ kind: "thinking-group", id: "msg-thinking-_viewer-history-a1", messages: [msg("a1")] },
				// ToolGroupItem：同上
				{ kind: "tool-group", id: "_viewer-history-t1", messages: [msg("t1"), msg("t2"), msg("t3")] },
			],
		},
		{ kind: "message", message: msg("u5") },
		{
			kind: "agent-run",
			id: "_viewer-history-b0",
			items: [{ kind: "thinking-group", id: "msg-thinking-_viewer-history-b1", messages: [msg("b1")] }],
		},
	];
}

test("折叠组的成员能当锚点：组内第 1 条（组 id 就是它）", () => {
	assert.equal(w.findAgentRunIndexByItemId(runsWithGroups(), "t1"), 0);
});

test("折叠组的成员能当锚点：组内第 2、3 条（组 id 不是它）", () => {
	// 反例（2026-11-25 全网关扫描，15 个会话 288 个 100 条刻度）：groupMessages 把轮内的
	// thinking / toolCall 折进组，成员放在 messages 里；childMatchesId 只查 record.id 与
	// record.message，于是「组里的第 2 条起」永远 -1 → 窗口退回尾部 → 点查找命中滚到最底部。
	// 实测 127/288 处失配，改后 0/288。
	const items = runsWithGroups();
	assert.equal(w.findAgentRunIndexByItemId(items, "t2"), 0, "tool-group 第 2 条");
	assert.equal(w.findAgentRunIndexByItemId(items, "t3"), 0, "tool-group 第 3 条");
});

test("thinking-only 消息（只在 thinking-group 里）能当锚点", () => {
	const items = runsWithGroups();
	assert.equal(w.findAgentRunIndexByItemId(items, "a1"), 0);
	assert.equal(w.findAgentRunIndexByItemId(items, "b1"), 2);
});

test("组内递归不影响原来的三条路径", () => {
	const items = runsWithGroups();
	assert.equal(w.findAgentRunIndexByItemId(items, "a0"), 0, "MessageItem.message");
	assert.equal(w.findAgentRunIndexByItemId(items, "u5"), 1, "顶级 message 项");
	assert.equal(w.findAgentRunIndexByItemId(items, "nope"), -1, "不存在必须 -1");
});

test("窗口围住组内锚点那一轮", () => {
	const items = runsWithGroups();
	const idx = w.findAgentRunIndexByItemId(items, "t2");
	const win = w.resolveAnchoredTurnWindow(items, 3, "t2");
	assert.ok(idx >= 0);
	assert.ok(
		win.some((r) => r.kind === "agent-run" && r.id === "_viewer-history-a0"),
		"窗口必须含锚点所在轮",
	);
	assert.ok(win.length <= 8, "窗口有界，实际 " + win.length);
});
