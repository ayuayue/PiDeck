import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/** Run the real controller, geometry and rAF animation without Electron or a model request. */
function sendScrollHarness({ height = 2800, viewportHeight = 600, latestTop = height - 140, startLoading = false, startWithOptimistic = false, startWithAnchor = false, bottomScrollSucceeds = true, viewerProjection = false } = {}) {
	const host = quickMessageHookHost();
	let now = 0;
	let nextFrame = 0;
	let naturalHeight = height;
	let top = Math.max(0, height - viewportHeight);
	let sessionId = "s1";
	let loadStatus = startLoading ? "loading" : "ready";
	let sendStatus = startWithOptimistic ? { status: "activating", requestId: "optimistic-uuid" } : { status: "idle" };
	// controller 通过会话级 atom 标记「发送置顶动画进行中」（TurnRow 据此延后新一轮折叠）。
	let sendPinAnimating = {};
	let messages = startWithOptimistic
		? [{ id: "optimistic-uuid", role: "user", text: "new question", timestamp: 1, agentId: "" }]
		: startLoading
			? []
			: viewerProjection
				? [{ id: "_viewer-history-9", role: "user", text: "history", timestamp: 1, agentId: "agent", meta: { entryId: "e9" } }]
				: [{ id: "history-user", role: "user", text: "history", timestamp: 1, agentId: "agent" }];
	const rowTops = new Map(startWithOptimistic ? [["optimistic-uuid", latestTop]] : startLoading ? [] : [[viewerProjection ? "_viewer-history-9" : "history-user", latestTop]]);
	const frames = new Map();
	const listeners = new Map();
	const observers = new Set();
	const calls = [];
	const spacer = {
		style: { height: "0px" },
		get offsetHeight() {
			return Number.parseFloat(this.style.height) || 0;
		},
	};
	const viewport = {
		clientHeight: viewportHeight,
		get scrollHeight() {
			return Math.max(viewportHeight, naturalHeight + spacer.offsetHeight);
		},
		get scrollTop() {
			return top;
		},
		set scrollTop(value) {
			top = Math.min(this.scrollHeight - viewportHeight, Math.max(0, value));
		},
		getBoundingClientRect: () => ({ top: 0, bottom: viewportHeight }),
		querySelector(selector) {
			if (selector === "[data-send-scroll-spacer]") return spacer;
			if (selector === '[role="log"]') return content;
			const id = selector.match(/data-message-id="([^"]+)"/)?.[1];
			if (!rowTops.has(id)) return null;
			return { getBoundingClientRect: () => ({ top: rowTops.get(id) - top, bottom: rowTops.get(id) - top + 60 }), dataset: { messageId: id } };
		},
		querySelectorAll: () => [],
		addEventListener(name, listener) {
			listeners.set(name, listener);
		},
		removeEventListener(name, listener) {
			if (listeners.get(name) === listener) listeners.delete(name);
		},
		scrollTo({ top: value }) {
			this.scrollTop = value;
		},
	};
	const content = {
		get offsetHeight() {
			return viewport.scrollHeight;
		},
	};
	const api = {
		stopScroll: () => calls.push("stop"),
		restoreAt(value) {
			calls.push("restore");
			viewport.scrollTop = value;
		},
		scrollToBottom() {
			calls.push("bottom");
			if (bottomScrollSucceeds) viewport.scrollTop = viewport.scrollHeight - viewportHeight;
		},
	};
	const atoms = {
		sessionMessagesCacheAtom: "cache",
		sessionMessageCacheBySessionIdAtomFamily: () => "entry",
		sessionRecordByIdAtomFamily: () => "record",
		sessionMessageLoadStateAtom: "load",
		sessionSendStateByIdAtom: "send",
		sendPinAnimatingByIdAtom: "sendPinAnimating",
		sessionScrollAnchorByIdAtom: "anchors",
	};
	const store = {
		set(key, updater) {
			if (key !== "sendPinAnimating") return;
			sendPinAnimating = typeof updater === "function" ? updater(sendPinAnimating) : updater;
		},
		get(key) {
			if (key === "cache") return { [sessionId]: { messages, source: "runtime" } };
			if (key === "entry") return { messages, source: "runtime" };
			if (key === "load") return { [sessionId]: { status: loadStatus } };
			if (key === "send") return { [sessionId]: sendStatus };
			if (key === "record") return { id: sessionId, projectId: "p1", status: "active", filePath: "/tmp/s1.jsonl", messageCount: messages.length };
			if (key === "sendPinAnimating") return sendPinAnimating;
			if (key === "anchors") return startWithAnchor && sessionId === "s1" ? { s1: { messageId: "optimistic-uuid", offsetTop: 96, windowTurns: 3 } } : {};
			return {};
		},
	};
	const requestAnimationFrame = (fn) => {
		frames.set(++nextFrame, fn);
		return nextFrame;
	};
	const cancelAnimationFrame = (id) => frames.delete(id);
	const react = {
		...host.react,
		useLayoutEffect: host.react.useEffect,
		useMemo(factory, deps) {
			const ref = host.react.useRef();
			if (!ref.current || deps.some((value, index) => !Object.is(value, ref.current.deps[index]))) ref.current = { deps, value: factory() };
			return ref.current.value;
		},
	};
	const load = createTsSandbox({
		stubs: {
			react,
			jotai: { atom: (value) => value, useAtomValue: (key) => (typeof key === "function" ? key() : store.get(key)), useStore: () => store, useSetAtom: () => () => {} },
			"jotai/utils": { selectAtom: (key, select) => () => select(store.get(key)) },
			"../atoms": atoms,
			"../desktopApi": { desktopApi: { sessions: { readRecordMessagePage: () => new Promise(() => {}), startDshHost: async () => false } } },
			"../i18n": { t: (key) => key },
		},
		globals: {
			performance: { now: () => now },
			CSS: { escape: (id) => id },
			requestAnimationFrame,
			cancelAnimationFrame,
			ResizeObserver: class {
				constructor(fn) {
					this.fn = fn;
				}
				observe() {
					observers.add(this);
				}
				disconnect() {
					observers.delete(this);
				}
			},
			window: { requestAnimationFrame, cancelAnimationFrame, matchMedia: () => ({ matches: false }), setTimeout: () => 1, clearTimeout: () => {} },
		},
	});
	const { useSessionTimelineController } = load("src/renderer/src/hooks/useSessionTimelineController.ts");
	let controller;
	const render = () =>
		host.render(() => {
			controller = useSessionTimelineController({ sessionId });
			controller.timelineRef.current = viewport;
			controller.scrollerScrollApiRef.current = api;
			return controller;
		});
	const advance = (ms = 16) => {
		now += ms;
		const pending = [...frames.values()];
		frames.clear();
		for (const fn of pending) fn(now);
		render();
	};
	render();
	advance();
	calls.length = 0;
	return {
		viewport,
		spacer,
		calls,
		render,
		advance,
		get controller() {
			return controller;
		},
		browse(value = 160) {
			controller.setAutoScrollFromScroller(false);
			viewport.scrollTop = value;
			render();
		},
		send(id = "d04a3300-3147-42fb-b8bc-9f0a587ece3b", { reply = false } = {}) {
			rowTops.set(id, naturalHeight - 20);
			naturalHeight += 100;
			messages = [...messages, { id, role: "user", text: "new question", timestamp: now, agentId: "agent" }];
			if (reply) messages.push({ id: "assistant-new", role: "assistant", text: "reply", timestamp: now, agentId: "agent" });
			render();
			return id;
		},
		stream() {
			naturalHeight += 20;
			messages = [...messages];
			render();
			for (const observer of observers) observer.fn();
		},
		resizeAbove(delta) {
			naturalHeight += delta;
			for (const [id, value] of rowTops) rowTops.set(id, value + delta);
			for (const observer of observers) observer.fn();
		},
		/** 发送态 in-flight：restore pending 期间的 id 变化只在此时才登记发送定位。 */
		beginSendState() {
			sendStatus = { status: "activating", requestId: "optimistic-uuid" };
			render();
		},
		endSendState() {
			sendStatus = { status: "idle" };
			render();
		},
		/** 恢复阶段读盘返回：填充历史消息但不代表用户发送。 */
		releaseHistory() {
			messages = [{ id: "history-user", role: "user", text: "history", timestamp: 1, agentId: "agent" }];
			rowTops.set("history-user", latestTop);
			loadStatus = "ready";
			render();
		},
		/** 结束 restorePhase 的 pending 状态。 */
		releaseLoad() {
			loadStatus = "ready";
			render();
			advance();
		},
		rowGap(id) {
			return rowTops.get(id) - viewport.scrollTop;
		},
		/** 会话级「发送置顶动画进行中」标记（TurnRow 折叠延后依据）。 */
		sendPinAnimating(id = "s1") {
			return sendPinAnimating[id] === true;
		},
		input(name = "wheel") {
			listeners.get(name)?.({ type: name });
		},
		switchSession() {
			sessionId = "s2";
			messages = [{ id: "other-user", role: "user", text: "other", timestamp: 2, agentId: "other" }];
			rowTops.set("other-user", 200);
			naturalHeight = 400;
			render();
		},
		returnToSourceAtLiveEdge() {
			sessionId = "s1";
			messages = [{ id: "history-user", role: "user", text: "history", timestamp: 1, agentId: "agent" }];
			rowTops.set("history-user", latestTop);
			naturalHeight = height;
			top = 0;
			render();
		},
		/** pi 预热激活后运行时全量 flush：磁盘页投影（_viewer-history-X）换成运行时投影
		 *（<agentId>-history-X），同一 entryId。 */
		reproject() {
			messages = messages.map((m) => ({ ...m, id: m.id.replace(/^_viewer-history-/, "agent-history-") }));
			for (const m of messages) if (!rowTops.has(m.id)) rowTops.set(m.id, rowTops.get(m.id.replace(/^agent-history-/, "_viewer-history-")) ?? latestTop);
			render();
		},
		finish() {
			for (let i = 0; i < 55; i++) advance();
		},
		unmount: host.unmount,
	};
}

