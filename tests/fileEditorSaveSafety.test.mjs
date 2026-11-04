import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const cmView = require("@codemirror/view");
const { Transaction } = require("@codemirror/state");
const { undo, undoDepth } = require("@codemirror/commands");
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/** 执行真实编辑器的 effects/listener，以真实 CM state 处理文本，不依赖浏览器布局。 */
function editorHarness(initialProps) {
	const host = quickMessageHookHost();
	const views = [];
	class EditorView {
		static updateListener = cmView.EditorView.updateListener;
		static scrollIntoView = cmView.EditorView.scrollIntoView;
		constructor({ state }) {
			this.state = state;
			this.dom = { addEventListener() {}, removeEventListener() {} };
			views.push(this);
		}
		dispatch(spec) {
			const transaction = spec instanceof Transaction ? spec : this.state.update(spec);
			this.state = transaction.state;
			for (const listener of this.state.facet(EditorView.updateListener)) {
				listener({ state: this.state, transactions: [transaction], docChanged: transaction.docChanged });
			}
		}
		destroy() {}
	}
	const { CodeMirrorEditor } = loadTsCommonJs("src/renderer/src/components/app/CodeMirrorEditor.tsx", {
		stubs: {
			react: { ...host.react, memo: (component) => component },
			"@codemirror/view": { ...cmView, EditorView },
			"../../utils/codemirrorSetup": { baseEditorExtensions: () => [], resolveEditorLanguage: () => null, foldMarkerDOM: () => null },
			"../../utils/editorFindShortcut": { isEditorFindShortcut: () => false },
			"../../utils/fileSearchTrigger": { isEditableTarget: () => false },
			"../../i18n": { t: (key) => key },
			"../ui-shadcn/dropdown-menu": {},
		},
	});
	let props = initialProps;
	const render = (patch = {}) => {
		props = { ...props, ...patch };
		return host.render(() => {
			const tree = CodeMirrorEditor(props);
			tree.props.ref.current = {};
			return tree;
		});
	};
	render();
	return {
		render,
		get view() {
			return views.at(-1);
		},
		unmount: host.unmount,
	};
}

function findElement(tree, predicate) {
	if (!tree || typeof tree !== "object") return undefined;
	if (predicate(tree)) return tree;
	for (const child of [tree.props?.children].flat(Infinity)) {
		const found = findElement(child, predicate);
		if (found) return found;
	}
	return undefined;
}

/** 执行 FileDiffViewer 的真实 load/change/save 与清理，替换的只有 UI 叶子和计时器。 */
function viewerHarness(initialProps = {}) {
	const host = quickMessageHookHost();
	const timers = new Map();
	const listeners = new Map();
	const dirtyChanges = [];
	const writes = [];
	let timerId = 0;
	let lazyId = 0;
	let preflightTasks = new Map();
	const setPreflight = (update) => {
		preflightTasks = update(preflightTasks);
	};
	const { FileDiffViewer } = loadTsCommonJs("src/renderer/src/components/app/FileDiffViewer.tsx", {
		globals: {
			window: {
				addEventListener: (type, callback) => listeners.set(type, callback),
				removeEventListener: (type, callback) => {
					if (listeners.get(type) === callback) listeners.delete(type);
				},
			},
			setTimeout: (callback) => {
				const id = ++timerId;
				timers.set(id, callback);
				return id;
			},
			clearTimeout: (id) => timers.delete(id),
		},
		stubs: {
			react: { ...host.react, lazy: () => (++lazyId === 1 ? "CodeMirrorEditor" : "CodeDiffView"), Suspense: "suspense" },
			jotai: { useSetAtom: () => setPreflight },
			"../../atoms/update-install-preflight": { updateInstallPreflightTasksAtom: {} },
			"../ui-shadcn/button": { Button: "button" },
			"../ui-shadcn/ConfirmDialog": { ConfirmDialog: "confirm" },
			"../session/MarkdownStream": { MarkdownStream: "markdown" },
			"../session/MarkdownLinkCore": { defaultUrlTransform: (value) => value },
			"../session/markdownSanitize": { UNTRUSTED_MARKDOWN_REHYPE_PLUGINS: [] },
			"rehype-katex": {},
			"../../utils/markdownPlugins": { remarkGfmNoSingleTilde: {} },
			"../session/composer/chips": { formatFilePathRef: (value) => value },
			"../../utils/notice": { showNotice() {} },
		},
	});
	let props = {
		filePath: "App.vue",
		activeTabId: "tab-1",
		mode: "view",
		theme: "dark",
		readContent: async () => "<template>one</template>\r\n<template>two</template>\r\n",
		saveContent: async (...args) => {
			writes.push(args);
		},
		onClose() {},
		onDirtyChange: (dirty) => dirtyChanges.push(dirty),
		...initialProps,
	};
	let tree;
	const render = (patch = {}) => {
		props = { ...props, ...patch };
		tree = host.render(() => FileDiffViewer(props));
		return tree;
	};
	return {
		render,
		writes,
		timers,
		listeners,
		dirtyChanges,
		preflight: () => [...preflightTasks.values()][0](),
		editor: () => findElement(tree, (element) => element.type === "CodeMirrorEditor"),
		alert: () => findElement(tree, (element) => element.props?.role === "alert"),
		async settle() {
			await setImmediate();
			render();
		},
		async advance() {
			const pending = [...timers.values()];
			timers.clear();
			for (const callback of pending) callback();
			await setImmediate();
			render();
		},
		unmount: host.unmount,
	};
}

