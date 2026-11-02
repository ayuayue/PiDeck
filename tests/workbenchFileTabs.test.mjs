import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function harness(
	tabs = [
		{ id: "a", label: "a.ts", active: true },
		{ id: "b", label: "b.ts" },
		{ id: "c", label: "c.ts", preview: true },
	],
) {
	const effects = [];
	const refs = [];
	const selected = [];
	const closed = [];
	const promoted = [];
	let state;
	let refIndex;
	const { WorkbenchFileTabs } = loadTsCommonJs("src/renderer/src/components/workspace/WorkbenchFileTabs.tsx", {
		stubs: {
			react: {
				useState: () => [
					state,
					(value) => {
						state = value;
					},
				],
				useRef: (value) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: value }),
				useLayoutEffect: (effect) => effects.push(effect),
			},
			"lucide-react": { X: () => null },
			"../../i18n": { t: (key) => key },
			"../../lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
		},
	});
	const render = (next = tabs) => {
		refIndex = 0;
		effects.length = 0;
		return WorkbenchFileTabs({ tabs: next, onSelect: (id) => selected.push(id), onClose: (id) => closed.push(id), onPromote: (id) => promoted.push(id) });
	};
	return { render, effects, selected, closed, promoted };
}

function key(node, value, target = node, extra = {}) {
	let prevented = false;
	node.props.onKeyDown({
		key: value,
		target,
		currentTarget: node,
		nativeEvent: { isComposing: false },
		preventDefault() {
			prevented = true;
		},
		...extra,
	});
	return prevented;
}

test("file tabs expose one keyboard entry and native close buttons", () => {
	const h = harness();
	const tree = h.render();
	const tabs = tree.props.children;
	const tabButtons = tabs.map((tab) => tab.props.children[0]);
	const closeButtons = tabs.map((tab) => tab.props.children[1]);
	assert.deepEqual(
		tabButtons.map((tab) => tab.props.tabIndex),
		[0, -1, -1],
	);
	const close = closeButtons[0];
	assert.equal(close.props.role, undefined);
	assert.equal(close.props.tabIndex, 0);
	assert.equal(closeButtons[1].props.tabIndex, -1);
	assert.equal(key(tabButtons[0], "Enter", close), false);
	assert.equal(key(tabButtons[0], " ", close), false);
	assert.deepEqual(h.selected, []);
	assert.equal(tabs[0].props.role, "presentation");
	assert.equal(tabButtons[0].props["aria-selected"], true);
	assert.equal(tabButtons[1].props["aria-selected"], false);
	assert.equal(tabButtons[0].props.children.type, "span");
	let stopped = 0;
	close.props.onClick({
		stopPropagation() {
			stopped++;
		},
	});
	close.props.onDoubleClick({
		stopPropagation() {
			stopped++;
		},
	});
	assert.equal(stopped, 2);
	assert.deepEqual(h.closed, ["a"]);
	assert.deepEqual(h.promoted, []);
	// The shared rounded surface remains clickable, including the padding around its label.
	tabs[1].props.onClick();
	tabs[1].props.onDoubleClick();
	assert.deepEqual(h.selected, ["b"]);
	assert.deepEqual(h.promoted, ["b"]);
});

test("arrow and boundary keys move focus without selecting a file", () => {
	const h = harness();
	const tree = h.render();
	const tabs = tree.props.children.map((tab) => tab.props.children[0]);
	let focused;
	const nodes = tabs.map((_, index) => ({
		focus() {
			focused = index;
		},
	}));
	tree.props.ref.current = { querySelectorAll: () => nodes };
	for (const [index, name, expected] of [
		[0, "ArrowRight", 1],
		[0, "ArrowLeft", 2],
		[1, "Home", 0],
		[0, "End", 2],
	]) {
		assert.equal(key(tabs[index], name), true);
		assert.equal(focused, expected);
	}
	assert.deepEqual(h.selected, []);
	assert.equal(key(tabs[1], "Enter"), true);
	assert.equal(key(tabs[2], " "), true);
	assert.deepEqual(h.selected, ["b", "c"]);
	assert.equal(key(tabs[1], "Delete"), true);
	assert.deepEqual(h.closed, ["b"]);
});

test("modified shortcuts and IME keys remain untouched", () => {
	const h = harness();
	const tab = h.render().props.children[0].props.children[0];
	assert.equal(key(tab, "Enter", tab, { nativeEvent: { isComposing: true } }), false);
	assert.equal(key(tab, "Home", tab, { ctrlKey: true }), false);
	assert.deepEqual(h.selected, []);
});

