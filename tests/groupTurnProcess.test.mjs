import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 过程组切分（对齐 DSH standard：大折叠栏内「中间回复 / 过程组」按原始时序交替）。
// 契约：空文本中间回复不作边界；重试/错误是一级行且截断组；工具类别变化不拆组。

const { groupTurnProcess, lastProcessGroup, lastProcessGroupIndex, lastToolCategory } = loadTsCommonJs(join(process.cwd(), "src/renderer/src/components/session/timeline/groupTurnProcess.ts"));

// loadTsCommonJs 在独立 vm realm 里执行模块代码，返回的 Array/Object 原型不来自主 realm，
// assert/strict 的 deepStrictEqual 会因原型不同判不等。按仓库既有惯例先归一化成主 realm 普通值。
const plain = (value) => JSON.parse(JSON.stringify(value));

/* ── 工厂：构造完整对象（不写半截字面量，避免字段漂移时批量失型） ── */

function message(id, text, toolName) {
	return {
		id,
		role: toolName ? "tool" : "assistant",
		text,
		timestamp: 1,
		meta: toolName ? { toolName } : undefined,
	};
}

function thinkingEntry(id) {
	return { kind: "process-entry", entry: { kind: "thinking-entry", id, group: { kind: "thinking-group", id, messages: [], text: "想了一下", startedAt: 1, endedAt: 2 } } };
}

function toolEntry(id, toolName) {
	return { kind: "process-entry", entry: { kind: "tool-entry", id, group: { kind: "tool-group", id, messages: [message(`${id}-m`, `${toolName} ok`, toolName)] } } };
}

function retryEntry(id) {
	return { kind: "process-entry", entry: { kind: "retry-entry", id, message: message(id, "正在重试") } };
}

function errorEntry(id) {
	return { kind: "process-entry", entry: { kind: "error-entry", id, message: { ...message(id, "请求失败"), role: "error" } } };
}

function interim(id, text) {
	return { kind: "interim-answer", id, message: message(id, text) };
}

function final(id, text) {
	return { kind: "final-answer", id, message: message(id, text) };
}

test("merges consecutive thinking and tool entries into one group and drops the final answer", () => {
	const nodes = groupTurnProcess([thinkingEntry("t1"), toolEntry("g1", "read"), toolEntry("g2", "bash"), final("f1", "答案")]);
	assert.equal(nodes.length, 1);
	assert.equal(nodes[0].kind, "group");
	assert.equal(nodes[0].members.length, 3);
	assert.equal(nodes[0].hasThinking, true);
	// toolCount 计的是工具调用条数（与折叠条「N个工具」按组合并计数的口径不同）
	assert.equal(nodes[0].toolCount, 2);
	assert.deepEqual(plain(nodes[0].counts), [
		{ kind: "read", count: 1 },
		{ kind: "commands", count: 1 },
	]);
});

test("a text interim answer splits the surrounding groups and stays a first-class sibling", () => {
	const nodes = groupTurnProcess([toolEntry("g1", "read"), interim("i1", "先看看这个文件"), toolEntry("g2", "bash")]);
	assert.deepEqual(plain(nodes.map((node) => node.kind)), ["group", "interim", "group"]);
	assert.equal(nodes[1].id, "i1");
});

test("an empty interim answer is neither a boundary nor a node (live skeleton must not split groups)", () => {
	// 回归：live 骨架 / 空 error 占位都是空文本；若当作边界，会凭空多出空组头
	const nodes = groupTurnProcess([toolEntry("g1", "read"), interim("i1", ""), interim("i2", "   "), toolEntry("g2", "bash")]);
	assert.equal(nodes.length, 1);
	assert.equal(nodes[0].kind, "group");
	assert.equal(nodes[0].members.length, 2);
});

test("retry and error rows become first-class rows and cut the group", () => {
	const nodes = groupTurnProcess([toolEntry("g1", "read"), retryEntry("r1"), errorEntry("e1"), toolEntry("g2", "bash")]);
	assert.deepEqual(plain(nodes.map((node) => node.kind)), ["group", "entry", "entry", "group"]);
	assert.equal(nodes[0].members.length, 1);
	assert.equal(nodes[3].members.length, 1);
});

test("consecutive interim answers produce no empty group between them", () => {
	const nodes = groupTurnProcess([interim("i1", "第一段"), interim("i2", "第二段")]);
	assert.deepEqual(plain(nodes.map((node) => node.kind)), ["interim", "interim"]);
});

test("only a final answer yields no nodes at all", () => {
	assert.deepEqual(plain(groupTurnProcess([final("f1", "答案")])), []);
});

test("a long task keeps one group per interruption, not one group per step", () => {
	// 典型长任务：思考/工具若干 → 阶段回复 → 思考/工具若干 → 最终回复
	const items = [thinkingEntry("t1"), toolEntry("g1", "read"), toolEntry("g2", "grep"), interim("i1", "进展"), thinkingEntry("t2"), toolEntry("g3", "edit"), toolEntry("g4", "bash"), final("f1", "答案")];
	const nodes = groupTurnProcess(items);
	assert.deepEqual(plain(nodes.map((node) => node.kind)), ["group", "interim", "group"]);
	// 关键收益：大折叠栏展开只看到 2 个组头 + 1 段中间回复，而不是 7 行步骤
	assert.equal(nodes.filter((node) => node.kind === "group").length, 2);
});

test("group id is derived from the first member so it stays stable across recomputes", () => {
	const items = [thinkingEntry("t1"), toolEntry("g1", "read"), final("f1", "答案")];
	const first = groupTurnProcess(items);
	const second = groupTurnProcess(items);
	assert.equal(first[0].id, second[0].id);
	assert.equal(first[0].id, "grp:t1");
});

test("tool category changes never split a group but every tool entry is counted", () => {
	const nodes = groupTurnProcess([toolEntry("g1", "read"), toolEntry("g2", "bash"), toolEntry("g3", "read"), final("f1", "答案")]);
	assert.equal(nodes.length, 1);
	assert.deepEqual(plain(nodes[0].counts), [
		{ kind: "read", count: 2 },
		{ kind: "commands", count: 1 },
	]);
});

test("running category follows the final thinking step rather than an earlier tool", () => {
	const nodes = groupTurnProcess([toolEntry("g1", "read"), thinkingEntry("t2")]);
	assert.equal(nodes[0].kind, "group");
	assert.equal(lastToolCategory(nodes[0].members), undefined);
	assert.equal(lastToolCategory(groupTurnProcess([toolEntry("g1", "grep"), toolEntry("g2", "read")])[0].members), "read");
});

test("lastProcessGroup / lastProcessGroupIndex locate the newest group for auto-expand", () => {
	const nodes = groupTurnProcess([toolEntry("g1", "read"), interim("i1", "进展"), toolEntry("g2", "bash")]);
	assert.equal(lastProcessGroup(nodes)?.id, "grp:g2");
	assert.equal(lastProcessGroupIndex(nodes), 2);
	assert.equal(lastProcessGroup(groupTurnProcess([interim("i1", "只有回复")])), undefined);
	assert.equal(lastProcessGroupIndex(groupTurnProcess([])), -1);
});
