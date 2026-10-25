import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// CuaService wires CuaIpcManager (electron ipcMain) together — stub electron,
// and stub the MCP registration so tests never touch the real ~/.pi/agent/mcp.json.
const electronStub = {
	ipcMain: {
		handle: () => {},
		removeHandler: () => {},
	},
	BrowserWindow: class {},
};

function loadServiceModule(registrationCalls) {
	return loadTsCommonJs("src/main/cua/CuaService.ts", {
		stubs: {
			electron: electronStub,
			"./CuaMcpRegistration": {
				ensureCuaMcpRegistered: (opts) => {
					registrationCalls.push({ type: "ensure", opts });
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

function makeDeps(logs) {
	return {
		mainWindow: () => null,
		log: (module, message, extra) => logs.push({ module, message, extra }),
	};
}

test("gate starts closed before the host is listening and opens on start() (state-misreport regression)", async (t) => {
	// 修复前：CuaGate 构造即 enabled=true，cua:get-state 在端点未启动、
	// cuaEnabled=false 时也恒报 enabled=true。现在的语义：gate 开 = 服务在跑。
	const registrationCalls = [];
	const logs = [];
	const { CuaService } = loadServiceModule(registrationCalls);
	const service = new CuaService(makeDeps(logs));

	assert.strictEqual(service.gate.isEnabled(), false, "gate must be closed before start()");
	assert.strictEqual(service.isRunning(), false);

	await service.start();
	t.after(async () => {
		await service.dispose();
	});

	assert.strictEqual(service.isRunning(), true);
	assert.strictEqual(service.gate.isEnabled(), true, "gate opens once the host is listening");
	assert.ok(
		registrationCalls.some((call) => call.type === "ensure"),
		"MCP registration happened",
	);

	await service.stop();
	assert.strictEqual(service.isRunning(), false);
	assert.strictEqual(service.gate.isEnabled(), false, "gate closes when the host stops");
	assert.ok(
		registrationCalls.some((call) => call.type === "unregister"),
		"MCP unregistration happened",
	);
});

test("start failure leaves gate closed (fail closed)", async () => {
	// 注入真实的启动失败：host.start() 拒绝。验证 catch 路径关 gate 并上抛。
	// 注意：同进程里第二个 loadTsCommonJs 会重新跑 CuaWin32 顶层 struct 注册，
	// 而真 koffi 跨 vm 缓存 → "Duplicate type name"；这里 stub 掉 ./CuaEngine
	// （本用例只关心 gate 与注册失败路径，engine 不参与）。
	const registrationCalls = [];
	const logs = [];
	const { CuaService } = loadTsCommonJs("src/main/cua/CuaService.ts", {
		stubs: {
			electron: electronStub,
			"./CuaEngine": {
				// 本用例只关心 gate 与注册失败路径，engine 不参与其余调用。
				CuaEngine: class {},
			},
			"./CuaMcpRegistration": {
				ensureCuaMcpRegistered: () => ({ written: false }),
				unregisterCuaMcp: () => ({ removed: false }),
			},
			"./CuaMcpHttpHost": {
				CuaMcpHttpHost: class {
					async start() {
						throw new Error("listen EACCES");
					}
					getUrl() {
						return null;
					}
					async stop() {}
				},
			},
		},
		globals: {
			setTimeout: globalThis.setTimeout.bind(globalThis),
			clearTimeout: globalThis.clearTimeout.bind(globalThis),
			fetch: globalThis.fetch.bind(globalThis),
		},
	});
	const service = new CuaService(makeDeps(logs));
	assert.strictEqual(service.gate.isEnabled(), false);

	await assert.rejects(() => service.start(), /EACCES/);
	assert.strictEqual(service.isRunning(), false);
	assert.strictEqual(service.gate.isEnabled(), false, "gate stays closed when start fails");
	assert.strictEqual(registrationCalls.length, 0, "registration is never reached");
});
