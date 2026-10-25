import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const NOT_READY = "The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.";

/** Runs the real component with controlled React effects and Electron guest readiness. */
function createBrowserPanelHarness(device = "pc") {
	const hooks = [];
	const timers = new Map();
	const listeners = new Map();
	const calls = [];
	let cursor = 0;
	let nextTimerId = 1;
	let pendingEffects = [];
	let tree;
	let ref;
	let guestReady = false;
	const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
	const react = {
		useState(initial) {
			const index = cursor++;
			hooks[index] ??= { value: typeof initial === "function" ? initial() : initial };
			return [
				hooks[index].value,
				(next) => {
					hooks[index].value = typeof next === "function" ? next(hooks[index].value) : next;
				},
			];
		},
		useRef(initial) {
			const index = cursor++;
			hooks[index] ??= { current: initial };
			return hooks[index];
		},
		useCallback(callback, deps) {
			const index = cursor++;
			if (!sameDeps(hooks[index]?.deps, deps)) hooks[index] = { value: callback, deps };
			return hooks[index].value;
		},
		useEffect(create, deps) {
			const index = cursor++;
			if (sameDeps(hooks[index]?.deps, deps)) return;
			pendingEffects.push(() => {
				hooks[index]?.cleanup?.();
				hooks[index] = { deps, cleanup: create() };
			});
		},
	};
	const jsx = (type, props) => ({ type, props: props ?? {} });
	const load = createTsSandbox({
		stubs: {
			react,
			"react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
			"lucide-react": {},
			"../../i18n": { t: (key) => key },
			"../ui-shadcn/button": { Button: "button" },
			"../ui-shadcn/input": { Input: "input" },
		},
		globals: {
			window: {
				setTimeout(callback) {
					const id = nextTimerId++;
					timers.set(id, callback);
					return id;
				},
				clearTimeout: (id) => timers.delete(id),
			},
		},
	});
	const api = load("src/renderer/src/components/app/BrowserPanel.tsx");
	api.moduleState.device = device;
	const invoke = (method, args = []) => {
		calls.push({ method, args });
		if (!wv.isConnected || !guestReady) throw new Error(NOT_READY);
	};
	const wv = {
		isConnected: false,
		loading: false,
		addEventListener(type, listener) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type).add(listener);
		},
		removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
		getUserAgent() {
			invoke("getUserAgent");
			return "Desktop UA";
		},
		setUserAgent(ua) {
			invoke("setUserAgent", [ua]);
		},
		isLoading() {
			invoke("isLoading");
			return wv.loading;
		},
		canGoBack() {
			invoke("canGoBack");
			return false;
		},
		canGoForward() {
			invoke("canGoForward");
			return false;
		},
		loadURL(url) {
			invoke("loadURL", [url]);
			return Promise.resolve();
		},
		goBack() {
			invoke("goBack");
		},
		goForward() {
			invoke("goForward");
		},
		reload() {
			invoke("reload");
		},
	};
	function find(node, predicate) {
		if (!node || typeof node !== "object") return;
		if (predicate(node)) return node;
		for (const child of [node.props?.children].flat()) {
			const found = find(child, predicate);
			if (found) return found;
		}
	}
	return {
		api,
		wv,
		calls,
		timers,
		loadedUrls: () => calls.filter((call) => call.method === "loadURL").map((call) => call.args[0]),
		render() {
			cursor = 0;
			pendingEffects = [];
			tree = api.BrowserPanel({});
			ref?.(null);
			ref = find(tree, (node) => node.type === "webview").props.ref;
			wv.isConnected = true;
			ref(wv);
			for (const effect of pendingEffects) effect();
		},
		emit(type, event = {}) {
			if (type === "dom-ready") guestReady = true;
			for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
		},
		runRetries() {
			for (const [id, callback] of [...timers]) {
				timers.delete(id);
				callback();
			}
		},
		click(title) {
			find(tree, (node) => node.props?.title === title).props.onClick();
		},
		unmount() {
			for (const hook of hooks) hook?.cleanup?.();
			ref?.(null);
			ref = undefined;
			wv.isConnected = false;
			guestReady = false;
			hooks.length = 0;
		},
	};
}

