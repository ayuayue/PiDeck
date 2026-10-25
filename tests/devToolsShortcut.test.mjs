import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

/**
 * 加载 src/main/devTools.ts。electron 依赖替换为可控替身：
 * - process.platform 可注入，覆盖 win32 / darwin 两套快捷键规则
 * - screen / BrowserWindow 由调用方提供
 */
function loadDevTools({ platform = "win32", screen = {}, browserWindow = {} } = {}) {
	const sandbox = {
		exports: {},
		process: { platform },
		require: (id) => (id === "electron" ? { screen, BrowserWindow: browserWindow } : require(id)),
	};
	vm.runInNewContext(transpile("src/main/devTools.ts"), sandbox, { filename: "devTools.ts" });
	return sandbox.exports;
}

/** 构造 before-input-event 输入形状 */
function input(overrides) {
	return {
		key: "F12",
		type: "keyDown",
		control: false,
		meta: false,
		shift: false,
		alt: false,
		...overrides,
	};
}

test("F12 opens devtools on Windows and macOS", () => {
	const win = loadDevTools({ platform: "win32" });
	const mac = loadDevTools({ platform: "darwin" });
	assert.equal(win.isDevToolsShortcut(input({ key: "F12" })), true);
	assert.equal(mac.isDevToolsShortcut(input({ key: "F12" })), true);
});

test("keyUp / other keys are not devtools shortcuts", () => {
	const mod = loadDevTools();
	assert.equal(mod.isDevToolsShortcut(input({ type: "keyUp" })), false);
	assert.equal(mod.isDevToolsShortcut(input({ key: "F11" })), false);
	assert.equal(mod.isDevToolsShortcut(input({ key: "Escape" })), false);
});

test("Windows/Linux: Ctrl+Shift+I/J open devtools, incomplete modifiers do not", () => {
	const mod = loadDevTools({ platform: "win32" });
	assert.equal(mod.isDevToolsShortcut(input({ key: "i", control: true, shift: true })), true);
	assert.equal(mod.isDevToolsShortcut(input({ key: "I", control: true, shift: true })), true);
	assert.equal(mod.isDevToolsShortcut(input({ key: "j", control: true, shift: true })), true);
	// 缺 Shift 或缺 Ctrl 都不触发
	assert.equal(mod.isDevToolsShortcut(input({ key: "i", control: true })), false);
	assert.equal(mod.isDevToolsShortcut(input({ key: "i", shift: true })), false);
	// 附带 Alt 不影响（浏览器习惯上 Ctrl+Shift+Alt+I 也开）
	assert.equal(mod.isDevToolsShortcut(input({ key: "i", control: true, shift: true, alt: true })), true);
	assert.equal(mod.isDevToolsShortcut(input({ key: "k", control: true, shift: true })), false);
});

test("macOS: Cmd+Option (Alt) I/J open devtools, bare Ctrl does not", () => {
	const mod = loadDevTools({ platform: "darwin" });
	assert.equal(mod.isDevToolsShortcut(input({ key: "i", meta: true, alt: true })), true);
	assert.equal(mod.isDevToolsShortcut(input({ key: "j", meta: true, alt: true })), true);
	// Cmd+Shift 也视为等价组合
	assert.equal(mod.isDevToolsShortcut(input({ key: "i", meta: true, shift: true })), true);
	// 只有 Ctrl 不算 macOS 快捷键
	assert.equal(mod.isDevToolsShortcut(input({ key: "i", control: true, shift: true })), false);
	assert.equal(mod.isDevToolsShortcut(input({ key: "i", meta: true })), false);
});

test("intersectsAnyDisplay: overlap, partial edge, and fully-offscreen cases", () => {
	const mod = loadDevTools();
	const display = { x: 0, y: 0, width: 1920, height: 1080 };
	assert.equal(mod.intersectsAnyDisplay({ x: 100, y: 100, width: 800, height: 600 }, [display]), true);
	// 与屏幕右缘重叠 1px 仍算可见
	assert.equal(mod.intersectsAnyDisplay({ x: 1900, y: 100, width: 800, height: 600 }, [display]), true);
	// 完全落在屏幕外
	assert.equal(mod.intersectsAnyDisplay({ x: 3000, y: 3000, width: 800, height: 600 }, [display]), false);
	assert.equal(mod.intersectsAnyDisplay({ x: -3000, y: -3000, width: 800, height: 600 }, [display]), false);
	// 无显示器信息时不视为可见
	assert.equal(mod.intersectsAnyDisplay({ x: 0, y: 0, width: 800, height: 600 }, []), false);
	// 多显示器：落在第二块屏上可见
	const second = { x: 1920, y: 0, width: 1280, height: 1024 };
	assert.equal(mod.intersectsAnyDisplay({ x: 2000, y: 100, width: 400, height: 300 }, [display, second]), true);
});

