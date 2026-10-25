/** ACP cancellation and process cleanup must settle the current runtime without reviving stale output. */
import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { harness, sessionUpdate, waitFor } from "./helpers/acpAgentHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function basicHandler(frame) {
	if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
	if (frame.method === "session/new") return { sessionId: "session-1" };
	return undefined;
}

/** 物化用例需要 agent 声明图片能力（sendPrompt 的图片块按 promptCapabilities.image 门控）。 */
function imageCapableHandler(frame) {
	if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } };
	return basicHandler(frame);
}

function imageGate() {
	let release;
	let started = false;
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	return {
		imageStore: {
			put: async () => {
				started = true;
				return pending;
			},
		},
		release,
		started: () => started,
	};
}

test("abort during local image materialization does not dispatch a new prompt after cancel", async (t) => {
	const gate = imageGate();
	const { manager, createAgent, lastProc } = harness(t, { handler: imageCapableHandler }, { imageStore: gate.imageStore, promptTurnTimeoutMs: 40 });
	const tab = await createAgent();
	const sending = manager.sendPrompt({ agentId: tab.id, message: "Question", images: [{ type: "image", data: "picture", mimeType: "image/png" }] });
	await waitFor(gate.started, "image materialization");
	await manager.abort(tab.id);
	gate.release("image-ref");
	await sending;
	assert.equal(lastProc().methodFrames("session/prompt").length, 0, "cancel must not be followed by the prompt it was meant to stop");
	assert.equal(manager.readMessages(tab.id)[0].images[0].ref, "image-ref");
	assert.equal((await manager.getRuntimeState(tab.id)).isTurnActive, false);
});

test("prompt rejection cancels every pending permission without waiting for its timeout", async (t) => {
	const { manager, createAgent, events, lastProc } = harness(t, { handler: basicHandler });
	const tab = await createAgent();
	const sending = manager.sendPrompt({ agentId: tab.id, message: "Question" });
	await waitFor(() => lastProc().methodFrames("session/prompt").length === 1);
	lastProc().writeFromCli({ jsonrpc: "2.0", id: "approval", method: "session/request_permission", params: { sessionId: "session-1", toolCall: { toolCallId: "call" }, options: [{ optionId: "once", name: "Allow", kind: "allow_once" }] } });
	await waitFor(() => events.uiRequests.some((event) => event.method === "select"));
	const request = events.uiRequests.find((event) => event.method === "select");
	lastProc().writeFromCli({ jsonrpc: "2.0", id: lastProc().methodFrames("session/prompt")[0].id, error: { code: -32603, message: "turn failed" } });
	assert.equal((await sending).accepted, false);
	assert.deepEqual(lastProc().frames.find((frame) => frame.id === "approval")?.result, { outcome: { outcome: "cancelled" } });
	assert.equal(events.uiRequests.filter((event) => event.completed && event.requestId === request.requestId).length, 1);
	assert.equal((await manager.sendUIResponse(tab.id, request.requestId, { type: "select", value: "Allow" })).accepted, false);
});

test("stopping a runtime while materialization is pending suppresses late timeline flushes", async (t) => {
	const gate = imageGate();
	const { manager, createAgent, events, lastProc } = harness(t, { handler: imageCapableHandler }, { imageStore: gate.imageStore });
	const tab = await createAgent();
	const sending = manager.sendPrompt({ agentId: tab.id, message: "Question", images: [{ type: "image", data: "picture", mimeType: "image/png" }] });
	await waitFor(gate.started, "image materialization");
	await manager.stop(tab.id);
	const count = events.messages.length;
	gate.release("image-ref");
	assert.equal((await sending).accepted, false);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(events.messages.length, count, "the removed runtime must never republish its cached messages");
	assert.equal(lastProc().methodFrames("session/prompt").length, 0);
	assert.equal(manager.list().length, 0);
});

test("process exit waits for trailing stdout frames instead of rejecting a completed prompt", async (t) => {
	const { manager, createAgent, lastProc } = harness(t, { handler: basicHandler });
	const tab = await createAgent();
	const sending = manager.sendPrompt({ agentId: tab.id, message: "Question" });
	await waitFor(() => lastProc().methodFrames("session/prompt").length === 1);
	const cli = lastProc();
	sessionUpdate(cli.writeFromCli, "session-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(300_000) } });
	cli.proc.exitCode = 0;
	cli.proc.emit("exit", 0, null);
	cli.writeFromCli({ jsonrpc: "2.0", id: cli.methodFrames("session/prompt")[0].id, result: { stopReason: "end_turn" } });
	cli.proc.stdout.end();
	assert.equal((await sending).accepted, true, "Node exit precedes stdout drain, so its final response is still deliverable");
	assert.equal(manager.readMessages(tab.id).at(-1).text.length, 300_000);
	assert.equal(manager.readMessages(tab.id).at(-1).stopReason, "stop");
});

test("standard ACP state payload merges into the canonical session atoms without leaking to another session", async (t) => {
	const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");
	const store = createStore();
	const { manager, createAgent, events, lastProc } = harness(t, { handler: basicHandler });
	const tab = await createAgent();
	const session = (id) => ({ id, projectId: "p1", title: id, environment: "native", source: "pi", backend: "acp", createdAt: 1, updatedAt: 1 });
	store.set(atoms.replaceProjectSessionsAtom, { projectId: "p1", sessions: [session("deck-1"), session("deck-2")] });
	store.set(atoms.replaceSessionRuntimesAtom, [{ sessionId: "deck-1", agentId: tab.id, runtimeGeneration: 1, projectId: "p1", cwd: "D:/proj-p1", status: "idle", createdAt: 1 }]);
	sessionUpdate(lastProc().writeFromCli, "session-1", { sessionUpdate: "plan", entries: [{ content: "Inspect", priority: "medium", status: "pending" }] });
	await waitFor(() => events.runtimeStates.at(-1)?.state?.todos?.length === 1);
	for (const payload of events.runtimeStates) store.set(atoms.applySessionRuntimeEventAtom, { kind: "event", sessionId: "deck-1", agentId: tab.id, runtimeGeneration: 1, sourceChannel: "agents:runtime-state", payload });
	const state = store.get(atoms.sessionRuntimeByIdAtom)["deck-1"].state;
	assert.equal(state.todos[0].content, "Inspect");
	assert.equal(state.modelName, "Gemini CLI");
	assert.equal(state.isTurnActive, false);
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["deck-2"], undefined);
});
