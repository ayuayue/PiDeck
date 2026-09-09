import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { selectAtom } from "jotai/utils";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

const source = readFileSync(
  "src/renderer/src/hooks/useSessionTimelineController.ts",
  "utf8",
);

function compileModule(filePath, imports = {}) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => imports[specifier] ?? nodeRequire(specifier),
    Date,
  });
  return module.exports;
}

function loadTimelineHelpers() {
  return compileModule("src/renderer/src/hooks/useSessionTimelineController.ts", {
    react: {},
    jotai: { atom: (value) => ({ _mockInit: value }) },
    "jotai/utils": {},
    "../atoms": {}, "../lib/pinTurnScroll": { animateScrollTop: () => () => undefined, pinScrollDurationMs: () => 320 },
    "../desktopApi": {},    "./timeline/autoExpandThreshold": { TURN_WINDOW_AUTO_EXPAND_THRESHOLD: 120, resolveAutoExpandThreshold: (h) => Math.max(120, Math.round(h * 0.4)) }, "./timeline/scrollHistoryPolicy": {},    "../components/session/timeline/turnRenderWindow": {
      TIMELINE_MOUNTED_TURN_LIMIT: 3,
      TIMELINE_SCROLLED_TURN_LIMIT: 3,
      TIMELINE_WINDOW_EXPAND_STEP: 3,
    },
    // 控制器 import 的跳转策略必须真实加载：shim 缺失时编译后 require 直接
    // MODULE_NOT_FOUND（285bc919 引入策略模块时漏补，4 个用例一直没跑起来）
    "../components/session/timeline/jumpWindowPolicy": compileModule(
      "src/renderer/src/components/session/timeline/jumpWindowPolicy.ts",
      { "./turnRenderWindow": { TIMELINE_WINDOW_EXPAND_STEP: 3 } },
    ),
  });
}

function loadSessionAtoms() {
  return compileModule("src/renderer/src/atoms/session-atoms.ts", {
    "../utils/agentRuntimeState": compileModule(
      "src/renderer/src/utils/agentRuntimeState.ts",
    ),
    "../utils/sessionRecordIdentity": compileModule(
      "src/renderer/src/utils/sessionRecordIdentity.ts",
    ),
    // 流式正文交接（3f4c252f 起被 session-atoms 依赖）：测试 loader 缺此 stub 时
    // session-atoms 编译后 require 失败（Cannot find module '../utils/liveTextHandoff'）
    "../utils/liveTextHandoff": compileModule(
      "src/renderer/src/utils/liveTextHandoff.ts",
    ),
    "./outlineRevision": compileModule(
      "src/renderer/src/atoms/outlineRevision.ts",
    ),
    "./outlineProjectionCache": compileModule(
      "src/renderer/src/atoms/outlineProjectionCache.ts",
    ),
  });
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
  assert.match(
    source,
    /const effectiveWindowTurns = autoScroll\s*\? TIMELINE_MOUNTED_TURN_LIMIT\s*:\s*scrolledWindowTurns;/,
  );
  assert.match(source, /renderedWindowTurnsRef\.current = effectiveWindowTurns;/);
  assert.match(
    source,
    /if \(windowExpandableRef\.current\) \{\s*setScrolledWindowTurns\(\(turns\) => turns \+ TIMELINE_WINDOW_EXPAND_STEP\);/,
  );
  // Even an irrecoverable anchor must unlock stick-to-bottom before showing the
  // fallback viewport, otherwise ResizeObserver can immediately re-pin it.
  assert.match(source, /api\.restoreAt\(0\)/);
});

test("scroll events synchronously retain an anchor before a same-task session switch", () => {
  // rAF remains the coalesced persistence path, but the last DOM snapshot must
  // exist before React can commit a tab change and cancel the pending frame.
  assert.match(
    source,
    /currentAnchorRef\.current = computeCurrentAnchor\(\);\s*if \(scrollAnchorFrameRef\.current != null\) return;\s*scrollAnchorFrameRef\.current = requestAnimationFrame/,
  );
});

test("scroll anchors prefer stable turn roots over collapsible execution children", () => {
  // 工具卡/思考步骤会随执行过程自动收起卸载；优先 user / run 根节点才能在
  // 切回时仍找到同一 messageId，而非退化到顶部。
  assert.match(
    source,
    /"article\.user-turn\[data-message-id\], \.turn-row\[data-message-id\]"/,
  );
  assert.match(source, /if \(stableAnchor\) return stableAnchor;/);
  assert.match(source, /return findAnchor\(timeline\.querySelectorAll<HTMLElement>\("\[data-message-id\]"\)\);/);
});

test("background Session cache changes retain the selected timeline slice", () => {
  const { sessionMessagesCacheAtom } = loadSessionAtoms();
  const store = createStore();
  const currentMessages = [{ id: "current" }];
  const selectedMessages = selectAtom(
    sessionMessagesCacheAtom,
    (cache) => cache.current?.messages,
    Object.is,
  );
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

test("prepend scroll compensation is skipped while following bottom and pins via restoreAt", () => {
  // 跟底中/浏览代数过期（autoScrollRef=true 或 generation 不匹配）不恢复旧锚点：
  // 贴底引擎负责生长补偿，迟到分页也不得把刚回底的视口重新插页；
  // 非跟底时走 pinViewportAfterPrepend（restoreAt），禁止原生 scrollTop 补偿。
  assert.match(
    source,
    /if \(autoScrollRef\.current \|\| anchor\.value\.generation !== historyBrowseGenerationRef\.current\) \{\n\s*loadMoreAnchorRef\.current = undefined;\n\s*return;\n\s*\}/,
  );
  assert.match(source, /pinViewportAfterPrepend\(nextScrollTop\)/);
  assert.doesNotMatch(source, /timeline\.scrollTop = nextScrollTop/);
  assert.match(source, /requestAnimationFrame\(\(\) => \{\n\s*programmaticScrollRef\.current = false;/);
});

test("escaping follow mode and expanding the window unlock the stick-to-bottom engine", () => {
  // 只改 React autoScroll、不 stopScroll 时，扩窗增高会被 RO 在 isAtBottom 下钉回底部。
  assert.match(
    source,
    /const escapeAutoScroll = useCallback\(\(\) => \{[\s\S]*?scrollerScrollApiRef\.current\?\.stopScroll\(\);/,
  );
  assert.match(
    source,
    /const expandWindow = useCallback\([\s\S]*?escapeAutoScroll\(\);[\s\S]*?setScrolledWindowTurns/,
  );
});

test("prepend pin uses restoreAt so ResizeObserver cannot re-lock to the bottom", () => {
  assert.match(source, /const pinViewportAfterPrepend = useCallback\(\(nextTop: number\) => \{/);
  assert.match(source, /api\?\.restoreAt/);
  assert.match(source, /api\.restoreAt\(nextTop\)/);
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
  assert.match(source, /if \([\s\S]*?programmaticScrollRef\.current[\s\S]*?\) return;/);
  assert.match(source, /HISTORY_AUTO_LOAD_THRESHOLD/);
  assert.doesNotMatch(source, /timeline\.addEventListener\("scroll", onScroll/);
});
