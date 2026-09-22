import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// electron 只桩 app.getPath / screen.getDisplayMatching：本模块不做窗口创建，只读几何与桌面路径。
const DESKTOP = "D:\\Desktop";
const { QuickTaskWindowChrome } = loadTsCommonJs("src/main/quickTask/quickTaskWindowChrome.ts", {
	stubs: {
		electron: {
			app: { getPath: (name) => (name === "desktop" ? DESKTOP : "C:\\userData") },
			screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
		},
	},
});

/** vm 跨 realm 时 deepEqual 会因原型不同误报，统一 JSON 比较（同 composerChips.test.mjs）。 */
function assertJsonEqual(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

/** 同时跟踪 normalBounds 与 bounds：紧凑模式改的是后者，保存偏好时要用前者。 */
function windowStub({ normal = { x: 200, y: 100, width: 1280, height: 900 }, maximized = false, fullscreen = false, destroyed = false } = {}) {
	const events = new EventEmitter();
	let bounds = { ...normal };
	let currentNormal = { ...normal };
	let isMaximized = maximized;
	let isFullscreen = fullscreen;
	let minimum = [880, 600];
	let alive = !destroyed;
	const sent = [];
	return {
		/** publish 走这里；channel 固定为 quick-task:changed，状态用于断言推送内容。 */
		webContents: {
			send: (channel, state) => sent.push({ channel, state }),
		},
		sent,
		once: events.once.bind(events),
		removeListener: events.removeListener.bind(events),
		emit: events.emit.bind(events),
		listenerCount: events.listenerCount.bind(events),
		isDestroyed: () => !alive,
		kill: () => {
			alive = false;
		},
		getNormalBounds: () => ({ ...currentNormal }),
		getBounds: () => ({ ...bounds }),
		getMinimumSize: () => [...minimum],
		isMaximized: () => isMaximized,
		isFullScreen: () => isFullscreen,
		isMinimized: () => false,
		setFullScreen: (value) => {
			isFullscreen = value;
		},
		unmaximize: () => {
			isMaximized = false;
		},
		maximize: () => {
			isMaximized = true;
		},
		setMinimumSize: (w, h) => {
			minimum = [w, h];
		},
		setBounds: (value) => {
			bounds = { ...value };
		},
		restore() {},
		show() {},
		focus() {},
	};
}

function createChrome(win) {
	const saved = [];
	const chrome = new QuickTaskWindowChrome({ getWindow: () => win, saveWorkbenchBounds: (size) => saved.push(size) });
	return { chrome, saved };
}

test("紧凑模式关窗时保存的是工作台几何，不是 720×760 的小窗口尺寸", async () => {
	const win = windowStub();
	const { chrome, saved } = createChrome(win);
	// 用真实存在的目录走完校验，确保 saved bounds 是「进入紧凑模式前」捕获的工作台尺寸。
	await chrome.applyLaunchTarget({ quickTaskPath: process.cwd() });
	assert.equal(win.getBounds().width, 720, "进入紧凑模式后窗口应变窄");
	chrome.saveWorkbenchBoundsOnClose(win);
	assertJsonEqual(saved.at(-1), { width: 1280, height: 900 });
});

test("未激活紧凑模式时按最大化/全屏语义取 normal bounds", () => {
	const win = windowStub({ maximized: true });
	const { chrome, saved } = createChrome(win);
	chrome.saveWorkbenchBoundsOnClose(win);
	assertJsonEqual(saved.at(-1), { width: 1280, height: 900 });
});

test("窗口已销毁时不写几何", () => {
	const win = windowStub();
	const { chrome, saved } = createChrome(win);
	win.kill();
	chrome.saveWorkbenchBoundsOnClose(win);
	assert.equal(saved.length, 0);
});

test("interceptClose 只在紧凑模式激活时消费关闭事件", async () => {
	const win = windowStub();
	const { chrome } = createChrome(win);
	let prevented = 0;
	const event = {
		preventDefault: () => {
			prevented += 1;
		},
	};

	assert.equal(chrome.interceptClose(event), false);
	assert.equal(prevented, 0);

	await chrome.applyLaunchTarget({ quickTaskPath: process.cwd() });
	assert.equal(chrome.controller.isActive(), true);
	assert.equal(chrome.interceptClose(event), true);
	assert.equal(prevented, 1);
	assert.equal(chrome.controller.isActive(), false, "拦截关闭应退出紧凑模式而不是关掉应用");

	// 退出后再次关闭应交还给 index.ts 的 closeToTray / 退出分支。
	assert.equal(chrome.interceptClose(event), false);
	assert.equal(prevented, 1);
});

test("applyLaunchTarget：quick-task 意图被消费，普通意图只退出紧凑模式", async () => {
	const win = windowStub();
	const { chrome } = createChrome(win);

	assert.equal(await chrome.applyLaunchTarget({ quickTaskDesktop: true }), true);
	assert.equal(chrome.controller.getState().path, DESKTOP, "桌面入口应解析为已知桌面目录而不是硬编码 %USERPROFILE%");
	assert.equal(chrome.controller.isActive(), true);
	// 状态变更必须推给当前窗口的 webContents（渲染层靠它进入紧凑模式）。
	assert.deepEqual(
		win.sent.map((entry) => entry.channel),
		["quick-task:changed"],
	);

	// 打开项目/会话属于 index.ts 的职责：这里只负责先退出紧凑模式并返回 false。
	assert.equal(await chrome.applyLaunchTarget({ projectPath: "C:\\somewhere" }), false);
	assert.equal(chrome.controller.isActive(), false);

	assert.equal(await chrome.applyLaunchTarget(undefined), false);
});

test("窗口引用是现取的：换窗口后重新捕获那一侧的工作台几何", async () => {
	const first = windowStub();
	const second = windowStub({ normal: { x: 0, y: 0, width: 1600, height: 1000 } });
	const holder = { window: first };
	const saved = [];
	const chrome = new QuickTaskWindowChrome({ getWindow: () => holder.window, saveWorkbenchBounds: (size) => saved.push(size) });

	await chrome.applyLaunchTarget({ quickTaskPath: process.cwd() });
	chrome.saveWorkbenchBoundsOnClose(holder.window);
	assertJsonEqual(saved.at(-1), { width: 1280, height: 900 });

	holder.window = second;
	await chrome.applyLaunchTarget({ quickTaskPath: process.cwd() });
	chrome.saveWorkbenchBoundsOnClose(holder.window);
	assertJsonEqual(saved.at(-1), { width: 1600, height: 1000 });
	assert.notEqual(saved.at(-1).width, 1280, "第二个窗口必须重新捕获几何，不能沿用第一个窗口的 saved bounds");
});
