import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/** IPC 完成顺序由测试裁决，不使用真实 PTY、DOM 或计时器。 */
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function tab(id) {
	return { id, agentId: "", ownerKey: "cwd:/project", title: id, cwd: "/project", shell: "bash", createdAt: 0 };
}

/** 仅替换外部能力，直接通过真实 TerminalDock 的公开按钮/事件验证状态流转。 */
function dockHarness(initialTabs = [tab("A"), tab("B")], settings = {}) {
	const host = quickMessageHookHost();
	const timers = new Map();
	const frames = new Map();
	const elements = new Map();
	const notices = [];
	const terminals = [];
	const copied = [];
	const inputs = [];
	const appended = [];
	const serialized = [];
	const dataListeners = new Set();
	const exitListeners = new Set();
	let nextId = 0;
	let closeCount = 0;
	let clipboardOk = true;
	let tree;
	let create = async () => tab("C");
	let close = async () => {};
	let ensure = async () => initialTabs;
	const react = {
		...host.react,
		useMemo(factory, deps) {
			const slot = host.react.useRef();
			if (!slot.current || deps.some((value, index) => !Object.is(value, slot.current.deps[index]))) slot.current = { deps, value: factory() };
			return slot.current.value;
		},
	};
	const jsx = (type, props) => ({ type, props });
	class Addon {
		fit() {}
		dispose() {}
		onContextLoss() {}
		serialize() {
			const snapshot = "serialized terminal";
			serialized.push(snapshot);
			return snapshot;
		}
	}
	class FakeTerminal {
		constructor(options) {
			this.options = options;
			this.cols = 80;
			this.rows = 24;
			this.unicode = {};
			this.selectionListeners = new Set();
			terminals.push(this);
		}
		loadAddon() {}
		open() {}
		write(data, callback) {
			this.output = (this.output ?? "") + data;
			callback?.();
		}
		scrollToBottom() {}
		focus() {}
		onData() {
			return { dispose() {} };
		}
		getSelection() {
			return "selected text";
		}
		onSelectionChange(listener) {
			this.selectionListeners.add(listener);
			return { dispose: () => this.selectionListeners.delete(listener) };
		}
		dispose() {
			this.disposed = true;
		}
	}
	const terminal = {
		ensure: (...args) => ensure(...args),
		list: async () => initialTabs,
		create: (...args) => create(...args),
		close: (...args) => close(...args),
		input: async (...args) => {
			inputs.push(args);
		},
		resize: async () => {},
		shells: async () => [],
		onData: (listener) => {
			dataListeners.add(listener);
			return () => dataListeners.delete(listener);
		},
		onExit: (listener) => {
			exitListeners.add(listener);
			return () => exitListeners.delete(listener);
		},
	};
	const load = createTsSandbox({
		stubs: {
			react,
			"react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
			"@xterm/xterm": { Terminal: FakeTerminal },
			"@xterm/addon-fit": { FitAddon: Addon },
			"@xterm/addon-search": { SearchAddon: Addon },
			"@xterm/addon-serialize": { SerializeAddon: Addon },
			"@xterm/addon-unicode11": { Unicode11Addon: Addon },
			"@xterm/addon-web-links": { WebLinksAddon: Addon },
			"@xterm/addon-webgl": { WebglAddon: Addon },
			"@xterm/xterm/css/xterm.css": {},
			"../../utils/openExternal": { openInSystemBrowser() {} },
			"../../utils/notice": { showNotice: (...args) => notices.push(args) },
			"../utils/notice": { showNotice: (...args) => notices.push(args) },
			"../../utils/clipboard": {
				writeClipboard: async (text) => {
					copied.push(text);
					return clipboardOk;
				},
			},
			"lucide-react": { ChevronDown: "icon", ChevronUp: "icon", MoreHorizontal: "icon", Plus: "icon", X: "icon" },
			"../ui-shadcn/ConfirmDialog": { ConfirmDialog: "confirm" },
			"../ui-shadcn/button": { Button: "button" },
			"../bridge/BridgeSlot": { BridgeGuiSlot: "bridge", useBridgeSessionId: () => undefined },
			"../ui-shadcn/popover": { Popover: "popover", PopoverContent: "popover-content", PopoverTrigger: "popover-trigger" },
			"../../i18n": { t: (key) => key },
			"../i18n": { t: (key) => key },
			"../../terminalDockState": {
				appendTerminalReplayBuffer(current, data) {
					appended.push(data);
					return (current + data).slice(-200_000);
				},
			},
			"../../terminalThemes": {
				TERMINAL_THEME_DEFS: [],
				resolveTerminalTheme: () => ({ css: {}, xterm: { background: "#ffffff" }, dataTheme: "light" }),
			},
		},
		globals: {
			Error,
			document: { documentElement: { dataset: {} } },
			getComputedStyle: () => ({ getPropertyValue: () => "" }),
			MutationObserver: class {
				observe() {}
				disconnect() {}
			},
			ResizeObserver: class {
				observe() {}
				disconnect() {}
			},
			window: {
				setTimeout(callback) {
					const id = ++nextId;
					timers.set(id, callback);
					return id;
				},
				clearTimeout(id) {
					timers.delete(id);
				},
				requestAnimationFrame(callback) {
					const id = ++nextId;
					frames.set(id, callback);
					return id;
				},
				cancelAnimationFrame(id) {
					frames.delete(id);
				},
			},
			requestAnimationFrame(callback) {
				const id = ++nextId;
				frames.set(id, callback);
				return id;
			},
			cancelAnimationFrame(id) {
				frames.delete(id);
			},
		},
	});
	const { TerminalDock } = load("src/renderer/src/components/terminal/TerminalDock.tsx");
	let props = {
		target: { kind: "project", projectId: "project", cwd: "/project" },
		open: true,
		closing: false,
		collapsed: false,
		height: 220,
		terminal,
		terminalSettings: { themeId: "inherit", fontSize: null, fontFamily: "", scrollback: 5000, cursorStyle: "block", cursorBlink: false, copyOnSelect: false, paddingY: 0, confirmClose: "never", startupCommand: "", ...settings },
		onThemeChange() {},
		onCollapsedChange() {},
		onHeightChange() {},
		onClose() {
			closeCount++;
		},
	};
	function visit(node, callback) {
		if (Array.isArray(node)) {
			node.forEach((child) => visit(child, callback));
			return;
		}
		if (!node || typeof node !== "object" || !node.props) return;
		callback(node);
		visit(node.props.children, callback);
	}
	function render(patch = {}) {
		props = { ...props, ...patch };
		return host.render(() => {
			tree = TerminalDock(props);
			visit(tree, (node) => {
				if (typeof node.type === "string" && node.props.ref && typeof node.props.ref === "object") {
					if (!elements.has(node.props.ref)) elements.set(node.props.ref, { style: { setProperty() {}, removeProperty() {} } });
					node.props.ref.current = elements.get(node.props.ref);
				}
			});
			return tree;
		});
	}
	function find(predicate) {
		let found;
		visit(tree, (node) => {
			if (!found && predicate(node)) found = node;
		});
		assert.ok(found, "expected terminal control");
		return found;
	}
	async function settle() {
		for (let i = 0; i < 8; i++) await Promise.resolve();
		render();
	}
	return {
		render,
		settle,
		notices,
		terminals,
		copied,
		inputs,
		appended,
		serialized,
		emitData(tabId, data) {
			for (const listener of dataListeners) listener({ tabId, data });
		},
		emitExit(tabId, exitCode) {
			for (const listener of exitListeners) listener({ tabId, exitCode });
		},
		selectTab(id) {
			find((node) => node.type === "button" && node.props.className?.includes("terminal-tab-label") && node.props.children[0] === id).props.onClick();
		},
		get closeCount() {
			return closeCount;
		},
		isExited(id) {
			return find((node) => node.type === "button" && node.props.className?.includes("terminal-tab-label") && node.props.children[0] === id).props.children[1] !== "";
		},
		get ids() {
			const ids = [];
			visit(tree, (node) => {
				if (node.type === "button" && node.props.className?.includes("terminal-tab-label")) ids.push(node.props.children[0]);
			});
			return ids;
		},
		setClose(fn) {
			close = fn;
		},
		setCreate(fn) {
			create = fn;
		},
		setEnsure(fn) {
			ensure = fn;
		},
		confirmCloseAll() {
			find((node) => node.type === "confirm" && node.props.title === "terminal.closeAllConfirm").props.onConfirm();
		},
		setClipboardOk(ok) {
			clipboardOk = ok;
		},
		async ready() {
			render();
			for (const [id, callback] of [...timers]) {
				timers.delete(id);
				callback();
			}
			render();
			await settle();
		},
		closeTab(id) {
			const container = find((node) => node.props.className?.startsWith("terminal-tab ") && node.props.children?.[0]?.props.children?.[0] === id);
			container.props.children[1].props.onClick({ stopPropagation() {} });
		},
		addTab() {
			find((node) => node.props.title === "terminal.new").props.onClick();
		},
		closeAll() {
			find((node) => node.props.title === "terminal.closeAll").props.onClick();
		},
		contextMenu() {
			return find((node) => node.props.className === "terminal-pane-shell").props.onContextMenu({ preventDefault() {}, stopPropagation() {} });
		},
		unmount() {
			host.unmount();
		},
	};
}

