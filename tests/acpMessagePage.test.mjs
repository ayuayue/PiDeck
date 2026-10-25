/** ACP timelines use the existing catalog page IPC, never pi files or image-session storage. */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function messages(prefix, turns = 3) {
	return Array.from({ length: turns }, (_, index) => [
		{ id: `${prefix}-u${index}`, agentId: "acp:fixture", role: "user", text: `Question ${index}`, timestamp: index },
		{ id: `${prefix}-a${index}`, agentId: "acp:fixture", role: "assistant", text: `Answer ${index}`, timestamp: index },
	]).flat();
}

/** Register the actual IPC handler with in-memory dependencies; no Electron process or CLI is started. */
function harness(entry, history) {
	const handlers = new Map();
	const calls = [];
	const { registerSessionIpc } = loadTsCommonJs("src/main/ipc/sessionIpc.ts", {
		stubs: { electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, dialog: {} } },
	});
	registerSessionIpc({
		sessionCatalog: { get: (id) => (id === "deck-session" ? entry : undefined) },
		sessionRuntimeCoordinator: { getTarget: () => undefined },
		dshBackend: {
			readAcpMessages: (id) => {
				calls.push(["acp", id]);
				return history;
			},
		},
		readImageSessionMessages: async () => {
			calls.push(["image"]);
			return [];
		},
		agentManager: {
			readSessionDisplayTurnPage: async () => {
				calls.push(["pi"]);
				return { messages: [], total: 0, nextBefore: null };
			},
		},
		appLogger: { warn: () => {} },
	});
	return { calls, read: (before, size) => handlers.get("sessions:catalog-read-message-page")({}, "deck-session", before, size) };
}

test("ACP catalog pages restore active history and paginate complete turns with the existing cursor", async () => {
	const history = messages("s");
	const { read, calls } = harness({ id: "deck-session", projectId: "p1", backend: "acp", acpSessionId: "agent-session" }, history);
	const newest = await read(undefined, 1);
	assert.deepEqual(
		Array.from(newest.messages, (message) => message.id),
		["s-u2", "s-a2"],
	);
	assert.equal(newest.total, 6);
	assert.equal(newest.nextBefore, 4);
	const older = await read(newest.nextBefore, 1);
	assert.deepEqual(
		Array.from(older.messages, (message) => message.id),
		["s-u1", "s-a1"],
	);
	assert.equal(older.nextBefore, 2);
	const oldest = await read(older.nextBefore, 1);
	assert.deepEqual(
		Array.from(oldest.messages, (message) => message.id),
		["s-u0", "s-a0"],
	);
	assert.equal(oldest.nextBefore, null);
	assert.deepEqual(calls, [
		["acp", "agent-session"],
		["acp", "agent-session"],
		["acp", "agent-session"],
	]);
});

test("ACP records with stale pi file paths still read only their ACP session", async () => {
	const history = messages("other", 1);
	const { read, calls } = harness({ id: "deck-session", projectId: "p1", backend: "acp", acpSessionId: "other-agent-session", filePath: "C:/stale/pi-session.jsonl" }, history);
	const page = await read();
	assert.equal(page.messages.length, 2);
	assert.deepEqual(calls, [["acp", "other-agent-session"]]);
});