test("外部 value 同步不是用户编辑：CRLF 载入和重读不触发 onChange", () => {
	const changes = [];
	const editor = editorHarness({ value: "first\r\nsecond\r\n", onChange: (value) => changes.push(value) });
	try {
		assert.deepEqual(changes, []);
		editor.render({ value: "reloaded\r\nvalue\r\n" });
		assert.deepEqual(changes, []);
		editor.view.dispatch({ changes: { from: 0, insert: "edited " } });
		assert.deepEqual(changes, ["edited reloaded\nvalue\n"]);
	} finally {
		editor.unmount();
	}
});

test("只打开 CRLF 文件并等待防抖：零保存；真实编辑保留 CRLF 并只保存一次", async () => {
	const viewer = viewerHarness();
	let editor;
	try {
		viewer.render();
		await viewer.settle();
		editor = editorHarness(viewer.editor().props);
		assert.equal(editor.view.state.sliceDoc(), viewer.editor().props.value);
		await viewer.advance();
		assert.equal(viewer.writes.length, 0);
		assert.deepEqual(viewer.dirtyChanges, []);
		editor.view.dispatch({ changes: { from: 0, insert: "edited " } });
		viewer.render();
		await viewer.advance();
		assert.equal(viewer.writes.length, 1);
		assert.equal(viewer.writes[0][1], "edited <template>one</template>\r\n<template>two</template>\r\n");
		assert.deepEqual(viewer.dirtyChanges, [true, false]);
	} finally {
		editor?.unmount();
		viewer.unmount();
	}
});

test("保存进行中再次编辑：串行保存最新内容，安装前置任务等待最新内容落盘", async () => {
	const pending = [];
	const viewer = viewerHarness({
		readContent: async () => "original",
		saveContent: (path, content) => new Promise((resolve) => pending.push({ path, content, resolve })),
	});
	try {
		viewer.render();
		await viewer.settle();
		viewer.editor().props.onChange("first edit");
		viewer.render();
		await viewer.advance();
		assert.equal(pending.length, 1);
		viewer.editor().props.onChange("latest edit");
		viewer.render();
		let preflightDone = false;
		const preflight = viewer.preflight().then((result) => {
			preflightDone = true;
			return result;
		});
		await viewer.settle();
		assert.equal(pending.length, 1, "前一次保存结束前不得并发写入");
		assert.equal(preflightDone, false);
		pending[0].resolve();
		await viewer.settle();
		assert.equal(pending.length, 2);
		assert.equal(pending[1].content, "latest edit");
		assert.equal(preflightDone, false, "不能在旧内容落盘后就允许安装退出");
		assert.deepEqual(viewer.dirtyChanges, [true]);
		pending[1].resolve();
		assert.equal(await preflight, true);
		await viewer.settle();
		assert.deepEqual(viewer.dirtyChanges, [true, false]);
		await viewer.advance();
		assert.equal(pending.length, 2);
	} finally {
		for (const request of pending) request.resolve();
		viewer.unmount();
	}
});

