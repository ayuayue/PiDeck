import assert from "node:assert/strict";
import { createTsSandbox } from "./createTsSandbox.mjs";
import { quickMessageHookHost } from "./quickMessageHookHost.mjs";

/** IPC 完成顺序由测试裁决，不使用真实 PTY、DOM 或计时器。 */
export function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

export function tab(id) {
	return { id, agentId: "", ownerKey: "cwd:/project", title: id, cwd: "/project", shell: "bash", createdAt: 0 };
}

/** 仅替换外部能力，直接通过真实 TerminalDock 的公开按钮/事件验证状态流转。 */
export function dockHarness(initialTabs = [tab("A"), tab("B")], settings = {}) {
	const host = quickMessageHookHost();
	const timers = new Map();
	const frames = new Map();
	const elements = new Map();
	const notices = [];
	const terminals = [];
	const copied = [];
	const inputs = [];
	const resizes = [];
	const observers = [];
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
	let input = async () => {};
	let resize = async () => {};
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
			this.dataListeners = new Set();
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
		onData(listener) {
			this.dataListeners.add(listener);
			return { dispose: () => this.dataListeners.delete(listener) };
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
			await input(...args);
		},
		resize: async (...args) => {
			resizes.push(args);
			await resize(...args);
		},
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
				constructor(callback) {
					this.callback = callback;
					observers.push(this);
				}
				observe() {}
				disconnect() {
					this.disconnected = true;
				}
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
		resizes,
		appended,
		typeInput(data) {
			for (const listener of terminals.at(-1).dataListeners) listener(data);
		},
		resizeContainer() {
			for (const observer of observers) if (!observer.disconnected) observer.callback();
		},
		flushFrames() {
			for (const [id, callback] of [...frames]) {
				if (!frames.delete(id)) continue;
				callback();
			}
		},
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
		setInput(fn) {
			input = fn;
		},
		setResize(fn) {
			resize = fn;
		},
		setSettings(patch) {
			render({ terminalSettings: { ...props.terminalSettings, ...patch } });
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
