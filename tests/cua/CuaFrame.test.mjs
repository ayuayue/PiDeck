import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// 顶层不带 electron stub 也能加载：npm `electron` 包在非 Electron 运行时导出
// 的是二进制路径字符串，destructure 出 undefined，仅 captureScreen 不可用。
const CuaFrame = loadTsCommonJs("src/main/cua/CuaFrame.ts");

function makeElectronStub({ sources, calls, displays }) {
	const screenDisplays = displays ?? [PRIMARY_DISPLAY];
	return {
		desktopCapturer: {
			getSources: async (opts) => {
				calls.push(opts);
				return sources;
			},
		},
		nativeImage: {
			createFromDataURL: () => ({ isEmpty: () => true }),
		},
		screen: {
			getAllDisplays: () => screenDisplays,
			getPrimaryDisplay: () => screenDisplays.find((display) => display.id === PRIMARY_DISPLAY.id) ?? screenDisplays[0],
		},
	};
}

const PRIMARY_DISPLAY = { id: 2919297941, label: "DELL U2720Q", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
// 副屏在左侧且 200%：DIP 原点 -1560 → 物理 -3120。
const SECONDARY_DISPLAY = { id: 3094298054, label: "副屏", bounds: { x: -1560, y: 0, width: 1560, height: 1040 }, scaleFactor: 2 };

function makeFakeImage({ width, height, resizedTo }) {
	return {
		getSize: () => ({ width, height }),
		resize: (opts) => {
			assert.ok(opts.width > 0 && opts.height > 0, "resize needs positive dims");
			resizedTo.push(opts);
			return {
				getSize: () => ({ width: opts.width, height: opts.height }),
				resize: () => {
					throw new Error("double resize should never happen");
				},
				toJPEG: () => Buffer.from(`jpeg-${opts.width}x${opts.height}`),
			};
		},
		toJPEG: () => Buffer.from(`jpeg-${width}x${height}`),
	};
}

function loadFrameWithSources(sources, calls, displays) {
	return loadTsCommonJs("src/main/cua/CuaFrame.ts", {
		stubs: { electron: makeElectronStub({ sources, calls, displays }) },
	});
}

test("default capture options match probe5 budget", () => {
	// 1280 long edge / quality 75 keeps 2560x1440 frames under ~190KB base64.
	assert.strictEqual(CuaFrame.DEFAULT_MAX_LONG_EDGE, 1280);
	assert.strictEqual(CuaFrame.DEFAULT_QUALITY, 75);
});

test("captureScreen requests a large thumbnail ceiling, never 1x1 (regression)", async () => {
	// 2026-10 实机回归：thumbnailSize {1,1} 让 Electron 把 capture 缩到 1 像素，
	// 打包版 cua_capture 恒返回 width:1,height:1（CUA "看屏幕" 整体失效）。
	const calls = [];
	const resizedTo = [];
	const mod = loadFrameWithSources([{ id: "screen:0:0", thumbnail: makeFakeImage({ width: 2560, height: 1440, resizedTo }) }], calls);

	const frame = await mod.captureScreen();
	assert.strictEqual(calls.length, 1);
	const requested = calls[0].thumbnailSize;
	// 请求体量 = 输出预算：既不会像 1x1 那样截成 1 像素，也不会像旧版 8192 那样
	// 先把源放大到 8K 再缩回 1280（双重采样、更慢、更糊）。
	assert.deepStrictEqual({ ...requested }, { width: mod.DEFAULT_MAX_LONG_EDGE, height: mod.DEFAULT_MAX_LONG_EDGE });

	// 1280 long edge: 2560x1440 → 1280x720
	assert.strictEqual(frame.width, 1280);
	assert.strictEqual(frame.height, 720);
	assert.strictEqual(resizedTo.length, 1, "oversized source is resized once");
	assert.strictEqual(frame.mimeType, "image/jpeg");
	assert.strictEqual(frame.displayId, "screen:0:0");
});

test("captureScreen skips resize when the source already fits the budget", async () => {
	const calls = [];
	const resizedTo = [];
	const mod = loadFrameWithSources([{ id: "screen:0:0", thumbnail: makeFakeImage({ width: 800, height: 600, resizedTo }) }], calls);

	const frame = await mod.captureScreen();
	assert.strictEqual(frame.width, 800);
	assert.strictEqual(frame.height, 600);
	assert.strictEqual(resizedTo.length, 0, "no redundant resize within budget");
});

test("captureScreen requests an explicit maxLongEdge budget instead of a fixed 8K ceiling", async () => {
	const calls = [];
	const mod = loadFrameWithSources([{ id: "screen:0:0", thumbnail: makeFakeImage({ width: 2560, height: 1440, resizedTo: [] }) }], calls);

	await mod.captureScreen({ maxLongEdge: 640 });
	assert.deepStrictEqual({ ...calls[0].thumbnailSize }, { width: 640, height: 640 });
});

test("captureScreen throws when the requested displayId is not found", async () => {
	const mod = loadFrameWithSources([{ id: "screen:0:0", thumbnail: makeFakeImage({ width: 800, height: 600, resizedTo: [] }) }], []);
	await assert.rejects(() => mod.captureScreen({ displayId: "screen:9:9" }), /Screen source not found/);
});

// 实机顺序：Electron 的 sources[0] 在本机是"副屏"，"omit for primary" 靠索引会截错屏。
const PRIMARY_SOURCE = { id: "screen:1:0", display_id: String(PRIMARY_DISPLAY.id), thumbnail: makeFakeImage({ width: 1920, height: 1080, resizedTo: [] }) };
const SECONDARY_SOURCE = { id: "screen:0:0", display_id: String(SECONDARY_DISPLAY.id), thumbnail: makeFakeImage({ width: 3120, height: 2080, resizedTo: [] }) };

test("captureScreen without displayId captures the primary display, not sources[0]", async () => {
	const calls = [];
	const mod = loadFrameWithSources([SECONDARY_SOURCE, PRIMARY_SOURCE], calls, [PRIMARY_DISPLAY, SECONDARY_DISPLAY]);

	const frame = await mod.captureScreen();
	assert.strictEqual(frame.displayId, "screen:1:0");
	assert.strictEqual(frame.screenDisplayId, String(PRIMARY_DISPLAY.id));
	assert.strictEqual(frame.isPrimary, true);
	assert.deepStrictEqual({ ...frame.screenRect }, { x: 0, y: 0, width: 1920, height: 1080 });
	assert.strictEqual(frame.scaleFactor, 1);
});

test("captureScreen returns the physical rect of a 200% secondary display", async () => {
	const calls = [];
	const mod = loadFrameWithSources([SECONDARY_SOURCE, PRIMARY_SOURCE], calls, [PRIMARY_DISPLAY, SECONDARY_DISPLAY]);

	const frame = await mod.captureScreen({ displayId: String(SECONDARY_DISPLAY.id) });
	assert.strictEqual(frame.displayId, "screen:0:0");
	assert.strictEqual(frame.isPrimary, false);
	// DIP (-1560,0,1560x1040) @200% → 物理 (-3120,0,3120x2080)
	assert.deepStrictEqual({ ...frame.screenRect }, { x: -3120, y: 0, width: 3120, height: 2080 });
	assert.strictEqual(frame.scaleFactor, 2);
	assert.strictEqual(frame.width, 1280);
	assert.strictEqual(frame.height, 853);
});

test("captureScreen accepts a source id as displayId", async () => {
	const calls = [];
	const mod = loadFrameWithSources([SECONDARY_SOURCE, PRIMARY_SOURCE], calls, [PRIMARY_DISPLAY, SECONDARY_DISPLAY]);

	const frame = await mod.captureScreen({ displayId: "screen:0:0" });
	assert.strictEqual(frame.displayId, "screen:0:0");
	assert.deepStrictEqual({ ...frame.screenRect }, { x: -3120, y: 0, width: 3120, height: 2080 });
});
