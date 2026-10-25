/** Stable ACP v1 frames through the real manager/transport, without real processes or models. */
import assert from "node:assert/strict";
import test from "node:test";
import { harness, sessionUpdate, waitFor } from "./helpers/acpAgentHarness.mjs";

const configOptions = [{ id: "model", name: "Model", type: "select", currentValue: "fast", options: [{ name: "Fast", value: "fast" }] }];

function basicHandler(frame) {
	if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
	if (frame.method === "session/new") return { sessionId: "session-1" };
	return undefined;
}

function permission(
	cli,
	id,
	sessionId = "session-1",
	options = [
		{ optionId: "approve-this", name: "Allow", kind: "allow_once" },
		{ optionId: "deny-this", name: "Reject", kind: "reject_once" },
	],
) {
	cli.writeFromCli({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "tool-1", title: "Run command", rawInput: { command: "git status" } }, options } });
}

test("initialize reads agentInfo and object-valued session/list capabilities", async (t) => {
	const { manager, createAgent, lastProc } = harness(t, { handler: (frame) => (frame.method === "initialize" ? { protocolVersion: 1, agentInfo: { name: "fixture-agent", version: "1.0" }, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } } : basicHandler(frame)) });
	const tab = await createAgent();
	const info = manager.getAgentInfo(tab.id);
	assert.equal(info.name, "fixture-agent");
	assert.equal(info.capabilities.sessionList, true);
	assert.equal(info.capabilities.loadSession, true);
	assert.equal(lastProc().methodFrames("initialized").length, 0, "ACP has no initialized notification");
});

for (const version of [2, "1", undefined]) {
	test(`initialize rejects unsupported or malformed protocolVersion: ${String(version)}`, async (t) => {
		const { manager, createAgent, lastProc } = harness(t, { handler: (frame) => (frame.method === "initialize" ? { protocolVersion: version, agentCapabilities: {} } : basicHandler(frame)) });
		await assert.rejects(createAgent(), /protocolVersion/);
		assert.equal(lastProc().methodFrames("session/new").length, 0);
		assert.equal(manager.list().length, 0);
		assert.equal(lastProc().proc.exitCode, 0);
	});
}

test("session/load accepts an empty response and waits for replay/image materialization before attach", async (t) => {
	const { manager, lastProc } = harness(
		t,
		{
			handler: (frame, { writeFromCli }) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
				if (frame.method === "session/load") {
					sessionUpdate(writeFromCli, "old-session", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Earlier question" } });
					sessionUpdate(writeFromCli, "old-session", { sessionUpdate: "agent_message_chunk", content: { type: "image", mimeType: "image/png", data: "replayed-image" } });
					sessionUpdate(writeFromCli, "old-session", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Earlier answer" } });
					return {};
				}
				return basicHandler(frame);
			},
		},
		{
			imageStore: {
				put: async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return "loaded-ref";
				},
			},
		},
	);
	const tab = await manager.create({ projectId: "p1", backend: "acp", agentPreset: "gemini", acpSessionId: "old-session" });
	assert.equal(tab.sessionId, "old-session");
	assert.equal(lastProc().methodFrames("session/new").length, 0);
	const messages = manager.readMessages(tab.id);
	assert.equal(messages.length, 2, "create must resolve with complete replay, not an empty timeline");
	assert.equal(messages[1].text, "Earlier answer");
	assert.equal(messages[1].images[0].ref, "loaded-ref");
	assert.equal(messages[1].stopReason, "stop");
});

test("failed session/load discards partial replay before falling back to a new session", async (t) => {
	const titles = [];
	const { manager } = harness(
		t,
		{
			handler: (frame, { writeFromCli }) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
				if (frame.method === "session/load") {
					sessionUpdate(writeFromCli, "old-session", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "discard this replay" } });
					sessionUpdate(writeFromCli, "old-session", { sessionUpdate: "session_info_update", title: "Discarded title" });
					return { __error: true, code: -32602, message: "session missing" };
				}
				return basicHandler(frame);
			},
		},
		{ onTitleChanged: (_id, title) => titles.push(title) },
	);
	const tab = await manager.create({ projectId: "p1", deckSessionId: "deck-1", backend: "acp", agentPreset: "gemini", acpSessionId: "old-session" });
	assert.equal(tab.sessionId, "session-1");
	assert.equal(manager.readMessages(tab.id).length, 0);
	assert.equal(titles.includes("Discarded title"), false);
});

