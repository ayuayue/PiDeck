import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const i18n = readFileSync("src/renderer/src/i18n.ts", "utf8");
const scanner = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");

function refreshProjectSessionsBlock() {
  const match = app.match(/async function refreshProjectSessions\(projectId: string, silent = false\) \{[\s\S]*?\n  \}\n\n  \/\*\* 刷新项目侧栏数据/);
  assert.ok(match, "refreshProjectSessions implementation should be discoverable");
  return match[0];
}

test("queues every refresh collision instead of dropping user-triggered refreshes", () => {
  const block = refreshProjectSessionsBlock();
  assert.match(
    block,
    /if \(sessionRefreshRunningRef\.current\.has\(projectId\)\) \{[\s\S]*?sessionRefreshPendingRef\.current\.add\(projectId\);\s*return;/,
  );
  assert.doesNotMatch(block, /if \(silent\) sessionRefreshPendingRef\.current\.add\(projectId\)/);
  assert.match(block, /if \(sessionRefreshPendingRef\.current\.delete\(projectId\)\)/);
});

test("bounds session list requests so a hung scan releases the single-flight lock", () => {
  const block = refreshProjectSessionsBlock();
  assert.match(app, /const SESSION_REFRESH_TIMEOUT_MS = 20_000;/);
  assert.match(
    block,
    /withTimeout\(\s*api\.sessions\.list\(projectId\),\s*SESSION_REFRESH_TIMEOUT_MS,\s*t\("app\.sessionRefreshTimeout"\),?\s*\)/,
  );
  assert.match(block, /finally \{[\s\S]*?sessionRefreshRunningRef\.current\.delete\(projectId\)/);
  assert.match(i18n, /"app\.sessionRefreshTimeout"/g);
  assert.match(scanner, /private scanTimeoutMs = 18_000;/);
  assert.match(scanner, /new AbortController\(\)/);
  assert.match(scanner, /controller\.abort\(new Error\("Session scan timed out"\)\)/);
  assert.match(scanner, /clearTimeout\(scanTimer\)/);
  assert.match(scanner, /collectWslJsonl\(signal\)/);
  assert.match(scanner, /signal,\s*windowsHide: true/);
});
