import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function compile(filePath, imports = {}, globals = {}) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: (id) => imports[id] ?? nodeRequire(id),
		Date,
		...globals,
	});
	return module.exports;
}

const browsePin = compile("src/renderer/src/hooks/timeline/browsePin.ts");
// #400 的视口行筛选是纯函数（不碰 DOM）：拿真实模块直接驱动几何用例，
// 不再用正则去钉实现字符串。
const visibleRowsModule = compile("src/renderer/src/hooks/timeline/useVisibleTimelineRows.ts", { react: {} });

const timeline = compile("src/renderer/src/hooks/useSessionTimelineController.ts", {
	react: {},
	jotai: { atom: (value) => ({ _mockInit: value }) },
	"jotai/utils": {},
	"../atoms": {},
	// 轨道揭示（2026-10 新增）：控制器只存/取标量 atom，stub 成稳定占位即可。
	"../atoms/timeline-reveal-atoms": { clearTimelineRevealAtom: {}, requestTimelineRevealAtom: {} },
	"../lib/pinTurnScroll": { animateScrollTop: () => () => undefined, pinScrollDurationMs: () => 320 },
	"../desktopApi": {},
	// 控制器用 t() 播报「DSH 已停止」文案，而 i18n.ts 会拉起整份字典 → 给最小 stub；
	// sessionHistoryAvailability 是纯函数（只有 type import），照 browsePin 的做法编译真模块。
	// 两个都必须在 stub 表里：缺失时 loader 回落到以 tests/ 为基准的 nodeRequire，解析 .ts 必失败。
	"../i18n": { t: (key) => key },
	"../utils/sessionHistoryAvailability": compile("src/renderer/src/utils/sessionHistoryAvailability.ts"),
	"./timeline/autoExpandThreshold": { TURN_WINDOW_AUTO_EXPAND_THRESHOLD: 120, resolveAutoExpandThreshold: (h) => Math.max(120, Math.round(h * 0.4)) },
	"./timeline/scrollHistoryPolicy": {},
	// programmaticScrollGuard 是纯模块（无内部 import），直接编译真模块；缺这一条时 loader 会
	// 回落到以 tests/ 为基准的 nodeRequire，解析 .ts 必失败（模块已搬到 hooks/timeline）。
	"./timeline/programmaticScrollGuard": compile("src/renderer/src/hooks/timeline/programmaticScrollGuard.ts"),
	"../components/session/timeline/turnRenderWindow": {
		TIMELINE_SCROLLED_TURN_LIMIT: 3,
		TIMELINE_WINDOW_EXPAND_STEP: 3,
	},
	// useSessionTimelineController 引入 jumpWindowPolicy（策略函数），loader 缺此 stub 时
	// 回落到 nodeRequire 解析 .ts 失败。其自身依赖 ./turnRenderWindow，用同名 mock 即可。
	"../components/session/timeline/jumpWindowPolicy": compile("src/renderer/src/components/session/timeline/jumpWindowPolicy.ts", { "./turnRenderWindow": { TIMELINE_WINDOW_EXPAND_STEP: 3 } }),
	// 会话内查找落位归一（1055e794b 引入）：纯函数 + DOM 兜底，无内部 import。
	"../components/session/timeline/jumpTarget": compile("src/renderer/src/components/session/timeline/jumpTarget.ts"),
	"./timeline/browsePin": browsePin,
	// SendScrollPositioner（612bb51c1 从 controller 迁出）：真实模块自身只依赖
	// ../../lib/pinTurnScroll，与 ../lib/pinTurnScroll 同名 mock 共享即可。
	"./timeline/sendScroll": compile("src/renderer/src/hooks/timeline/sendScroll.ts", {
		"../../lib/pinTurnScroll": { animateScrollTop: () => () => undefined, pinScrollDurationMs: () => 320 },
	}),
	// 磁盘分页游标（控制器把 SessionMessagePage 收敛成缓存游标）：纯函数，直接编译真模块。
	"../utils/sessionDiskPageCursor": compile("src/renderer/src/utils/sessionDiskPageCursor.ts"),
	// 宿主插件 entryId 定位的轮询计划（reveal 通道）：controller 已改为值导入，
	// 缺这一条时 loader 会回落到以 tests/ 为基准的 nodeRequire，解析 .ts 必失败。
	"./timeline/timelineRevealChannel": compile("src/renderer/src/hooks/timeline/timelineRevealChannel.ts"),
	// #400：控制器改为经 useVisibleTimelineRows 读视口内行，并用它导出的轮根选择器。
	// 两样都必须给：只给 hook 不给 ROOT_ROW_SELECTOR 时，控制器里两处
	// querySelectorAll(ROOT_ROW_SELECTOR) 会拿到 undefined（2026-10-23 评审指出的替身不完整）。
	"./timeline/useVisibleTimelineRows": {
		ROOT_ROW_SELECTOR: visibleRowsModule.ROOT_ROW_SELECTOR,
		useVisibleTimelineRows: () => ({ readVisibleRows: () => [] }),
	},
});

