import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerArea = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
const overlay = readFileSync("src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx", "utf8");
const sessionView = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
const sessionTimeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");

/**
 * 这些是布局回归契约：runtime UI 属于会话时间线的可见交互，不再占用 composer 的
 * flex 高度；输入框仍由 composer 自己完整承载，Ask 待答时让 composer 坍缩让位（issue #230 定案 B）。
 */
test("composer keeps the editor inside the session column", () => {
	assert.match(composerArea, /className="composer[^\"]*min-h-0[^\"]*overflow-hidden/);
	// 输入卡 shrink-0：面板剩余高度不撑开输入框（todo/终端拖拽与输入高度解耦）
	assert.match(composerArea, /composer-box relative flex[^"]*shrink-0/);
	assert.doesNotMatch(composerArea, /runtimeUi/);
	assert.doesNotMatch(composerArea, /AskRegionResizer/);
});

test("ask inline bar uses the reusable BEUI-style ApprovalCard shell", () => {
	assert.match(overlay, /from "\.\.\/ui-shadcn\/approval-card"/);
	assert.match(overlay, /<ApprovalCard[\s\S]*open=/);
	assert.match(overlay, /BatchAskInlineBar/);
});

test("composer default height stays compact inside the timeline column", () => {
	const rendererUtils = readFileSync("src/renderer/src/rendererUtils.ts", "utf8");
	assert.match(rendererUtils, /COMPOSER_DEFAULT_HEIGHT = 160/);
	assert.match(rendererUtils, /COMPOSER_MIN_HEIGHT = 112/);
	assert.match(sessionView, /TIMELINE_MIN_HEIGHT \+ COMPOSER_MIN_HEIGHT/);
	assert.match(sessionView, /<ResizablePanelGroup[\s\S]*?orientation="vertical"/);
	assert.doesNotMatch(sessionView, /id="composer"/);
});

test("ask overlay keeps fold, cancel, batch and resume interactions", () => {
	assert.match(overlay, /cancel = \(\) =>/);
	assert.match(overlay, /method === "batch_ask"/);
	assert.match(overlay, /BatchAskInlineBar/);
	assert.match(overlay, /ask-inline-bar/);
	assert.doesNotMatch(overlay, /ask\.cancelHint/);
});

test("ask is pinned below the session timeline instead of inside its scroll content", () => {
	// issue #230：看历史时提问卡在视口外还得往下翻。Ask 现与输入框同级钉在对话区下方，
	// 不再作为时间线滚动内容的一块（不再传给 SessionSurfaceStage）。
	assert.doesNotMatch(sessionView, /<SessionSurfaceStage[\s\S]*runtimeUi,/);
	assert.match(sessionView, /<FloatingAskLayer>\{runtimeUi\}<\/FloatingAskLayer>/);
	// 时间线仍保留 runtimeUi 通道：并行问询浮层（AskPanelOverlay）走 OwnedSessionMessageTimeline。
	assert.match(sessionTimeline, /className="session-runtime-ui mx-auto w-full/);
	assert.doesNotMatch(sessionTimeline, /session-runtime-ui sticky bottom-0/);
	// 卡片自身仍不自建滚动：超出浮层高度的部分由 FloatingAskLayer 那一层滚，且只有这一层。
	assert.doesNotMatch(overlay, /overflow-y-auto/);
	const floating = readFileSync("src/renderer/src/components/session/FloatingAskLayer.tsx", "utf8");
	assert.equal(floating.match(/overflow-y-auto/g)?.length, 1);
	assert.match(floating, /scroll-ok: bounded[\s\S]{0,120}overflow-y-auto overscroll-contain/);
});
