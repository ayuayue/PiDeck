import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 扩展输出条目（appendEntry 投影卡 meta.type=customEntry）折进过程组的分组行为。
 *
 * 用户决策 2026-10：扩展输出不再单独成块——run 内到达的条目吸收为 agent-run 的
 * `extension-entries` 组员（折进「执行过程」折叠组）；run 未开始、或回合已收尾
 * （stop）之后才到达的条目保持独立条目兜底，避免把最终回答挤成中间回答。
 * `customMessage`（子代理完成通知）不受影响，仍是回合边界 + 独立通知卡。
 */

const { groupToolMessages, sameAgentRunForRender } = loadTsCommonJs("src/renderer/src/components/app/AppUtils.ts");
const { buildTurnDisplay } = loadTsCommonJs("src/renderer/src/components/session/timeline/buildTurnDisplay.ts");
const { groupTurnProcess } = loadTsCommonJs("src/renderer/src/components/session/timeline/groupTurnProcess.ts");

function userMessage(id) {
	return { id, role: "user", text: "帮我查一下", timestamp: 1 };
}

function assistantMessage(id, text, stopReason) {
	return { id, role: "assistant", text, timestamp: 2, stopReason };
}

function toolMessage(id) {
	return { id, role: "tool", text: "ok", timestamp: 3, meta: { toolName: "read", status: "done" } };
}

function extensionEntry(id, overrides = {}) {
	return {
		id,
		role: "system",
		text: "预览文本",
		timestamp: 4,
		meta: { type: "customEntry", customType: "acp-nudge", data: { note: "x" } },
		...overrides,
	};
}

function runItemKinds(run) {
	// loadTsCommonJs 在 vm 沙箱里加载生产模块，返回的数组是沙箱 realm 的 Array，
	// deepStrictEqual 对跨 realm 数组会因原型不同而失败 —— 先用 Array.from 转成宿主数组
	return Array.from(run.items, (item) => item.kind);
}

test("工具回合内的扩展输出折进 agent-run 的 extension-entries 组员", () => {
	const entry = extensionEntry("e1");
	const result = groupToolMessages([userMessage("u1"), assistantMessage("a1", "先看文件", "toolUse"), toolMessage("t1"), entry, assistantMessage("a2", "最终回答", "stop")]);
	assert.deepEqual(
		Array.from(result, (item) => item.kind),
		["message", "agent-run"],
		"用户消息独立成条，其余折进单一 agent-run",
	);
	const run = result[1];
	assert.deepEqual(runItemKinds(run), ["message", "tool-group", "extension-entries", "message"]);
	const group = run.items[2];
	assert.equal(group.id, "e1");
	assert.equal(Array.from(group.messages).length, 1);
	assert.equal(group.messages[0], entry, "组员持有原消息引用");
});

test("连续扩展输出合并为一个组员且保持时序", () => {
	const first = extensionEntry("e1");
	const second = extensionEntry("e2", { meta: { type: "customEntry", customType: "btw", data: {} } });
	const result = groupToolMessages([assistantMessage("a1", "", "toolUse"), toolMessage("t1"), first, second, assistantMessage("a2", "回答", "stop")]);
	assert.equal(result.length, 1);
	assert.deepEqual(
		Array.from(result, (item) => item.kind),
		["agent-run"],
	);
	assert.deepEqual(runItemKinds(result[0]), ["message", "tool-group", "extension-entries", "message"]);
	assert.deepEqual(Array.from(result[0].items[2].messages), [first, second]);
});

test("run 未开始时扩展输出保持独立条目兜底", () => {
	const result = groupToolMessages([extensionEntry("e1")]);
	assert.equal(result.length, 1);
	assert.equal(result[0].kind, "message");
	assert.equal(result[0].message.id, "e1");
});

test("已收尾回合之后到达的扩展输出独立成卡，不把最终回答降级为中间回答", () => {
	const entry = extensionEntry("e1");
	const result = groupToolMessages([assistantMessage("a1", "回答", "stop"), entry]);
	assert.deepEqual(
		Array.from(result, (item) => item.kind),
		["agent-run", "message"],
		"stop 之后扩展输出不属于该回合，应排在 run 之后",
	);
	const run = result[0];
	assert.deepEqual(runItemKinds(run), ["message"], "收尾回合不再吸收尾随扩展输出");
	assert.equal(run.endedAt, 2, "尾随扩展输出不应延长本轮回复耗时");
	assert.deepEqual(
		Array.from(buildTurnDisplay(run), (item) => item.kind),
		["final-answer"],
		"最终回答必须常驻，不能被降级成中间回答",
	);
	assert.equal(result[1].message, entry, "独立卡持有原消息引用");
});

