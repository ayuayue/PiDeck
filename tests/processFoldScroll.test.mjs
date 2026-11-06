import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

function foldHarness({ running = false, height = 1000 } = {}) {
	const host = quickMessageHookHost();
	const observers = new Set();
	const frames = new Map();
	let nextFrame = 0;
	class Element {
		listeners = new Map();
		clientHeight = 500;
		scrollHeight = height;
		top = 0;
		get scrollTop() {
			return this.top;
		}
		set scrollTop(value) {
			this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
		}
		addEventListener(name, listener) {
			this.listeners.set(name, listener);
		}
		removeEventListener(name) {
			this.listeners.delete(name);
		}
		getBoundingClientRect() {
			return { top: 0, left: 0, height: this.clientHeight };
		}
	}
	const viewport = new Element();
	const content = new Element();
	const jsx = (type, props) => ({ type, props });
	const stubs = {
		react: { ...host.react, memo: (component) => component },
		"react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
		"lucide-react": { ChevronUp: "icon" },
		"../../../i18n": { t: (key) => key },
		"../timeline/groupTurnProcess": {},
		"../../../lib/hooks/use-render-reuse": { useStableKeyedHandlers: (factory) => factory },
		"../../ui-shadcn/virtual-stack": { VirtualStack: "stack" },
		"./ErrorStep": {},
		"./InterimAnswer": {},
		"./ProcessGroupStep": {},
		"./RetryStep": {},
		"./useProcessGroupState": { isGroupOpen: () => false },
	};
	const load = createTsSandbox({
		stubs,
		globals: {
			HTMLElement: Element,
			Node: Element,
			document: { addEventListener() {}, removeEventListener() {} },
			getComputedStyle: () => ({ overflowY: "auto", overscrollBehaviorY: "auto" }),
			performance: { now: () => 100 },
			requestAnimationFrame: (callback) => {
				frames.set(++nextFrame, callback);
				return nextFrame;
			},
			cancelAnimationFrame: (id) => frames.delete(id),
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
	stubs["../../../lib/stick-to-bottom"] = load("src/renderer/src/lib/stick-to-bottom/useStickToBottom.ts");
	const { ProcessFold } = load("src/renderer/src/components/session/turn/ProcessFold.tsx");
	let nodes = [{ kind: "interim", id: "first", message: { text: "interim" } }];
	let scrollNode;
	let scrollBinding;
	let contentBinding;
	const bind = (ref, element) => {
		if (typeof ref === "function") ref(element);
		else if (ref) ref.current = element;
	};
	const children = (node) => [node?.props?.children].flat().filter(Boolean);
	function render() {
		host.render(() => {
			const tree = ProcessFold({ nodes, stepsVisible: true, agentRunning: running, groupState: {}, onToggleGroup() {}, onOpenExternal() {}, onCollapse() {} });
			const find = (node) => {
				if (node?.props?.className?.includes("overflow-y-auto")) return node;
				for (const child of children(node)) {
					const found = find(child);
					if (found) return found;
				}
			};
			scrollNode = find(tree);
			if (scrollBinding !== scrollNode.props.ref) {
				scrollBinding = scrollNode.props.ref;
				bind(scrollBinding, viewport);
			}
			const inner = children(scrollNode)[0];
			if (contentBinding !== inner?.props?.ref) {
				contentBinding = inner?.props?.ref;
				bind(contentBinding, content);
			}
		});
	}
	function resize() {
		for (const observer of [...observers]) observer.callback([{ contentRect: { height: observer.node === viewport ? viewport.clientHeight : viewport.scrollHeight } }]);
	}
	render();
	resize();
	return {
		viewport,
		wheel(deltaY) {
			scrollNode.props.onWheel?.({ deltaY, target: viewport });
			viewport.scrollTop += deltaY;
			render();
		},
		grow(delta, append = true) {
			viewport.scrollHeight += delta;
			if (append) nodes = [...nodes, { kind: "interim", id: `row-${nodes.length}`, message: { text: "next" } }];
			render();
			resize();
		},
		unmount() {
			bind(scrollBinding, null);
			bind(contentBinding, null);
			host.unmount();
		},
	};
}

test("a process fold keeps the prior bottom intent across a large append", () => {
	const h = foldHarness();
	try {
		h.wheel(1000);
		h.grow(300);
		assert.ok(h.viewport.scrollHeight - h.viewport.scrollTop - h.viewport.clientHeight <= 1);
	} finally {
		h.unmount();
	}
});

test("a running fold opens at the live edge and follows same-node height changes", () => {
	const h = foldHarness({ running: true });
	try {
		assert.ok(h.viewport.scrollTop >= 499, "opening a live fold must expose its tail");
		h.grow(350, false);
		assert.ok(h.viewport.scrollHeight - h.viewport.scrollTop - h.viewport.clientHeight <= 1);
	} finally {
		h.unmount();
	}
});

test("history opens at the start and an upward reader is not pulled back by growth", () => {
	const h = foldHarness();
	try {
		assert.equal(h.viewport.scrollTop, 0);
		h.wheel(1000);
		h.wheel(-180);
		const before = h.viewport.scrollTop;
		h.grow(400, false);
		assert.equal(h.viewport.scrollTop, before);
	} finally {
		h.unmount();
	}
});