test("sending a UUID user message from scrolled history smoothly brings it to the top", () => {
	const h = sendScrollHarness();
	try {
		h.browse();
		const start = h.viewport.scrollTop;
		const id = h.send();
		h.advance();
		assert.ok(Math.abs(h.viewport.scrollTop - start) < 1, "sending must not snap before the animation");
		h.advance();
		assert.ok(h.viewport.scrollTop - start < 20, "animation must ease into a long journey");
		h.finish();
		assert.ok(Math.abs(h.rowGap(id) - 24) <= 1, `new question is at ${h.rowGap(id)}px, not the viewport top`);
	} finally {
		h.unmount();
	}
});

test("short conversations do not acquire artificial scroll space or lose follow mode", () => {
	const h = sendScrollHarness({ height: 160 });
	try {
		h.send();
		h.advance();
		h.finish();
		assert.equal(h.viewport.scrollTop, 0);
		assert.equal(h.spacer.offsetHeight, 0);
		assert.equal(h.controller.autoScroll, true);
	} finally {
		h.unmount();
	}
});

test("a fast assistant append does not hide the new user message from send positioning", () => {
	const h = sendScrollHarness();
	try {
		const id = h.send(undefined, { reply: true });
		h.advance();
		h.finish();
		assert.ok(Math.abs(h.rowGap(id) - 24) <= 1);
	} finally {
		h.unmount();
	}
});

