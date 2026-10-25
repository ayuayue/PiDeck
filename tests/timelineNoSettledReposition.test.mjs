import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/** Render the actual timeline effects with virtual time, without a live pi process. */
function timelineHarness() {
	const host = quickMessageHookHost();
	let clock = 0;
	let timerId = 0;
	const timers = new Map();
	const messages = [
		{ id: "u1", role: "user", text: "question", timestamp: 1, agentId: "agent" },
		{ id: "a1", role: "assistant", text: "answer", timestamp: 2, agentId: "agent" },
	];
	const record = { id: "s1", projectId: "p1", status: "active" };
	let runtime = { agentId: "agent", runtimeGeneration: 1, status: "running", state: {} };
	const calls = [];
	const react = {
		...host.react,
		useLayoutEffect: host.react.useEffect,
		useMemo: (factory, deps) => host.react.useCallback(factory, deps)(),
		// SingleLinePreview 等新拉入的真实组件用到 memo：转发函数即可满足 harness 语义。
		memo: (fn) => fn,
	};
	const atomKey = (name) => name;
	const jsx = (type, props) => ({ type, props });
	const controller = {
		messages,
		visibleMessages: messages,
		totalMessageCount: messages.length,
		hasMoreMessages: false,
		isLoadingMoreMessages: false,
		autoScroll: true,
		scrolledWindowTurns: 3,
		timelineRef: { current: null },
		windowExpandableRef: { current: false },
		scrollFinalAnswerToUpperMiddle: (id) => calls.push(id),
		cancelSettledRepositionForNewRun: () => {},
		markProgrammaticScroll: () => {},
		pinBrowseRow: () => {},
	};
	const load = createTsSandbox({
		stubs: {
			react,
			"react/jsx-runtime": { jsx, jsxs: jsx },
			jotai: {
				useAtomValue: (key) => {
					if (key === "record") return record;
					if (key === "runtime") return runtime;
					if (key === "cache") return { messages };
					if (typeof key === "function") return key();
					return false;
				},
			},
			"jotai/utils": { selectAtom: (value, select) => () => select(value) },
			"motion/react": { useReducedMotion: () => false },
			"../../atoms": {
				sessionRecordByIdAtomFamily: () => "record",
				sessionRuntimeBySessionIdAtomFamily: () => "runtime",
				sessionMessageCacheBySessionIdAtomFamily: () => "cache",
				sessionMessageLoadStateAtom: { s1: { status: "ready" } },
				sessionSendStateByIdAtom: {},
				liveThinkingIdBySessionIdAtomFamily: atomKey,
				liveTextStreamingBySessionAtom: atomKey,
				liveThinkingStreamingBySessionAtom: atomKey,
			},
			"../../atoms/ask-echo-atoms": { askEchoBySessionIdAtomFamily: atomKey },
			"../../utils/askUi": { injectAskEchoMessage: (items) => items },
			"../../hooks/useTimelineSelection": { useTimelineSelection: () => ({ quote: null, clear: () => {}, toolbarRef: { current: null } }) },
			// 消息右键菜单：时间线新增的两个 import 若不 stub 会去加载真实组件图
			// （hook → SurfaceParts → SurfaceComponents → motion/preview-rail 的 "@/lib/ease"
			// 以及 view → dropdown-menu 的 "@/lib/floatingWheelGuard" 都是沙箱解析不了的 alias）。
			"../../hooks/useMessageContextMenu": { useMessageContextMenu: () => ({ state: null, handleContextMenu: () => {}, close: () => {}, copy: () => {}, selectAll: () => {} }) },
			"./timeline/MessageContextMenu": {},
			"../../hooks/useSessionVisionBridgeExpected": { useSessionVisionBridgeExpected: () => false },
			// 收藏入口（useFavorites）会牵进 favorites-atoms → 真实 atoms 图（jotai atom），
			// 与滚动重定位无关，这里只保留时间线读取的两个成员。
			"../../hooks/useFavorites": { useFavorites: () => ({ favoritedMessageKeys: new Set(), toggleMessageFavorite: () => {} }) },
			"../../hooks/useSessionTimelineController": {
				canLoadSessionTimelineMore: () => true,
				deriveSessionSurfaceRuntime: (_count, _load, _send, status) => ({ isLoading: false, isStarting: false, isBusy: status === "running", status }),
			},
			"../app/AppUtils": {
				groupToolMessages: () => [
					{ kind: "message", message: messages[0] },
					{ kind: "agent-run", id: "a1", steps: [], finalAnswer: messages[1] },
				],
				reconcileRuns: (_previous, next) => next,
			},
			"./SurfaceParts": {},
			"./MarkdownStream": {},
			"./composer/quoteChip": {},
			"./timeline/SelectionToolbar": {},
			"../../utils/clipboard": {},
			"../../utils/notice": {},
			"../../i18n": { t: (key) => key },
			"../../lib/utils": { cn: (...parts) => parts.filter(Boolean).join(" ") },
			"@/lib/utils": { cn: (...parts) => parts.filter(Boolean).join(" ") },
			"../ui-shadcn/button": {},
			"lucide-react": {},
			"./timelineFailureNotice": { reduceFailureNoticePass: ({ state }) => ({ state, toasts: [] }) },
			"./SessionStartSurface": {},
			"./NotifyMessageCard": {},
			"../agents/message-scroller": {},
		},
		globals: {
			window: {
				setTimeout: (fn, delay) => {
					timers.set(++timerId, { fn, at: clock + delay });
					return timerId;
				},
				clearTimeout: (id) => timers.delete(id),
			},
		},
	});
	const { SessionMessageTimeline } = load("src/renderer/src/components/session/SessionMessageTimeline.tsx");
	const render = () => host.render(() => SessionMessageTimeline({ sessionId: "s1", controller }));
	return {
		calls,
		render,
		idle() {
			runtime = { ...runtime, status: "idle" };
			render();
		},
		advance(ms) {
			const until = clock + ms;
			while (true) {
				const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) break;
				clock = next[1].at;
				timers.delete(next[0]);
				next[1].fn();
			}
			clock = until;
		},
		unmount: host.unmount,
	};
}

test("finishing a reply never schedules a scroll back to its beginning", () => {
	const h = timelineHarness();
	try {
		h.render();
		h.idle();
		h.advance(5000);
		assert.deepEqual(h.calls, [], "reply completion must only collapse process details, never reposition the viewport");
	} finally {
		h.unmount();
	}
});
