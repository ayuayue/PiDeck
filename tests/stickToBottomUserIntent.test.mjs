import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
  return module.exports;
}

const engine = compile("src/renderer/src/lib/stick-to-bottom/useStickToBottom.ts");
const engineSource = readFileSync(
  "src/renderer/src/lib/stick-to-bottom/useStickToBottom.ts",
  "utf8",
);

// 用户反馈 bug（2026-09）：物理已到底但逻辑逃逸时（restoreAt/扩窗误逃逸后），
// 用户继续下滑没有位移、不产生 scroll 事件，handleScroll 的重锁路径收不到信号，
// 表现为「回底按钮点很多次没反应，手动下滑也无法恢复吸底」。
// 修复：真实下滚输入（wheel deltaY>0）到达时，物理距底 <= 容差带直接重锁。
test("down-wheel at physical bottom relocks without requiring a scroll event (bug 2)", () => {
  // 距底在容差带内：下滚输入直接重锁
  assert.equal(engine.shouldRelockFromDownInput(0, 25), true);
  assert.equal(engine.shouldRelockFromDownInput(10), true);
  assert.equal(engine.shouldRelockFromDownInput(25), true);
  // 距底超出容差带：仍处历史浏览区，不重锁
  assert.equal(engine.shouldRelockFromDownInput(26), false);
  assert.equal(engine.shouldRelockFromDownInput(100), false);
});

test("engine reports every user wheel/scroll intent, including repeated directions", () => {
  // 方向是一次输入事件，不是可去重的长期状态：up → 回底 → up 的第二个浏览周期
  // 必须再次通知 controller；布局滚动仍由 ResizeObserver/ignoreScrollToTop 守卫过滤。
  assert.match(engineSource, /reportUserIntent\("up", "scroll"|reportUserIntent\("up", "input"/);
  assert.match(engineSource, /reportUserIntent\("down", "scroll"|reportUserIntent\("down", "input"/);
  assert.match(
    engineSource,
    /onUserIntent\?: \(intent: ScrollUserIntent, source: ScrollIntentSource\) => void/,
  );
  assert.match(
    engineSource,
    /const reportUserIntent = useCallback\(\(intent: ScrollUserIntent, source: ScrollIntentSource\) => \{\s*optionsRef\.current\?\.onUserIntent\?\.\(intent, source\);/,
  );
  assert.doesNotMatch(engineSource, /lastUserIntentRef/);
  // 下滚重锁在真实下滚输入路径（wheel deltaY>0）直接判定
  assert.match(engineSource, /if \(deltaY > 0\) \{/);
  assert.match(engineSource, /shouldRelockFromDownInput\(distanceFromBottom\)/);
});

test("MessageScroller wires user scroll intent from engine to the timeline controller", () => {
  const scrollerSource = readFileSync(
    "src/renderer/src/components/agents/message-scroller.tsx",
    "utf8",
  );
  const timelineSource = readFileSync(
    "src/renderer/src/components/session/SessionMessageTimeline.tsx",
    "utf8",
  );
  assert.match(
    scrollerSource,
    /onUserScrollIntent\?: \(intent: "up" \| "down", source: "scroll" \| "input"\) => void/,
  );
  assert.match(scrollerSource, /onUserIntent: onUserScrollIntent,/);
  assert.match(timelineSource, /onUserScrollIntent=\{controller\.setUserScrollIntent\}/);
});