test("同一轮内先折进过程组、收尾后的尾随条目独立成卡", () => {
	const midTurn = extensionEntry("e1");
	const trailing = extensionEntry("e2");
	const result = groupToolMessages([userMessage("u1"), assistantMessage("a1", "先看文件", "toolUse"), toolMessage("t1"), midTurn, assistantMessage("a2", "最终回答", "stop"), trailing]);
	assert.deepEqual(
		Array.from(result, (item) => item.kind),
		["message", "agent-run", "message"],
		"用户消息独立，回合内条目合成 run，收尾后的条目独立",
	);
	const run = result[1];
	assert.deepEqual(runItemKinds(run), ["message", "tool-group", "extension-entries", "message"]);
	assert.equal(result[2].message, trailing);
	assert.deepEqual(
		Array.from(buildTurnDisplay(run), (item) => item.kind),
		["interim-answer", "process-entry", "process-entry", "final-answer"],
		"回合内中间回答保留在折叠序列，最终回答常驻",
	);
});

test("收尾回合之后的扩展输出也不会被下一轮吸收", () => {
	const entry = extensionEntry("e1");
	const result = groupToolMessages([assistantMessage("a1", "第一轮回答", "stop"), entry, assistantMessage("a2", "第二轮回答", "stop")]);
	assert.deepEqual(
		Array.from(result, (item) => item.kind),
		["agent-run", "message", "agent-run"],
		"扩展输出落在两轮之间，前后各成一个 run",
	);
	assert.deepEqual(
		Array.from(buildTurnDisplay(result[0]), (item) => item.kind),
		["final-answer"],
	);
	assert.deepEqual(
		Array.from(buildTurnDisplay(result[2]), (item) => item.kind),
		["final-answer"],
	);
});

test("customMessage 仍是回合边界且不并入组员", () => {
	const customMessage = { id: "cm1", role: "system", text: "子任务完成", timestamp: 5, meta: { type: "customMessage" } };
	const result = groupToolMessages([assistantMessage("a1", "第一轮", "stop"), customMessage, assistantMessage("a2", "第二轮", "stop")]);
	assert.deepEqual(
		Array.from(result, (item) => item.kind),
		["agent-run", "message", "agent-run"],
		"customMessage 前后断开成两个 run，自身保持独立条目",
	);
	assert.equal(result[1].message, customMessage);
});

test("buildTurnDisplay 把 extension-entries 投影为 extension-entry 过程条目", () => {
	const entry = extensionEntry("e1");
	const run = {
		kind: "agent-run",
		id: "r1",
		items: [
			{ kind: "tool-group", id: "t1", messages: [toolMessage("t1")] },
			{ kind: "extension-entries", id: "e1", messages: [entry] },
		],
		startedAt: 1,
		endedAt: 5,
	};
	const display = buildTurnDisplay(run);
	assert.deepEqual(
		Array.from(
			display.filter((item) => item.kind === "process-entry"),
			(item) => item.entry.kind,
		),
		["tool-entry", "extension-entry"],
	);
});

test("groupTurnProcess 把扩展输出折进过程组且不计入工具数", () => {
	const run = {
		kind: "agent-run",
		id: "r1",
		items: [
			{ kind: "tool-group", id: "t1", messages: [toolMessage("t1")] },
			{ kind: "extension-entries", id: "e1", messages: [extensionEntry("e1"), extensionEntry("e2")] },
		],
		startedAt: 1,
		endedAt: 5,
	};
	const nodes = groupTurnProcess(buildTurnDisplay(run));
	assert.equal(nodes.length, 1);
	assert.equal(nodes[0].kind, "group");
	assert.equal(nodes[0].toolCount, 1);
	assert.equal(nodes[0].extensionCount, 2);
	assert.deepEqual(
		Array.from(nodes[0].members, (member) => member.kind),
		["tool-entry", "extension-entry"],
	);
});

test("sameAgentRunForRender 对 extension-entries 内容变化敏感", () => {
	const base = {
		kind: "agent-run",
		id: "r1",
		items: [{ kind: "extension-entries", id: "e1", messages: [extensionEntry("e1")] }],
		startedAt: 1,
		endedAt: 4,
		askWaitMs: 0,
		askPending: false,
	};
	assert.equal(sameAgentRunForRender(base, structuredClone(base)), true);
	const changed = structuredClone(base);
	changed.items[0].messages[0].text = "变了";
	assert.equal(sameAgentRunForRender(base, changed), false, "条目文本变化必须触发重算");
	const added = structuredClone(base);
	added.items[0].messages.push(extensionEntry("e2"));
	assert.equal(sameAgentRunForRender(base, added), false, "追加条目必须触发重算");
});
