import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const analyzer = loadTsCommonJs("src/main/cua/CuaWindowAnalyzer.ts", {
	stubs: {
		"./CuaWin32": {
			// SM_CXSCREEN=0, SM_CYSCREEN=1; virtual: X=76, Y=77, CX=78, CY=79.
			GetSystemMetrics: (nIndex) => {
				switch (nIndex) {
					case 0:
					case 78:
						return 2560;
					case 1:
					case 79:
						return 1440;
					default:
						return 0;
				}
			},
			enumerateWindows: () => [
				{
					hwnd: 1,
					title: "Foreground Window",
					pid: 100,
					rect: { x: 0, y: 0, width: 2560, height: 1440 },
					isVisible: true,
					isForeground: true,
					isTopmost: false,
					zIndex: 0,
				},
				{
					hwnd: 2,
					title: "Background Window",
					pid: 200,
					rect: { x: 100, y: 100, width: 800, height: 600 },
					isVisible: true,
					isForeground: false,
					isTopmost: false,
					zIndex: 1,
				},
			],
		},
	},
});

test("analyzeWindows computes occlusion for foreground covering background", () => {
	const result = analyzer.analyzeWindows();
	assert.strictEqual(result.length, 2);

	const foreground = result.find((r) => r.window.hwnd === 1);
	const background = result.find((r) => r.window.hwnd === 2);

	assert.ok(foreground);
	assert.strictEqual(foreground.occludedArea, 0);
	assert.ok(foreground.titleBarPoint);

	assert.ok(background);
	// Background is fully covered by the fullscreen foreground window.
	assert.strictEqual(background.visibleRect.width, 0);
	assert.strictEqual(background.visibleRect.height, 0);
	assert.strictEqual(background.titleBarPoint, undefined);
});

test("findWindowByTitle returns matching window", () => {
	const found = analyzer.findWindowByTitle("Background");
	assert.ok(found);
	assert.strictEqual(found.window.hwnd, 2);
});

test("findWindowByTitle returns undefined for missing window", () => {
	const found = analyzer.findWindowByTitle("Missing");
	assert.strictEqual(found, undefined);
});

function makeAnalyzerWithWindows(windows) {
	return loadTsCommonJs("src/main/cua/CuaWindowAnalyzer.ts", {
		stubs: {
			"./CuaWin32": {
				GetSystemMetrics: (nIndex) => (nIndex === 78 || nIndex === 0 ? 2560 : nIndex === 79 || nIndex === 1 ? 1440 : 0),
				enumerateWindows: (includeInvisible) => (includeInvisible ? windows : windows.filter((w) => w.isVisible)),
			},
		},
	});
}

test("analyzeWindows includeInvisible passthrough and invisible windows are never occluders", () => {
	const windows = [
		{ hwnd: 10, title: "Hidden Top", pid: 300, rect: { x: 0, y: 0, width: 200, height: 200 }, isVisible: false, isForeground: false, isTopmost: false, zIndex: 0 },
		{ hwnd: 11, title: "Visible Back", pid: 301, rect: { x: 0, y: 0, width: 200, height: 200 }, isVisible: true, isForeground: true, isTopmost: false, zIndex: 1 },
	];
	const mod = makeAnalyzerWithWindows(windows);

	const visibleOnly = mod.analyzeWindows();
	assert.strictEqual(visibleOnly.length, 1, "default excludes invisible windows");
	assert.strictEqual(visibleOnly[0].window.hwnd, 11);

	const all = mod.analyzeWindows({ includeInvisible: true });
	assert.strictEqual(all.length, 2);
	const hidden = all.find((r) => r.window.hwnd === 10);
	const visible = all.find((r) => r.window.hwnd === 11);
	assert.strictEqual(hidden.visibleRects.length, 0, "invisible window shows nothing");
	assert.strictEqual(hidden.visibleRect.width, 0);
	// 关键回归：隐藏窗口叠在可见窗口之上也不能把它遮掉。
	assert.strictEqual(visible.occludedArea, 0, "invisible windows must not occlude");
	assert.ok(visible.visibleRects.length > 0);
});

test("visibleRects fragments track visibleRect bounding box", () => {
	const result = analyzer.analyzeWindows();
	const foreground = result.find((r) => r.window.hwnd === 1);
	assert.ok(foreground.visibleRects.length > 0);
	const background = result.find((r) => r.window.hwnd === 2);
	assert.strictEqual(background.visibleRects.length, 0, "fully occluded window has no visible fragments");
});
