import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const require = createRequire(import.meta.url);
const floatingSandbox = createTsSandbox({
	stubs: {
		"@electron-toolkit/utils": { is: { dev: true } },
		electron: { BrowserWindow: class {}, ipcMain: { handle() {}, removeHandler() {} }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, app: { getPath: () => "/tmp" } },
	},
});

function resolveUnstubbedRequire(specifier) {
	if (!specifier.startsWith(".")) return require(specifier);
	const target = resolve("src/main/floating", /\.(ts|tsx|js)$/.test(specifier) ? specifier : `${specifier}.ts`);
	return floatingSandbox(target);
}

function loadModule(file, mockDeps = {}) {
	const source = readFileSync(`src/main/floating/${file}`, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const module = { exports: {} };
	const context = vm.createContext({
		...floatingSandbox,
		module,
		exports: module.exports,
		require: (id) => {
			if (id === "@electron-toolkit/utils") return { is: { dev: true } };
			if (id === "electron") return mockDeps.electron ?? {};
			if (Object.hasOwn(mockDeps, id)) return mockDeps[id];
			return resolveUnstubbedRequire(id);
		},
	});
	vm.runInContext(outputText, context);
	return module.exports;
}

test("FloatingController: enabled=false 时不显示", async () => {
	const { FloatingController } = loadModule("FloatingController.ts", {
		electron: { BrowserWindow: class {}, ipcMain: { handle() {}, removeHandler() {} }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, app: { getPath: () => "/tmp" } },
	});
	const settings = { get: () => ({ floatingBallEnabled: false }) };
	const agentManager = { addStateListener: () => () => undefined, list: () => [] };
	const ctrl = new FloatingController({ settingsStore: settings, agentManager, getMainWindow: () => null, onExpandMini: async () => {}, onExpandCompact: async () => {}, onShowMainWindow: () => {} });
	await ctrl.show();
	assert.equal(ctrl.isActive(), false);
});

test("FloatingController: getState 返回默认值", async () => {
	const { FloatingController } = loadModule("FloatingController.ts", {
		electron: { BrowserWindow: class {}, ipcMain: { handle() {}, removeHandler() {} }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, app: { getPath: () => "/tmp" } },
	});
	const settings = { get: () => ({ floatingBallEnabled: true }) };
	const agentManager = { addStateListener: () => () => undefined, list: () => [] };
	const ctrl = new FloatingController({ settingsStore: settings, agentManager, getMainWindow: () => null, onExpandMini: async () => {}, onExpandCompact: async () => {}, onShowMainWindow: () => {} });
	const state = ctrl.getState();
	assert.equal(state.visible, false);
	assert.equal(state.expandTarget, "mini");
	assert.equal(state.runningCount, 0);
	assert.equal(state.activeCount, 0);
});

test("MiniOverlayWindow 尺寸常量", async () => {
	const { MINI_OVERLAY_W, MINI_OVERLAY_H, MiniOverlayWindow } = loadModule("MiniOverlayWindow.ts", {
		electron: { BrowserWindow: class {}, ipcMain: { handle() {}, removeHandler() {} }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, app: { getPath: () => "/tmp" } },
	});
	assert.ok(typeof MiniOverlayWindow === "function");
	assert.equal(MINI_OVERLAY_W, 480);
	assert.equal(MINI_OVERLAY_H, 640);
});

const miniOverlayElectronStub = { BrowserWindow: class {}, ipcMain: { handle() {}, removeHandler() {} }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, app: { getPath: () => "/tmp" }, nativeTheme: { shouldUseDarkColors: false } };

function newMiniOverlay(agentTabs) {
	const { MiniOverlayWindow } = loadModule("MiniOverlayWindow.ts", { electron: miniOverlayElectronStub });
	return new MiniOverlayWindow({
		settingsStore: { get: () => ({ language: "zh-CN", theme: "system", themeScheduleLightStart: "09:00", themeScheduleDarkStart: "19:00", floatingBallAlwaysOnTop: true }) },
		agentManager: { addStateListener: () => () => undefined, list: () => agentTabs },
		projectStore: { list: () => [{ id: "p1", name: "P1", path: "C:/p1" }] },
		onJumpToSession: () => {},
		onQuickPrompt: async () => ({ ok: true }),
	});
}

test("MiniOverlayWindow 状态快照：activeSessions 含全部打开中会话且运行中优先", () => {
	const ctrl = newMiniOverlay([
		{ id: "agent-a", sessionId: "s-live", title: "Live", projectId: "p1", status: "running", createdAt: 20 },
		{ id: "agent-b", sessionId: "s-idle", title: "Idle", projectId: "p1", status: "idle", createdAt: 30 },
		{ id: "agent-c", title: "No session", projectId: "p1", status: "running", createdAt: 10 },
		{ id: "agent-d", sessionId: "s-closed", title: "Closed", projectId: "p1", status: "closed", createdAt: 40 },
	]);
	const state = ctrl.buildState();
	assert.deepEqual(
		Array.from(state.activeSessions, (session) => session.id),
		// 运行中按创建时间降序排最前，其余（idle）跟上；无 sessionId 的 tab 回退 agent id；closed 不出现。
		["s-live", "agent-c", "s-idle"],
	);
	assert.deepEqual(
		Array.from(state.activeSessions, (session) => session.isRunning),
		[true, true, false],
	);
	assert.deepEqual(
		Array.from(state.recentSessions, (session) => session.id),
		["s-idle", "s-live", "agent-c"],
	);
	assert.equal(state.runningCount, 2);
	assert.ok(!state.activeSessions.some((session) => session.id === "s-closed"));
});
