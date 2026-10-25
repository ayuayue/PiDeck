import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const require = createRequire(import.meta.url);

/**
 * 未显式打桩的相对 import → 交给统一沙箱按**源文件目录**解析。
 *
 * 本文件需要自建 sandbox 全局（MockBrowserWindow / 计时器 spies），因此不能直接用
 * createTsSandbox 加载 PetWindow；这里只借用它「按源文件目录解析」的能力。
 */
const petSandbox = createTsSandbox();

function resolveUnstubbedRequire(specifier) {
	if (!specifier.startsWith(".")) return require(specifier);
	const target = resolve("src/main/pet", /\.(ts|tsx|js)$/.test(specifier) ? specifier : `${specifier}.ts`);
	return petSandbox(target);
}

function loadModule(mockProcess = {}) {
	const source = readFileSync("src/main/pet/PetWindow.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	class MockBrowserWindow {
		static last = null;

		constructor(options) {
			this.options = options;
			this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
			this.setBoundsCalls = 0;
			this.listeners = new Map();
			this.webContents = {
				on: () => undefined,
				once: () => undefined,
				session: { webRequest: { onHeadersReceived: () => undefined } },
			};
			MockBrowserWindow.last = this;
		}

		isDestroyed() {
			return false;
		}
		setAlwaysOnTop() {}
		on(name, listener) {
			this.listeners.set(name, listener);
		}
		loadFile() {
			return Promise.resolve();
		}
		loadURL() {
			return Promise.resolve();
		}
		showInactive() {}
		getBounds() {
			return this.bounds;
		}
		getPosition() {
			return [this.bounds.x, this.bounds.y];
		}
		getSize() {
			return [this.bounds.width, this.bounds.height];
		}
		setSize(width, height) {
			this.bounds = { ...this.bounds, width, height };
		}
		setBounds(bounds) {
			this.setBoundsCalls += 1;
			this.bounds = { ...this.bounds, ...bounds };
		}
		destroy() {}
	}
	let intervalCalls = 0;
	const fsWrites = [];
	const sandbox = {
		exports: {},
		__dirname: "/tmp/pi-desktop-test/out/main/pet",
		setTimeout,
		clearTimeout,
		setInterval: () => {
			intervalCalls += 1;
			return 1;
		},
		clearInterval: () => undefined,
		process: {
			platform: "linux",
			env: {},
			argv: [],
			...mockProcess,
		},
		require: (id) => {
			if (id === "electron") {
				return {
					app: {
						commandLine: {
							getSwitchValue: () => "",
						},
						getPath: () => "/tmp/pi-desktop-test",
					},
					BrowserWindow: MockBrowserWindow,
					screen: {
						getDisplayMatching: () => ({
							workArea: { x: 0, y: 0, width: 1920, height: 1080 },
						}),
					},
				};
			}
			if (id === "@electron-toolkit/utils") return { is: { dev: true } };
			if (id === "../preloadPath") {
				return { preparePreloadPath: async (sourcePath) => sourcePath };
			}
			if (id === "./petSpriteProtocol") {
				return { PET_WINDOW_PARTITION: "persist:pet" };
			}
			// 拆分后 PetWindow 会读取 Chromium 沙箱偏好；测试中固定为未开启（默认路径）。
			if (id === "../settings/SettingsStore") {
				return { readElectronChromiumSandboxPreference: () => false };
			}
			// 共享布局纯函数：用真实源码转译加载，避免 mock 与实现漂移
			if (id.endsWith("shared/petNotificationLayout")) {
				const src = readFileSync("src/shared/petNotificationLayout.ts", "utf8");
				const { outputText: layoutJs } = ts.transpileModule(src, {
					compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
				});
				const layoutModule = { exports: {} };
				vm.runInNewContext(layoutJs, { module: layoutModule, exports: layoutModule.exports });
				return layoutModule.exports;
			}
			if (id === "node:fs/promises") {
				return {
					mkdir: async () => {},
					readFile: async () => {
						throw new Error("no position file");
					},
					writeFile: async (_path, content) => {
						fsWrites.push(String(content));
					},
				};
			}
			// PetWindow 的诊断日志（2026-08 新增）走 appLogger，测试环境静默
			if (id.endsWith("logging/sharedLogger")) {
				return { getAppLogger: () => null };
			}
			// 未显式打桩的相对 import：交给统一沙箱按**源文件目录**（src/main/pet）解析。
			// 生产新增本地模块（#213 的 ../v8HeapLimits 等）不再让本文件整片 MODULE_NOT_FOUND。
			return resolveUnstubbedRequire(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, {
		filename: "PetWindow.ts",
	});
	return {
		...sandbox.exports,
		MockBrowserWindow,
		fsWrites,
		getIntervalCalls: () => intervalCalls,
	};
}

test("treats X11 ozone on Linux Wayland as freely positionable", () => {
	const { detectPetWindowCaps } = loadModule({
		platform: "linux",
		env: {
			XDG_SESSION_TYPE: "wayland",
			WAYLAND_DISPLAY: "wayland-0",
			DISPLAY: ":0",
		},
		argv: ["electron", ".", "--ozone-platform=x11"],
	});

	assert.deepEqual(JSON.parse(JSON.stringify(detectPetWindowCaps())), {
		transparent: true,
		clickThrough: true,
		freePosition: true,
	});
});

test("keeps the Wayland fallback when Electron uses native Wayland", () => {
	const { detectPetWindowCaps } = loadModule({
		platform: "linux",
		env: {
			XDG_SESSION_TYPE: "wayland",
			WAYLAND_DISPLAY: "wayland-0",
			DISPLAY: ":0",
		},
		argv: ["electron", ".", "--ozone-platform=wayland"],
	});

	assert.deepEqual(JSON.parse(JSON.stringify(detectPetWindowCaps())), {
		transparent: false,
		clickThrough: true,
		freePosition: false,
	});
});

test("keeps the Wayland fallback when Electron selects ozone automatically", () => {
	const { detectPetWindowCaps } = loadModule({
		platform: "linux",
		env: {
			XDG_SESSION_TYPE: "wayland",
			WAYLAND_DISPLAY: "wayland-0",
			DISPLAY: ":0",
		},
		argv: ["electron", ".", "--ozone-platform=auto"],
	});

	assert.deepEqual(JSON.parse(JSON.stringify(detectPetWindowCaps())), {
		transparent: false,
		clickThrough: true,
		freePosition: false,
	});
});

test("uses restricted caps when the Linux display backend is unknown", () => {
	const { detectPetWindowCaps } = loadModule({
		platform: "linux",
		env: {},
		argv: ["electron", "."],
	});

	assert.deepEqual(JSON.parse(JSON.stringify(detectPetWindowCaps())), {
		transparent: false,
		clickThrough: true,
		freePosition: false,
	});
});

test("restricted Linux windows avoid transparent backgrounds and absolute positioning", async () => {
	const { PetWindow, MockBrowserWindow, getIntervalCalls } = loadModule({
		platform: "linux",
		env: {
			XDG_SESSION_TYPE: "wayland",
			WAYLAND_DISPLAY: "wayland-0",
		},
		argv: ["electron", ".", "--ozone-platform=auto"],
	});
	const petWindow = new PetWindow();

	await petWindow.create();
	assert.equal(MockBrowserWindow.last.options.backgroundColor, "#eef0f3");
	assert.equal("x" in MockBrowserWindow.last.options, false);
	assert.equal("y" in MockBrowserWindow.last.options, false);
	assert.equal(MockBrowserWindow.last.listeners.has("moved"), false);
	assert.equal(getIntervalCalls(), 0);

	petWindow.moveTo(300, 200);
	assert.equal(MockBrowserWindow.last.setBoundsCalls, 0);
});

test("patrol is disabled when free positioning is unavailable", () => {
	const source = readFileSync("src/main/pet/index.ts", "utf8");
	assert.match(source, /petPatrolEnabled[\s\S]{0,160}detectPetWindowCaps\(\)\.freePosition/);
});

test("scale changes push appearance settings to the pet window", () => {
	const source = readFileSync("src/main/pet/index.ts", "utf8");
	assert.match(source, /next\.petScale !== prev\.petScale[\s\S]{0,240}this\.pushAppearance\(next\)/);
	assert.match(source, /settingsApplyWindow/);
});

const x11Env = {
	platform: "linux",
	env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
	argv: [],
};

function feetCenter(win) {
	const b = win.getBounds();
	return { x: b.x + b.width / 2, y: b.y + b.height };
}

function approx(a, b, label) {
	assert.ok(Math.abs(a - b) <= 1, `${label}: ${a} vs ${b}`);
}

test("create uses the normal layout size and notification expands the window around the feet anchor", async () => {
	const { PetWindow, MockBrowserWindow } = loadModule(x11Env);
	const petWindow = new PetWindow();

	await petWindow.create(1, "large");
	const win = MockBrowserWindow.last;
	assert.equal(win.options.width, 192);
	assert.equal(win.options.height, 208);
	// 移到屏幕中部，避免扩展时被 workArea 钳制干扰锚点验证
	petWindow.moveTo(500, 700);

	const before = feetCenter(win);
	petWindow.setNotificationVisible(true);
	const expanded = feetCenter(win);
	assert.ok(win.getBounds().width > 192);
	assert.ok(win.getBounds().height > 208);
	approx(expanded.x, before.x, "feet x while expanded");
	approx(expanded.y, before.y, "feet y while expanded");

	petWindow.setNotificationVisible(false);
	const restored = feetCenter(win);
	approx(restored.x, before.x, "feet x after restore");
	approx(restored.y, before.y, "feet y after restore");
	assert.equal(win.getBounds().width, 192);
	assert.equal(win.getBounds().height, 208);
});

test("resize keeps the feet anchor and clamps inside the work area", async () => {
	const { PetWindow, MockBrowserWindow } = loadModule(x11Env);
	const petWindow = new PetWindow();

	await petWindow.create(1, "medium");
	const win = MockBrowserWindow.last;
	const before = feetCenter(win);

	petWindow.resize(0.5);
	const after = feetCenter(win);
	approx(after.x, before.x, "feet x after resize");
	approx(after.y, before.y, "feet y after resize");
	assert.equal(win.getBounds().width, 96);
	assert.equal(win.getBounds().height, 104);

	// 靠近屏幕底部时重新放大，窗口整体被钳制在 workArea 内
	win.setBounds({ x: 1700, y: 1000, width: 96, height: 104 });
	petWindow.resize(2);
	const b = win.getBounds();
	assert.ok(b.x + b.width <= 1920);
	assert.ok(b.y + b.height <= 1080);
});

test("font mode changes reflow the notification slot without moving the feet", async () => {
	const { PetWindow, MockBrowserWindow } = loadModule(x11Env);
	const petWindow = new PetWindow();

	await petWindow.create(0.5, "compact");
	const win = MockBrowserWindow.last;
	petWindow.moveTo(500, 700);
	petWindow.setNotificationVisible(true);
	const before = feetCenter(win);
	const heightBefore = win.getBounds().height;

	petWindow.setFontMode("xlarge");
	const after = feetCenter(win);
	approx(after.x, before.x, "feet x after font change");
	approx(after.y, before.y, "feet y after font change");
	assert.ok(win.getBounds().height > heightBefore, "notification slot grows with font mode");
});

test("moveTo persists positions converted back to the normal layout", async () => {
	const { PetWindow, MockBrowserWindow, fsWrites } = loadModule(x11Env);
	const petWindow = new PetWindow();

	await petWindow.create(1, "medium");
	const win = MockBrowserWindow.last;
	petWindow.setNotificationVisible(true);
	const expanded = { ...win.getBounds() };
	// 通知布局下拖到 (100, 300)，脚底中心 = (100 + w/2, 300 + h)
	petWindow.moveTo(100, 300);
	// 持久化走 400ms 防抖（schedulePersistPosition）：最后一次位置在防抖窗口后落盘
	await new Promise((r) => setTimeout(r, 450));
	const saved = JSON.parse(fsWrites.at(-1));
	// 换算回普通布局（192x208）：脚底中心不变
	const feetX = 100 + expanded.width / 2;
	const feetY = 300 + expanded.height;
	approx(saved.x + 96, feetX, "persisted feet x");
	approx(saved.y + 208, feetY, "persisted feet y");
});

test("pet window disables background throttling so sprite rAF keeps running while unfocused", async () => {
	const { PetWindow, MockBrowserWindow } = loadModule(x11Env);
	const petWindow = new PetWindow();
	await petWindow.create(0.3, "medium");
	// 宠物永远浮在桌面、几乎不获焦。Electron 默认 backgroundThrottling=true
	// 会把后台 rAF 掐到约 1fps 甚至停在第一帧，表现为 idle/running 都静止。
	assert.equal(MockBrowserWindow.last.options.webPreferences.backgroundThrottling, false);
});
