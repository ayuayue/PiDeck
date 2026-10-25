import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const { normalizeQuickMessages } = loadTsCommonJs("src/shared/quickMessages.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 延迟保存/刷新回包，验证真实 hook 在读盘期间继续编辑时不会退回旧草稿。 */
function editorHarness(initial = ["继续"], defaults = ["默认"]) {
	const host = quickMessageHookHost();
	let items = initial;
	let currentDefaults = defaults;
	const requests = [];
	const refreshRequests = [];
	const saved = [];
	const notices = [];
	const timers = new Map();
	let timerId = 0;
	const save = (next) => {
		saved.push(Array.from(next));
		return new Promise((resolve) =>
			requests.push((ok = true) => {
				if (ok) items = normalizeQuickMessages(next);
				resolve(ok);
			}),
		);
	};
	const refresh = () =>
		new Promise((resolve) =>
			refreshRequests.push((next) => {
				if (next) {
					items = next.items;
					currentDefaults = next.defaults;
					// 模拟 atom 发布快照后先渲染、await 再续跑，暴露清空草稿后误用旧磁盘内容的竞态。
					host.render(useQuickMessageEditor);
				}
				resolve(next);
			}),
		);
	const { useQuickMessageEditor } = loadTsCommonJs("src/renderer/src/hooks/useQuickMessageEditor.ts", {
		stubs: {
			react: host.react,
			"./useQuickMessages": {
				useQuickMessages: () => ({ items, defaults: currentDefaults, defaultsAvailable: true, loading: false, save, refresh, openFile: async () => {} }),
			},
			"../i18n": { t: (key) => key },
			"../utils/notice": { showNotice: (message) => notices.push(message) },
		},
		globals: {
			window: {
				setTimeout: (callback) => {
					timers.set(++timerId, callback);
					return timerId;
				},
				clearTimeout: (id) => timers.delete(id),
			},
		},
	});
	return {
		render: () => host.render(useQuickMessageEditor),
		async settle(ok = true) {
			while (requests.length) requests.shift()(ok);
			await tick();
		},
		async refreshWith(defaultItems, { available = true, diskItems = items } = {}) {
			assert.equal(refreshRequests.length, 1, "补充操作必须重读一次最新的内置清单");
			refreshRequests.shift()(defaultItems === null ? null : { items: diskItems, defaults: defaultItems, defaultsAvailable: available, filePath: "quick-messages.json", seeded: false });
			await tick();
		},
		fireTimers() {
			const pending = [...timers.values()];
			timers.clear();
			for (const callback of pending) callback();
		},
		unmount: host.unmount,
		saved,
		notices,
		get items() {
			return items;
		},
	};
}

test("添加空行在保存回包后仍可编辑，填写后失焦落盘", async () => {
	const h = editorHarness();
	h.render().addItem();
	await h.settle();
	assert.deepEqual(Array.from(h.render().rows), ["继续", ""]);
	h.render().setItem(1, "新消息");
	h.render().flushPending();
	await h.settle();
	assert.deepEqual(Array.from(h.items), ["继续", "新消息"]);
});

test("旧结构保存回包不能抹掉随后添加的空行", async () => {
	const h = editorHarness(["继续", "提交"]);
	h.render().removeItem(0);
	h.render().addItem();
	await h.settle();
	assert.deepEqual(Array.from(h.render().rows), ["提交", ""]);
});

test("连续添加受条数上限约束", async () => {
	const h = editorHarness(Array.from({ length: 29 }, (_, i) => String(i)));
	h.render().addItem();
	h.render().addItem();
	await h.settle();
	assert.equal(h.render().rows.length, 30);
	assert.equal(h.render().atLimit, true);
});

test("旧命令引用也使用最新草稿，连续输入/添加不依赖下一次渲染", async () => {
	const h = editorHarness(["A", "B"]);
	const editor = h.render();
	editor.setItem(0, "已编辑 A");
	editor.setItem(1, "已编辑 B");
	editor.addItem();
	editor.addItem();
	assert.deepEqual(Array.from(h.render().rows), ["已编辑 A", "已编辑 B", "", ""]);
	h.unmount();
	await h.settle();
	assert.deepEqual(Array.from(h.items), ["已编辑 A", "已编辑 B"]);
});

test("补充内置：等待最新清单期间的新输入也保留，只追加缺项并取消旧 debounce", async () => {
	const h = editorHarness(["个人 B", "个人 A"], ["旧内置"]);
	const editor = h.render();
	editor.setItem(0, "  编辑中 B  ");
	const merging = editor.mergeDefaults();
	assert.equal(h.render().merging, true);
	editor.setItem(1, "编辑中 A");
	editor.addItem();
	await h.refreshWith(["编辑中 A", "最新内置", "最新内置"], { diskItems: ["磁盘旧数据"] });
	assert.deepEqual(Array.from(h.render().rows), ["  编辑中 B  ", "编辑中 A", "", "最新内置"]);
	assert.deepEqual(h.saved, [["  编辑中 B  ", "编辑中 A", "", "最新内置"]]);
	h.fireTimers();
	await h.settle();
	await merging;
	assert.deepEqual(Array.from(h.render().rows), ["  编辑中 B  ", "编辑中 A", "", "最新内置"], "保存清洗不应挤掉正在编辑的空行或空白");
	assert.equal(h.saved.length, 1, "旧 debounce 不能在合并后写回旧列表");
	assert.equal(h.render().merging, false);
});

test("补充内置：读取耗时超过 debounce 后失败，期间输入仍落盘且保持草稿", async () => {
	const h = editorHarness(["个人"]);
	const editor = h.render();
	editor.setItem(0, "保留输入");
	const merging = editor.mergeDefaults();
	h.fireTimers();
	await h.settle();
	await h.refreshWith(null);
	await merging;
	assert.deepEqual(Array.from(h.items), ["保留输入"]);
	assert.deepEqual(Array.from(h.render().rows), ["保留输入"]);
});

test("补充内置：刷新回包触发渲染时也不能把当前个人清单换成旧磁盘内容", async () => {
	const h = editorHarness(["个人 B", "个人 A"]);
	const merging = h.render().mergeDefaults();
	await h.refreshWith(["内置"], { diskItems: ["磁盘旧值"] });
	assert.deepEqual(Array.from(h.render().rows), ["个人 B", "个人 A", "内置"]);
	await h.settle();
	await merging;
});

test("补充内置：读取期间完成的删除仍属于最新草稿，旧磁盘快照不能复活已删行", async () => {
	const h = editorHarness(["删除我", "个人 B", "个人 A"]);
	const editor = h.render();
	const merging = editor.mergeDefaults();
	editor.removeItem(0);
	await h.settle();
	assert.deepEqual(Array.from(h.render().rows), ["个人 B", "个人 A"]);
	await h.refreshWith(["内置"], { diskItems: ["删除我", "个人 B", "个人 A"] });
	assert.deepEqual(Array.from(h.render().rows), ["个人 B", "个人 A", "内置"]);
	await h.settle();
	await merging;
});

test("补充内置：失败和不可用不覆盖草稿，不丢待保存输入", async () => {
	for (const available of [null, false]) {
		const h = editorHarness(["个人"]);
		h.render().setItem(0, "未保存的编辑");
		const merging = h.render().mergeDefaults();
		await h.refreshWith(available === null ? null : [], { available: false });
		await merging;
		assert.deepEqual(Array.from(h.render().rows), ["未保存的编辑"]);
		assert.equal(h.saved.length, 0);
		h.fireTimers();
		await h.settle();
		assert.deepEqual(Array.from(h.items), ["未保存的编辑"]);
		assert.equal(h.render().merging, false);
	}
});

test("补充内置：重复点击只处理一次，清单已有全部项时不写盘", async () => {
	const h = editorHarness(["  REVIEW  ", "个人"]);
	const editor = h.render();
	const merging = editor.mergeDefaults();
	const duplicate = editor.mergeDefaults();
	await h.refreshWith(["review", "个人"]);
	await Promise.all([merging, duplicate]);
	assert.equal(h.saved.length, 0);
	assert.deepEqual(Array.from(h.render().rows), ["  REVIEW  ", "个人"]);
});

test("补充内置：满额不写盘、不挤掉个人条目", async () => {
	const initial = Array.from({ length: 30 }, (_, i) => `个人 ${i}`);
	const h = editorHarness(initial);
	const merging = h.render().mergeDefaults();
	await h.refreshWith(["内置"]);
	await merging;
	assert.equal(h.saved.length, 0);
	assert.deepEqual(Array.from(h.render().rows), initial);
});

test("补充内置：保存失败仍保留合并草稿，迟到回包也不能覆盖后续输入", async () => {
	for (const ok of [false, true]) {
		const h = editorHarness(["个人"]);
		const merging = h.render().mergeDefaults();
		await h.refreshWith(["内置"]);
		h.render().setItem(0, "后续编辑");
		await h.settle(ok);
		await merging;
		assert.deepEqual(Array.from(h.render().rows), ["后续编辑", "内置"]);
		if (!ok) assert.equal(h.notices.length, 0, "保存失败不能显示成功提示");
	}
});

test("补充内置：卸载后的读盘结果不得再发起保存", async () => {
	const h = editorHarness(["个人"]);
	const merging = h.render().mergeDefaults();
	h.unmount();
	await h.refreshWith(["内置"]);
	await merging;
	assert.equal(h.saved.length, 0);
});

test("重新读取：保存或读盘失败不清空编辑草稿", async () => {
	for (const saveOk of [false, true]) {
		const h = editorHarness(["个人"]);
		h.render().setItem(0, "未保存编辑");
		const reloading = h.render().reload();
		await h.settle(saveOk);
		if (saveOk) await h.refreshWith(null);
		await reloading;
		assert.deepEqual(Array.from(h.render().rows), ["未保存编辑"]);
	}
});

test("拖动排序与上下移共用最新草稿，保留空行与原文", async () => {
	const h = editorHarness(["A", "B", "C"]);
	const editor = h.render();
	editor.setItem(0, "  最新 A  ");
	editor.addItem();
	editor.reorderItems(0, 3);
	assert.deepEqual(Array.from(h.render().rows), ["B", "C", "", "  最新 A  "]);
	await h.settle();
	assert.deepEqual(Array.from(h.render().rows), ["B", "C", "", "  最新 A  "]);
	editor.moveItem(3, -1);
	await h.settle();
	assert.deepEqual(Array.from(h.render().rows), ["B", "C", "  最新 A  ", ""]);
});

test("拖动排序：无效下标/越界/原地放下都不保存", () => {
	const h = editorHarness(["A", "B", "C"]);
	const editor = h.render();
	for (const invalid of [-1, 3, 0.5, Number.NaN, Infinity]) {
		editor.reorderItems(invalid, 0);
		editor.reorderItems(0, invalid);
	}
	editor.reorderItems(0, 0);
	editor.moveItem(-1, 1);
	editor.moveItem(3, -1);
	assert.deepEqual(Array.from(h.render().rows), ["A", "B", "C"]);
	assert.equal(h.saved.length, 0);
});
