import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/** 渲染真实弹框为轻量节点树，验证拖放事件边界，不借助实现源码正则。 */
function dialogHarness() {
	const host = quickMessageHookHost();
	const moveCalls = [];
	const mergeCalls = [];
	let rows = ["A", "B", "C"];
	const editor = {
		rows,
		loading: false,
		atLimit: false,
		defaultsAvailable: true,
		merging: false,
		reorderItems: (...args) => moveCalls.push(args),
		moveItem: (...args) => moveCalls.push(args),
		mergeDefaults: async () => mergeCalls.push(true),
	};
	const jsx = (type, props, key) => ({ type, props, key });
	const { QuickMessagesDialog } = loadTsCommonJs("src/renderer/src/components/app/settings/QuickMessagesDialog.tsx", {
		stubs: {
			react: host.react,
			"react/jsx-runtime": { jsx, jsxs: jsx },
			"lucide-react": {},
			"../../../hooks/useQuickMessageEditor": { useQuickMessageEditor: () => ({ ...editor, rows }) },
			"../../../i18n": { t: (key) => key },
			"../../ui-shadcn/button": { Button: "Button" },
			"../../ui-shadcn/input": { Input: "Input" },
			"../../ui-shadcn/dialog": Object.fromEntries(["Dialog", "DialogClose", "DialogContent", "DialogDescription", "DialogFooter", "DialogHeader", "DialogTitle"].map((name) => [name, name])),
		},
	});
	return {
		render(open = true) {
			const tree = host.render(() => QuickMessagesDialog({ open, onOpenChange: () => {} }));
			const nodes = [];
			function visit(node) {
				if (Array.isArray(node)) {
					for (const child of node) visit(child);
					return;
				}
				if (!node || typeof node !== "object") return;
				nodes.push(node);
				visit(node.props?.children);
			}
			visit(tree);
			return {
				tree,
				content: nodes.find((node) => node.type === "DialogContent"),
				handles: nodes.filter((node) => node.props?.draggable),
				dropRows: nodes.filter((node) => node.props?.onDrop && node.type === "div"),
				buttons: nodes.filter((node) => node.type === "Button"),
			};
		},
		setRows: (next) => {
			rows = next;
		},
		unmount: host.unmount,
		moveCalls,
		mergeCalls,
	};
}

/** 原生 drag 的 DataTransfer 在 dragover 阶段不可读；排序来源必须来自本地把柄 ref。 */
function dragEvent() {
	const data = new Map();
	return {
		dataTransfer: {
			types: [],
			effectAllowed: "all",
			dropEffect: "none",
			setData: (type, value) => data.set(type, value),
			getData: () => {
				throw new Error("不应信任/读取外部拖放载荷");
			},
		},
		defaultPrevented: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
		stopPropagation() {},
	};
}

test("管理弹框：宽度覆盖 sm 默认值，补充按钮与手柄方向键保持可用", async () => {
	const h = dialogHarness();
	const view = h.render();
	assert.ok(view.content.props.className.includes("w-[min(960px,calc(100vw-48px))]"));
	assert.ok(view.content.props.className.includes("max-w-none"));
	assert.ok(view.content.props.className.includes("sm:max-w-none"));
	const merge = view.buttons.find((button) => Array.isArray(button.props.children) && button.props.children.includes("settings.quickMessagesMergeDefaults"));
	assert.ok(merge, "必须能显式补充内置而不是恢复覆盖");
	await merge.props.onClick();
	assert.equal(h.mergeCalls.length, 1);
	// 上移/下移按钮已删（拖拽 + 手柄方向键单轨）：不再渲染移动按钮，删除按钮仍在
	assert.equal(view.buttons.filter((button) => ["settings.quickMessagesMoveUp", "settings.quickMessagesMoveDown"].includes(button.props["aria-label"])).length, 0);
	assert.equal(view.buttons.filter((button) => button.props["aria-label"] === "settings.quickMessagesRemove").length, 3);
	// 键盘微调：聚焦手柄后 ↑/↓ 走 moveItem（上移/下移按钮的无障碍替代）
	const keyEvent = (key) => ({
		key,
		defaultPrevented: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
		stopPropagation() {},
	});
	assert.equal(typeof view.handles[0].props.onKeyDown, "function", "手柄必须接键盘事件（上移/下移按钮的无障碍替代）");
	view.handles[0].props.onKeyDown(keyEvent("ArrowUp"));
	view.handles[2].props.onKeyDown(keyEvent("ArrowDown"));
	assert.deepEqual(h.moveCalls, [
		[0, -1],
		[2, 1],
	]);
});

test("拖放：外部文本/文件不触发排序，也不能把载荷下标当内部来源", () => {
	const h = dialogHarness();
	const view = h.render();
	assert.equal(view.handles.length, 3);
	assert.equal(view.dropRows.length, 3);
	const event = dragEvent();
	view.dropRows[1].props.onDragOver(event);
	view.dropRows[1].props.onDrop(event);
	assert.equal(h.moveCalls.length, 0);
	assert.equal(event.defaultPrevented, true, "外部文本/文件也不能落入输入框或冒泡给宿主");
});

test("拖放：内部把柄发起，目标行接受 move；drop 后状态清空", () => {
	const h = dialogHarness();
	const view = h.render();
	const event = dragEvent();
	view.handles[0].props.onDragStart(event);
	assert.equal(event.dataTransfer.effectAllowed, "move");
	view.dropRows[2].props.onDragOver(event);
	assert.equal(event.defaultPrevented, true);
	assert.equal(event.dataTransfer.dropEffect, "move");
	view.dropRows[2].props.onDrop(event);
	assert.deepEqual(h.moveCalls, [[0, 2]]);
	view.dropRows[1].props.onDrop(event);
	assert.equal(h.moveCalls.length, 1, "放下后不能复用上次来源");
});

test("拖放：dragend、关闭、卸载都取消来源；旧事件不应继续排序", () => {
	for (const cancel of ["dragend", "close", "unmount"]) {
		const h = dialogHarness();
		const view = h.render();
		const event = dragEvent();
		view.handles[0].props.onDragStart(event);
		if (cancel === "dragend") view.handles[0].props.onDragEnd(event);
		if (cancel === "close") h.render(false);
		if (cancel === "unmount") h.unmount();
		view.dropRows[2].props.onDrop(event);
		assert.equal(h.moveCalls.length, 0, cancel);
	}
});

test("拖放：相同长度的列表替换也使旧来源失效", () => {
	const h = dialogHarness();
	const view = h.render();
	const event = dragEvent();
	view.handles[1].props.onDragStart(event);
	h.setRows(["X", "Y", "Z"]);
	h.render();
	view.dropRows[0].props.onDrop(event);
	assert.equal(h.moveCalls.length, 0);
});

test("拖放：期间列表变化取消旧下标，即使 drop 回调来自旧渲染也不能移动另一条", () => {
	const h = dialogHarness();
	const view = h.render();
	const event = dragEvent();
	view.handles[1].props.onDragStart(event);
	h.setRows(["B", "C"]);
	h.render();
	view.dropRows[0].props.onDrop(event);
	assert.equal(h.moveCalls.length, 0);
});