test("stream rerenders do not cancel the send animation and consumed space shrinks without a jump", () => {
	const h = sendScrollHarness();
	try {
		h.browse();
		const id = h.send();
		h.advance();
		for (let i = 0; i < 12; i++) {
			h.advance();
			h.stream();
		}
		h.finish();
		assert.ok(Math.abs(h.rowGap(id) - 24) <= 1);
		const space = h.spacer.offsetHeight;
		const top = h.viewport.scrollTop;
		h.stream();
		assert.equal(h.spacer.offsetHeight, Math.max(0, space - 20));
		assert.equal(h.viewport.scrollTop, top);
		assert.equal(h.controller.autoScroll, true, "normal streaming follow resumes after the one-off positioning");
	} finally {
		h.unmount();
	}
});

test("manual scrolling cancels send positioning immediately without removing space and clamping", () => {
	const h = sendScrollHarness();
	try {
		h.browse();
		h.send();
		for (let i = 0; i < 12; i++) h.advance();
		h.input();
		const stopped = h.viewport.scrollTop;
		h.finish();
		assert.equal(h.viewport.scrollTop, stopped);
		assert.equal(h.controller.autoScroll, false);
	} finally {
		h.unmount();
	}
});

test("session switching disposes send animation and spacer instead of scrolling the new session", () => {
	const h = sendScrollHarness();
	try {
		h.browse();
		h.send();
		h.advance();
		h.switchSession();
		h.finish();
		assert.equal(h.spacer.offsetHeight, 0);
		assert.equal(h.viewport.scrollTop, 0);
	} finally {
		h.unmount();
	}
});

