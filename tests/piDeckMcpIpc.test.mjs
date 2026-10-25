import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
test("MCP management rejects guest/subframe input before touching service or secrets; disposal unregisters handlers", async () => {
	const handlers = new Map();
	const calls = [];
	const warn = [];
	const { registerPiDeckMcpIpc } = loadTsCommonJs("src/main/ipc/piDeckMcpIpc.ts", { stubs: { electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) } } } });
	const frame = {};
	const contents = { mainFrame: frame };
	const event = { sender: contents, senderFrame: frame };
	const unregister = registerPiDeckMcpIpc(
		{
			getState: async () => {
				calls.push("state");
				return {};
			},
			setAccess: async (input) => {
				calls.push(input);
				return {};
			},
			connection: async () => {
				calls.push("secret");
				return {};
			},
		},
		() => ({ webContents: contents, isDestroyed: () => false }),
		(code) => warn.push(code),
	);
	for (const channel of handlers.keys()) {
		for (const denied of [
			{ sender: {}, senderFrame: frame },
			{ sender: contents, senderFrame: {} },
		]) {
			assert.equal((await handlers.get(channel)(denied, { enabled: true, projectIds: ["p1"] })).code, "sender-not-authorized");
		}
	}
	assert.deepEqual(calls, []);
	for (const value of [null, { enabled: "yes", projectIds: [] }, { enabled: true, projectIds: [1] }, { enabled: true, projectIds: ["p1"], token: "injected" }]) {
		assert.equal((await handlers.get(ipcChannels.piDeckMcpSetAccess)(event, value)).code, "invalid-input");
	}
	assert.deepEqual(calls, []);
	assert.equal((await handlers.get(ipcChannels.piDeckMcpSetAccess)(event, { enabled: false, projectIds: [] })).ok, true);
	assert.equal((await handlers.get(ipcChannels.piDeckMcpConnection)(event)).ok, true);
	assert.equal(calls.length, 2);
	unregister();
	assert.equal(handlers.size, 0);
	assert.ok(warn.every((code) => !code.includes("injected")));
});