test("unrelated terminal events never enter this dock replay cache", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	h.emitData("foreign", "foreign output");
	h.emitExit("foreign", 1);
	assert.deepEqual(h.appended, []);
	h.emitData("A", "own output");
	assert.deepEqual(h.appended, ["own output"]);
	assert.ok(h.terminals.at(-1).output.endsWith("own output"));
	h.unmount();
});

test("closed active tab is not serialized back into its deleted replay cache", async () => {
	const h = dockHarness();
	await h.ready();
	h.closeTab("A");
	await h.settle();
	assert.deepEqual(h.ids, ["B"]);
	assert.deepEqual(h.serialized, []);
	h.emitData("A", "late output");
	h.emitExit("A", 0);
	assert.deepEqual(h.appended, []);
	h.unmount();
});

test("valid tab switching and collapse still serialize and replay the local terminal", async () => {
	const h = dockHarness();
	await h.ready();
	h.selectTab("B");
	await h.settle();
	assert.equal(h.serialized.length, 1);
	h.selectTab("A");
	await h.settle();
	assert.equal(h.terminals.at(-1).output, "serialized terminal");
	h.render({ collapsed: true });
	h.render({ collapsed: false });
	assert.equal(h.terminals.at(-1).output, "serialized terminal");
	h.unmount();
});

