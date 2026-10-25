import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 窗口缩放快捷键：shared/zoom 的档位计算 + main/windowZoom 的执行器。
 *
 * 执行器通过 createTsSandbox 加载真实依赖（windowZoom → appShortcuts → shared/shortcuts），
 * 只把「窗口」换成记录调用的替身，验证命中键 → setZoomFactor → 持久化的顺序与长按去重。
 * 覆盖表显式写死 Ctrl+= / Ctrl+-，摆脱宿主平台默认键差异。
 */
function setup() {
	const load = createTsSandbox();
	const zoom = load("src/shared/zoom.ts");
	const windowZoom = load("src/main/windowZoom.ts");
	const appShortcuts = load("src/main/appShortcuts.ts");
	appShortcuts.refreshShortcutBindings({ shortcuts: { zoomIn: "Ctrl+=", zoomOut: "Ctrl+-" } });
	return { zoom, windowZoom, appShortcuts };
}

/** before-input-event 的输入形状 */
function input(overrides = {}) {
	return { key: "=", type: "keyDown", control: false, meta: false, shift: false, alt: false, isComposing: false, ...overrides };
}

/** 记录 setZoomFactor / persistZoomFactor 调用的宿主替身 */
function host(current = 1, { destroyed = false } = {}) {
	const calls = { applied: [], persisted: [], notified: [] };
	const win = {
		isDestroyed: () => destroyed,
		webContents: { setZoomFactor: (value) => calls.applied.push(value) },
	};
	return {
		calls,
		host: {
			getWindow: () => win,
			getZoomFactor: () => current,
			persistZoomFactor: (value) => calls.persisted.push(value),
			notifyZoomFactor: (value) => calls.notified.push(value),
		},
	};
}

test("clampZoomFactor：钳制到 [0.8,1.5]、保留两位小数、坏值回落 100%", () => {
	const { zoom } = setup();
	assert.equal(zoom.ZOOM_FACTOR_MIN, 0.8);
	assert.equal(zoom.ZOOM_FACTOR_MAX, 1.5);
	assert.equal(zoom.ZOOM_FACTOR_STEP, 0.05);
	assert.equal(zoom.clampZoomFactor(0.5), 0.8);
	assert.equal(zoom.clampZoomFactor(2), 1.5);
	assert.equal(zoom.clampZoomFactor(1.234), 1.23);
	// 非有限值（NaN/Infinity）回落 100%，避免坏值写进 settings.json
	assert.equal(zoom.clampZoomFactor(Number.NaN), 1);
	assert.equal(zoom.clampZoomFactor(Number.POSITIVE_INFINITY), 1);
	assert.equal(zoom.clampZoomFactor(Number.NEGATIVE_INFINITY), 1);
});

test("nextZoomFactor：逐档加减、边界处不再越界、不累积浮点误差", () => {
	const { zoom } = setup();
	assert.equal(zoom.nextZoomFactor(1, "in"), 1.05);
	assert.equal(zoom.nextZoomFactor(1, "out"), 0.95);
	// 连续放大 20 次停在 1.5，不会得到 1.5000000000000002
	let value = 1;
	for (let i = 0; i < 20; i += 1) value = zoom.nextZoomFactor(value, "in");
	assert.equal(value, 1.5);
	// 连续缩小同样停在 0.8
	for (let i = 0; i < 40; i += 1) value = zoom.nextZoomFactor(value, "out");
	assert.equal(value, 0.8);
	// 坏值起步按 100% 计算
	assert.equal(zoom.nextZoomFactor(Number.NaN, "in"), 1.05);
});

test("命中缩放快捷键：setZoomFactor 与持久化都收到同一档位并返回 true", () => {
	const { windowZoom } = setup();
	const { calls, host: h } = host(1);
	const handle = windowZoom.createWindowZoomShortcutHandler(h);
	assert.equal(handle(input({ key: "=", control: true })), true);
	assert.deepEqual(calls.applied, [1.05]);
	assert.deepEqual(calls.persisted, [1.05]);
	// 渲染层同步：不推就会让设置页一直显示旧百分比
	assert.deepEqual(calls.notified, [1.05]);
	// 缩小走 Ctrl+-
	assert.equal(handle(input({ key: "-", control: true })), true);
	assert.deepEqual(calls.applied, [1.05, 0.95]);
	assert.deepEqual(calls.persisted, [1.05, 0.95]);
	assert.deepEqual(calls.notified, [1.05, 0.95]);
});

test("长按自动重复（isAutoRepeat）命中但不改档、不写盘、不通知", () => {
	const { windowZoom } = setup();
	const { calls, host: h } = host(1);
	const handle = windowZoom.createWindowZoomShortcutHandler(h);
	assert.equal(handle(input({ key: "=", control: true, isAutoRepeat: true })), true);
	assert.deepEqual(calls.applied, []);
	assert.deepEqual(calls.persisted, []);
	assert.deepEqual(calls.notified, []);
});

test("未命中返回 false 且无副作用；主窗口销毁时仍持久化档位", () => {
	const { windowZoom } = setup();
	const { calls, host: h } = host(1);
	const handle = windowZoom.createWindowZoomShortcutHandler(h);
	assert.equal(handle(input({ key: "k", control: true })), false);
	assert.deepEqual(calls.applied, []);
	assert.deepEqual(calls.persisted, []);
	assert.deepEqual(calls.notified, []);
	// 窗口已销毁：不再调用 setZoomFactor，但设置仍落盘（下次启动恢复）
	const gone = host(1, { destroyed: true });
	const handleGone = windowZoom.createWindowZoomShortcutHandler(gone.host);
	assert.equal(handleGone(input({ key: "=", control: true })), true);
	assert.deepEqual(gone.calls.applied, []);
	assert.deepEqual(gone.calls.persisted, [1.05]);
});

test("到达边界时重复按键仍写入同一档位（幂等，不会越界）", () => {
	const { windowZoom } = setup();
	const { calls, host: h } = host(1.5);
	const handle = windowZoom.createWindowZoomShortcutHandler(h);
	assert.equal(handle(input({ key: "=", control: true })), true);
	assert.deepEqual(calls.applied, [1.5]);
	assert.deepEqual(calls.persisted, [1.5]);
	assert.deepEqual(calls.notified, [1.5]);
});

test("notifyZoomFactor 是可选依赖：未提供时命中仍不报错", () => {
	const { windowZoom } = setup();
	const applied = [];
	const handle = windowZoom.createWindowZoomShortcutHandler({
		getWindow: () => ({ isDestroyed: () => false, webContents: { setZoomFactor: (v) => applied.push(v) } }),
		getZoomFactor: () => 1,
		persistZoomFactor: () => undefined,
	});
	assert.equal(handle(input({ key: "=", control: true })), true);
	assert.deepEqual(applied, [1.05]);
});