const composerController = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
const runtimeController = readFileSync("src/renderer/src/hooks/useSessionRuntimeController.ts", "utf8");
const composerArea = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
const header = readFileSync("src/renderer/src/components/session/SessionHeader.tsx", "utf8");
const headerCss = readFileSync("src/renderer/src/styles/foundation.css", "utf8");

test("background runtime start is not a user-facing start", () => {
	// 输入预热会把 runtime 打成 starting，但 send 仍是 idle：不能当成「正在启动」去锁 UI。
	assert.equal(timeline.isUserFacingSessionStart("idle"), false);
	assert.equal(timeline.isUserFacingSessionStart(undefined), false);
	assert.equal(timeline.isUserFacingSessionStart("sending"), false);
	assert.equal(timeline.isUserFacingSessionStart("activating"), true);
});

test("prewarming an empty ready session does not flash the history skeleton", () => {
	const prewarm = timeline.deriveSessionSurfaceRuntime(0, "ready", "idle", "starting", undefined, true);
	assert.equal(prewarm.isLoading, false);
	assert.equal(prewarm.isStarting, false);
	assert.equal(prewarm.isBusy, false);
});

test("send activating still counts as starting, but does not replace start surface with skeleton", () => {
	// 空会话点发送：保留起始页，等首条消息上屏；不要先闪一轮骨架屏。
	const sending = timeline.deriveSessionSurfaceRuntime(0, "ready", "activating", "starting", undefined, true);
	assert.equal(sending.isStarting, true);
	assert.equal(sending.isBusy, true);
	assert.equal(sending.isLoading, false);
	assert.equal(sending.status, "starting");
});

test("composer lock follows send activating, not background runtime starting", () => {
	// 预热只创建进程，不能 setEditable(false)，否则输入一半失焦。
	assert.match(composerController, /isUserFacingSessionStart\(sendState\.status\)/);
	assert.doesNotMatch(composerController, /runtime\?\.status === "starting" \|\| sendState\.status === "activating"/);
	assert.match(composerArea, /disabled=\{composer\.isStarting\}/);
});

