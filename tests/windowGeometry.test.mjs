/**
 * 透明/无边框窗口几何守卫契约。
 *
 * 背景（2026-11）：Windows 上透明无边框窗口会被系统放大 bounds —— 悬浮球实测
 * 224x104 → 690x632，桌宠也有同类注释。放大的窗口会移动可视内容的锚点、并在透明
 * 区域继续拦截下层点击。移动必须带设计尺寸，并按固定间隔把尺寸纠回来。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox({ stubs: {} });
const { moveWindowWithSize, ensureWindowSize, WindowSizeGuard } = load("src/main/windowGeometry.ts");

function fakeWindow(bounds) {
	return {
		bounds: { ...bounds },
		destroyed: false,
		calls: [],
		getSize() {
			return [this.bounds.width, this.bounds.height];
		},
		getPosition() {
			return [this.bounds.x, this.bounds.y];
		},
		setBounds(next) {
			this.calls.push({ ...next });
			this.bounds = { ...next };
		},
		isDestroyed() {
			return this.destroyed;
		},
	};
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("moveWindowWithSize：移动时强制设计尺寸并取整坐标", () => {
	const win = fakeWindow({ x: 0, y: 0, width: 690, height: 632 });
	moveWindowWithSize(win, 10.6, 20.2, { width: 72, height: 72 });
	assert.deepEqual(win.bounds, { x: 11, y: 20, width: 72, height: 72 });
});

test("ensureWindowSize：尺寸偏离时只纠正尺寸，位置不变", () => {
	const win = fakeWindow({ x: 300, y: 400, width: 690, height: 632 });
	ensureWindowSize(win, { width: 72, height: 72 });
	assert.deepEqual(win.bounds, { x: 300, y: 400, width: 72, height: 72 });
});

test("ensureWindowSize：尺寸已正确时不产生写调用", () => {
	const win = fakeWindow({ x: 300, y: 400, width: 72, height: 72 });
	ensureWindowSize(win, { width: 72, height: 72 });
	assert.equal(win.calls.length, 0);
});

test("WindowSizeGuard：定时把被系统放大的窗口拉回设计尺寸", async () => {
	const win = fakeWindow({ x: 100, y: 200, width: 690, height: 632 });
	const guard = new WindowSizeGuard(
		() => win,
		() => ({ width: 72, height: 72 }),
		10,
	);
	guard.start();
	await delay(40);
	guard.stop();
	assert.deepEqual(win.bounds, { x: 100, y: 200, width: 72, height: 72 });
});

test("WindowSizeGuard：窗口销毁后自动停止，不再写窗口", async () => {
	const win = fakeWindow({ x: 100, y: 200, width: 72, height: 72 });
	const guard = new WindowSizeGuard(
		() => win,
		() => ({ width: 72, height: 72 }),
		10,
	);
	guard.start();
	win.destroyed = true;
	win.bounds = { x: 100, y: 200, width: 690, height: 632 };
	await delay(40);
	assert.equal(win.calls.length, 0, "销毁后 ensure 应直接停表，不调用 setBounds");
});
