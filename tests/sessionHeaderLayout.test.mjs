import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionView = readFileSync(
  "src/renderer/src/components/session/SessionView.tsx",
  "utf8",
);
const runtimeInjector = readFileSync(
  "src/renderer/src/components/session/SessionRuntimeInjector.tsx",
  "utf8",
);
const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");

test("session tabs keep the full row and move status/actions below", () => {
  const sessionTop = sessionView.indexOf("<SessionTabsBar {...sessionTabs}");
  const contentStart = sessionView.indexOf("<ResizablePanel", sessionTop);
  assert.notEqual(sessionTop, -1);
  assert.notEqual(contentStart, -1);
  const headerArea = sessionView.slice(sessionTop, contentStart);

  // Tab 的横向空间只属于会话标签；状态徽章和新会话操作应在下一行独立布局。
  assert.match(headerArea, /<SessionTabsBar\s+\{\.\.\.sessionTabs\}\s+actions=\{null\}\s*\/>/);
  assert.doesNotMatch(headerArea, /actions=\{(?!null\})/);
  assert.match(headerArea, /<SessionHeader[\s\S]*?\/>/);
});

test("session status and new-session controls use the shared medium radius", () => {
  // Tab 栏只保留会话标签；状态徽章和操作下移到独立 header，避免多个徽章长期占用 Tab 的横向空间。
  const statusBlock = surfaces.slice(
    surfaces.indexOf(".session-status span"),
    surfaces.indexOf(".session-status .ctx-chip"),
  );
  const newSessionBlock = foundation.slice(
    foundation.indexOf(".session-combo-trigger {"),
    foundation.indexOf(".session-combo-trigger:hover"),
  );

  assert.match(statusBlock, /border-radius:\s*var\(--radius-md\)/);
  assert.match(newSessionBlock, /border-radius:\s*var\(--radius-md\)/);
});

test("restart is offered only when the current session has a bound Agent", () => {
  assert.match(
    runtimeInjector,
    /showRestart=\{Boolean\(runtime\.activeAgentId\) && !isLanWeb\}/,
  );
});
