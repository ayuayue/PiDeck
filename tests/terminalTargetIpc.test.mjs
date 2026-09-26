import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function setup(projects = { p1: { id: "p1", name: "Project", path: "C:/trusted/project", lastOpenedAt: 0 } }) {
	const handlers = new Map();
	const calls = [];
	const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
	const ipcChannels = loadTsCommonJs("src/shared/ipc.ts").ipcChannels;
	const { registerTerminalIpc } = loadTsCommonJs("src/main/ipc/terminalIpc.ts", { stubs: { electron: { ipcMain } } });
	registerTerminalIpc({
		appLogger: { info: () => {} },
		projectStore: { get: (projectId) => projects[projectId] },
		sessionRuntimeCoordinator: {
			validateTarget: (target) => (target.runtimeGeneration === 4 ? { ok: true, value: target } : { ok: false, error: { code: "SESSION_RUNTIME_STALE" } }),
		},
		terminalManager: {
			list: (target) => {
				calls.push({ method: "list", target: plain(target) });
				return [];
			},
			ensure: (target) => {
				calls.push({ method: "ensure", target: plain(target) });
				return [];
			},
			create: (target, shell) => {
				calls.push({ method: "create", target: plain(target), shell });
				return { id: "tab-1", ownerKey: "project:p1" };
			},
			input: (tabId, data) => calls.push({ method: "input", tabId, data }),
			resize: (tabId, cols, rows) => calls.push({ method: "resize", tabId, cols, rows }),
			close: (tabId) => calls.push({ method: "close", tabId }),
			listShells: () => [],
		},
		toSessionCommandIpcError: (error) => new Error(error.code),
	});
	return { calls, handlers, ipcChannels };
}

test("project terminal IPC accepts only project identity and delegates no renderer cwd", async () => {
	const { calls, handlers, ipcChannels } = setup();
	await handlers.get(ipcChannels.terminalList)({}, { kind: "project", projectId: "p1" });
	assert.deepEqual(calls, [{ method: "list", target: { kind: "project", projectId: "p1" } }]);

	await assert.rejects(handlers.get(ipcChannels.terminalCreate)({}, { kind: "project", projectId: "p1", cwd: "C:/attacker" }), /INVALID_TERMINAL_TARGET/);
	assert.equal(calls.length, 1);
});

test("project terminal IPC rejects missing and non-terminal projects", async () => {
	const { handlers, ipcChannels } = setup({
		chat: { id: "chat", name: "Chat", path: "C:/chat", kind: "chat", lastOpenedAt: 0 },
	});
	const list = handlers.get(ipcChannels.terminalList);
	assert.throws(() => list({}, { kind: "project", projectId: "missing" }), /PROJECT_NOT_FOUND/);
	assert.throws(() => list({}, { kind: "project", projectId: "chat" }), /TERMINAL_PROJECT_UNSUPPORTED/);
});

test("agent terminal IPC validates runtime binding and shell selection", async () => {
	const { calls, handlers, ipcChannels } = setup();
	const create = handlers.get(ipcChannels.terminalCreate);
	const target = { kind: "agent", sessionId: "s1", agentId: "a1", runtimeGeneration: 4 };
	await create({}, target, "bash");
	assert.deepEqual(calls[0], { method: "create", target, shell: "bash" });

	await assert.rejects(create({}, { ...target, runtimeGeneration: 3 }, "bash"), /SESSION_RUNTIME_STALE/);
	await assert.rejects(create({}, target, "ssh"), /INVALID_TERMINAL_SHELL/);
	assert.equal(calls.length, 1);
});

test("terminal I/O IPC rejects malformed inputs before calling the manager", () => {
	const { calls, handlers, ipcChannels } = setup();
	const input = handlers.get(ipcChannels.terminalInput);
	const resize = handlers.get(ipcChannels.terminalResize);
	const close = handlers.get(ipcChannels.terminalClose);

	assert.throws(() => input({}, 123, "ls\\r"), /INVALID_TERMINAL_TAB_ID/);
	assert.throws(() => input({}, "tab-1", null), /INVALID_TERMINAL_INPUT/);
	assert.throws(() => resize({}, "tab-1", Number.NaN, 24), /INVALID_TERMINAL_SIZE/);
	assert.throws(() => resize({}, "tab-1", 80, 24.5), /INVALID_TERMINAL_SIZE/);
	assert.throws(() => close({}, ""), /INVALID_TERMINAL_TAB_ID/);
	assert.deepEqual(calls, []);
});

test("shared terminal owner keys contain stable IDs, not cwd values", () => {
	const { terminalOwnerKeyFor } = loadTsCommonJs("src/shared/types/terminal.ts");
	assert.equal(terminalOwnerKeyFor({ kind: "project", projectId: "p1" }), "project:p1");
	assert.equal(terminalOwnerKeyFor({ kind: "agent", sessionId: "s1", agentId: "a1", runtimeGeneration: 4 }), "agent:a1");
});
