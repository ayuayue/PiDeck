import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildTurnDisplay, hasFoldableContent } = loadTsCommonJs("src/renderer/src/components/session/timeline/buildTurnDisplay.ts");
const { buildProcessSummary } = loadTsCommonJs("src/renderer/src/components/session/timeline/segmentSummary.ts");
const { groupTurnProcess } = loadTsCommonJs("src/renderer/src/components/session/timeline/groupTurnProcess.ts");
const { resolveLiveInterimId } = loadTsCommonJs("src/renderer/src/components/session/timeline/liveMount.ts");
const { AnswerOutput } = loadTsCommonJs("src/renderer/src/components/session/AnswerOutput.tsx", {
	stubs: {
		"../../atoms/session-atoms": {},
		// 验证真实正文出口的清理/空值判定；Markdown 插件不是本次计数差异的来源。
		"./MarkdownStream": { MarkdownStream: ({ text }) => createElement("p", null, text) },
	},
});

/** 构造带协议结束标记的真实中间消息；正文清理不得修改历史对象。 */
function interimMessage(id, text) {
	return { id, agentId: "agent-a", role: "assistant", text, timestamp: 1, stopReason: "toolUse" };
}

function displayMessages(messages) {
	return buildTurnDisplay({ kind: "agent-run", id: "run-a", items: messages.map((message) => ({ kind: "message", message })), startedAt: 1, endedAt: 2 });
}

function renderAnswer(item) {
	return renderToStaticMarkup(createElement(AnswerOutput, { mode: "settled", text: item.message.text, messageId: item.id, onOpenExternal: () => {} }));
}

const invisibleBodies = [
	["空骨架", ""],
	["空白", " \n\t "],
	["仅思考标签", "<thinking>先看代码再回答</thinking>"],
	["仅终端控制码", "\u001b[0m"],
	["控制码包裹思考标签", "\u001b[32m<THINKING>只有思考\n没有正文</THINKING>\u001b[0m"],
];

for (const [label, text] of invisibleBodies) {
	test(`${label}：没有正文时不计中间回复，不显示空折叠栏或分组节点`, () => {
		const message = interimMessage("interim-a", text);
		const items = displayMessages([message]);
		assert.equal(items.length, 1, "保留 live 正文使用的稳定挂载点");
		assert.equal(items[0].id, message.id);
		assert.equal(items[0].message, message, "不改写历史消息");
		assert.equal(renderAnswer(items[0]), "");
		assert.equal(buildProcessSummary(items).interimCount, 0, "统计必须与真实正文出口一致");
		assert.equal(hasFoldableContent(items), false);
		assert.equal(groupTurnProcess(items).length, 0);
	});
}

test("混合正常正文和不可见消息：中间回复数等于实际渲染的段数", () => {
	const messages = [...invisibleBodies.map(([, text], index) => interimMessage(`empty-${index}`, text)), interimMessage("visible-a", "我先查看代码"), interimMessage("visible-b", "\u001b[32m<thinking>内部思考</thinking>\n核对完毕，继续验证。\u001b[0m")];
	const items = displayMessages(messages);
	const rendered = items.map(renderAnswer).filter(Boolean);
	assert.equal(rendered.length, 2);
	assert.equal(buildProcessSummary(items).interimCount, rendered.length);
	assert.equal(hasFoldableContent(items), true);
	assert.deepEqual(
		Array.from(groupTurnProcess(items), (node) => node.id),
		["visible-a", "visible-b"],
	);
	assert.match(rendered[1], /核对完毕，继续验证。/);
	assert.doesNotMatch(rendered[1], /内部思考/);
	assert.equal(messages.at(-1).text, "\u001b[32m<thinking>内部思考</thinking>\n核对完毕，继续验证。\u001b[0m");
});

test("不可见中间消息不拆开相邻的过程组", () => {
	const tool = (id) => ({ kind: "tool-group", id, messages: [{ id, agentId: "agent-a", role: "tool", text: "read ok", timestamp: 1, meta: { toolName: "read", status: "done" } }] });
	const items = buildTurnDisplay({ kind: "agent-run", id: "run-a", items: [tool("tool-a"), { kind: "message", message: interimMessage("hidden-a", "<thinking>没有正文</thinking>") }, tool("tool-b")], startedAt: 1, endedAt: 2 });
	const nodes = groupTurnProcess(items);
	assert.equal(nodes.length, 1);
	assert.equal(nodes[0].kind, "group");
	assert.equal(nodes[0].members.length, 2);
	assert.equal(buildProcessSummary(items).interimCount, 0);
	assert.equal(hasFoldableContent(items), true, "工具步骤仍可展开");
});

test("不计数的空骨架仍可挂载实时正文", () => {
	const [item] = displayMessages([interimMessage("live-a", "")]);
	assert.equal(buildProcessSummary([item]).interimCount, 0);
	assert.equal(resolveLiveInterimId({ sessionId: "session-a", lastInterimId: item.id, lastMessageText: item.message.text, liveTextActive: true, agentRunning: true, isStreaming: true, isLastAgentRun: true }), "live-a");
});