test("session header does not grow when agent is only prewarming", () => {
	assert.match(runtimeController, /isUserFacingSessionStart\(/);
	assert.doesNotMatch(runtimeController, /activeConversationStatus === "starting" \|\s*currentSessionSendState\.status === "activating"/);
	assert.match(header, /isStarting \? " loading"/);
	// 标题行是 h-7（28px）；loading 再写 min-height:36px 会把整栏顶高一截。
	assert.doesNotMatch(headerCss, /\.chat-header-actions\.loading \{[\s\S]*?min-height:\s*36px/);
});

// ── #400 浏览钉快路径（评审 d#1：替身恒返回 []，快路径 0 次执行 → 这里直接驱动它）
test("pickVisibleRootRow：只认没被视口顶切掉的轮根（锚点与浏览钉共用这一判据）", () => {
	const rows = [
		{ id: "cut", top: -80, bottom: 0, isRootRow: true },
		{ id: "card", top: 2, bottom: 20, isRootRow: false },
		{ id: "root", top: 30, bottom: 90, isRootRow: true },
	];
	assert.equal(browsePin.pickVisibleRootRow(rows).id, "root");
	assert.equal(browsePin.pickVisibleRootRow([]), null);
	assert.equal(browsePin.pickVisibleRootRow([{ id: "card", top: 2, bottom: 20, isRootRow: false }]), null);
});

const domRow = (id, top, bottom) => ({
	dataset: { messageId: id },
	getBoundingClientRect: () => ({ top, bottom, width: 10, height: bottom - top }),
});
const fakeTimeline = (rows = []) => ({
	getBoundingClientRect: () => ({ top: 100, bottom: 900, width: 800, height: 800 }),
	clientTop: 0,
	querySelectorAll: () => rows,
});

test("findBrowsePin 快路径：跳过被视口顶切掉的行，取第一条底部仍在视口内的轮根", () => {
	const rows = [
		{ id: "cut", top: -80, bottom: 0, isRootRow: true },
		{ id: "next", top: 6, bottom: 40, isRootRow: true },
	];
	const pin = timeline.findBrowsePin(fakeTimeline(), rows);
	assert.equal(pin.messageId, "next");
	assert.equal(pin.expectedViewportTop, 6);
});

test("findBrowsePin 快路径优先轮根：卡类行在前也不选它", () => {
	const rows = [
		{ id: "card", top: 2, bottom: 20, isRootRow: false },
		{ id: "root", top: 30, bottom: 90, isRootRow: true },
	];
	const pin = timeline.findBrowsePin(fakeTimeline(), rows);
	assert.equal(pin.messageId, "root");
	assert.equal(pin.expectedViewportTop, 30);
});

test("findBrowsePin 快路径无轮根时回落全量遍历（评审 d#3 的回归点）", () => {
	const cards = [{ id: "card", top: 2, bottom: 20, isRootRow: false }];
	const fallback = [domRow("below", 150, 200)];
	const pin = timeline.findBrowsePin(fakeTimeline(fallback), cards);
	assert.equal(pin.messageId, "below");
	assert.equal(pin.expectedViewportTop, 50);
});

test("findBrowsePin 空可见集合走全量遍历", () => {
	const fallback = [domRow("only", 120, 180)];
	const pin = timeline.findBrowsePin(fakeTimeline(fallback), []);
	assert.equal(pin.messageId, "only");
	assert.equal(pin.expectedViewportTop, 20);
});

// ── #400 视口行筛选（纯函数）：几何用例钉住判据，不再用正则匹配实现 ──
const row = (id, top, bottom, isRootRow = true, width = 10, height = bottom - top) => ({ id, top, bottom, isRootRow, width, height });
// vm 沙箱里创建的数组原型属于另一个 realm，deepStrictEqual 会判不等；Array.from 转回主 realm。
const selectIds = (rows, viewportHeight = 800) => Array.from(visibleRowsModule.selectVisibleRows(rows, viewportHeight), (entry) => entry.id);

test("selectVisibleRows：视口顶部落在行间空白时仍返回下一行", () => {
	// .turn-row 的 mb-6 是 24px：A.bottom=-10、B.top=14 时视口顶边落在空白里，
	// 全量分支会选 B；旧的「第一名 top>1 就整份判废」会把这次结果白白丢掉、退回全量扫描。
	assert.deepEqual(selectIds([row("prev", -190, -10), row("next", 14, 194)]), ["next"]);
});

test("selectVisibleRows：顶部「加载更多」块占位时首行仍是有效结果", () => {
	// scrollTop < 加载更多块高度时首行 top 恒 > 1；这不是缓存缺行。
	assert.deepEqual(selectIds([row("first", 40, 220)]), ["first"]);
});

test("selectVisibleRows：向上快速滚动留下的迟到行被跳过而不是作废整份", () => {
	// IO 回调晚于 scroll 事件：上一帧的顶行已整行滚出上方（bottom<1），
	// 它必须被跳过，当前顶行仍要选中。
	assert.deepEqual(selectIds([row("stale", -300, -5), row("current", -20, 100)]), ["current"]);
});

test("selectVisibleRows：零面积行与视口下界以下的行都不参与", () => {
	// 零面积 = display:none / 折叠区被卸下：有意的行为变更，不再作为锚点。
	assert.deepEqual(selectIds([row("inview", 10, 90), row("hidden", 0, 0), row("below", 900, 1100)]), ["inview"]);
	assert.deepEqual(selectIds([]), []);
});

test("selectVisibleRows：零面积行（rect 全 0）在视口内也必须被几何判据排除", () => {
	// 真正触发 rect.width===0 && rect.height===0：行在视口内（top=100/bottom=100），
	// 但它没有布局盒（display:none / 折叠区被卸下），不能当锚点或浏览钉。
	assert.deepEqual(selectIds([row("zero", 100, 100, true, 0, 0), row("normal", 120, 200)]), ["normal"]);
	assert.deepEqual(selectIds([row("zero", 100, 100, true, 0, 0)]), []);
});

// ── #400 观察器生命周期（真实 hook + fake DOM）：负向样本必须能抓住旧实现 ──
function createObserverHarness() {
	const rafQueue = new Map();
	let rafId = 0;
	const ioInstances = [];
	const moInstances = [];
	class FakeIntersectionObserver {
		constructor(callback, options) {
			this.callback = callback;
			this.options = options;
			this.observed = new Set();
			this.disconnected = false;
			ioInstances.push(this);
		}
		observe(element) {
			// 与浏览器一致：disconnect 后 observe 会重新激活观察器 —— 旧实现的 bug 正是走这条。
			if (this.disconnected) this.disconnected = false;
			this.observed.add(element);
		}
		unobserve(element) {
			this.observed.delete(element);
		}
		disconnect() {
			this.disconnected = true;
		}
	}
	class FakeMutationObserver {
		constructor(callback) {
			this.callback = callback;
			this.disconnected = false;
			moInstances.push(this);
		}
		observe() {}
		disconnect() {
			this.disconnected = true;
		}
	}
	return {
		globals: {
			IntersectionObserver: FakeIntersectionObserver,
			MutationObserver: FakeMutationObserver,
			Node: { ELEMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
			requestAnimationFrame: (callback) => {
				rafId += 1;
				rafQueue.set(rafId, callback);
				return rafId;
			},
			cancelAnimationFrame: (id) => {
				rafQueue.delete(id);
			},
		},
		react: {
			useRef: (initial) => ({ current: initial }),
			useCallback: (callback) => callback,
			useEffect: (effect) => effect(),
		},
		ioInstances,
		moInstances,
		takeFrame: () => {
			const entry = rafQueue.entries().next().value;
			if (!entry) return undefined;
			rafQueue.delete(entry[0]);
			return entry[1];
		},
	};
}

const fakeRowRoot = (id) => ({
	nodeType: 1,
	dataset: { messageId: id },
	isConnected: true,
	matches: (selector) => selector === visibleRowsModule.ROOT_ROW_SELECTOR,
	querySelectorAll: () => [],
	getBoundingClientRect: () => ({ top: 0, bottom: 10, width: 10, height: 10 }),
});
const fakeScroller = (rootRows) => ({
	getBoundingClientRect: () => ({ top: 100, bottom: 900, width: 800, height: 800 }),
	clientTop: 0,
	clientHeight: 800,
	querySelectorAll: (selector) => (selector === visibleRowsModule.ROOT_ROW_SELECTOR ? rootRows : []),
});

test("teardown 后旧合并帧不会复活旧 IO（身份比较，而不是 !ioRef.current）", () => {
	const harness = createObserverHarness();
	const rowA = fakeRowRoot("turn-a");
	const rowB = fakeRowRoot("turn-b");
	const hook = compile("src/renderer/src/hooks/timeline/useVisibleTimelineRows.ts", { react: harness.react }, harness.globals);
	const ref = { current: fakeScroller([rowA]) };
	const { readVisibleRows } = hook.useVisibleTimelineRows(ref);
	readVisibleRows();
	const ioA = harness.ioInstances[0];
	const moA = harness.moInstances[0];
	// 旧观察者在轮换前已经排队的一帧：先出队，模拟「rAF 已开始执行、cancel 拦不住」。
	moA.callback([{ addedNodes: [rowB], removedNodes: [] }]);
	const staleFlush = harness.takeFrame();
	assert.equal(typeof staleFlush, "function");
	assert.equal(ioA.observed.has(rowB), false);
	ref.current = fakeScroller([rowB]);
	readVisibleRows(); // teardown 旧 IO/MO，再建新 IO
	assert.equal(ioA.disconnected, true);
	const observedBefore = ioA.observed.size;
	staleFlush();
	assert.equal(ioA.observed.size, observedBefore, "旧帧必须被丢弃，不能对旧 IO 重新 observe");
	assert.equal(ioA.disconnected, true, "旧帧不得把已 disconnect 的 IO 复活");
});

test("观察器只登记行根，行内子卡（data-message-id）不进集合", () => {
	const harness = createObserverHarness();
	const root = fakeRowRoot("turn-root");
	const hook = compile("src/renderer/src/hooks/timeline/useVisibleTimelineRows.ts", { react: harness.react }, harness.globals);
	const ref = { current: fakeScroller([root]) };
	const { readVisibleRows } = hook.useVisibleTimelineRows(ref);
	readVisibleRows();
	const io = harness.ioInstances[0];
	assert.deepEqual([...io.observed], [root]);
	const mo = harness.moInstances[0];
	// 行内新增工具卡：自身不是行根、子树里也没有行根 → 必须被剪枝。
	mo.callback([{ addedNodes: [{ nodeType: 1, matches: (selector) => selector === "[data-message-id]", querySelector: () => null, closest: () => root }], removedNodes: [] }]);
	harness.takeFrame()();
	assert.equal(io.observed.size, 1, "子卡不得被 observe");
});