test("early terminal exit is shown after create settles and never gets a startup command", async () => {
	const h = dockHarness([tab("A")], { startupCommand: "test command" });
	await h.ready();
	const creating = deferred();
	h.setCreate(() => creating.promise);
	h.addTab();
	h.emitExit("C", 7);
	creating.resolve(tab("C"));
	await h.settle();
	assert.equal(h.isExited("C"), true);
	assert.ok(h.terminals.at(-1).output.includes("[process exited with code 7]"));
	h.emitData("C", "late output");
	await h.settle();
	assert.deepEqual(h.inputs, []);
	h.unmount();
});

test("a create response already marked exited never schedules its startup command", async () => {
	const h = dockHarness([tab("A")], { startupCommand: "test command" });
	await h.ready();
	h.setCreate(async () => ({ ...tab("C"), exited: true, exitCode: 1 }));
	h.addTab();
	await h.settle();
	assert.equal(h.isExited("C"), true);
	h.emitData("C", "late output");
	await h.settle();
	assert.deepEqual(h.inputs, []);
	h.unmount();
});

test("a running terminal still receives its startup command once after its first prompt", async () => {
	const h = dockHarness([tab("A")], { startupCommand: "test command" });
	await h.ready();
	h.addTab();
	await h.settle();
	h.emitData("C", "first prompt");
	h.emitData("C", "more output");
	await h.settle();
	assert.equal(h.isExited("C"), false);
	assert.deepEqual(h.inputs, [["C", "test command\r"]]);
	h.unmount();
});

test("initial output emitted before create settles is retained for replay", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	const creating = deferred();
	h.setCreate(() => creating.promise);
	h.addTab();
	h.emitData("C", "initial prompt");
	creating.resolve(tab("C"));
	await h.settle();
	assert.equal(h.terminals.at(-1).output, "initial prompt");
	h.emitData("foreign", "foreign output");
	assert.deepEqual(h.appended, ["initial prompt"]);
	h.unmount();
});

test("parallel tab closes cannot resurrect an already closed tab", async () => {
	const h = dockHarness();
	await h.ready();
	const a = deferred();
	const b = deferred();
	h.setClose((id) => (id === "A" ? a.promise : b.promise));
	h.closeTab("A");
	h.closeTab("B");
	a.resolve();
	await h.settle();
	b.resolve();
	await h.settle();
	assert.deepEqual(h.ids, []);
	assert.equal(h.closeCount, 1);
	h.unmount();
});

test("a tab created while the last old tab closes remains visible", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	const closing = deferred();
	h.setClose(() => closing.promise);
	h.closeTab("A");
	h.addTab();
	await h.settle();
	closing.resolve();
	await h.settle();
	assert.deepEqual(h.ids, ["C"]);
	assert.equal(h.closeCount, 0);
	h.unmount();
});

test("close-all removes only its captured tabs, not a newly created tab", async () => {
	const h = dockHarness();
	await h.ready();
	const closing = deferred();
	h.setClose(() => closing.promise);
	h.closeAll();
	h.addTab();
	await h.settle();
	closing.resolve();
	await h.settle();
	assert.deepEqual(h.ids, ["C"]);
	assert.equal(h.closeCount, 0);
	h.unmount();
});