test("a failed live-edge restore exposes go-bottom instead of silently losing follow", () => {
	const h = sendScrollHarness({ bottomScrollSucceeds: false });
	try {
		h.switchSession();
		h.returnToSourceAtLiveEdge();
		h.advance();
		h.advance();
		assert.equal(h.viewport.scrollTop, 0, "the injected restore failure must remain observable");
		assert.equal(h.controller.autoScroll, false);
		assert.equal(h.controller.showScrollToBottom, true);
	} finally {
		h.unmount();
	}
});

test("history mounting alone never replays a send animation", () => {
	const h = sendScrollHarness();
	try {
		h.finish();
		assert.equal(h.spacer.offsetHeight, 0);
		assert.equal(h.viewport.scrollTop, 2200);
		assert.deepEqual(h.calls, []);
	} finally {
		h.unmount();
	}
});

// 回归（用户反馈「DSH 会话发消息没有平滑置顶动画」）：DSH 新会话的乐观气泡常在面板
// 完成历史恢复前就进缓存；旧实现只在那一帧刷新基线，恢复完成后 id 不再变化，动画被吞。
test("a send published before the timeline finishes restoring gets positioned afterwards", () => {
	const h = sendScrollHarness({ startLoading: true });
	try {
		h.beginSendState();
		h.send("optimistic-uuid");
		// 发送态在恢复完成前已回到 idle（host 已受理），不能因此丢掉这次定位。
		h.endSendState();
		h.releaseLoad();
		h.finish();
		assert.ok(Math.abs(h.rowGap("optimistic-uuid") - 24) <= 1, `gap=${h.rowGap("optimistic-uuid")}`);
	} finally {
		h.unmount();
	}
});

// 反向保护：恢复期间读盘/投影填充历史也会改变末条 user id，不能当成发送重播定位。
test("history landing during restore does not replay send positioning", () => {
	const h = sendScrollHarness({ startLoading: true });
	try {
		h.releaseHistory();
		h.releaseLoad();
		h.finish();
		assert.equal(h.spacer.offsetHeight, 0);
		assert.equal(h.controller.autoScroll, true);
	} finally {
		h.unmount();
	}
});

// 引导页首发 / 切页回来：面板挂载时乐观气泡已经在缓存里（没人观察到 id 变化），
// 发送态仍 in-flight 且 requestId 就是这条 user 消息时，恢复完成后要补一次定位。
test("a pane mounted with an in-flight optimistic message still gets send positioning", () => {
	const h = sendScrollHarness({ startLoading: true, startWithOptimistic: true });
	try {
		h.releaseLoad();
		h.finish();
		assert.ok(Math.abs(h.rowGap("optimistic-uuid") - 24) <= 1, `gap=${h.rowGap("optimistic-uuid")}`);
	} finally {
		h.unmount();
	}
});

