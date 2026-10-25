import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { updateActiveToolCalls } = loadTsCommonJs("src/shared/toolRuntimeState.ts");

// loadTsCommonJs 在独立 VM realm 执行，Map 原型不同导致 deepStrictEqual 报
// “same structure but not reference-equal”，统一用 entries + JSON 比较跨 realm 结果。
const entries = (state) => JSON.stringify(Array.from(state.calls.entries()));

test("updateActiveToolCalls：start/end 带同一 toolCallId 时正常移除", () => {
	const started = updateActiveToolCalls(new Map(), { type: "start", toolCallId: "call-1", toolName: "bash" });
	assert.equal(entries(started), '[["call-1","bash"]]');
	assert.equal(started.isExecutingTool, true);

	const ended = updateActiveToolCalls(started.calls, { type: "end", toolCallId: "call-1" });
	assert.equal(entries(ended), "[]");
	assert.equal(ended.isExecutingTool, false);
	assert.equal(ended.completedBatch, true);
});

test("updateActiveToolCalls：end 缺 toolCallId 时按 toolName 归并，不能永久卡在「执行中」", () => {
	// 回归护栏（2026-09「工具返回后卡住」的成因之一）：
	// start 缺 id 时上层合成 `${toolName}-${timestamp}` 兜底 key，而 end 缺 id 时只能拿到空串。
	// 旧实现只按空串 delete → 永远删不掉 → 工具永久「执行中」，
	// 且 AgentManager.markIdleIfPiReportsNoWork 的兜底判空闲也被同一个标志挡住，会话再也不会 idle。
	const started = updateActiveToolCalls(new Map(), { type: "start", toolCallId: "bash-1712345678901", toolName: "bash" });
	assert.equal(started.isExecutingTool, true);

	const ended = updateActiveToolCalls(started.calls, { type: "end", toolCallId: "", toolName: "bash" });
	assert.equal(entries(ended), "[]");
	assert.equal(ended.isExecutingTool, false);
	assert.equal(ended.completedBatch, true);
});

test("updateActiveToolCalls：无 id 无 toolName 且只剩一个在跑时按唯一项归属", () => {
	const started = updateActiveToolCalls(new Map(), { type: "start", toolCallId: "bash-1712345678901", toolName: "bash" });
	const ended = updateActiveToolCalls(started.calls, { type: "end", toolCallId: "" });
	assert.equal(entries(ended), "[]");
	assert.equal(ended.completedBatch, true);
});

test("updateActiveToolCalls：无 id 且无 toolName 时，多工具并行下拒绝猜测归属", () => {
	// 无法归属时宁可不删：误判成「工具批次结束」会让 steer 在别的工具仍运行时过早进入 pi 队列。
	let state = updateActiveToolCalls(new Map(), { type: "start", toolCallId: "a", toolName: "read" });
	state = updateActiveToolCalls(state.calls, { type: "start", toolCallId: "b", toolName: "bash" });

	const ended = updateActiveToolCalls(state.calls, { type: "end", toolCallId: "" });
	assert.equal(ended.isExecutingTool, true);
	assert.equal(ended.completedBatch, false);
});

test("updateActiveToolCalls：同名工具并行时 toolName 回退匹配最后一项", () => {
	let state = updateActiveToolCalls(new Map(), { type: "start", toolCallId: "bash-1", toolName: "bash" });
	state = updateActiveToolCalls(state.calls, { type: "start", toolCallId: "bash-2", toolName: "bash" });

	const ended = updateActiveToolCalls(state.calls, { type: "end", toolCallId: "", toolName: "bash" });
	assert.equal(entries(ended), '[["bash-1","bash"]]');
	assert.equal(ended.isExecutingTool, true, "还剩一个同名工具在跑，不能判批次结束");
});

test("updateActiveToolCalls：迟到/重复 end 的未知 id 不误删在跑的工具", () => {
	const started = updateActiveToolCalls(new Map(), { type: "start", toolCallId: "call-1", toolName: "bash" });
	const late = updateActiveToolCalls(started.calls, { type: "end", toolCallId: "ghost" });
	assert.equal(entries(late), '[["call-1","bash"]]');
	assert.equal(late.isExecutingTool, true);
	assert.equal(late.completedBatch, false);
});

test("updateActiveToolCalls：并行批次只在最后一个工具结束时产生 final-end", () => {
	let state = updateActiveToolCalls(new Map(), { type: "start", toolCallId: "a", toolName: "read" });
	state = updateActiveToolCalls(state.calls, { type: "start", toolCallId: "b", toolName: "bash" });
	assert.equal(state.isExecutingTool, true);
	assert.equal(state.executingToolName, "bash", "展示最后启动的工具名");

	const first = updateActiveToolCalls(state.calls, { type: "end", toolCallId: "a" });
	assert.equal(first.isExecutingTool, true);
	assert.equal(first.completedBatch, false, "首个并行工具结束不是可投递 steer 的窗口");

	const second = updateActiveToolCalls(first.calls, { type: "end", toolCallId: "b" });
	assert.equal(second.isExecutingTool, false);
	assert.equal(second.completedBatch, true);
});
