import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Web SSE 流式化（A1）：pi 事件 → AI SDK v5 UIMessageStream 帧 翻译器。
 * 验证：
 * 1) text_delta 生成 text-start/text-delta/text-end 三件套（首帧自动补 start）
 * 2) thinking_delta/end 生成 reasoning 块
 * 3) tool_execution_start/end 生成 tool-input/output-available
 * 4) agent_end 收尾（error 时带 error 帧）
 * 5) 端点与协议头接线（WebServiceManager 注册 /stream + x-vercel-ai-ui-message-stream）
 */

const webServiceSource = readFileSync("src/main/web/WebServiceManager.ts", "utf8");
const indexSource = readFileSync("src/main/index.ts", "utf8");

const { PiEventToUiMessageStream, WebEventStreamRouter, SSE_DONE, serializeSseFrame } = loadTsCommonJs("src/main/web/WebEventStream.ts");

test("text_delta produces start/delta/end triple with auto text-start", () => {
	const adapter = new PiEventToUiMessageStream();

	const start = adapter.push({ type: "message_start", message: { role: "assistant", id: "m1" } });
	assert.equal(start[0].type, "start");
	assert.equal(start[0].messageId, "m1");

	const d1 = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "Hello" },
	});
	assert.equal(d1.length, 2);
	assert.equal(d1[0].type, "text-start");
	assert.equal(d1[1].type, "text-delta");
	assert.equal(d1[1].delta, "Hello");

	// 同一 text 块复用 id，不再发 text-start
	const d2 = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: " world" },
	});
	assert.equal(d2.length, 1);
	assert.equal(d2[0].type, "text-delta");
	assert.equal(d2[0].id, d1[0].id);

	const end = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "text_end" },
	});
	assert.equal(end[0].type, "text-end");
	assert.equal(end[0].id, d1[0].id);
});

test("thinking_delta/end produces reasoning block with start/delta/end", () => {
	const adapter = new PiEventToUiMessageStream();

	const d = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "思考中" },
	});
	assert.equal(d.length, 2);
	assert.equal(d[0].type, "reasoning-start");
	assert.equal(d[1].type, "reasoning-delta");
	assert.equal(d[1].delta, "思考中");

	const end = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_end", content: "思考中" },
	});
	// thinking_end 带 content 但本次事件无 delta：先补一段 reasoning-delta 再收尾
	assert.equal(end[0].type, "reasoning-delta");
	assert.equal(end[0].delta, "思考中");
	assert.equal(end[1].type, "reasoning-end");
});

test("tool_execution_start/end produces tool-input-available and tool-output-available", () => {
	const adapter = new PiEventToUiMessageStream();

	const start = adapter.push({
		type: "tool_execution_start",
		toolName: "bash",
		toolCallId: "call_1",
		args: { command: "ls" },
	});
	assert.equal(start[0].type, "tool-input-start");
	assert.equal(start[0].toolCallId, "call_1");
	assert.equal(start[0].toolName, "bash");
	assert.equal(start[1].type, "tool-input-available");
	assert.equal(start[1].input.command, "ls");

	const end = adapter.push({
		type: "tool_execution_end",
		toolName: "bash",
		toolCallId: "call_1",
		isError: false,
		// P2 工具卡展开：真实执行结果必须透传到 output（空对象会让历史工具卡无详情可展开）
		result: { code: 0, stdout: "ok" },
	});
	assert.equal(end[0].type, "tool-output-available");
	assert.equal(end[0].toolCallId, "call_1");
	// result 对象由宿主传入、适配器原样透传；JSON 归一后 deepEqual（避开 vm realm 原型差异）
	assert.deepEqual(JSON.parse(JSON.stringify(end[0].output)), { code: 0, stdout: "ok" });
});

