import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// ---- handler-level boundary validation (fail closed) -----------------

function loadManagerWithCapturingIpc() {
	const handlers = new Map();
	const mod = loadTsCommonJs("src/main/ipc/cuaIpc.ts", {
		stubs: {
			electron: {
				ipcMain: {
					handle: (channel, fn) => {
						handlers.set(channel, fn);
					},
					removeHandler: (channel) => {
						handlers.delete(channel);
					},
				},
				BrowserWindow: class {},
			},
		},
		globals: {
			setTimeout: globalThis.setTimeout.bind(globalThis),
			clearTimeout: globalThis.clearTimeout.bind(globalThis),
		},
	});
	return { mod, handlers };
}

function makeRecordingGate() {
	const overrides = [];
	let enabled = false;
	return {
		overrides,
		isEnabled: () => enabled,
		setEnabled: (value) => {
			enabled = value;
		},
		setSessionOverride: (sessionId, value) => {
			overrides.push([sessionId, value]);
		},
		setApprovalHandler: () => {},
		getSessionOverrides: () => ({}),
	};
}

test("cuaApprovalResponse with truthy non-boolean allowed resolves as invalid_response (fail closed)", async () => {
	const { mod, handlers } = loadManagerWithCapturingIpc();
	const gate = makeRecordingGate();
	const manager = new mod.CuaIpcManager({
		gate,
		mainWindow: () => ({ isDestroyed: () => false, webContents: { send: () => {} } }),
		log: () => {},
	});
	manager.register();

	const handler = manager.createApprovalHandler();
	const pending = handler({ action: "click", sessionId: "s", detail: {}, timestampMs: 1 });
	const requestId = manager.pendingApprovals.keys().next().value;

	// truthy 但非 boolean——以前会绕过审批直接放行。
	await handlers.get("cua:approval-response")({}, requestId, { allowed: "yes" });
	const result = await pending;
	// vm realm 里的对象与宿主 realm 原型不同，逐字段断言。
	assert.strictEqual(result.allowed, false);
	assert.strictEqual(result.reason, "invalid_response");
});

test("cuaSetState ignores non-boolean enabled and malformed sessionOverride", async () => {
	const { mod, handlers } = loadManagerWithCapturingIpc();
	const gate = makeRecordingGate();
	const logs = [];
	const manager = new mod.CuaIpcManager({
		gate,
		mainWindow: () => null,
		log: (_m, msg, extra) => logs.push({ msg, extra }),
	});
	manager.register();

	const response = await handlers.get("cua:set-state")(
		{},
		{
			enabled: 1, // truthy number — must NOT set
			sessionOverride: { sessionId: "", enabled: "no" },
		},
	);
	assert.strictEqual(gate.isEnabled(), false, "non-boolean enabled must not toggle");
	assert.strictEqual(gate.overrides.length, 0, "malformed override must not be applied");
	assert.ok(logs.some((entry) => entry.msg.includes("invalid sessionOverride")));
	assert.deepStrictEqual(JSON.parse(JSON.stringify(response.sessionOverrides)), {});

	// Valid shapes still work.
	await handlers.get("cua:set-state")({}, { enabled: true, sessionOverride: { sessionId: "s1", enabled: false } });
	assert.strictEqual(gate.isEnabled(), true);
	assert.deepStrictEqual(gate.overrides, [["s1", false]]);
});

// CuaIpcManager imports from electron (ipcMain, BrowserWindow) which is not
// available in the test VM. We stub electron before loading.
const electronStub = {
	ipcMain: {
		handle: () => {},
		removeHandler: () => {},
	},
	BrowserWindow: class {},
};

const { CuaIpcManager } = loadTsCommonJs("src/main/ipc/cuaIpc.ts", {
	stubs: {
		electron: electronStub,
	},
	globals: {
		fetch: globalThis.fetch.bind(globalThis),
	},
});

function makeFakeGate() {
	return {
		isEnabled: () => true,
		setEnabled: () => {},
		setSessionOverride: () => {},
		// Exposed for CuaIpcManager internal access to config.sessionOverrides
		config: { sessionOverrides: new Map() },
	};
}

function makeFakeWindow() {
	return {
		isDestroyed: () => false,
		webContents: { send: () => {} },
	};
}

test("CuaIpcManager creates approval handler that resolves", async () => {
	let sentPayload = null;
	const fakeWindow = {
		isDestroyed: () => false,
		webContents: {
			send: (_channel, payload) => {
				sentPayload = payload;
			},
		},
	};

	const manager = new CuaIpcManager({
		gate: makeFakeGate(),
		mainWindow: () => fakeWindow,
		log: () => {},
	});

	const handler = manager.createApprovalHandler();

	const approvalPromise = handler({
		action: "click",
		sessionId: "test-session",
		detail: { x: 100, y: 200 },
		timestampMs: Date.now(),
	});

	// Wait for the payload to be sent to renderer.
	await new Promise((resolve) => setTimeout(resolve, 50));

	assert.ok(sentPayload, "payload should have been sent to renderer");
	assert.strictEqual(sentPayload.action, "click");
	assert.ok(sentPayload.requestId, "requestId should be present");

	// Manually resolve the pending approval (simulating renderer response).
	const pending = manager.pendingApprovals.get(sentPayload.requestId);
	assert.ok(pending, "pending approval should exist");

	pending.resolve({ allowed: true });

	const result = await approvalPromise;
	assert.strictEqual(result.allowed, true);

	manager.dispose();
});

test("CuaIpcManager handles no window scenario", async () => {
	const manager = new CuaIpcManager({
		gate: makeFakeGate(),
		mainWindow: () => null,
		log: () => {},
	});

	const handler = manager.createApprovalHandler();
	const result = await handler({
		action: "click",
		sessionId: "test-session",
		detail: {},
		timestampMs: Date.now(),
	});

	assert.strictEqual(result.allowed, false);
	assert.strictEqual(result.reason, "no_window");
});

test("CuaIpcManager dispose resolves pending approvals", async () => {
	const fakeWindow = makeFakeWindow();

	const manager = new CuaIpcManager({
		gate: makeFakeGate(),
		mainWindow: () => fakeWindow,
		log: () => {},
	});

	const handler = manager.createApprovalHandler();
	const approvalPromise = handler({
		action: "type",
		sessionId: "test-session",
		detail: { text: "hello" },
		timestampMs: Date.now(),
	});

	await new Promise((resolve) => setTimeout(resolve, 50));

	manager.dispose();

	const result = await approvalPromise;
	assert.strictEqual(result.allowed, false);
	assert.strictEqual(result.reason, "disposed");
});