test("external links wait for dom-ready before calling Electron guest methods", () => {
	const panel = createBrowserPanelHarness();
	panel.api.navigateTo("https://example.test/first");
	assert.doesNotThrow(() => panel.render());
	panel.runRetries();
	assert.deepEqual(panel.calls, [], "a DOM ref alone must not allow any guest method");
	panel.emit("dom-ready");
	panel.runRetries();
	assert.deepEqual(panel.loadedUrls(), ["https://example.test/first"]);
	panel.unmount();
});

test("restored mobile mode applies its user agent only after dom-ready", () => {
	const panel = createBrowserPanelHarness("mobile");
	assert.doesNotThrow(() => panel.render());
	assert.deepEqual(panel.calls, []);
	panel.emit("dom-ready");
	assert.equal(panel.calls[0].method, "getUserAgent");
	assert.match(panel.calls.find((call) => call.method === "setUserAgent").args[0], /iPhone/);
	panel.unmount();
});

test("URL state changes do not reset readiness for the existing webview", () => {
	const panel = createBrowserPanelHarness();
	panel.render();
	panel.emit("dom-ready");
	panel.emit("did-navigate", { url: "https://example.test/redirected" });
	panel.render();
	panel.api.navigateTo("https://example.test/second");
	assert.deepEqual(panel.loadedUrls(), ["https://example.test/second"]);
	panel.unmount();
});

test("loading retains the latest external link until it can be consumed", () => {
	const panel = createBrowserPanelHarness();
	panel.render();
	panel.emit("dom-ready");
	panel.wv.loading = true;
	panel.api.navigateTo("https://example.test/first");
	panel.api.navigateTo("https://example.test/latest");
	panel.runRetries();
	assert.deepEqual(panel.loadedUrls(), []);
	panel.wv.loading = false;
	panel.emit("did-stop-loading");
	panel.runRetries();
	assert.deepEqual(panel.loadedUrls(), ["https://example.test/latest"]);
	panel.unmount();
	assert.equal(panel.timers.size, 0);
});

test("unmount cancels pending retries and remount waits for a new dom-ready", () => {
	const panel = createBrowserPanelHarness();
	panel.api.navigateTo("https://example.test/pending");
	panel.render();
	panel.unmount();
	assert.equal(panel.timers.size, 0);
	panel.emit("dom-ready");
	panel.runRetries();
	assert.deepEqual(panel.calls, []);
	panel.render();
	panel.runRetries();
	assert.deepEqual(panel.loadedUrls(), []);
	panel.emit("dom-ready");
	panel.runRetries();
	assert.deepEqual(panel.loadedUrls(), ["https://example.test/pending"]);
	panel.unmount();
});

test("loading events before dom-ready do not query navigation history", () => {
	const panel = createBrowserPanelHarness();
	panel.render();
	assert.doesNotThrow(() => panel.emit("did-navigate", { url: "https://example.test/initial" }));
	assert.doesNotThrow(() => panel.emit("did-stop-loading"));
	assert.deepEqual(panel.calls, []);
	panel.unmount();
});

test("unmount cancels every retry after repeated links arrive during loading", () => {
	const panel = createBrowserPanelHarness();
	panel.render();
	panel.emit("dom-ready");
	panel.wv.loading = true;
	panel.api.navigateTo("https://example.test/first");
	panel.api.navigateTo("https://example.test/second");
	panel.unmount();
	assert.equal(panel.timers.size, 0);
});

test("toolbar navigation does not call guest methods before dom-ready", () => {
	const panel = createBrowserPanelHarness();
	panel.render();
	for (const title of ["browser.home", "browser.reload", "browser.back", "browser.forward"]) {
		assert.doesNotThrow(() => panel.click(title));
	}
	assert.deepEqual(panel.calls, []);
	panel.unmount();
});