test("late close completion after unmount cannot close the current owner dock", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	const closing = deferred();
	h.setClose(() => closing.promise);
	h.closeTab("A");
	h.unmount();
	closing.resolve();
	for (let i = 0; i < 8; i++) await Promise.resolve();
	assert.equal(h.closeCount, 0);
});

test("copy-on-select reattaches after collapsing and expanding the xterm instance", async () => {
	const h = dockHarness([tab("A")], { copyOnSelect: true });
	await h.ready();
	assert.equal(h.terminals.at(-1).selectionListeners.size, 1);
	h.render({ collapsed: true });
	h.render({ collapsed: false });
	const terminal = h.terminals.at(-1);
	assert.equal(terminal.selectionListeners.size, 1);
	for (const listener of terminal.selectionListeners) listener();
	await h.settle();
	assert.deepEqual(h.copied, ["selected text"]);
	h.unmount();
});

test("failed clipboard write does not report a successful right-click copy", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	h.setClipboardOk(false);
	h.contextMenu();
	await h.settle();
	assert.equal(
		h.notices.some(([message]) => message === "terminal.copied"),
		false,
	);
	h.unmount();
});

test("failed single close keeps the tab and reports the failure", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	h.setClose(async () => {
		throw new Error("close failed");
	});
	h.closeTab("A");
	await h.settle();
	assert.deepEqual(h.ids, ["A"]);
	assert.equal(h.closeCount, 0);
	assert.ok(h.notices.some(([message, , tone]) => message.includes("close failed") && tone === "error"));
	h.unmount();
});

test("failed create reports the error without changing existing tabs", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	h.setCreate(async () => {
		throw new Error("spawn failed");
	});
	h.addTab();
	await h.settle();
	assert.deepEqual(h.ids, ["A"]);
	assert.ok(h.notices.some(([message, , tone]) => message.includes("spawn failed") && tone === "error"));
	h.unmount();
});

test("partial close-all failure keeps failed tabs and reports it", async () => {
	const h = dockHarness();
	await h.ready();
	h.setClose(async (id) => {
		if (id === "B") throw new Error("B close failed");
	});
	h.closeAll();
	await h.settle();
	assert.deepEqual(h.ids, ["B"]);
	assert.equal(h.closeCount, 0);
	assert.ok(h.notices.some(([message, , tone]) => message.includes("B close failed") && tone === "error"));
	h.unmount();
});

test("last-tab close waits for a pending create before hiding the dock", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	const creating = deferred();
	h.setCreate(() => creating.promise);
	h.addTab();
	h.closeTab("A");
	await h.settle();
	assert.equal(h.closeCount, 0);
	creating.resolve(tab("C"));
	await h.settle();
	assert.deepEqual(h.ids, ["C"]);
	assert.equal(h.closeCount, 0);
	h.unmount();
});

test("failed pending create allows a previously requested empty dock close", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	const creating = deferred();
	h.setCreate(() => creating.promise);
	h.addTab();
	h.closeTab("A");
	await h.settle();
	creating.reject(new Error("spawn failed"));
	await h.settle();
	assert.deepEqual(h.ids, []);
	assert.equal(h.closeCount, 1);
	h.unmount();
});

test("close-all confirmation does not capture tabs created while the dialog is open", async () => {
	const h = dockHarness([tab("A")], { confirmClose: "always" });
	await h.ready();
	h.closeAll();
	await h.settle();
	h.addTab();
	await h.settle();
	h.confirmCloseAll();
	await h.settle();
	assert.deepEqual(h.ids, ["C"]);
	assert.equal(h.closeCount, 0);
	h.unmount();
});

test("switching terminal owner clears stale tabs before the new owner hydrates", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	const loading = deferred();
	h.setEnsure(() => loading.promise);
	h.render({ target: { kind: "project", projectId: "other", cwd: "/other" } });
	await h.settle();
	assert.deepEqual(h.ids, []);
	loading.resolve([tab("D")]);
	await h.settle();
	assert.deepEqual(h.ids, ["D"]);
	h.unmount();
});

test("old owner create completion cannot insert a tab into the new owner", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	const creating = deferred();
	h.setCreate(() => creating.promise);
	h.addTab();
	h.setEnsure(async () => [tab("D")]);
	h.render({ target: { kind: "project", projectId: "other", cwd: "/other" } });
	await h.settle();
	creating.resolve(tab("C"));
	await h.settle();
	assert.deepEqual(h.ids, ["D"]);
	assert.equal(h.closeCount, 0);
	h.unmount();
});