test("standard config, title and plan updates reach session-isolated existing UI payloads", async (t) => {
	const seen = [];
	const titles = [];
	const { manager, events, createAgent, lastProc } = harness(t, { handler: basicHandler }, { onConfigOptionsChanged: (tab, options) => seen.push({ agentId: tab.id, options }), onTitleChanged: (_id, title) => titles.push(title) });
	const tab = await createAgent();
	const update = (sessionId, value) => sessionUpdate(lastProc().writeFromCli, sessionId, value);
	update("session-1", { sessionUpdate: "config_option_update", configOptions });
	update("session-1", { sessionUpdate: "session_info_update", title: "ACP session title" });
	update("session-1", { sessionUpdate: "plan", entries: [{ content: "Inspect", priority: "high", status: "in_progress" }] });
	await waitFor(() => events.runtimeStates.some((payload) => payload.state?.todos?.[0]?.content === "Inspect"), "standard state payload containing plan");
	assert.equal(manager.getSessionConfigOptions(tab.id)[0].id, "model");
	assert.equal(seen[0].agentId, tab.id);
	assert.deepEqual(titles, ["ACP session title"]);
	update("other-session", { sessionUpdate: "config_option_update", configOptions: [] });
	update("session-1", { sessionUpdate: "plan", entries: [] });
	await waitFor(() => events.runtimeStates.at(-1)?.state?.todos?.length === 0);
	assert.equal(seen.length, 1);
});

test("prompt records one local user message when the agent does not echo it", async (t) => {
	const { manager, createAgent } = harness(t, {
		handler: (frame, { writeFromCli }) => {
			if (frame.method === "session/prompt") {
				sessionUpdate(writeFromCli, "session-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } });
				return { stopReason: "end_turn" };
			}
			return basicHandler(frame);
		},
	});
	const tab = await createAgent();
	await manager.sendPrompt({ agentId: tab.id, message: "Question" });
	await manager.sendPrompt({ agentId: tab.id, message: "Another question" });
	const messages = manager.readMessages(tab.id);
	assert.deepEqual(
		Array.from(messages, (message) => message.role),
		["user", "assistant", "user", "assistant"],
	);
	assert.equal(messages[0].text, "Question");
	assert.equal(messages[2].text, "Another question");
});

test("live user echoes do not duplicate a submitted prompt or its image attachments", async (t) => {
	const { manager, createAgent } = harness(t, {
		handler: (frame, { writeFromCli }) => {
			// 能力门控（AcpAgentManager.sendPrompt）要求 agent 声明 promptCapabilities.image 才接受图块；
			// 本用例测回显去重，不是门控，故显式声明。
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } };
			if (frame.method === "session/prompt") {
				for (const content of frame.params.prompt) sessionUpdate(writeFromCli, "session-1", { sessionUpdate: "user_message_chunk", content });
				sessionUpdate(writeFromCli, "session-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } });
				return { stopReason: "end_turn" };
			}
			return basicHandler(frame);
		},
	});
	const tab = await createAgent();
	await manager.sendPrompt({ agentId: tab.id, message: "Question", images: [{ type: "image", data: "picture", mimeType: "image/png" }] });
	const messages = manager.readMessages(tab.id);
	assert.equal(messages.length, 2);
	assert.equal(messages[0].role, "user");
	assert.equal(messages[0].text, "Question");
	assert.equal(messages[0].images.length, 1);
});

test("a prompt failure after agent output reports unknown delivery instead of pruning the session", async (t) => {
	const { manager, createAgent } = harness(t, {
		handler: (frame, { writeFromCli }) => {
			if (frame.method === "session/prompt") {
				sessionUpdate(writeFromCli, "session-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Partial answer" } });
				return { __error: true, code: -32603, message: "agent failed after output" };
			}
			return basicHandler(frame);
		},
	});
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "Question" });
	assert.equal(result.accepted, false);
	assert.equal(result.delivery, "unknown");
	assert.equal(manager.readMessages(tab.id).at(-1).text, "Partial answer");
});

test("standard permission requests return nested outcomes with the original optionId", async (t) => {
	const { manager, events, createAgent, lastProc } = harness(t, { handler: basicHandler });
	const tab = await createAgent();
	permission(lastProc(), "permission-1");
	await waitFor(() => events.uiRequests.some((payload) => payload.method === "select"));
	const request = events.uiRequests.find((payload) => payload.method === "select");
	assert.equal(request.title, "Run command");
	await manager.sendUIResponse(tab.id, request.requestId, { type: "select", value: "Reject" });
	assert.deepEqual(lastProc().frames.find((frame) => frame.id === "permission-1").result, { outcome: { outcome: "selected", optionId: "deny-this" } });
});

