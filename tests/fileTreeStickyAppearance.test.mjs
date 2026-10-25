import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/** 提供可控的目录自然位置与 sticky 槽位，验证吸顶外观而不启动浏览器。 */
function rowAt(top, naturalTop, slotTop) {
	const row = { top, naturalTop, slotTop, dataset: {} };
	row.getBoundingClientRect = () => ({ top: row.top });
	row.parentElement = { getBoundingClientRect: () => ({ top: row.naturalTop }) };
	return row;
}

/** hook 的 DOM / 帧 / observer 宿主：只替换浏览器边界，加载真实生产模块。 */
function mount(rows, enabled = true) {
	const listeners = new Map();
	const frames = new Map();
	const observed = new Set();
	let nextFrame = 0;
	let cleanup;
	let onResize;
	let disconnected = false;
	const panel = {
		clientTop: 0,
		getBoundingClientRect: () => ({ top: 0 }),
		querySelectorAll: () => rows,
		addEventListener: (name, listener) => listeners.set(name, listener),
		removeEventListener: (name, listener) => {
			if (listeners.get(name) === listener) listeners.delete(name);
		},
	};
	const load = createTsSandbox({
		stubs: {
			react: {
				useLayoutEffect: (effect) => {
					cleanup = effect();
				},
			},
		},
		globals: {
			getComputedStyle: (row) => ({ top: `${row.slotTop}px` }),
			requestAnimationFrame: (callback) => {
				const id = ++nextFrame;
				frames.set(id, callback);
				return id;
			},
			cancelAnimationFrame: (id) => frames.delete(id),
			ResizeObserver: class {
				constructor(callback) {
					onResize = callback;
				}
				observe(element) {
					observed.add(element);
				}
				disconnect() {
					disconnected = true;
					observed.clear();
				}
			},
		},
	});
	const { useFileTreeStickyAppearance } = load("src/renderer/src/hooks/files/useFileTreeStickyAppearance.ts");
	useFileTreeStickyAppearance({ current: panel }, [], new Set(), enabled);
	return {
		listeners,
		frames,
		observed,
		get disconnected() {
			return disconnected;
		},
		scroll: () => listeners.get("scroll")?.(),
		resize: () => onResize?.(),
		flush: () => {
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) callback();
		},
		unmount: () => cleanup?.(),
	};
}

test("普通目录行不加吸顶阴影", () => {
	const rows = [rowAt(28, 28, 28), rowAt(56, 56, 56)];
	const host = mount(rows);
	assert.deepEqual(
		rows.map((row) => row.dataset.fileStuck),
		["false", "false"],
	);
	assert.deepEqual(
		rows.map((row) => row.dataset.fileStickyLast),
		["false", "false"],
	);
	host.unmount();
});

test("三层真正吸顶时只有最后一行显示阴影", () => {
	const rows = [rowAt(28, -300, 28), rowAt(56, -272, 56), rowAt(84, -244, 84)];
	const host = mount(rows);
	assert.deepEqual(
		rows.map((row) => row.dataset.fileStuck),
		["true", "true", "true"],
	);
	assert.deepEqual(
		rows.map((row) => row.dataset.fileStickyLast),
		["false", "false", "true"],
	);
	host.unmount();
});

test("滚回自然位置后移除吸顶阴影，滚动事件每帧只处理一次", () => {
	const row = rowAt(28, -200, 28);
	const host = mount([row]);
	assert.equal(row.dataset.fileStickyLast, "true");
	row.naturalTop = 28;
	host.scroll();
	host.scroll();
	host.resize();
	assert.equal(host.frames.size, 1);
	host.flush();
	assert.equal(row.dataset.fileStuck, "false");
	assert.equal(row.dataset.fileStickyLast, "false");
	host.unmount();
});

test("离开吸顶槽位的旧目录不保留阴影", () => {
	const rows = [rowAt(12, -500, 28), rowAt(56, -472, 56)];
	const host = mount(rows);
	assert.equal(rows[0].dataset.fileStuck, "false");
	assert.equal(rows[0].dataset.fileStickyLast, "false");
	assert.equal(rows[1].dataset.fileStickyLast, "true");
	host.unmount();
});

test("卸载时退订 scroll、observer、待处理帧并清除外观标记", () => {
	const row = rowAt(28, -200, 28);
	const host = mount([row]);
	assert.equal(host.listeners.size, 1);
	assert.equal(host.observed.size, 2);
	host.scroll();
	assert.equal(host.frames.size, 1);
	host.unmount();
	assert.equal(host.listeners.size, 0);
	assert.equal(host.frames.size, 0);
	assert.equal(host.disconnected, true);
	assert.deepEqual(row.dataset, {});
});

test("进入搜索视图时不注册文件树几何订阅", () => {
	const row = rowAt(28, -200, 28);
	const host = mount([row], false);
	assert.equal(host.listeners.size, 0);
	assert.equal(host.observed.size, 0);
	assert.deepEqual(row.dataset, {});
});