function focusHarness() {
	const h = harness();
	const body = {};
	const document = { body, activeElement: body };
	let tree;
	let nodes = [];
	let focused = null;
	let scrolled = null;
	const list = {
		ownerDocument: document,
		querySelectorAll: () => nodes.map((pair) => pair[0]),
		contains: (element) => nodes.some((pair) => pair.includes(element) && element.isConnected),
	};
	const render = (tabs) => {
		tree = h.render(tabs);
		tree.props.ref.current = list;
		nodes = tree.props.children.map((wrapper, index) =>
			[0, 1].map((part) => ({
				isConnected: true,
				focus() {
					document.activeElement = this;
					focused = [index, part];
					wrapper.props.onFocus({
						target: this,
						currentTarget: {
							scrollIntoView(options) {
								scrolled = options;
							},
						},
					});
				},
			})),
		);
		return tree;
	};
	render();
	return { h, render, document, list, nodes: () => nodes, focused: () => focused, scrolled: () => scrolled, blur: (relatedTarget) => tree.props.onBlurCapture({ relatedTarget, currentTarget: list }) };
}

test("tab and close focus share the roving entry and scroll into view", () => {
	const f = focusHarness();
	f.nodes()[2][1].focus();
	// The option object crosses the VM boundary, so compare it structurally rather than by realm.
	assert.equal(JSON.stringify(f.scrolled()), JSON.stringify({ block: "nearest", inline: "nearest" }));
	assert.equal(
		JSON.stringify(f.h.render().props.children.map((wrapper) => wrapper.props.children.map((node) => node.props.tabIndex))),
		JSON.stringify([
			[-1, -1],
			[-1, -1],
			[0, 0],
		]),
	);
	f.blur(f.nodes()[2][0]);
	assert.equal(f.h.render().props.children[2].props.children[0].props.tabIndex, 0);
	f.blur({});
	assert.equal(JSON.stringify(f.h.render().props.children.map((wrapper) => wrapper.props.children[0].props.tabIndex)), JSON.stringify([0, -1, -1]));
});

test("removing a focused tab or its close button recovers only lost focus", () => {
	for (const part of [0, 1]) {
		const f = focusHarness();
		const removed = f.nodes()[2][part];
		removed.focus();
		removed.isConnected = false;
		f.document.activeElement = f.document.body;
		f.render([
			{ id: "a", label: "a" },
			{ id: "b", label: "b" },
		]);
		f.h.effects.forEach((effect) => effect());
		assert.deepEqual(f.focused(), [1, 0]);
	}
	const f = focusHarness();
	const removed = f.nodes()[2][1];
	removed.focus();
	removed.isConnected = false;
	f.document.activeElement = f.document.body;
	f.render([
		{ id: "a", label: "a", active: true },
		{ id: "b", label: "b" },
	]);
	f.h.effects.forEach((effect) => effect());
	assert.deepEqual(f.focused(), [0, 0]);
});

test("blocked close, dialog focus and a deliberate blur never trigger recovery", () => {
	const blocked = focusHarness();
	blocked.nodes()[1][1].focus();
	blocked.h.effects.forEach((effect) => effect());
	assert.deepEqual(blocked.focused(), [1, 1]);
	for (const blur of ["dialog", "outside", "null"]) {
		const f = focusHarness();
		const removed = f.nodes()[1][1];
		removed.focus();
		if (blur !== "dialog") f.blur(blur === "null" ? null : {});
		removed.isConnected = false;
		f.document.activeElement = blur === "dialog" ? {} : f.document.body;
		f.render([{ id: "a", label: "a", active: true }]);
		f.h.effects.forEach((effect) => effect());
		assert.deepEqual(f.focused(), [1, 1], blur);
	}
});

test("removing the last tab leaves an empty list without throwing", () => {
	const f = focusHarness();
	const removed = f.nodes()[0][1];
	removed.focus();
	removed.isConnected = false;
	f.document.activeElement = f.document.body;
	const tree = f.render([]);
	f.h.effects.forEach((effect) => effect());
	assert.deepEqual(tree.props.children, []);
	assert.equal(f.document.activeElement, f.document.body);
});

test("without an active tab the first file remains reachable", () => {
	const h = harness([
		{ id: "a", label: "a" },
		{ id: "b", label: "b" },
	]);
	assert.deepEqual(
		h.render().props.children.map((tab) => tab.props.children[0].props.tabIndex),
		[0, -1],
	);
});
