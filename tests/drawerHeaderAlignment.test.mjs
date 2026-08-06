import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

/**
 * pure official P2-4：drawer header 高度/背景改由 DrawerSurface Tailwind 承担。
 */

const styles = readRendererStyles();
const drawerSurface = readFileSync(
  "src/renderer/src/components/workspace/DrawerSurface.tsx",
  "utf8",
);

test("drawer header uses official compact chrome classes", () => {
  // 与主区状态栏（chat-header）同高：均为 h-10 = 40px，底边线同一 y 值
  assert.match(drawerSurface, /drawer-header flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border\/40 bg-background px-3/);
  assert.match(drawerSurface, /truncate text-body font-semibold/);
});

test("drawer does not cast a shadow over the adjacent white pane", () => {
  // 用行首锚定取裸 .detail-drawer 规则，避免误中 .shell-panel-drawer .detail-drawer
  const drawer = styles.match(/(?:^|\n)\.detail-drawer \{([\s\S]*?)\n\}/)?.[1];

  assert.ok(drawer, "drawer styles must exist");
  assert.match(drawer, /box-shadow:\s*none;/);
});
