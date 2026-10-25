import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/** 用宿主 DIP 光标与伪窗口复现缩放屏拖动；不启动 Electron、不写用户位置文件。 */
function createHarness({ snap = true, savedPosition = null, workArea = { x: 0, y: 0, width: 1280, height: 720 } } = {}) {
	const handlers = new Map();
	const windows = [];
	let cursor = { x: 0, y: 0 };
	let clicks = 0;
	const writes = [];
	class FakeWindow {
		constructor(options) {
			this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
			this.webContents = { send() {}, on() {}, setWindowOpenHandler() {} };
			this.events = new Map();
			windows.push(this);
		}
		isDestroyed() {
			return false;
		}
		setMenu() {}
		setAlwaysOnTop() {}
		on(name, fn) {
			this.events.set(name, fn);
		}
		once(name, fn) {
			this.on(name, fn);
		}
		show() {}
		async loadFile() {
			this.events.get("ready-to-show")?.();
		}
		getPosition() {
			return [this.bounds.x, this.bounds.y];
		}
		getBounds() {
			return { ...this.bounds };
		}
		setPosition(x, y) {
			this.bounds.x = x;
			this.bounds.y = y;
		}
	}
	const load = createTsSandbox({
		stubs: {
			electron: {
				app: { getPath: () => "/isolated-test" },
				BrowserWindow: FakeWindow,
				ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) },
				screen: { getCursorScreenPoint: () => cursor, getPrimaryDisplay: () => ({ workArea }), getDisplayNearestPoint: () => ({ workArea }), getDisplayMatching: () => ({ workArea }) },
			},
			"@electron-toolkit/utils": { is: { dev: false } },
			"node:fs/promises": {
				readFile: async () => JSON.stringify(savedPosition),
				mkdir: async () => {},
				writeFile: async (_path, value) => {
					writes.push(JSON.parse(value));
				},
			},
			"../preloadPath": { preparePreloadPath: async () => "/isolated-preload.js" },
			"../v8HeapLimits": { rendererHeapAdditionalArguments: () => [] },
			"../settings/SettingsStore": { readElectronChromiumSandboxPreference: () => true },
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
	const { FloatingController } = load("src/main/floating/FloatingController.ts");
	const { ipcChannels } = load("src/shared/ipc.ts");
	const controller = new FloatingController({
		settingsStore: { get: () => ({ floatingBallEnabled: true, floatingBallSnapToEdge: snap, floatingBallAlwaysOnTop: true }) },
		getMainWindow: () => null,
		onExpandMini: async () => {
			clicks++;
		},
		onExpandCompact: async () => {},
		onShowMainWindow: () => {},
		addAgentStateListener: () => () => {},
		getActiveAgentCount: () => 0,
		getRunningAgentCount: () => 0,
		getRecentRunningTitles: () => [],
	});
	return {
		controller,
		windows,
		writes,
		setCursor: (point) => {
			cursor = point;
		},
		clicks: () => clicks,
		invoke: (key, ...args) => handlers.get(ipcChannels[key])({ sender: windows[0].webContents }, ...args),
		workArea,
	};
}

function assertVisible(bounds, area) {
	assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width, "整个悬浮窗必须留在工作区横向范围内");
	assert.ok(bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height, "整个悬浮窗必须留在工作区纵向范围内");
}

test("缩放屏连续拖动使用宿主 DIP 光标，不累计 renderer screenX 偏移", async () => {
	const h = createHarness();
	await h.controller.show();
	const win = h.windows[0];
	for (let i = 0; i < 30; i++) {
		h.setCursor({ x: win.bounds.x + 32, y: win.bounds.y + 40 });
		h.invoke("floatingBallDragStart");
		h.setCursor({ x: 1150, y: 320 });
		h.invoke("floatingBallDragMove", 1725, 480); // renderer 的 150% 坐标不能与 DIP offset 混用。
		assert.equal(win.bounds.x, 1118);
		assert.equal(win.bounds.y, 280);
		h.invoke("floatingBallDragEnd");
		assertVisible(win.bounds, h.workArea);
		assert.equal(win.bounds.x, h.workArea.width - win.bounds.width);
	}
	assert.equal(h.clicks(), 0);
});

test("恢复已离屏的位置会钳制回当前工作区", async () => {
	const h = createHarness({ savedPosition: { x: 8000, y: -7000 } });
	await h.controller.show();
	assertVisible(h.windows[0].bounds, h.workArea);
});

test("关闭贴边也不能把整个悬浮窗拖丢", async () => {
	const h = createHarness({ snap: false, workArea: { x: -1280, y: -100, width: 1280, height: 720 } });
	await h.controller.show();
	const win = h.windows[0];
	h.setCursor({ x: win.bounds.x + 32, y: win.bounds.y + 40 });
	h.invoke("floatingBallDragStart");
	h.setCursor({ x: 7000, y: -9000 });
	h.invoke("floatingBallDragMove", 7000, -9000);
	h.invoke("floatingBallDragEnd");
	assertVisible(win.bounds, h.workArea);
});

test("重复 mouseup 不重复展开；缓慢累计移动不是点击", async () => {
	const h = createHarness();
	await h.controller.show();
	const win = h.windows[0];
	const start = { x: win.bounds.x + 32, y: win.bounds.y + 40 };
	h.setCursor(start);
	h.invoke("floatingBallDragStart");
	for (let i = 1; i <= 8; i++) {
		h.setCursor({ x: start.x + i, y: start.y });
		h.invoke("floatingBallDragMove", start.x + i, start.y);
	}
	h.invoke("floatingBallDragEnd");
	assert.equal(h.clicks(), 0);
	h.setCursor({ x: win.bounds.x + 32, y: win.bounds.y + 40 });
	h.invoke("floatingBallDragStart");
	h.invoke("floatingBallDragEnd");
	h.invoke("floatingBallDragEnd");
	assert.equal(h.clicks(), 1);
});