test("toggleMainWindowDevTools: open, close, and invalid-window branches", () => {
	const mod = loadDevTools();
	// 已打开 → closeDevTools，返回 false
	let closed = false;
	const closingWin = {
		isDestroyed: () => false,
		webContents: {
			isDevToolsOpened: () => true,
			closeDevTools: () => {
				closed = true;
			},
			openDevTools: () => {
				assert.fail("must not open when already opened");
			},
			once: () => {},
		},
	};
	assert.equal(mod.toggleMainWindowDevTools(closingWin), false);
	assert.equal(closed, true);
	// 空窗口 / 已销毁窗口 → false
	assert.equal(mod.toggleMainWindowDevTools(null), false);
	assert.equal(mod.toggleMainWindowDevTools(undefined), false);
	assert.equal(mod.toggleMainWindowDevTools({ isDestroyed: () => true, webContents: {} }), false);
	// 未打开 → openDevTools({mode:"detach"})，返回 true
	let openOpts = null;
	let onceRegistered = null;
	const openingWin = {
		isDestroyed: () => false,
		webContents: {
			isDevToolsOpened: () => false,
			openDevTools: (opts) => {
				openOpts = opts;
			},
			closeDevTools: () => {},
			once: (event, cb) => {
				onceRegistered = { event, cb };
			},
		},
	};
	assert.equal(mod.toggleMainWindowDevTools(openingWin), true);
	assert.equal(openOpts.mode, "detach");
	assert.equal(onceRegistered.event, "devtools-opened");
});

test("offscreen devtools window is repositioned to primary display center on open", () => {
	const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
	let devToolsWin = {
		isDestroyed: () => false,
		getBounds: () => ({ x: 5000, y: 5000, width: 1200, height: 800 }),
		setBounds: () => {
			throw new Error("should not be called for visible window");
		},
	};
	const browserWindow = { fromWebContents: () => devToolsWin };
	const screen = {
		getAllDisplays: () => [{ workArea }],
		getPrimaryDisplay: () => ({ workArea }),
	};
	const mod = loadDevTools({ screen, browserWindow });
	// 屏幕外的窗口：触发 devtools-opened 后应 setBounds 到主屏居中
	let repositioned = null;
	devToolsWin.setBounds = (b) => {
		repositioned = b;
	};
	let onceCb = null;
	const win = {
		isDestroyed: () => false,
		webContents: {
			isDevToolsOpened: () => false,
			openDevTools: () => {},
			closeDevTools: () => {},
			// 真实 Electron 在 devtools-opened 后就绪；mock 需提供该属性
			devToolsWebContents: {},
			once: (_event, cb) => {
				onceCb = cb;
			},
		},
	};
	mod.toggleMainWindowDevTools(win);
	onceCb();
	// 跨 vm realm 的对象不能用 deepStrictEqual（原型不同），逐字段断言
	assert.equal(repositioned.x, 360);
	assert.equal(repositioned.y, 140);
	assert.equal(repositioned.width, 1200);
	assert.equal(repositioned.height, 800);
	// 已在屏幕内的窗口：不 reposition
	devToolsWin = {
		...devToolsWin,
		getBounds: () => ({ x: 100, y: 100, width: 800, height: 600 }),
		setBounds: () => {
			throw new Error("visible window must not be repositioned");
		},
	};
	onceCb = null;
	const win2 = {
		isDestroyed: () => false,
		webContents: {
			isDevToolsOpened: () => false,
			openDevTools: () => {},
			closeDevTools: () => {},
			devToolsWebContents: {},
			once: (_event, cb) => {
				onceCb = cb;
			},
		},
	};
	mod.toggleMainWindowDevTools(win2);
	onceCb();
});

test("main window and webview guest both route devtools shortcuts through the shared module", () => {
	const main = readFileSync("src/main/index.ts", "utf8");
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	assert.match(main, /import \{ isDevToolsShortcut, toggleMainWindowDevTools \} from "\.\/devTools"/);
	// 主窗口 before-input-event 统一走共享匹配（注册表 + 用户覆盖）+ 开关
	assert.match(main, /mainWindow\.webContents\.on\("before-input-event"/);
	assert.match(main, /isShortcutInput\("toggleDevTools", input\)/);
	assert.match(main, /toggleMainWindowDevTools\(mainWindow\)/);
	// webview guest（独立 webContents）同样转发，避免内置浏览器里 F12 无响应
	assert.match(main, /guest\.on\("before-input-event"/);
	assert.match(main, /toggleMainWindowDevTools\(window\)/);
	// 设置页 IPC 与快捷键共用同一开关入口
	assert.match(systemIpc, /toggleMainWindowDevTools\(getMainWindow\(\)\)/);
	// 旧的内联重复实现已删除
	assert.doesNotMatch(main, /openDevTools\(\{ mode: "detach" \}\)/);
});