test("permission options with identical names remain independently selectable", async (t) => {
	const { manager, events, createAgent, lastProc } = harness(t, { handler: basicHandler });
	const tab = await createAgent();
	permission(lastProc(), 71, "session-1", [
		{ optionId: "once", name: "Allow", kind: "allow_once" },
		{ optionId: "always", name: "Allow", kind: "allow_always" },
	]);
	await waitFor(() => events.uiRequests.some((payload) => payload.method === "select"));
	const request = events.uiRequests.find((payload) => payload.method === "select");
	assert.equal(new Set(request.options).size, 2);
	await manager.sendUIResponse(tab.id, request.requestId, { type: "select", value: request.options[0] });
	assert.deepEqual(lastProc().frames.find((frame) => frame.id === 71).result, { outcome: { outcome: "selected", optionId: "once" } });
});

test("invalid or foreign-session permission requests are promptly cancelled, never deferred forever", async (t) => {
	const { events, createAgent, lastProc } = harness(t, { handler: basicHandler });
	await createAgent();
	permission(lastProc(), 72, "other-session");
	permission(lastProc(), 73, "session-1", []);
	await waitFor(() => lastProc().frames.filter((frame) => frame.id === 72 || frame.id === 73).length === 2);
	for (const id of [72, 73]) assert.deepEqual(lastProc().frames.find((frame) => frame.id === id).result, { outcome: { outcome: "cancelled" } });
	assert.equal(events.uiRequests.length, 0);
});

test("permission expiry returns cancelled to the agent and withdraws the UI request exactly once", async (t) => {
	const { manager, events, createAgent, lastProc } = harness(t, { handler: basicHandler }, { permissionTimeoutMs: 20 });
	const tab = await createAgent();
	permission(lastProc(), 74);
	await waitFor(() => lastProc().frames.some((frame) => frame.id === 74 && frame.result));
	const request = events.uiRequests.find((payload) => payload.method === "select");
	assert.deepEqual(lastProc().frames.find((frame) => frame.id === 74).result, { outcome: { outcome: "cancelled" } });
	assert.equal(events.uiRequests.filter((payload) => payload.requestId === request.requestId && payload.completed).length, 1);
	assert.equal((await manager.sendUIResponse(tab.id, request.requestId, { type: "select", value: "Allow" })).accepted, false);
});

test("concurrent config selections are serialized so a late first response cannot roll back the newer table", async (t) => {
	const table = (value) => [{ id: "model", name: "Model", type: "select", currentValue: value, options: [{ name: value, value }] }];
	const notifications = [];
	let firstFrame;
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "session-1" };
				if (frame.method === "session/set_config_option") {
					if (!firstFrame) {
						firstFrame = frame;
						return undefined; // 第一个响应由测试延迟手动写，模拟乱序
					}
					return { configOptions: table(frame.params.value) };
				}
				return undefined;
			},
		},
		{ onConfigOptionsChanged: (_tab, options) => notifications.push(options[0].currentValue) },
	);
	const tab = await createAgent();
	const first = manager.applyConfigOption(tab.id, "model", "first");
	const second = manager.applyConfigOption(tab.id, "model", "second");
	await waitFor(() => lastProc().methodFrames("session/set_config_option").length >= 1, "first set frame");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(lastProc().methodFrames("session/set_config_option").length, 1, "the second set must wait for the first response before being sent");
	lastProc().writeFromCli({ jsonrpc: "2.0", id: firstFrame.id, result: { configOptions: table("first") } });
	assert.equal((await first)[0].currentValue, "first");
	await waitFor(() => lastProc().methodFrames("session/set_config_option").length === 2, "second set frame");
	assert.equal((await second)[0].currentValue, "second");
	assert.equal(manager.getSessionConfigOptions(tab.id)[0].currentValue, "second");
	assert.deepEqual(notifications, ["first", "second"], "notifications must follow request order and end at the newest table");
});

test("abort settles all permissions while keeping the prompt active until its cancelled response", async (t) => {
	const { manager, events, createAgent, lastProc } = harness(t, { handler: basicHandler });
	const tab = await createAgent();
	const sending = manager.sendPrompt({ agentId: tab.id, message: "Question" });
	await waitFor(() => lastProc().methodFrames("session/prompt").length === 1);
	permission(lastProc(), 75);
	await waitFor(() => events.uiRequests.some((payload) => payload.method === "select"));
	await manager.abort(tab.id);
	assert.deepEqual(lastProc().frames.find((frame) => frame.id === 75)?.result, { outcome: { outcome: "cancelled" } });
	assert.equal((await manager.getRuntimeState(tab.id)).isTurnActive, true);
	sessionUpdate(lastProc().writeFromCli, "session-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Cancelled tail" } });
	lastProc().writeFromCli({ jsonrpc: "2.0", id: lastProc().methodFrames("session/prompt")[0].id, result: { stopReason: "cancelled" } });
	assert.equal((await sending).accepted, true);
	assert.equal(manager.readMessages(tab.id).at(-1).stopReason, "aborted");
});
