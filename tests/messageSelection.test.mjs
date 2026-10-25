import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 多选消息树选择逻辑（MessageShareModal / SessionReferenceModal 共享）：
 * - 可选项口径 = user 消息 + agent-run 内 assistant 消息（勾选集即导出集）
 * - run 整组切换与三态（checked / indeterminate / unchecked）
 * - 工具只读摘要提取（meta.toolName 优先，回退文本首词）
 */

function loadSelectionModule() {
	const source = readFileSync("src/renderer/src/utils/messageSelection.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: "messageSelection.ts",
	}).outputText;
	const sandbox = { exports: {}, require: () => ({}) };
	vm.runInNewContext(output, sandbox, { filename: "messageSelection.ts" });
	return sandbox.exports;
}

const selection = loadSelectionModule();

/** vm 隔离下 Set/Array 原型不同，跨 realm 值统一 JSON 序列化后比较 */
const json = (value) => JSON.stringify(value);
const sorted = (set) => json(Array.from(set).sort());

/** 消息构造工厂（与 RenderMessage 结构一致） */
function makeMessage(id, role, text, extra = {}) {
	return {
		kind: "message",
		message: { id, agentId: "agent", role, text, timestamp: 0, ...extra },
	};
}

/** 工具消息：ToolGroupItem.messages 是裸 ChatMessage[]（无 kind 包装） */
function makeToolMessage(id, text, meta) {
	return { id, agentId: "agent", role: "tool", text, timestamp: 0, meta };
}

function makeRun(id, items) {
	return { kind: "agent-run", id, items, startedAt: 0, endedAt: 100 };
}

function makeToolGroup(id, messages) {
	return { kind: "tool-group", id, messages };
}

function makeThinkingGroup(id) {
	return { kind: "thinking-group", id, messages: [], text: "", startedAt: 0, endedAt: 0 };
}

const sampleTree = [
	makeMessage("u1", "user", "第一个问题"),
	makeRun("r1", [makeMessage("a1", "assistant", "回答一"), makeMessage("a2", "assistant", "回答二"), makeToolGroup("t1", [makeToolMessage("tool1", "▶ read", { toolName: "read" }), makeToolMessage("tool2", "✓ edit", { toolName: "edit" })])]),
	makeMessage("u2", "user", "第二个问题"),
	makeRun("r2", [makeThinkingGroup("th1"), makeMessage("a3", "assistant", "回答三")]),
	makeMessage("sys1", "system", "压缩摘要"),
];

test("getSelectableMessageIds：user + run 内 assistant 可选，tool/system/thinking 排除", () => {
	const ids = selection.getSelectableMessageIds(sampleTree);
	assert.equal(json(ids), json(["u1", "a1", "a2", "u2", "a3"]));
});

test("getSelectableMessageIds：空树返回空数组", () => {
	assert.equal(json(selection.getSelectableMessageIds([])), "[]");
});

test("toggleMessage：添加与移除不修改原集合", () => {
	const initial = new Set(["u1", "a1"]);
	const added = selection.toggleMessage(initial, "a2");
	assert.equal(sorted(added), json(["a1", "a2", "u1"]));
	const removed = selection.toggleMessage(initial, "u1");
	assert.equal(sorted(removed), json(["a1"]));
	// 原集合不可变
	assert.equal(sorted(initial), json(["a1", "u1"]));
});

test("toggleRun：部分选中时整组全选", () => {
	const initial = new Set(["u1", "a1"]);
	const run = sampleTree[1];
	const next = selection.toggleRun(initial, run);
	assert.equal(sorted(next), json(["a1", "a2", "u1"]));
});

test("toggleRun：全选时整组清空", () => {
	const initial = new Set(["u1", "a1", "a2"]);
	const run = sampleTree[1];
	const next = selection.toggleRun(initial, run);
	assert.equal(sorted(next), json(["u1"]));
});

test("toggleRun：run 无 assistant 消息时原样返回", () => {
	const emptyRun = makeRun("r0", [makeToolGroup("t0", [makeToolMessage("x", "read")])]);
	const initial = new Set(["u1"]);
	const next = selection.toggleRun(initial, emptyRun);
	assert.equal(sorted(next), json(["u1"]));
});

test("getRunSelectionState：三态（checked/indeterminate/unchecked）", () => {
	const run = sampleTree[1]; // a1 + a2
	assert.equal(selection.getRunSelectionState(new Set(["a1", "a2"]), run), "checked");
	assert.equal(selection.getRunSelectionState(new Set(["a1"]), run), "indeterminate");
	assert.equal(selection.getRunSelectionState(new Set(["u1"]), run), "unchecked");
	assert.equal(selection.getRunSelectionState(new Set(), makeRun("r0", [])), "unchecked");
});

test("toggleAll：全选 / 清空 / 空列表", () => {
	const all = ["u1", "a1", "a2", "u2", "a3"];
	assert.equal(sorted(selection.toggleAll(new Set(["u1"]), all)), json([...all].sort()));
	assert.equal(json(Array.from(selection.toggleAll(new Set(all), all))), "[]");
	assert.equal(json(Array.from(selection.toggleAll(new Set(), []))), "[]");
});

test("getToolSummaries：按工具名聚合次数，meta.toolName 优先", () => {
	const run = makeRun("r1", [makeMessage("a1", "assistant", "回答"), makeToolGroup("t1", [makeToolMessage("tool1", "▶ read", { toolName: "read" }), makeToolMessage("tool2", "✓ read", { toolName: "read" }), makeToolMessage("tool3", "✓ edit", { toolName: "edit" })])]);
	const summaries = selection.getToolSummaries(run);
	assert.equal(
		json(summaries),
		json([
			{ name: "read", count: 2 },
			{ name: "edit", count: 1 },
		]),
	);
});

test("getToolSummaries：无工具调用的 run 返回空数组", () => {
	const run = makeRun("r1", [makeMessage("a1", "assistant", "回答")]);
	assert.equal(json(selection.getToolSummaries(run)), "[]");
});

test("extractToolName：meta.toolName 优先", () => {
	assert.equal(selection.extractToolName({ meta: { toolName: "bash" }, text: "▶ bash ls" }), "bash");
});

test("extractToolName：无 meta 时剥 ANSI/状态符号取首词", () => {
	assert.equal(selection.extractToolName({ meta: {}, text: "\x1b[32m✓\x1b[0m read file" }), "read");
	assert.equal(selection.extractToolName({ meta: {}, text: "▶ edit" }), "edit");
	assert.equal(selection.extractToolName({ meta: {}, text: "" }), "tool");
});
