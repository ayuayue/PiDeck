import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// #115 U5 收尾：通知机制从自研 app-notice 锚点浮层迁移为 sonner 全局 toast。
// 本测试锁定新契约：notify 请求仍经 showNotice 出口，showNotice 落到 sonner，
// Toaster 在渲染树根挂载，旧的 app-notice/NoticeCenter 不再回流。

const sessionAtoms = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");
const mainEntry = readFileSync("src/renderer/src/main.tsx", "utf8");
const notice = readFileSync("src/renderer/src/utils/notice.ts", "utf8");
const sonner = readFileSync("src/renderer/src/components/ui-shadcn/sonner.tsx", "utf8");
const sessionView = readFileSync(
  "src/renderer/src/components/session/SessionView.tsx",
  "utf8",
);
const header = readFileSync(
  "src/renderer/src/components/session/SessionHeader.tsx",
  "utf8",
);

test("通知统一走 sonner 全局 toast（不再有 app-notice 锚点浮层）", () => {
  // pi extension 的 notify 请求仍渲染进 runtime atom
  assert.match(sessionAtoms, /request\.method === "notify"/);
  assert.match(sessionAtoms, /notification:\s*\{/);

  // showNotice 出口保持，内部落到 sonner
  const runtimeController = readFileSync(
    "src/renderer/src/hooks/useSessionRuntimeController.ts",
    "utf8",
  );
  assert.match(runtimeController, /showNotice\(\s*notification\.message/);
  assert.match(notice, /from "sonner"/);
  assert.match(notice, /toast\.(error|warning|info|\()/);
  assert.match(notice, /duration \?\? .*1500/);
  assert.match(runtimeController, /backgroundPending/);
  assert.match(runtimeController, /Number\.POSITIVE_INFINITY/);

  // Toaster 使用官方右上角布局并显示可关闭按钮；兜底 DOM toast 也保持同一视觉位置。
  assert.match(sonner, /position="top-right"/);
  assert.match(sonner, /closeButton/);
  // fallback toast must align with Sonner while leaving the custom title-bar drag region.
  assert.match(notice, /"top:calc\(var\(--window-drag-height, 0px\) \+ 12px\)"/);
  assert.doesNotMatch(notice, /"top:16px"/);
  assert.match(notice, /common\.close/);

  // Toaster 挂载在渲染树根（TooltipProvider 同级）
  assert.match(mainEntry, /ui-shadcn\/sonner/);
  assert.match(mainEntry, /<Toaster \/>/);

  // 旧自研浮层不得回流
  assert.doesNotMatch(sessionView, /NoticeCenter/);
  assert.doesNotMatch(header, /app-notice/);
});
