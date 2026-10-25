import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// CuaEngine pulls handle math plus every Win32 input path — all stubbed
// so a test run can never inject real OS input.

function makeState() {
	return {
		clicks: [],
		scrolls: [],
		types: [],
		combos: [],
		winpos: [],
		shows: [],
		moves: [],
		foregroundHwnd: 42,
		clickAtError: null,
		findResult: undefined,
		analyzeResult: [],
		virtualDisplay: { x: -2560, y: 0, width: 5120, height: 1440 },
	};
}

function loadEngine(state) {
	return loadTsCommonJs("src/main/cua/CuaEngine.ts", {
		stubs: {
			"./CuaWin32": {
				koffiAddress: (ptr) => Number(ptr) || 0,
				clickAt: (x, y, button, w, h, ox, oy) => {
					if (state.clickAtError) throw state.clickAtError;
					state.clicks.push({ x, y, button, w, h, ox, oy });
					return 3;
				},
				scrollAt: (x, y, deltaY, deltaX, w, h, ox, oy) => {
					state.scrolls.push({ x, y, deltaY, deltaX, w, h, ox, oy });
					return 2;
				},
				moveMouseAbsolute: (x, y, w, h, ox, oy) => {
					state.moves.push({ x, y, w, h, ox, oy });
					return 1;
				},
				typeUnicode: (text) => {
					state.types.push(text);
					return text.length * 2;
				},
				pressKeyCombo: (combo) => {
					state.combos.push(combo);
					return 2;
				},
				SetWindowPos: (hwnd, insertAfter, x, y, cx, cy, flags) => {
					state.winpos.push({ hwnd: Number(hwnd), insertAfter, x, y, cx, cy, flags });
					return true;
				},
				ShowWindow: (hwnd, cmd) => {
					state.shows.push({ hwnd: Number(hwnd), cmd });
					return true;
				},
				IsWindow: () => true,
				GetForegroundWindow: () => state.foregroundHwnd,
				HWND_TOPMOST: -1,
				HWND_NOTOPMOST: -2,
				SW_RESTORE: 9,
				SWP_NOMOVE: 0x2,
				SWP_NOSIZE: 0x1,
				SWP_NOACTIVATE: 0x10,
				SWP_SHOWWINDOW: 0x40,
				VK_MAP: { enter: 0x0d, ctrl: 0x11 },
			},
			"./CuaWindowAnalyzer": {
				analyzeWindows: () => state.analyzeResult,
				findWindowByTitle: () => state.findResult,
				getPrimaryDisplay: () => ({ width: 2560, height: 1440 }),
				getVirtualDisplay: () => state.virtualDisplay,
			},
		},
		globals: {
			setTimeout: globalThis.setTimeout.bind(globalThis),
			clearTimeout: globalThis.clearTimeout.bind(globalThis),
		},
	});
}

function makeAllowGate(calls) {
	// Minimal CuaGate-shaped allow-everything double. The engine under test only
	// needs check() contract, so a fake keeps the test free of Electron imports.
	return {
		check: (action, sessionId, detail, meta) => {
			calls.push({ action, sessionId, detail, meta });
			return Promise.resolve({ allowed: true });
		},
		isEnabled: () => true,
	};
}

const VIRTUAL = { x: -2560, y: 0, width: 5120, height: 1440 };

test("click passes virtual-desktop origin to clickAt (multi-monitor regression)", async () => {
	const state = makeState();
	const { CuaEngine } = loadEngine(state);
	const gateCalls = [];
	const engine = new CuaEngine(undefined, makeAllowGate(gateCalls));

	const result = await engine.click("session-a", -100, 700, "left");
	assert.strictEqual(result.sent, 3);
	assert.strictEqual(gateCalls.length, 1);
	assert.strictEqual(state.clicks.length, 1);
	const click = state.clicks[0];
	assert.deepStrictEqual({ w: click.w, h: click.h, ox: click.ox, oy: click.oy }, { w: VIRTUAL.width, h: VIRTUAL.height, ox: VIRTUAL.x, oy: VIRTUAL.y });
	assert.strictEqual(click.button, "left");
});

test("doubleClick asks the gate ONCE and injects two clicks", async () => {
	const state = makeState();
	const { CuaEngine } = loadEngine(state);
	const gateCalls = [];
	const engine = new CuaEngine(undefined, makeAllowGate(gateCalls));

	const result = await engine.doubleClick("session-a", 320, 640, "left");
	assert.strictEqual(result.sent, 6, "two physical clicks worth of INPUT records");
	assert.strictEqual(state.clicks.length, 2, "two clickAt invocations");
	assert.strictEqual(gateCalls.length, 1, "exactly one approval for the whole gesture");
	assert.strictEqual(gateCalls[0].detail.double, true, "approval detail marks the gesture as double");
});

test("scroll injects wheel deltas with virtual-desktop normalization", async () => {
	const state = makeState();
	const { CuaEngine } = loadEngine(state);
	const gateCalls = [];
	const engine = new CuaEngine(undefined, makeAllowGate(gateCalls));

	const result = await engine.scroll("session-a", 200, 300, -120, 0);
	assert.strictEqual(result.sent, 2);
	assert.strictEqual(state.scrolls.length, 1);
	const scroll = state.scrolls[0];
	assert.strictEqual(scroll.deltaY, -120);
	assert.deepStrictEqual({ w: scroll.w, h: scroll.h, ox: scroll.ox, oy: scroll.oy }, { w: VIRTUAL.width, h: VIRTUAL.height, ox: VIRTUAL.x, oy: VIRTUAL.y });
});

