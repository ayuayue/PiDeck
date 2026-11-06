import assert from "node:assert/strict";
import test from "node:test";
import { Virtualizer, defaultRangeExtractor } from "@tanstack/virtual-core";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

function listHarness() {
	const host = quickMessageHookHost();
	const frames = new Map();
	const timers = new Map();
	const observers = new Set();
	const measured = [];
	let nextId = 0;
	let rectShift = 0;
	const run = {
		dataset: { virtualRunId: "run-0", index: "0" },
		clientWidth: 800,
		getBoundingClientRect: () => ({ top: 400 + rectShift - viewport.scrollTop, bottom: 1600 + rectShift - viewport.scrollTop, height: 1200 }),
	};
	const nested = { dataset: { index: "0" }, getBoundingClientRect: () => ({ height: 40 }) };
	const viewport = {
		clientWidth: 800,
		clientHeight: 300,
		scrollHeight: 20_000,
		scrollTop: 500,
		getBoundingClientRect: () => ({ top: 0 }),
		querySelector: () => run,
		querySelectorAll: (selector) => (selector === "[data-index]" ? [run, nested] : selector.includes("data-virtual-run-id") ? [run] : []),
	};
	const scrollRef = { current: viewport };
	let options;
	const instance = new Virtualizer({
		count: 0,
		getScrollElement: () => null,
		estimateSize: () => 900,
		scrollToFn() {},
		observeElementRect() {},
		observeElementOffset() {},
		initialRect: { width: 800, height: 300 },
		initialOffset: 0,
	});
	const jsx = (type, props) => ({ type, props });
	class Component {
		constructor(props) {
			this.props = props;
		}
	}
	const load = createTsSandbox({
		stubs: {
			react: { ...host.react, Component, useInsertionEffect: host.react.useLayoutEffect },
			"react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
			"@tanstack/react-virtual": {
				defaultRangeExtractor,
				useVirtualizer: (next) => {
					options = next;
					instance.setOptions({ ...instance.options, ...next, getScrollElement: () => null, initialRect: { width: 800, height: 300 } });
					return {
						getVirtualItems: () => [],
						getTotalSize: () => 900,
						measureElement: (node) => measured.push(node),
						measure() {},
						itemSizeCache: new Map(),
					};
				},
			},
		},
		globals: {
			requestAnimationFrame: (callback) => {
				frames.set(++nextId, callback);
				return nextId;
			},
			cancelAnimationFrame: (id) => frames.delete(id),
			setTimeout: (callback) => {
				timers.set(++nextId, callback);
				return nextId;
			},
			clearTimeout: (id) => timers.delete(id),
			ResizeObserver: class {
				constructor(callback) {
					this.callback = callback;
					observers.add(this);
				}
				observe(node) {
					this.node = node;
				}
				disconnect() {
					observers.delete(this);
				}
			},
		},
	});
	const { VirtualRunList } = load("src/renderer/src/components/session/timeline/VirtualRunList.tsx");
	const runs = Array.from({ length: 14 }, (_, index) => ({ id: `run-${index}` }));
	const props = { runs, scrollRef, renderRun: () => null, getRunId: (item) => item.id, isAgentRun: () => true, isRenderable: () => true };
	let tree;
	function render(extra = {}, beforeCommit = () => {}) {
		host.render(() => {
			tree = VirtualRunList({ ...props, ...extra });
			beforeCommit(tree);
		});
		return tree;
	}
	const flush = (queue) => {
		const callbacks = [...queue.values()];
		queue.clear();
		for (const callback of callbacks) callback();
	};
	return {
		render,
		viewport,
		run,
		nested,
		measured,
		frames,
		get options() {
			return options;
		},
		get indexes() {
			return instance.getVirtualIndexes();
		},
		resize(width) {
			viewport.clientWidth = width;
			for (const observer of [...observers]) observer.callback([]);
			flush(timers);
		},
		shift(value) {
			rectShift = value;
		},
		flushFrames() {
			flush(frames);
		},
		unmount() {
			host.unmount();
		},
	};
}

test("changing only a pinned run invalidates the virtualizer range memo", () => {
	const h = listHarness();
	try {
		h.render();
		assert.ok(!h.indexes.includes(10));
		h.render({ pinnedRunKeys: ["run-10"] });
		assert.ok(h.indexes.includes(10), "offscreen pin must be included without count or scroll changes");
		const extractor = h.options.rangeExtractor;
		h.render({ pinnedRunKeys: ["run-10"] });
		assert.equal(h.options.rangeExtractor, extractor, "unchanged pin values must not invalidate every streamed render");
	} finally {
		h.unmount();
	}
});

test("width settle never measures an inner VirtualStack row as an outer run", () => {
	const h = listHarness();
	try {
		h.render();
		h.resize(400);
		assert.ok(h.measured.includes(h.run));
		assert.ok(!h.measured.includes(h.nested), "data-index alone does not establish row ownership");
	} finally {
		h.unmount();
	}
});

test("unmounted text rows get taller estimates when their width narrows", () => {
	const h = listHarness();
	try {
		const first = h.render({ solid: true });
		const rows = first.props.children?.props?.children ?? first.props.children;
		rows[0].props.ref({ clientWidth: 800, hasAttribute: () => false, getBoundingClientRect: () => ({ height: 1000 }) });
		h.render();
		h.viewport.querySelectorAll = () => [];
		h.resize(400);
		assert.equal(h.options.estimateSize(0), 2000);
		h.resize(800);
		assert.equal(h.options.estimateSize(0), 1000, "an exact width bucket remains authoritative");
	} finally {
		h.unmount();
	}
});

test("layout switching restores the pre-mutation anchor, not the replacement geometry", () => {
	const h = listHarness();
	let boundary;
	try {
		const first = h.render({ solid: true });
		assert.equal(typeof first.type, "function", "layout switches need a pre-mutation snapshot boundary");
		boundary = new first.type(first.props);
		const previous = boundary.props;
		h.render({ solid: false }, (next) => {
			boundary.props = next.props;
			const snapshot = boundary.getSnapshotBeforeUpdate(previous);
			h.shift(240);
			boundary.componentDidUpdate(previous, {}, snapshot);
		});
		h.flushFrames();
		assert.equal(h.viewport.scrollTop, 740);
	} finally {
		boundary?.componentWillUnmount?.();
		h.unmount();
	}
});
