import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// CuaService 装配 CuaIpcManager（electron ipcMain）与 MCP host；stub electron、engine、注册模块，
// 测试只验证 host 生命周期与 gate 开关的解耦。
const electronStub = {
	ipcMain: { handle: () => {}, removeHandler: () => {} },
	BrowserWindow: class {},
};

function loadCuaService(registrationCalls) {
	return loadTsCommonJs("src/main/cua/CuaService.ts", {
		stubs: {
			electron: electronStub,
			"./CuaEngine": { CuaEngine: class {} },
			"./CuaMcpRegistration": {
				ensureCuaMcpRegistered: (options) => {
					registrationCalls.push({ type: "ensure", options });
					return { written: true };
				},
				unregisterCuaMcp: () => {
					registrationCalls.push({ type: "unregister" });
					return { removed: true };
				},
			},
		},
		globals: {
			setTimeout: globalThis.setTimeout.bind(globalThis),
			clearTimeout: globalThis.clearTimeout.bind(globalThis),
			fetch: globalThis.fetch.bind(globalThis),
		},
	});
}

function makeBrowserAgent() {
	return {
		enabled: false,
		approvalHandler: null,
		setEnabled(value) {
			this.enabled = value;
		},
		setApprovalHandler(handler) {
			this.approvalHandler = handler;
		},
		getToolDeps() {
			return { enabled: () => this.enabled, controller: {}, gate: {} };
		},
	};
}

function makeDeps(browserAgent, logs = []) {
	return {
		getMainWindow: () => null,
		log: (module, message, extra) => logs.push({ module, message, extra }),
		browserAgent,
	};
}

test("browser-only settings start the host without enabling the CUA gate", async (t) => {
	const registrationCalls = [];
	const browserAgent = makeBrowserAgent();
	const { CuaService } = loadCuaService(registrationCalls);
	const service = new CuaService(makeDeps(browserAgent));
	t.after(async () => {
		await service.dispose();
	});

	await service.applySettings({ cuaEnabled: false, browserAgentEnabled: true });
	assert.equal(service.isRunning(), true, "host must run for the browser capability");
	assert.equal(service.gate.isEnabled(), false, "CUA gate must stay closed when only the browser is on");
	assert.equal(browserAgent.enabled, true);
	assert.ok(registrationCalls.some((call) => call.type === "ensure"));
});

test("enabling CUA later does not restart the running host", async (t) => {
	const registrationCalls = [];
	const browserAgent = makeBrowserAgent();
	const { CuaService } = loadCuaService(registrationCalls);
	const service = new CuaService(makeDeps(browserAgent));
	t.after(async () => {
		await service.dispose();
	});

	await service.applySettings({ cuaEnabled: false, browserAgentEnabled: true });
	await service.applySettings({ cuaEnabled: true, browserAgentEnabled: true });
	assert.equal(service.isRunning(), true);
	assert.equal(service.gate.isEnabled(), true, "CUA gate opens when CUA is enabled");
	assert.equal(browserAgent.enabled, true);
	assert.equal(registrationCalls.filter((call) => call.type === "ensure").length, 1, "host restarted: token/port would churn");
});

test("turning both capabilities off stops the host, unregisters, and closes the browser gate", async (t) => {
	const registrationCalls = [];
	const browserAgent = makeBrowserAgent();
	const { CuaService } = loadCuaService(registrationCalls);
	const service = new CuaService(makeDeps(browserAgent));
	t.after(async () => {
		await service.dispose();
	});

	await service.applySettings({ cuaEnabled: false, browserAgentEnabled: true });
	await service.applySettings({ cuaEnabled: false, browserAgentEnabled: false });
	assert.equal(service.isRunning(), false);
	assert.equal(browserAgent.enabled, false);
	assert.ok(registrationCalls.some((call) => call.type === "unregister"));
});
