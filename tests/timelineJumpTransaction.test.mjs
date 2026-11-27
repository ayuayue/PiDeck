import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";
const ref = (current) => ({ current });
const noop = () => {};
function harness() {
	const host = quickMessageHookHost();
	const frames = new Map();
	let sequence = 0;
	const load = createTsSandbox({
		stubs: { react: host.react, "../../../utils/rendererLog": { logFromRenderer: noop }, "../../../utils/notice": { showNotice: noop }, "../../../i18n": { t: (x) => x } },
		globals: {
			performance: { now: () => 1 },
			CSS: { escape: (x) => x },
			requestAnimationFrame: (fn) => {
				frames.set(++sequence, fn);
				return sequence;
			},
			cancelAnimationFrame: (id) => frames.delete(id),
		},
	});
	return {
		host,
		load,
		frames,
		tick() {
			const tasks = [...frames.values()];
			frames.clear();
			tasks.forEach((fn) => fn());
		},
	};
}

test("点击已挂载的最后三条也开启新事务并取消旧pending跳转", () => {
	const h = harness();
	const { useTimelineJumpNavigation } = h.load("src/renderer/src/hooks/session/timeline/useTimelineJumpNavigation.ts");
	const row = { dataset: { messageId: "latest" }, getBoundingClientRect: () => ({ top: 50, height: 30 }), getClientRects: () => [1] };
	const timeline = { scrollTop: 0, querySelector: () => row, getBoundingClientRect: () => ({ top: 0 }) };
	const pending = [];
	const nonce = ref(4);
	const options = {
		ownerKey: "s",
		ownerKeyRef: ref("s"),
		timelineRef: ref(timeline),
		combinedMessages: [{ id: "latest" }],
		scrollerScrollApiRef: ref({ restoreAt: noop }),
		browsePinRef: ref(null),
		browsePinFrozenRef: ref(false),
		skipBrowsePinRef: ref(false),
		jumpSettleInterruptedRef: ref(false),
		jumpNonceRef: nonce,
		hasEarlierPages: true,
		isSurfaceLoading: false,
		escapeAutoScroll: noop,
		markProgrammaticScroll: noop,
		highlightMessage: noop,
		requestTimelineReveal: noop,
		clearTimelineReveal: noop,
		expandWindowBatched: noop,
		setShowScrollToBottom: noop,
		setPendingJump: (value) => pending.push(value),
		setJumpAnchorMessageId: noop,
	};
	try {
		const nav = h.host.render(() => useTimelineJumpNavigation(options));
		nav.jumpToMessage("latest");
		assert.equal(nonce.current, 5);
		assert.equal(pending.at(-1), undefined);
		nav.jumpToMessage("latest");
		assert.equal(nonce.current, 6);
	} finally {
		h.host.unmount();
	}
});

test("旧跳转的等待帧不能在新点击后改写视口", () => {
	const h = harness();
	const { useJumpRowWait } = h.load("src/renderer/src/hooks/session/timeline/useJumpRowWait.ts");
	let found = 0;
	try {
		const wait = h.host.render(() => useJumpRowWait({ messagesRef: ref([{ id: "live" }]), resolveIndex: () => 0, onFound: () => found++, onExhausted: noop, expandWindowBatched: noop }));
		wait.waitForRow({ querySelector: () => ({}) }, "live", () => false);
		h.tick();
		assert.equal(found, 0);
		assert.equal(h.frames.size, 0);
	} finally {
		h.host.unmount();
	}
});

test("取页A未返回时已点击B：A 的代数判定必须为假，等待与锚点都不许再动", async () => {
	const h = harness();
	const { useTimelineJumpChain } = h.load("src/renderer/src/hooks/session/timeline/useTimelineJumpChain.ts");
	const guards = [];
	let current = { ownerKey: "s", value: { messageId: "old", requestId: 1, nonce: 1, expandAttempts: 0, loadAttempts: 0, expandedTurns: 0, startedAt: 1, waitFrames: 0, observedCount: -1, stalledAttempts: 0 } };
	const anchors = [];
	let waits = 0;
	const options = {
		controllerEnabled: true,
		get pendingJump() {
			return current;
		},
		setPendingJump: noop,
		timelineRef: ref({ querySelector: () => null }),
		combinedMessages: [{ id: "other" }],
		ownerKey: "s",
		ownerKeyRef: ref("s"),
		jumpNonceRef: ref(1),
		hasEarlierPages: true,
		isSurfaceLoading: false,
		isLoadingMessagePage: false,
		loadMoreError: null,
		loadMoreMessages: noop,
		scrolledWindowTurns: 3,
		skipBrowsePinRef: ref(false),
		pendingExpandTurnsRef: ref(0),
		jumpAnchorMessageId: null,
		setJumpAnchorMessageId: (value) => anchors.push(value),
		scrollJumpTargetIntoView: noop,
		settleJumpTarget: noop,
		highlightMessage: noop,
		clearTimelineReveal: noop,
		requestTimelineReveal: noop,
		findFallbackJumpRow: () => null,
		readLastJumpOutcome: () => "idle",
		loadPageAroundEntry: (_wanted, isCurrent) => {
			guards.push(isCurrent);
			return new Promise(() => {});
		},
		waitForJumpRow: () => waits++,
		expandWindow: noop,
	};
	try {
		h.host.render(() => useTimelineJumpChain(options));
		assert.equal(guards.length, 1, "第一次取页必须带代数判定");
		assert.equal(guards[0](), true, "本次点击仍是最新请求");
		// 用户又点了另一条：新请求到来，旧请求代数作废。
		options.jumpNonceRef.current = 2;
		assert.equal(guards[0](), false, "点击当场取消旧请求，不能等React重绘后才取消");
		current = { ownerKey: "s", value: { ...current.value, messageId: "new", requestId: 2, nonce: 2 } };
		h.host.render(() => useTimelineJumpChain(options));
		assert.equal(guards[0](), false, "迟到结果必须被判为过期，不能再设锚点或启动等待");
		assert.deepEqual(anchors, [], "过期取页不得写锚点");
		assert.equal(waits, 0, "过期取页不得启动等行循环");
		h.host.unmount();
		assert.equal(guards.at(-1)(), false, "卸载后迟到响应不能再改缓存或视口");
	} finally {
		h.host.unmount();
	}
});