test("assistant done and agent_end do not close the stream before tools finish", () => {
	const adapter = new PiEventToUiMessageStream();
	adapter.push({ type: "message_start", message: { role: "assistant", id: "m1" } });
	const midDone = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "done" },
	});
	assert.equal(
		midDone.some((frame) => frame.type === "finish"),
		false,
	);
	assert.equal(adapter.push({ type: "agent_end", stopReason: "toolUse" }).length, 0);

	const tool = adapter.push({
		type: "tool_execution_start",
		toolName: "bash",
		toolCallId: "call_1",
	});
	assert.equal(tool[0].type, "tool-input-start");
	const next = adapter.push({ type: "message_start", message: { role: "assistant", id: "m2" } });
	assert.equal(next[0].type, "start-step");

	const settled = adapter.push({ type: "agent_settled" });
	assert.equal(settled.at(-1).type, "finish");
});

test("tool_execution_end with isError emits tool-output-error", () => {
	const adapter = new PiEventToUiMessageStream();
	adapter.push({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_err" });
	const end = adapter.push({
		type: "tool_execution_end",
		toolCallId: "call_err",
		isError: true,
	});
	assert.equal(end[0].type, "tool-output-error");
	assert.equal(end[0].toolCallId, "call_err");
});

test("agent_end without error does not emit finish; settled does", () => {
	const adapter = new PiEventToUiMessageStream();
	assert.equal(adapter.push({ type: "agent_end", stopReason: "done" }).length, 0);
	assert.equal(adapter.push({ type: "agent_settled" })[0].type, "finish");
});

test("agent_settled also closes the Web stream", () => {
	const adapter = new PiEventToUiMessageStream();
	const frames = adapter.push({ type: "agent_settled" });
	assert.equal(frames[0].type, "finish");
});

test("tool_execution_end without tool_execution_start is ignored to prevent AI SDK error", () => {
	const adapter = new PiEventToUiMessageStream();
	// 中途连入或并发时，错过了 tool_execution_start
	const end = adapter.push({
		type: "tool_execution_end",
		toolCallId: "orphan_call_1",
		isError: false,
	});
	assert.equal(end.length, 0);

	const errorEnd = adapter.push({
		type: "tool_execution_end",
		toolCallId: "orphan_call_2",
		isError: true,
	});
	assert.equal(errorEnd.length, 0);

	const toolCallEnd = adapter.push({
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_end",
			toolCall: { id: "orphan_call_3", output: {} },
		},
	});
	assert.equal(toolCallEnd.length, 0);
});

test("duplicate toolcall_start after tool_execution_start must not reset state to running", () => {
	const adapter = new PiEventToUiMessageStream();
	// 顶层事件先到（正常路径）：发 input 帧
	const top = adapter.push({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_dup_1", args: { cmd: "ls" } });
	assert.equal(top.filter((f) => f.type === "tool-input-available").length, 1);
	// message 层重效（pi 回放顺序不定）：不重发 input，避免把已 settle 的 part 拍回 running
	const replay = adapter.push({
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_start",
			toolCall: { id: "call_dup_1", name: "bash", input: { cmd: "ls" } },
		},
	});
	assert.equal(replay.length, 0, "duplicate input frames would regress AI SDK part state");
});

test("toolcall_end without output keeps the tool part running until execution end", () => {
	const adapter = new PiEventToUiMessageStream();
	adapter.push({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_run_1", input: {} });
	// LLM 层参数发完但执行未结束：不 settle，工具卡继续转圈
	const mid = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_end", toolCall: { id: "call_run_1" } },
	});
	assert.equal(mid.length, 0, "toolcall_end without output must not settle the part");
	// 真实结果到达才结算
	const end = adapter.push({ type: "tool_execution_end", toolCallId: "call_run_1", isError: false, result: "done" });
	assert.equal(end.at(-1).type, "tool-output-available");
});

test("toolcall_end with output settles once; later tool_execution_end does not duplicate", () => {
	const adapter = new PiEventToUiMessageStream();
	// message 层先到（回放最终消息带 output）
	adapter.push({
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_start",
			toolCall: { id: "call_fin_1", name: "bash", input: {} },
		},
	});
	const mid = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_end", toolCall: { id: "call_fin_1", output: { ok: true } } },
	});
	assert.equal(mid.at(-1).type, "tool-output-available");
	// 顶层事件后到：不再发第二份 output
	const top = adapter.push({ type: "tool_execution_end", toolCallId: "call_fin_1", isError: false, result: { ok: true } });
	assert.equal(top.filter((f) => f.type === "tool-output-available").length, 0);
});

