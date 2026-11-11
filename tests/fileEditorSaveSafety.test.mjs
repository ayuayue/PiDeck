import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const cmView = require("@codemirror/view");
const { Transaction } = require("@codemirror/state");
const { undo, undoDepth } = require("@codemirror/commands");
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const CRLF_DEFAULT = "<template>one</template>\r\n<template>two</template>\r\n";

/** 与实现同一算法（`sha256:` + 内容哈希）；同步算完后在微任务里 resolve，测试不依赖 WebCrypto 的线程池调度。 */
const sha256Revision = (text) => "sha256:" + createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const digestStub = { subtle: { digest: async (_algorithm, bytes) => createHash("sha256").update(Buffer.from(bytes)).digest() } };

/**
 * 渲染层入口在模块顶层就要问宿主：desktopApi 读 `window.piDesktop` / `location.protocol`，
 * browserApi 再读 `location.search` 与 `localStorage`。这里只验证编辑器保存语义，给一个
 * 「非 Web、非 Electron」的最小页面即可（protocol 不是 http、userAgent 不含 `Electron/`，
 * 于是 isLanWeb 与 isElectronRuntime 都为 false，不会掉进 missingElectronPreload）。
 */
const HOST_PAGE = {
	location: { protocol: "file:", search: "" },
	localStorage: { getItem: () => null, setItem() {} },
};
const HOST_NAVIGATOR = { userAgent: "pideck-test" };

/** 执行真实编辑器的 effects/listener，以真实 CM state 处理文本，不依赖浏览器布局。 */
function editorHarness(initialProps) {
	const host = quickMessageHookHost();
	const views = [];
	class EditorView {
		static updateListener = cmView.EditorView.updateListener;
		static scrollIntoView = cmView.EditorView.scrollIntoView;
		// 远端起默认开启 wordWrap：Compartment 里会读这个静态扩展，缺了会让 EditorState.create 直接崩。
		static lineWrapping = cmView.EditorView.lineWrapping;
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
		globals: {
			window: { ...HOST_PAGE, addEventListener() {}, removeEventListener() {} },
			navigator: HOST_NAVIGATOR,
		},
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
				...HOST_PAGE,
			},
			navigator: HOST_NAVIGATOR,
			setTimeout: (callback) => {
				const id = ++timerId;
				timers.set(id, callback);
				return id;
			},
			clearTimeout: (id) => timers.delete(id),
			crypto: digestStub,
		},
		stubs: {
			react: { ...host.react, lazy: () => "L" + ++lazyId, Suspense: "suspense" },
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
		// 用非 HTML/SVG 扩展名：上游新增的内容嗅探会把 .vue（以 <template> 开头）当 HTML 预览，
		// 此时根本不渲染编辑器，与这些用例要验的「编辑器自动保存」无关。
		filePath: "App.ts",
		activeTabId: "tab-1",
		mode: "view",
		theme: "dark",
		readContent: async () => CRLF_DEFAULT,
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
		// lazy 桩给每个懒加载组件唯一名字（L1/L2/…）；编辑器是其中唯一带 onChange 的那个。
		editor: () => findElement(tree, (element) => typeof element.type === "string" && /^L\d+$/.test(element.type) && element.props?.onChange !== undefined),
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
		// 乐观锁：首次保存必须带上「载入时读到的那份内容」的 sha256 基准。
		assert.equal(viewer.writes[0][3], sha256Revision(CRLF_DEFAULT));
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
		saveContent: (path, content, scope, expectedRevision) => new Promise((resolve) => pending.push({ path, content, scope, expectedRevision, resolve })),
	});
	try {
		viewer.render();
		await viewer.settle();
		viewer.editor().props.onChange("first edit");
		viewer.render();
		await viewer.advance();
		assert.equal(pending.length, 1);
		assert.equal(pending[0].expectedRevision, sha256Revision("original"));
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
		// 基准随成功保存推进：第二次带的是第一次落盘内容的指纹，而不是最初的载入内容。
		assert.equal(pending[1].expectedRevision, sha256Revision("first edit"));
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
		saveContent: (_path, content, _scope, expectedRevision) => new Promise((resolve) => pending.push({ content, expectedRevision, resolve })),
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
		assert.equal(pending[1].expectedRevision, sha256Revision("temporary edit"), "撤回内容仍以最近一次成功落盘的指纹作基准");
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
	const revisions = [];
	const viewer = viewerHarness({
		saveContent: async (_path, _content, _scope, expectedRevision) => {
			revisions.push(expectedRevision);
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
		// 失败的保存不推进基准指纹：重试仍按最初载入内容做乐观锁。
		assert.deepEqual(revisions, [sha256Revision(CRLF_DEFAULT), sha256Revision(CRLF_DEFAULT)]);
		assert.equal(viewer.alert(), undefined);
		assert.deepEqual(viewer.dirtyChanges, [true, false]);
	} finally {
		viewer.unmount();
	}
});
