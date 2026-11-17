import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

function setup({ following = true, anchor, loading = false } = {}) {
	const host = quickMessageHookHost();
	const frames = new Map();
	const timers = new Map();
	let nextId = 0;
	const saved = [];
	const row = { id: "answer", top: -80, bottom: 700, isRootRow: true };
	const timeline = {
		scrollTop: 300,
		scrollHeight: 1600,
		clientHeight: 400,
		getBoundingClientRect: () => ({ top: 20 }),
		querySelector: () => ({ getBoundingClientRect: () => ({ top: -60 }) }),
	};
	const options = {
		messages: [{ id: "answer", meta: { entryId: "entry-answer" } }],
		ownerKey: "session-A",
		legacyOwnerKey: "legacy",
		controllerEnabled: true,
		effectiveWindowTurns: 6,
		renderedWindowTurnsRef: { current: 6 },
		timelineRef: { current: timeline },
		ownerKeyRef: { current: "session-A" },
		autoScrollRef: { current: following },
		setAutoScroll: (value) => (options.autoScrollRef.current = value),
		setShowScrollToBottom: (value) => (options.showButton = value),
		restoreAnchor: anchor,
		setRestoreAnchor: (value) => (options.restoreAnchor = value),
		restorePhase: "pending",
		setRestorePhase: (value) => (options.restorePhase = value),
		scrolledWindowTurns: 6,
		setScrolledWindowTurns: () => {},
		isSurfaceLoading: loading,
		hasEarlierPages: false,
		isLoadingMessagePage: false,
		loadMoreMessages: () => {},
		markProgrammaticScroll: () => {},
		scrollerScrollApiRef: {
			current: {
				scrollToBottom: () => (timeline.scrollTop = timeline.scrollHeight - timeline.clientHeight),
				restoreAt: (top) => (timeline.scrollTop = top),
			},
		},
		browsePinRef: { current: null },
		browsePinFrozenRef: { current: false },
		pinFallbackHeightRef: { current: 0 },
		programmaticScrollGuardRef: { current: { generation: 0, suppressUntil: 0 } },
		sendScrollRef: { current: { isAnimating: false } },
		settleScrollCancelRef: { current: undefined },
		windowExpandableRef: { current: false },
		readVisibleRowsRef: { current: () => [row] },
		measurePinnedRowTop: () => row.top,
		findBrowsePin: () => ({ messageId: row.id, expectedViewportTop: row.top }),
		isTimelineAtBottom: (top, height, viewport) => height - top - viewport < 16,
		timelineViewportTop: () => 20,
		bottomThreshold: 16,
		saveScrollAnchor: (value) => saved.push(value),
	};
	const { useTimelineScrollAnchor } = loadTsCommonJs("src/renderer/src/hooks/session/timeline/useTimelineScrollAnchor.ts", {
		stubs: { react: host.react },
		globals: {
			requestAnimationFrame: (callback) => {
				frames.set(++nextId, callback);
				return nextId;
			},
			cancelAnimationFrame: (id) => frames.delete(id),
			window: {
				setTimeout: (callback) => {
					timers.set(++nextId, callback);
					return nextId;
				},
				clearTimeout: (id) => timers.delete(id),
			},
			performance: { now: () => 1000 },
			CSS: { escape: (value) => value },
		},
	});
	const render = () => host.render(() => useTimelineScrollAnchor(options));
	return {
		options,
		timeline,
		saved,
		render,
		unmount: () => host.unmount(),
		frame() {
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) callback(1000);
		},
	};
}

test("跟随中的流式大幅增高不保存为阅读锚点，切回仍跟随", () => {
	const h = setup({ loading: true });
	h.render().handleTimelineScroll();
	h.frame();
	h.unmount();
	assert.equal(h.saved.at(-1).sessionId, "session-A");
	assert.equal(h.saved.at(-1).anchor, null, "几何滞后不能替代用户已退出跟随的状态");
});

test("无锚点恢复后两帧间正文增高，继续跟随且不出现回底按钮", () => {
	const h = setup();
	h.render();
	h.frame();
	h.render();
	assert.equal(h.timeline.scrollTop, 1200);
	h.timeline.scrollHeight += 96;
	h.frame();
	assert.equal(h.options.autoScrollRef.current, true);
	assert.equal(h.options.showButton, false);
	h.unmount();
});

test("阅读后同一任务内切走，不等下一帧也保存旧会话锚点", () => {
	const h = setup({ following: false, loading: true });
	h.render().handleTimelineScroll();
	h.options.ownerKeyRef.current = "session-B";
	h.unmount();
	assert.equal(h.saved.at(-1).sessionId, "session-A");
	assert.equal(h.saved.at(-1).anchor.messageId, "answer");
	assert.equal(h.saved.at(-1).anchor.offsetTop, -80);
	assert.equal(h.saved.at(-1).anchor.windowTurns, 6);
});

test("上滚阅读仍保存稳定行、负偏移与窗口，切回原位并保持回底入口", () => {
	const h = setup({ following: false, loading: true });
	h.render().handleTimelineScroll();
	h.frame();
	h.unmount();
	const anchor = h.saved.at(-1).anchor;
	assert.equal(anchor.messageId, "answer");
	assert.equal(anchor.entryId, "entry-answer");
	assert.equal(anchor.offsetTop, -80);
	assert.equal(anchor.windowTurns, 6);
	const restored = setup({ anchor });
	restored.render();
	restored.frame();
	assert.equal(restored.options.autoScrollRef.current, false);
	assert.equal(restored.options.showButton, true);
	assert.equal(restored.timeline.scrollTop, 300);
	assert.equal(restored.options.browsePinRef.current.messageId, "answer");
	restored.unmount();
});

test("恢复后的用户上滚仍有权退出跟随，后续帧不抢回", () => {
	const h = setup();
	h.render();
	h.frame();
	h.render();
	h.options.autoScrollRef.current = false;
	h.options.setShowScrollToBottom(true);
	h.timeline.scrollTop -= 200;
	h.frame();
	assert.equal(h.options.autoScrollRef.current, false);
	assert.equal(h.options.showButton, true);
	h.unmount();
});

test("切换 owner 后旧恢复帧不能滚动新会话", () => {
	const h = setup();
	h.render();
	h.options.ownerKeyRef.current = "session-B";
	h.frame();
	assert.equal(h.timeline.scrollTop, 300);
	assert.equal(h.options.restorePhase, "pending");
	h.unmount();
});
