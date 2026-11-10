import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { registerSessionShareExportIpc } = loadTsCommonJs("src/main/ipc/sessionShareExportIpc.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

test("share IPC binds preview/save/release to the calling renderer and cleans up on window destruction", async () => {
	const handlers = new Map();
	const calls = [];
	let destroyed;
	const service = {
		prepare: async (owner, input) => {
			calls.push(["prepare", owner, input]);
			return { ok: true, value: { previewId: "main-issued" } };
		},
		save: async (owner, id) => {
			calls.push(["save", owner, id]);
			return { ok: true };
		},
		release: (owner, id) => calls.push(["release", owner, id]),
		releaseOwner: (owner) => calls.push(["destroyed", owner]),
	};
	registerSessionShareExportIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, service);
	const event = {
		sender: {
			id: 7,
			once: (name, callback) => {
				assert.equal(name, "destroyed");
				destroyed = callback;
			},
			isDestroyed: () => false,
		},
	};
	const input = { sessionId: "stable-session", options: {} };
	await handlers.get(ipcChannels.sessionsSharePrepare)(event, input);
	await handlers.get(ipcChannels.sessionsShareSave)(event, "main-issued");
	handlers.get(ipcChannels.sessionsShareRelease)(event, "main-issued");
	destroyed();
	assert.deepEqual(calls, [
		["prepare", 7, input],
		["save", 7, "main-issued"],
		["release", 7, "main-issued"],
		["destroyed", 7],
	]);
});