test("activateWindow restores TOPMOST even when the title-bar click throws (try/finally)", async () => {
	const state = makeState();
	state.findResult = {
		window: {
			hwnd: 7,
			title: "Target",
			pid: 123,
			rect: { x: 10, y: 10, width: 400, height: 300 },
			isVisible: true,
			isForeground: false,
			isTopmost: false,
			zIndex: 0,
		},
		visibleRect: { x: 10, y: 10, width: 400, height: 300 },
		visibleRects: [{ x: 10, y: 10, width: 400, height: 300 }],
		occludedArea: 0,
		titleBarPoint: { x: 60, y: 15 },
	};
	state.clickAtError = new Error("SendInput failed");

	const { CuaEngine } = loadEngine(state);
	const engine = new CuaEngine(undefined, makeAllowGate([]));

	await assert.rejects(() => engine.activateWindow("Target"), /SendInput failed/);

	const inserts = state.winpos.map((entry) => entry.insertAfter);
	assert.ok(inserts.includes(-1), "TOPMOST applied before the click");
	assert.ok(inserts.includes(-2), "NOTOPMOST restored after failure");
	assert.ok(inserts.indexOf(-1) < inserts.lastIndexOf(-2), "restore happens after raise");
});

test("activateWindow short-circuits when target is already foreground", async () => {
	const state = makeState();
	state.findResult = {
		window: {
			hwnd: 7,
			title: "Target",
			pid: 123,
			rect: { x: 0, y: 0, width: 100, height: 100 },
			isVisible: true,
			isForeground: true,
			isTopmost: false,
			zIndex: 0,
		},
		visibleRect: { x: 0, y: 0, width: 100, height: 100 },
		visibleRects: [{ x: 0, y: 0, width: 100, height: 100 }],
		occludedArea: 0,
		titleBarPoint: { x: 10, y: 5 },
	};
	const { CuaEngine } = loadEngine(state);
	const engine = new CuaEngine(undefined, makeAllowGate([]));

	const result = await engine.activateWindow("Target");
	assert.strictEqual(result.success, true);
	assert.strictEqual(result.method, "already-foreground");
	assert.strictEqual(state.winpos.length, 0, "no TOPMOST dance needed");
	assert.strictEqual(state.clicks.length, 0, "no title-bar click needed");
});

test("doubleClick honors gate denial before any injection", async () => {
	const state = makeState();
	const { CuaEngine } = loadEngine(state);
	const denyGate = {
		check: () => Promise.resolve({ allowed: false, reason: "user_denied" }),
	};
	const engine = new CuaEngine(undefined, denyGate);

	const result = await engine.doubleClick("session-a", 1, 2, "left");
	assert.strictEqual(result.sent, 0);
	assert.strictEqual(result.gateDecision, "denied");
	assert.strictEqual(state.clicks.length, 0, "denied gesture must not inject input");
});

test("type text goes through typeUnicode, key combo through pressKeyCombo", async () => {
	const state = makeState();
	const { CuaEngine } = loadEngine(state);
	const engine = new CuaEngine(undefined, makeAllowGate([]));

	const textResult = await engine.type("s", { text: "hello" });
	assert.strictEqual(textResult.sent, "hello".length * 2);
	assert.deepStrictEqual(state.types, ["hello"]);

	const keyResult = await engine.type("s", { key: "enter", modifiers: ["ctrl"] });
	assert.strictEqual(keyResult.sent, 2);
	assert.strictEqual(state.combos.length, 1);
});

test("isPointVisible respects occlusion fragments and treats bare desktop as visible", async () => {
	const state = makeState();
	state.analyzeResult = [
		{
			window: {
				hwnd: 1,
				title: "Top",
				pid: 1,
				rect: { x: 0, y: 0, width: 400, height: 400 },
				isVisible: true,
				isForeground: true,
				isTopmost: false,
				zIndex: 0,
			},
			visibleRect: { x: 200, y: 0, width: 200, height: 400 },
			visibleRects: [{ x: 200, y: 0, width: 200, height: 400 }],
			occludedArea: 100,
		},
		{
			window: {
				hwnd: 2,
				title: "Back",
				pid: 2,
				rect: { x: 0, y: 0, width: 400, height: 400 },
				isVisible: true,
				isForeground: false,
				isTopmost: false,
				zIndex: 1,
			},
			visibleRect: { x: 0, y: 0, width: 0, height: 0 },
			visibleRects: [],
			occludedArea: 160000,
		},
	];
	const { CuaEngine } = loadEngine(state);
	const engine = new CuaEngine(undefined, makeAllowGate([]));

	assert.strictEqual(engine.isPointVisible(50, 50), false, "point on occluded part of top window is not clickable-visible");
	assert.strictEqual(engine.isPointVisible(300, 50), true, "point on surviving fragment is visible");
	assert.strictEqual(engine.isPointVisible(4000, 4000), true, "bare desktop counts as visible");
});
