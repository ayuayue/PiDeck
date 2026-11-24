import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox({ stubs: { "../../../i18n": { t: (key) => key }, "../../ui-shadcn/button": {}, "../SurfaceComponents": {} } });
const { AgentMessageProjector } = load("src/main/pi/AgentMessageProjector.ts");
const { groupToolMessages } = load("src/renderer/src/components/app/appUtils/groupMessages.ts");
const { buildTurnDisplay } = load("src/renderer/src/components/session/timeline/buildTurnDisplay.ts");
const { buildProcessSummary } = load("src/renderer/src/components/session/timeline/segmentSummary.ts");
const { TurnRowActions } = load("src/renderer/src/components/session/turn/TurnRowActions.tsx");
const { convertKimiSession } = load("src/main/sessions/kimiSessionConvert.ts");
const projector = new AgentMessageProjector({ translate: (key) => key, isAskAborted: () => false });
const textBlock = (text) => ({ type: "text", text });
const toolCall = (id) => ({ type: "toolCall", id, name: "Read", arguments: {} });
const importModel = { api: "kimi-import", provider: "kimi", model: "kimi-import" };

function turns(rawMessages) {
	return Array.from(groupToolMessages(projector.convert("kimi-test", rawMessages)), (row) => {
		if (row.kind !== "agent-run") return null;
		const items = buildTurnDisplay(row, { showThinking: true, isComplete: true });
		return {
			visible: Array.from(
				items.filter((item) => item.kind === "final-answer"),
				(item) => item.message.text,
			),
			toolGroups: buildProcessSummary(items).toolCount,
		};
	}).filter(Boolean);
}

const expectedTurns = [
	{ visible: ["开始检查"], toolGroups: 0 },
	{ visible: ["检查第二项"], toolGroups: 1 },
	{ visible: ["检查完成"], toolGroups: 1 },
];

test("Kimi 旧导入：收起执行过程后仍可见各段输出，工具次数按段显示", () => {
	// v2 会把文本和随后的调用落在同一条 toolUse 消息内。
	const history = [];
	for (const [id, text] of [
		["a", "开始检查"],
		["b", "检查第二项"],
	]) {
		history.push({ role: "assistant", ...importModel, stopReason: "toolUse", content: [textBlock(text), toolCall(id)] });
		history.push({ role: "toolResult", toolCallId: id, toolName: "Read", content: [textBlock("ok")] });
	}
	history.push({ role: "assistant", ...importModel, stopReason: "stop", content: [textBlock("检查完成")] });
	assert.deepEqual(turns(history), expectedTurns);
	// 真实模型的中间回复仍服从 pi 原有折叠规则。
	assert.equal(turns(history.map((msg) => ({ ...msg, api: "openai-completions", model: "kimi-k2" }))).length, 1);
});

test("Kimi 新导入：从 wire 经历史投影到折叠时间线，中间文本和过程计数分段", async () => {
	const events = [];
	for (const [id, text] of [
		["a", "开始检查"],
		["b", "检查第二项"],
	]) {
		events.push({ type: "step.begin", uuid: id }, { type: "content.part", stepUuid: id, part: textBlock(text) }, { type: "tool.call", stepUuid: id, toolCallId: id, name: "Read", args: {} }, { type: "tool.result", toolCallId: id, result: { output: "ok" } }, { type: "step.end", uuid: id });
	}
	events.push({ type: "content.part", part: textBlock("检查完成") });
	const entries = events.map((event, i) => ({ type: "context.append_loop_event", event, time: 1000 + i }));
	const session = { meta: { sessionId: "kimi-test", title: "test", firstTimestamp: 1000 }, sourcePath: "wire.jsonl", sourceMtime: 1200, sourceSize: 1024, entries };
	const { raw } = await convertKimiSession({ projectPath: "/test", translate: (key) => key, session });
	const messages = raw
		.trim()
		.split("\n")
		.map(JSON.parse)
		.filter((line) => line.type === "message")
		.map((line) => line.message);
	assert.deepEqual(turns(messages), expectedTurns);
});

test("轮尾：Kimi Code 导入显示 kimi code，真实模型显示自己的名字", () => {
	for (const [provider, modelId, label] of [
		["kimi", "kimi-import", "kimi code"],
		["kimi", "kimi code", "kimi code"],
		["other", "kimi-import", "kimi-import"],
		["kimi", "kimi-k2", "kimi-k2"],
		["kimi-work", "kimi-work-import", "kimi-work-import"],
	]) {
		const html = renderToStaticMarkup(createElement(TurnRowActions, { showTurnModel: true, turnModel: { provider, modelId } }));
		assert.ok(html.includes(`>${label}</span>`), html);
		assert.ok(html.includes(`title="${provider}/${label}"`), html);
	}
});