test("agent_end error carries error frame before finish", () => {
	const adapter = new PiEventToUiMessageStream();
	const frames = adapter.push({ type: "agent_end", error: "boom" });
	assert.equal(frames[0].type, "error");
	assert.equal(frames[0].errorText, "boom");
	assert.equal(frames[1].type, "finish");
});

test("finish() closes open text/reasoning blocks", () => {
	const adapter = new PiEventToUiMessageStream();
	adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "abc" },
	});
	const frames = adapter.finish();
	assert.equal(frames[0].type, "text-end");
	assert.equal(frames[1].type, "finish");
});

test("serializeSseFrame / SSE_DONE produce AI SDK wire format", () => {
	assert.equal(serializeSseFrame({ type: "finish" }), 'data: {"type":"finish"}\n\n');
	assert.equal(SSE_DONE, "data: [DONE]\n\n");
});

test("WebEventStreamRouter closes the response after sending the done marker", () => {
	const received = [];
	let finished = 0;
	const router = new WebEventStreamRouter(() => "session-1");
	router.add(
		"session-1",
		(wire) => {
			received.push(wire);
			return true;
		},
		() => {},
		() => {
			finished += 1;
		},
	);
	router.bindPiSource((handler) => {
		handler("agent-a", { type: "agent_settled" });
		return () => {};
	});
	assert.equal(received.at(-1), "data: [DONE]\n\n");
	assert.equal(finished, 1);
});

test("WebEventStreamRouter routes agent events to per-session entries only", () => {
	const received = [];
	const router = new WebEventStreamRouter((agentId) => {
		if (agentId === "agent-a") return "session-1";
		return undefined;
	});
	router.add(
		"session-1",
		(wire) => {
			received.push(wire);
			return true;
		},
		() => {},
	);
	// 绑定 pi 源后事件按 agentId → sessionId 路由；finish 后自动附 [DONE]
	router.bindPiSource((handler) => {
		handler("agent-a", { type: "message_start", message: { role: "assistant" } });
		handler("other-agent", { type: "agent_settled" });
		handler("agent-a", { type: "agent_settled" });
		return () => {};
	});
	assert.equal(received.length, 3);
	assert.match(received[0], /data: \{"type":"start"/);
	assert.match(received[1], /data: \{"type":"finish"\}/);
	assert.equal(received[2], "data: [DONE]\n\n");

	router.unbindPiSource();
});

test("WebServiceManager registers /stream SSE endpoint with protocol header", () => {
	assert.match(webServiceSource, /\/api\/sessions\/([^/]+)\/stream/);
	assert.match(webServiceSource, /x-vercel-ai-ui-message-stream/);
	assert.match(webServiceSource, /text\/event-stream/);
	// [DONE] 终止标记在翻译器模块
	assert.match(readFileSync("src/main/web/WebEventStream.ts", "utf8"), /data: \[DONE\]/);
});

test("index.ts wires pi event source + agent-to-session router to WebServiceManager", () => {
	assert.match(indexSource, /subscribePiEvents:/);
	assert.match(indexSource, /addLocalEventListener/);
	assert.match(indexSource, /getSessionIdForAgent:/);
	assert.match(indexSource, /getSessionId\(agentId\)/);
});

test("web frontend preserves streaming block during polling refresh", () => {
	// refresh() 在流式活跃时只渲染侧栏/状态，不整体重绘 #messages
	assert.match(webServiceSource, /if \(streamingSessionId\)/);
	assert.match(webServiceSource, /renderMessages\(\)/);
	// render() 不再直接操作 #messages（拆到 renderMessages）
	const renderBody = webServiceSource.slice(webServiceSource.indexOf("function render() {"), webServiceSource.indexOf("function renderMessages()"));
	assert.doesNotMatch(renderBody, /el\("messages"\)/);
});

test("web frontend reloads authoritative messages on stream finish", () => {
	// [DONE] 后先停流、再 loadSessionMessages + 整体重绘（替换流式增量块）
	assert.match(webServiceSource, /finishStream\(sessionId\)/);
	assert.match(webServiceSource, /loadSessionMessages\(sessionId\)/);
	assert.match(webServiceSource, /async function finishStream/);
});
