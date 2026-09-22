import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { selectAtom } from "jotai/utils";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const source = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");

/**
 * 时间线控制器模块图。
 *
 * 用 createTsSandbox（相对 import 以**被加载文件目录**为基准解析）而不是手写
 * require 桥：旧写法未列进 stub 表的本地依赖会以 tests/ 为基准解析，生产代码
 * 一新增 import 就整片 MODULE_NOT_FOUND（本文件曾因此踩坑两次）。现在只有需要
 * 替身/故意打桩的依赖才列在 stubs 里，其余相对依赖（jumpWindowPolicy /
 * browsePin / turnRenderWindow 等策略模块）按真实路径加载——跳转策略必须真实
 * 求值才能测行为，桩掉等于测了个假的。
 */
function loadTimelineHelpers() {
	return createTsSandbox({
		stubs: {
			react: {},
			jotai: { atom: (value) => ({ _mockInit: value }) },
			"jotai/utils": {},
			"../atoms": {},
			"../lib/pinTurnScroll": { animateScrollTop: () => () => undefined, pinScrollDurationMs: () => 320 },
			"../desktopApi": {},
			// i18n 只用到 t()：测试不校验文案，桩成直返 key（避免加载真实词典）。
			"../i18n": { t: (key) => key },
			"./timeline/autoExpandThreshold": { TURN_WINDOW_AUTO_EXPAND_THRESHOLD: 120, resolveAutoExpandThreshold: (h) => Math.max(120, Math.round(h * 0.4)) },
			"./timeline/scrollHistoryPolicy": {},
			"../components/session/timeline/turnRenderWindow": {
				TIMELINE_MOUNTED_TURN_LIMIT: 3,
				TIMELINE_SCROLLED_TURN_LIMIT: 3,
				TIMELINE_WINDOW_EXPAND_STEP: 3,
			},
		},
		globals: { Date },
	})("src/renderer/src/hooks/useSessionTimelineController.ts");
}

/**
 * session-atoms 模块图：依赖都是真实相对路径，直接交给 createTsSandbox 按源文件
 * 目录解析（旧写法逐个 stub 真实文件，只是为了绕开手写 loader 的解析基准）。
 */
function loadSessionAtoms() {
	return createTsSandbox()("src/renderer/src/atoms/session-atoms.ts");
}

test("timeline pagination restores the load-more anchor instead of jumping the viewport", () => {
	const { restoreTimelineAnchor } = loadTimelineHelpers();
	assert.equal(restoreTimelineAnchor(240, 600), 840);
	assert.equal(restoreTimelineAnchor(0, 0), 0);
});

test("session switch restores anchored history view state including its turn window", () => {
	const { resolveSessionTimelineRestoreState } = loadTimelineHelpers();

	const bottom = resolveSessionTimelineRestoreState(undefined);
	assert.equal(bottom.autoScroll, true);
	assert.equal(bottom.showScrollToBottom, false);
	assert.equal(bottom.scrolledWindowTurns, 3);

	const history = resolveSessionTimelineRestoreState({
		messageId: "run-4",
		offsetTop: -24,
		windowTurns: 9,
		savedAt: 100,
	});
	assert.equal(history.autoScroll, false);
	assert.equal(history.showScrollToBottom, true);
	assert.equal(history.scrolledWindowTurns, 9);

	// Hot-reload may leave a pre-window anchor in memory; it must safely fall
	// back to the small base window rather than treating the anchor as invalid.
	const legacy = resolveSessionTimelineRestoreState({
		messageId: "run-4",
		offsetTop: -24,
		savedAt: 100,
	});
	assert.equal(legacy.scrolledWindowTurns, 3);
});

test("timeline auto-scroll only sticks while the reader remains near the bottom", () => {
	const { isTimelineAtBottom } = loadTimelineHelpers();
	assert.equal(isTimelineAtBottom(980, 1100, 120), true);
	assert.equal(isTimelineAtBottom(700, 1100, 120), false);
});