test("returning to an in-flight send restores its history anchor without replaying send positioning", () => {
	const h = sendScrollHarness({ startLoading: true, startWithOptimistic: true, startWithAnchor: true, latestTop: 1000 });
	try {
		h.releaseLoad();
		h.finish();
		assert.ok(Math.abs(h.rowGap("optimistic-uuid") - 96) <= 1, `restored gap=${h.rowGap("optimistic-uuid")}`);
		assert.equal(h.controller.autoScroll, false);
		assert.equal(h.controller.showScrollToBottom, true);
	} finally {
		h.unmount();
	}
});

/* ── 发送置顶动画进行中标记：TurnRow 的「新一轮折叠」据此延后 ──
 * 背景（2026-10 用户反馈「发送后动画先向上再向下」）：折叠信号在动画途中把上一轮执行过程
 * 收掉，上方内容骤缩 → 视口补偿把 scrollTop 往回带。标记必须在动画期间为 true，
 * 且任何结束路径（完成 / 用户滚动 / 切会话 / 短会话）都要落回 false，否则折叠永远不执行。 */

test("清屏动画期间标记会话为「置顶中」，动画结束即撤销", () => {
	const h = sendScrollHarness();
	try {
		h.browse();
		h.send();
		h.advance();
		assert.equal(h.sendPinAnimating(), true, "动画开始后必须立起标记");
		h.finish();
		assert.equal(h.sendPinAnimating(), false, "动画结束后必须撤销标记");
	} finally {
		h.unmount();
	}
});

test("用户滚动打断动画时同样撤销标记（不留悬挂 true）", () => {
	const h = sendScrollHarness();
	try {
		h.browse();
		h.send();
		for (let i = 0; i < 6; i++) h.advance();
		assert.equal(h.sendPinAnimating(), true);
		h.input();
		assert.equal(h.sendPinAnimating(), false, "用户接管滚动后不得继续推迟折叠");
	} finally {
		h.unmount();
	}
});

test("切会话时撤销标记，不把旧会话的「置顶中」带到新会话", () => {
	const h = sendScrollHarness();
	try {
		h.browse();
		h.send();
		h.advance();
		assert.equal(h.sendPinAnimating(), true);
		h.switchSession();
		assert.equal(h.sendPinAnimating("s1"), false);
	} finally {
		h.unmount();
	}
});

test("短会话不播置顶动画，也不残留标记", () => {
	const h = sendScrollHarness({ height: 160 });
	try {
		h.send();
		h.advance();
		h.finish();
		assert.equal(h.sendPinAnimating(), false);
	} finally {
		h.unmount();
	}
});

test("pi 预热重投影同一 entryId 不触发发送定位，也不打断历史浏览", () => {
	const h = sendScrollHarness({ viewerProjection: true });
	try {
		h.browse();
		const start = h.viewport.scrollTop;
		h.reproject();
		h.advance();
		h.finish();
		assert.equal(h.viewport.scrollTop, start, "同一条消息换 id 不得移动视口");
		assert.equal(h.spacer.offsetHeight, 0, "不得创建发送定位垫片");
		assert.equal(h.controller.autoScroll, false, "应停留在历史浏览模式，不重锁跟底");
		assert.ok(!h.sendPinAnimating(), "不得置位发送置顶动画标记");
		// 重投影后再发一条新消息（无 entryId）：发送定位仍必须正常工作。
		const id = h.send();
		h.advance();
		h.finish();
		assert.ok(Math.abs(h.rowGap(id) - 24) <= 1, `重投影后的真实发送仍应置顶，实际 ${h.rowGap(id)}px`);
	} finally {
		h.unmount();
	}
});
