/**
 * ACP 投影器状态机单测(纯函数,不依赖真实 CLI):
 * user 回显、assistant 流式聚合(thought 与 message 分流)、tool 卡片按
 * toolCallId 精确回写状态、plan/available_commands_update 投影、settleAcpTurn
 * 回合收口、未知 update 前向兼容忽略。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { initialAcpProjection, projectAcpSessionUpdate, settleAcpTurn, ACP_TOOL_RESULT_MAX_CHARS } = loadTsCommonJs("src/main/acp/AcpEventProjector.ts");

const AGENT = "agent-1";

function step(state, update) {
	return projectAcpSessionUpdate(state, update, AGENT);
}

test("user_message_chunk echoes text and image blocks", () => {
	let state = step(initialAcpProjection(), { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } });
	state = step(state, { sessionUpdate: "user_message_chunk", content: { type: "image", data: "abcd", mimeType: "image/png" } });
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[0].role, "user");
	assert.equal(state.messages[0].text, "hello");
	assert.equal(state.messages[1].images[0].mimeType, "image/png");
	assert.equal(state.replayed, true);
});

test("agent_message_chunk aggregates into one streaming assistant message per turn", () => {
	let state = initialAcpProjection();
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo world" } });
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0].text, "Hello world");
	assert.equal(state.activeAssistantIndex, 0);
	state = settleAcpTurn(state, "end_turn");
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second turn" } });
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[1].text, "second turn");
});

test("thought chunks stream into thinking field, not message text", () => {
	let state = initialAcpProjection();
	state = step(state, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } });
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } });
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0].text, "answer");
	assert.equal(state.messages[0].thinking, "thinking...");
});

test("tool_call updates the same card by toolCallId across status transitions", () => {
	let state = initialAcpProjection();
	state = step(state, { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Read file", kind: "read", status: "in_progress" });
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0].meta.status, "running");
	state = step(state, { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Read file", kind: "read", status: "completed", content: [{ type: "text", text: "file body" }] });
	// 同一 callId 更新原卡片,不新增消息
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0].meta.status, "completed");
	assert.equal(state.messages[0].meta.fullText, "file body");
	// 第二个工具追加新卡片
	state = step(state, { sessionUpdate: "tool_call", toolCallId: "tc2", title: "Run build", kind: "execute", status: "in_progress", locations: [{ path: "src/a.ts", line: 3 }] });
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[1].meta.locations.length, 1);
	// 流式 assistant 消息不会被工具卡切断:消息后仍可继续聚合
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
	const last = state.messages[state.messages.length - 1];
	assert.equal(last.role, "assistant");
	assert.equal(last.text, "done");
});

test("tool content truncates beyond cap and keeps fullText", () => {
	const long = "x".repeat(ACP_TOOL_RESULT_MAX_CHARS + 100);
	let state = initialAcpProjection();
	state = step(state, { sessionUpdate: "tool_call", toolCallId: "tc1", title: "T", status: "completed", content: [{ type: "text", text: long }] });
	assert.equal(state.messages[0].meta.fullText.length, ACP_TOOL_RESULT_MAX_CHARS + 100);
	assert.ok(state.messages[0].text === undefined || state.messages[0].text.length <= 4);
	// 特殊块占位
	state = step(state, { sessionUpdate: "tool_call", toolCallId: "tc2", title: "T2", status: "completed", content: [{ type: "diff", path: "a.ts" }, { type: "terminal" }] });
	assert.match(state.messages[1].meta.fullText, /\[diff a\.ts\]/);
	assert.match(state.messages[1].meta.fullText, /\[terminal\]/);
});

test("plan and available_commands_update project last-wins", () => {
	let state = initialAcpProjection();
	state = step(state, {
		sessionUpdate: "plan",
		plan: [
			{ content: "a", status: "in_progress" },
			{ content: "b", status: "pending" },
		],
	});
	assert.equal(state.todos.length, 2);
	assert.equal(state.todos[0].status, "in_progress");
	state = step(state, { sessionUpdate: "plan", plan: [{ content: "only", status: "completed" }] });
	assert.equal(state.todos.length, 1);
	assert.equal(state.todos[0].status, "completed");
	state = step(state, { sessionUpdate: "available_commands_update", commands: [{ name: "/run", description: "run it" }] });
	assert.equal(state.commands.length, 1);
	assert.equal(state.commands[0].name, "/run");
	assert.equal(state.commands[0].source, "acp");
});

test("session_info_update records title and unknown updates are ignored", () => {
	let state = initialAcpProjection();
	state = step(state, { sessionUpdate: "session_info_update", sessionTitle: "My session" });
	assert.equal(state.title, "My session");
	const before = state.messages.length;
	state = step(state, { sessionUpdate: "some_future_update", anything: true });
	assert.equal(state.messages.length, before);
	assert.equal(state.replayed, true);
});

test("settleAcpTurn marks stop reason and clears active index", () => {
	let state = initialAcpProjection();
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
	state = settleAcpTurn(state, "cancelled");
	assert.equal(state.messages.length, 1);
	// cancelled/aborted 归一为渲染层 aborted 语义
	assert.equal(state.messages[0].stopReason, "aborted");
	assert.equal(state.activeAssistantIndex, undefined);
});