test("timeline owns paging, delegated scroll follow, and outline jump lifecycle", () => {
	assert.match(source, /selectAtom\([\s\S]*sessionMessagesCacheAtom/);
	assert.match(source, /readRecordMessagePage\(sessionId/);
	assert.match(source, /prependHistoryPage/);
	// 激活分页（2026-08）：runtime 窗口会话的显示总数 = disk 前缀 + 窗口段的组合长度
	assert.match(source, /totalMessageCount: diskPage \? diskPage\.total : combinedMessages\.length/);
	// 流式跟随由 beUI MessageScroller 负责；controller 只接收跟随状态，避免重复写 scrollTop。
	assert.match(source, /setAutoScrollFromScroller/);
	// 2026-11：100 条分页器已删除，jump 不再扩渲染窗口（数据全量在 atom）
	assert.doesNotMatch(source, /pagination\.loadUntilIncluded\(index\)/);
	assert.match(source, /restoreTimelineAnchor\(/);
});

test("anchor restoration preserves its effective tail window and expands only when needed", () => {
	assert.match(source, /windowTurns: renderedWindowTurnsRef\.current/);
	// 跟随态的 DOM 固定为 3 轮，即使回底 effect 尚未来得及重置 scrolledWindowTurns；
	// 保存必须使用实际窗口，避免切回时恢复到不同高度的文档。
	assert.match(source, /const effectiveWindowTurns = autoScroll\s*\? TIMELINE_MOUNTED_TURN_LIMIT\s*:\s*scrolledWindowTurns;/);
	assert.match(source, /renderedWindowTurnsRef\.current = effectiveWindowTurns;/);
	assert.match(source, /if \(windowExpandableRef\.current\) \{\s*setScrolledWindowTurns\(\(turns\) => turns \+ TIMELINE_WINDOW_EXPAND_STEP\);/);
	// Even an irrecoverable anchor must unlock stick-to-bottom before showing the
	// fallback viewport, otherwise ResizeObserver can immediately re-pin it.
	assert.match(source, /api\.restoreAt\(0\)/);
});

test("scroll events synchronously retain an anchor before a same-task session switch", () => {
	// rAF remains the coalesced persistence path, but the last DOM snapshot must
	// exist before React can commit a tab change and cancel the pending frame.
	assert.match(source, /currentAnchorRef\.current = computeCurrentAnchor\(\);[\s\S]*?if \(scrollAnchorFrameRef\.current != null\) return;\s*scrollAnchorFrameRef\.current = requestAnimationFrame/);
});

test("scroll anchors prefer stable turn roots over collapsible execution children", () => {
	// 工具卡/思考步骤会随执行过程自动收起卸载；优先 user / run 根节点才能在
	// 切回时仍找到同一 messageId，而非退化到顶部。
	assert.match(source, /"article\.user-turn\[data-message-id\], \.turn-row\[data-message-id\]"/);
	assert.match(source, /if \(stableAnchor\) return stableAnchor;/);
	assert.match(source, /return findAnchor\(timeline\.querySelectorAll<HTMLElement>\("\[data-message-id\]"\)\);/);
});

test("background Session cache changes retain the selected timeline slice", () => {
	const { sessionMessagesCacheAtom } = loadSessionAtoms();
	const store = createStore();
	const currentMessages = [{ id: "current" }];
	const selectedMessages = selectAtom(sessionMessagesCacheAtom, (cache) => cache.current?.messages, Object.is);
	store.set(sessionMessagesCacheAtom, {
		current: { messages: currentMessages },
		background: { messages: [{ id: "old" }] },
	});
	const before = store.get(selectedMessages);
	store.set(sessionMessagesCacheAtom, {
		current: { messages: currentMessages },
		background: { messages: [{ id: "new" }] },
	});
	assert.equal(store.get(selectedMessages), before);
});

test("bottom-settle history clear invalidates in-flight runtime history pages", () => {
	// 清理成功后必须推进 load 序号并复位加载标志：迟到页响应被 latestLoadBySession 丢弃，
	// isLoadingMessagePage 也不会卡死后续加载（修复前只有 clearHistory 调用）。
	assert.match(source, /clearHistory\(sessionId\)/);
	assert.match(source, /const sequence = \+\+nextLoadSequence;/);
	assert.match(source, /setIsLoadingMessagePage\(false\)/);
	assert.match(source, /trackLatestLoad\(sessionId, sequence\)/);
	// 逻辑跟底不等于物理到底：平滑回底途中不会立刻清历史。
	assert.match(source, /isTimelineAtBottom\(timeline\.scrollTop/);
});

test("prepend scroll compensation is skipped while following bottom and pins the visible row", () => {
	// 跟底中/浏览代数过期（autoScrollRef=true 或 generation 不匹配）不恢复旧锚点：
	// 贴底引擎负责生长补偿，迟到分页也不得把刚回底的视口重新插页；
	// 滚动翻页钉正在看的那一轮（pinBrowseRow），禁止按整页 scrollHeight 差写原生 scrollTop。
	assert.match(source, /if \(autoScrollRef\.current \|\| anchor\.value\.generation !== historyBrowseGenerationRef\.current\) \{\n\s*loadMoreAnchorRef\.current = undefined;\n\s*return;\n\s*\}/);
	assert.match(source, /if \(anchor\.value\.preserveAtTop\) \{\n\s*pinBrowseRow\(\);/);
	assert.doesNotMatch(source, /timeline\.scrollTop = nextScrollTop/);
	// 顶部不补偿路径仍需抑制本帧 scroll；守卫由代数化 rAF 清理，不能再用会
	// 被定时窗口永久锁住的独立 boolean。
	assert.match(source, /if \(nextScrollTop === null\) \{[\s\S]{0,180}?markProgrammaticScroll\(\);/);
	assert.match(source, /finishProgrammaticScrollFrame\(guard, generation\)/);
	assert.doesNotMatch(source, /programmaticScrollRef/);
});

test("escaping follow mode and expanding the window unlock the stick-to-bottom engine", () => {
	// 只改 React autoScroll、不 stopScroll 时，扩窗增高会被 RO 在 isAtBottom 下钉回底部。
	assert.match(source, /const escapeAutoScroll = useCallback\(\(\) => \{[\s\S]*?scrollerScrollApiRef\.current\?\.stopScroll\(\);/);
	assert.match(source, /const expandWindow = useCallback\([\s\S]*?escapeAutoScroll\(\);[\s\S]*?setScrolledWindowTurns/);
});

test("prepend pin uses restoreAt so ResizeObserver cannot re-lock to the bottom", () => {
	assert.match(source, /const pinViewportAfterPrepend = useCallback\(\s*\(nextTop: number\) => \{/);
	assert.match(source, /api\?\.restoreAt/);
	assert.match(source, /api\.restoreAt\(nextTop\)/);
});

test("history expand pins the visible turn row instead of container height delta", () => {
	// 上滑跳到更早 1~2 轮的根因：整页 scrollHeight 差把后排版也算进去，且只补一次。
	assert.match(source, /browsePinScrollTop\(timeline\.scrollTop, currentTop, pin\.expectedViewportTop\)/);
	assert.match(source, /const pinBrowseRow = useCallback\(\(\) => \{/);
	assert.match(source, /new ResizeObserver\(\(\) => \{/);
	assert.match(source, /browsePinFrozenRef/);
	assert.doesNotMatch(source, /restoreTimelineAnchor\(timeline\.scrollTop, heightDelta\)/);
});

test("load-more compensation is skipped at the very top so prepended content stays visible", () => {
	// 2026-02 回归：视口在顶部（≤8px 阈值）时 prepend/展开不补偿 scrollTop——
	// 容器 overflow-anchor:none，插入内容不会自动调整滚动位置，补偿会把新内容推出视口上方，
	// 表现为「点击加载更多/显示更早无反馈」。中部才按高度差补偿保持视口内容不动。
	const { resolveTimelineTopCompensation } = loadTimelineHelpers();
	assert.equal(resolveTimelineTopCompensation(0, 600), null);
	assert.equal(resolveTimelineTopCompensation(8, 600), null);
	assert.equal(resolveTimelineTopCompensation(240, 600), 840);
	assert.equal(resolveTimelineTopCompensation(9, -100), -91);
	assert.equal(resolveTimelineTopCompensation(240, 0), 240);
});

test("auto history load consumes engine intent without a competing scroll listener", () => {
	// stick 引擎逐次上报真实用户输入；controller 下一帧读取最终位置后直接决策。
	// 普通 scroll 仅保存锚点，resize/clamp/动画不能凭 scrollTop 变化取得扩窗权限。
	assert.match(source, /const setUserScrollIntent = useCallback/);
	assert.match(source, /if \(intent !== "up"\) return;/);
	assert.match(source, /userScrollIntentFrameRef\.current = window\.requestAnimationFrame/);
	assert.match(source, /if \(isProgrammaticScrollActive\(programmaticScrollGuardRef\.current, performance\.now\(\)\)\) return;/);
	assert.match(source, /HISTORY_AUTO_LOAD_THRESHOLD/);
	assert.doesNotMatch(source, /timeline\.addEventListener\("scroll", onScroll/);
});
