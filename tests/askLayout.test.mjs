import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerArea = readFileSync(
  "src/renderer/src/components/session/ComposerArea.tsx",
  "utf8",
);
const overlay = readFileSync(
  "src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx",
  "utf8",
);
const sessionView = readFileSync(
  "src/renderer/src/components/session/SessionView.tsx",
  "utf8",
);
const sessionTimeline = readFileSync(
  "src/renderer/src/components/session/SessionMessageTimeline.tsx",
  "utf8",
);

/**
 * 这些是布局回归契约：runtime UI 属于会话时间线的可见交互，不再占用 composer 的
 * flex 高度；输入框仍由 composer 自己完整承载，Ask 也不再创建第二个纵向滚动 owner。
 */
test("composer keeps the editor inside the resizable panel", () => {
  assert.match(composerArea, /className="composer[^\"]*min-h-0[^\"]*overflow-hidden/);
  assert.match(composerArea, /composer-box relative flex min-h-0[^\"]*flex-1/);
  assert.doesNotMatch(composerArea, /runtimeUi/);
  assert.doesNotMatch(composerArea, /AskRegionResizer/);
});

test("ask inline bar uses shadcn Collapsible for its fold state", () => {
  assert.match(overlay, /from "\.\.\/ui-shadcn\/collapsible"/);
  assert.match(overlay, /<Collapsible[\s\S]*open=/);
  assert.match(overlay, /<CollapsibleTrigger/);
  assert.match(overlay, /<CollapsibleContent/);
});

test("composer default height stays compact while remaining vertically resizable", () => {
  const rendererUtils = readFileSync("src/renderer/src/rendererUtils.ts", "utf8");
  assert.match(rendererUtils, /COMPOSER_DEFAULT_HEIGHT = 160/);
  assert.match(rendererUtils, /COMPOSER_MIN_HEIGHT = 148/);
  assert.match(sessionView, /COMPOSER_DEFAULT_HEIGHT/);
  assert.match(sessionView, /minSize=\{COMPOSER_MIN_HEIGHT\}/);
  assert.match(sessionView, /ResizablePanelGroup orientation="vertical"/);
  assert.match(sessionView, /id="composer"/);
});

test("ask overlay keeps fold, cancel, batch and resume interactions", () => {
  assert.match(overlay, /cancel = \(\) =>/);
  assert.match(overlay, /method === "batch_ask"/);
  assert.match(overlay, /BatchAskInlineBar/);
  assert.match(overlay, /ask-inline-bar/);
  assert.doesNotMatch(overlay, /ask\.cancelHint/);
});

test("ask is rendered at the bottom of the session timeline", () => {
  assert.match(sessionView, /<SessionMessageTimeline[\s\S]*runtimeUi=\{runtimeUi\}/);
  assert.match(sessionTimeline, /className="session-runtime-ui mx-auto w-full/);
  assert.doesNotMatch(sessionTimeline, /session-runtime-ui sticky bottom-0/);
  // 时间线是唯一滚动 owner，Ask 不再嵌套自己的 overflow-y-auto。
  assert.doesNotMatch(overlay, /overflow-y-auto/);
});
