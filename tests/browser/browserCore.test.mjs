import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const { normalizeBrowserSnapshot, formatBrowserSnapshot, SNAPSHOT_LIMITS } = loadTsCommonJs("src/main/browser/browserSnapshot.ts");
const { selectBrowserGuest } = loadTsCommonJs("src/main/browser/browserTarget.ts");
const { BrowserGuestRegistry } = loadTsCommonJs("src/main/browser/BrowserGuestRegistry.ts");

// ── 快照归一化/格式化（纯函数） ──────────────────────────────────────────────

const RAW = {
	url: "https://example.com/a",
	title: "Example",
	viewport: { width: 1280, height: 800 },
	scroll: { x: 0, y: 120 },
	devicePixelRatio: 2,
	iframeCount: 1,
	elements: [
		{ ref: "e1", role: "button", name: "  Submit   now ", tag: "button", box: { x: 10, y: 20, width: 80, height: 30 } },
		{ ref: "e1", role: "button", name: "duplicate ref", tag: "button" },
		{ ref: "nope", role: "button", name: "bad ref", tag: "button" },
		{ ref: "e3", role: "textbox", name: "Query", tag: "input", value: "hello", disabled: true },
		{ ref: "e4", role: "button", name: "zero box", tag: "button", box: { x: 0, y: 0, width: 0, height: 0 } },
		"not-an-object",
	],
	totalElements: 7,
	truncated: true,
};

test("normalizeBrowserSnapshot keeps valid unique refs and drops malformed data", () => {
	const snapshot = normalizeBrowserSnapshot(RAW);
	assert.equal(snapshot.elements.map((element) => element.ref).join(","), "e1,e3,e4");
	assert.equal(snapshot.elements[0].name, "Submit now", "whitespace is collapsed");
	assert.equal(snapshot.elements[0].box.width, 80);
	assert.equal(snapshot.elements[1].value, "hello");
	assert.equal(snapshot.elements[1].disabled, true);
	assert.equal(snapshot.elements[2].box, undefined, "zero-area boxes are dropped");
	assert.equal(snapshot.totalElements, 7);
	assert.equal(snapshot.truncated, true);
	assert.equal(snapshot.viewport.width, 1280);
	assert.equal(snapshot.scroll.y, 120);
	assert.equal(snapshot.devicePixelRatio, 2);
	assert.equal(snapshot.snapshotId, 0, "snapshotId is assigned by the controller");
});

test("normalizeBrowserSnapshot honors maxElements and caps string lengths", () => {
	const longName = "x".repeat(500);
	const raw = { elements: Array.from({ length: 5 }, (_value, index) => ({ ref: `e${index + 1}`, role: "button", name: longName, tag: "button", value: longName })) };
	const snapshot = normalizeBrowserSnapshot(raw, { maxElements: 2 });
	assert.equal(snapshot.elements.length, 2);
	assert.ok(snapshot.truncated, "truncation is reported even when the page did not set it");
	assert.equal(snapshot.elements[0].name.length, SNAPSHOT_LIMITS.nameChars);
	assert.equal(snapshot.elements[0].value.length, SNAPSHOT_LIMITS.valueChars);
});