test("保存期间撤回到原内容：仍需等待旧写入并把原内容真正保存回来", async () => {
	const pending = [];
	const viewer = viewerHarness({
		readContent: async () => "original",
		saveContent: (_path, content) => new Promise((resolve) => pending.push({ content, resolve })),
	});
	try {
		viewer.render();
		await viewer.settle();
		viewer.editor().props.onChange("temporary edit");
		viewer.render();
		await viewer.advance();
		viewer.editor().props.onChange("original");
		viewer.render();
		let done = false;
		const saved = viewer.preflight().then((result) => {
			done = true;
			return result;
		});
		await viewer.settle();
		assert.equal(done, false, "不能仅因内容等于旧基准就跳过正在进行的写入");
		pending[0].resolve();
		await viewer.settle();
		assert.equal(pending[1].content, "original");
		pending[1].resolve();
		assert.equal(await saved, true);
		await viewer.settle();
		assert.deepEqual(viewer.dirtyChanges, [true, false]);
	} finally {
		for (const request of pending) request.resolve();
		viewer.unmount();
	}
});

test("CRLF 编辑成单行后自动保存：保留编辑器实例和撤销历史", async () => {
	const viewer = viewerHarness({ readContent: async () => "first\r\nsecond\r\n" });
	let editor;
	try {
		viewer.render();
		await viewer.settle();
		editor = editorHarness(viewer.editor().props);
		const initialView = editor.view;
		editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "single line" } });
		viewer.render();
		editor.render(viewer.editor().props);
		assert.equal(undoDepth(editor.view.state), 1);
		await viewer.advance();
		editor.render(viewer.editor().props);
		assert.equal(editor.view, initialView, "保存不得因换行推断变化而销毁编辑器");
		assert.equal(undoDepth(editor.view.state), 1);
		assert.equal(undo({ state: editor.view.state, dispatch: (transaction) => editor.view.dispatch(transaction) }), true);
		assert.equal(editor.view.state.sliceDoc(), "first\r\nsecond\r\n");
	} finally {
		editor?.unmount();
		viewer.unmount();
	}
});

test("重读失败取消旧防抖，Ctrl+S/过期timer不得保存旧缓冲，脏状态保留", async () => {
	const viewer = viewerHarness();
	try {
		viewer.render();
		await viewer.settle();
		viewer.editor().props.onChange("unsaved edit");
		viewer.render();
		const staleTimer = [...viewer.timers.values()][0];
		viewer.render({
			maxFileSizeMB: 1,
			readContent: async () => {
				throw new Error("FILE_ACCESS_DENIED:EACCES");
			},
		});
		assert.equal(viewer.timers.size, 0);
		await viewer.settle();
		assert.equal(viewer.editor(), undefined);
		staleTimer();
		viewer.listeners.get("keydown")({ key: "s", ctrlKey: true, preventDefault() {} });
		await viewer.advance();
		assert.equal(viewer.writes.length, 0);
		assert.deepEqual(viewer.dirtyChanges, [true]);
	} finally {
		viewer.unmount();
	}
});

test("首次加载失败不挂编辑器，Ctrl+S 也不会写盘", async () => {
	const viewer = viewerHarness({
		readContent: async () => {
			throw new Error("FILE_NOT_TEXT:128");
		},
	});
	try {
		viewer.render();
		await viewer.settle();
		assert.equal(viewer.editor(), undefined);
		viewer.listeners.get("keydown")({ key: "s", ctrlKey: true, preventDefault() {} });
		await viewer.advance();
		assert.equal(viewer.writes.length, 0);
		assert.deepEqual(viewer.dirtyChanges, []);
	} finally {
		viewer.unmount();
	}
});

test("保存被拒绝后展示可读错误并保留编辑内容和dirty，显式重试可成功", async () => {
	let attempts = 0;
	const viewer = viewerHarness({
		saveContent: async () => {
			if (++attempts === 1) throw new Error("FILE_ACCESS_DENIED:EPERM");
		},
	});
	try {
		viewer.render();
		await viewer.settle();
		viewer.editor().props.onChange("keep unsaved content");
		viewer.render();
		await viewer.advance();
		assert.equal(viewer.editor().props.value, "keep unsaved content");
		assert.deepEqual(viewer.dirtyChanges, [true]);
		assert.ok(viewer.alert());
		assert.equal(JSON.stringify(viewer.alert()).includes("FILE_ACCESS_DENIED"), false);
		viewer.listeners.get("keydown")({ key: "s", ctrlKey: true, preventDefault() {} });
		await viewer.settle();
		assert.equal(attempts, 2);
		assert.equal(viewer.alert(), undefined);
		assert.deepEqual(viewer.dirtyChanges, [true, false]);
	} finally {
		viewer.unmount();
	}
});
