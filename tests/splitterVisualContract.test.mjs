import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const hook = readFileSync("src/renderer/src/hooks/useNotifyLayoutResized.ts", "utf8");
const appShell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");
const terminalDock = readFileSync(
  "src/renderer/src/components/terminal/TerminalDockPanel.tsx",
  "utf8",
);
const splitStage = readFileSync("src/renderer/src/components/session/SessionSplitStage.tsx", "utf8");

/**
 * 分割线视觉与悬浮层跟随契约（#issue：拖拽时双线 + 悬浮菜单错位）：
 * - 分割线 hover/拖拽态必须是「单条实色线」（1.5px、无渐变），
 *   3px 渐变 + 14px 柔影在浅色主题下观感像双线，曾导致用户反馈；
 * - 拖拽分割线期间必须向 window 派发 resize（floating-ui 据此重算浮层），
 *   防止已打开的菜单/下拉停留在旧锚点位置、松手后跳变或不回归。
 */
test("splitter hover/active stays a single solid line (no gradient double-line)", () => {
  // 高亮规则块：实色单线，位置不变，无渐变
  const block = foundation.match(
    /\.splitter:hover::before,[\s\S]*?\.splitter\[data-separator="active"\]::before\s*\{([^}]*)\}/,
  );
  assert.ok(block, "splitter hover/active rule must exist");
  const body = block[1];
  assert.match(body, /width:\s*1\.5px/, "active line must be 1.5px solid");
  assert.doesNotMatch(body, /linear-gradient/, "no gradient (looks like double line)");
  assert.match(body, /left:\s*0/, "line must not shift position while dragging");
});

test("layout drag dispatches window resize for floating-layer recalc", () => {
  // hook 必须派发 resize（floating-ui autoUpdate 的唯一重算信号之一）
  assert.match(hook, /dispatchEvent\(new Event\("resize"\)\)/, "hook must dispatch resize");
  // 拖拽跟踪覆盖三类分割线（左右栏 / 终端 / 分屏 sash）
  assert.match(
    hook,
    /\.splitter,\s*\.v-splitter,\s*\.session-split-sash,\s*\.session-terminal-splitter/,
    "track all splitter classes",
  );
  // 终端分隔条有独立视觉样式，使用专用命中类，避免复用透明的 .v-splitter。
  assert.match(terminalDock, /session-terminal-splitter/);
  // 外层与分屏宿主调用 hook，触发全局拖拽监听注册。
  assert.match(appShell, /useNotifyLayoutResized/, "AppShell must wire the hook");
  assert.match(splitStage, /useNotifyLayoutResized/, "SessionSplitStage must wire the hook");
});