test("formatBrowserSnapshot renders refs, states, boxes and escapes quotes", () => {
	const snapshot = normalizeBrowserSnapshot({
		url: "https://example.com",
		title: 'He said "hi"',
		elements: [{ ref: "e1", role: "button", name: 'Say "go"', tag: "button", disabled: true, box: { x: 1.4, y: 2.6, width: 10, height: 20 } }],
	});
	snapshot.snapshotId = 3;
	const text = formatBrowserSnapshot(snapshot);
	assert.match(text, /# browser_snapshot snapshotId=3/);
	assert.match(text, /target: https:\/\/example\.com \| "He said 'hi'"/);
	assert.match(text, /- button "Say 'go'" \[ref=e1\] \[disabled\] \[box=1,3,10,20\]/);
});

test("formatBrowserSnapshot enforces the text budget and says it truncated", () => {
	const elements = Array.from({ length: 200 }, (_value, index) => ({ ref: `e${index + 1}`, role: "button", name: "y".repeat(200), tag: "button" }));
	const snapshot = normalizeBrowserSnapshot({ elements, totalElements: 500 });
	snapshot.snapshotId = 9;
	const text = formatBrowserSnapshot(snapshot);
	assert.ok(text.length <= SNAPSHOT_LIMITS.textChars, `text budget exceeded: ${text.length}`);
	assert.match(text, /truncated by size/);
});

// ── guest 选择与登记表 ────────────────────────────────────────────────────────

function makeGuest({ id, type = "webview", panel = true, url = `https://page-${id}.test/`, title = `Page ${id}` } = {}) {
	const listeners = new Map();
	const guest = {
		id,
		type,
		panel,
		url,
		title,
		destroyed: false,
		isDestroyed() {
			return this.destroyed;
		},
		getType() {
			return this.type;
		},
		getURL() {
			return this.url;
		},
		getTitle() {
			return this.title;
		},
		on(event, callback) {
			const list = listeners.get(event) ?? [];
			list.push(callback);
			listeners.set(event, list);
		},
		once(event, callback) {
			const list = listeners.get(event) ?? [];
			list.push(callback);
			listeners.set(event, list);
		},
		removeListener(event, callback) {
			const list = listeners.get(event) ?? [];
			listeners.set(
				event,
				list.filter((entry) => entry !== callback),
			);
		},
		emitDestroyed() {
			this.destroyed = true;
			for (const callback of listeners.get("destroyed") ?? []) callback();
			listeners.delete("destroyed");
		},
		emit(event) {
			for (const callback of listeners.get(event) ?? []) callback();
		},
	};
	return guest;
}

test("selectBrowserGuest only accepts live webview guests from the browser partition, preferring the newest", () => {
	const first = makeGuest({ id: 1 });
	const pluginGuest = makeGuest({ id: 2, panel: false });
	const windowContents = makeGuest({ id: 3, type: "window", panel: true });
	const destroyed = makeGuest({ id: 4 });
	destroyed.destroyed = true;
	const newest = makeGuest({ id: 5 });
	const isPanel = (guest) => guest.panel === true;
	const selected = selectBrowserGuest([first, pluginGuest, windowContents, destroyed, newest], isPanel);
	assert.equal(selected.id, 5);
	assert.equal(selected.url, "https://page-5.test/");
	assert.equal(selectBrowserGuest([pluginGuest, windowContents, destroyed], isPanel), null);
});

test("selectBrowserGuest returns null when the guest dies while reading its URL", () => {
	const guest = makeGuest({ id: 8 });
	guest.getURL = () => {
		throw new Error("destroyed");
	};
	assert.equal(
		selectBrowserGuest([guest], () => true),
		null,
	);
});

function makeRegistry(listAll = () => []) {
	return new BrowserGuestRegistry({ listAll, isBrowserPanelGuest: (guest) => guest.panel === true });
}

test("BrowserGuestRegistry attaches guests, resolves the latest, and cleans up on destroy", () => {
	const registry = makeRegistry();
	const first = makeGuest({ id: 1 });
	const second = makeGuest({ id: 2 });
	registry.attach(first);
	registry.attach(second);
	registry.attach(second); // idempotent
	assert.equal(registry.resolve().id, 2);
	second.emitDestroyed();
	assert.equal(registry.resolve().id, 1);
	registry.detach(1);
	assert.equal(registry.resolve(), null);
	registry.dispose();
});

test("BrowserGuestRegistry reports navigation events and stops after detach", () => {
	const navigated = [];
	const registry = new BrowserGuestRegistry({
		listAll: () => [],
		isBrowserPanelGuest: (guest) => guest.panel === true,
		onGuestNavigated: (guest) => navigated.push(guest.id),
	});
	const guest = makeGuest({ id: 9 });
	registry.attach(guest);
	guest.emit("did-navigate");
	guest.emit("did-navigate-in-page");
	assert.deepEqual(navigated, [9, 9], "both full navigations and SPA route changes are reported");
	registry.detach(9);
	guest.emit("did-navigate");
	assert.deepEqual(navigated, [9, 9], "detached guests no longer report navigation");
	registry.dispose();
});

test("BrowserGuestRegistry falls back to the runtime webContents list when nothing was attached", () => {
	const guest = makeGuest({ id: 7 });
	const registry = makeRegistry(() => [guest]);
	assert.equal(registry.resolve().id, 7);
	registry.dispose();
});
