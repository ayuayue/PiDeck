import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 底栏动作（设置/反馈/官网/主题切换）迁移为 beUI Dock（motion/dock）：
 * 浮动卡片容器铺满底栏宽度（w-full + justify-between 均匀分布四个动作）；
 * 按钮本体仍是 shadcn ghost Button，title/aria-label 与 onClick 回调保持原契约；
 * 主题按钮的图标/文案反映当前模式，翻转规则由 themeAppearance.toggleThemeMode 承担。
 */

const sidebar = readFileSync(
  "src/renderer/src/components/sidebar/SidebarContent.tsx",
  "utf8",
);

test("v3 sidebar bottom actions render inside a full-width beUI Dock", () => {
  assert.match(sidebar, /import \{ Dock, DockItem \} from "\.\.\/motion\/dock";/);
  assert.match(sidebar, /<Dock size=\{32\} className="w-full justify-between">/);
  assert.equal((sidebar.match(/<DockItem>/g) || []).length, 4);
});

test("dock keeps the four actions, their labels and callbacks", () => {
  const dockBlock = sidebar.slice(sidebar.indexOf("<Dock size={32}"));
  assert.match(dockBlock, /title=\{hasPendingUpdate \? t\("settings.titleWithUpdate"\) : t\("settings.title"\)\}[\s\S]*?onClick=\{props\.onOpenSettings\}/);
  assert.match(dockBlock, /title=\{t\("feedback.title"\)\}[\s\S]*?onClick=\{props\.onOpenFeedback\}/);
  assert.match(dockBlock, /title=\{t\("app.homepage"\)\}[\s\S]*?onClick=\{props\.onOpenHomepage\}/);
  // 主题按钮：title/aria 用当前模式的完整文案，回调走 onToggleTheme
  assert.match(dockBlock, /title=\{themeToggleTitle\} aria-label=\{themeToggleTitle\} onClick=\{props\.onToggleTheme\}/);
  // 按钮本体仍是 shadcn ghost Button（hover 观感由 utility 承担）
  assert.equal((dockBlock.match(/variant="ghost"/g) || []).length, 4);
});

test("legacy toolbar/icon-button bottom bar classes are gone", () => {
  assert.doesNotMatch(sidebar, /icon-button/);
  assert.doesNotMatch(sidebar, /toolbar-actions/);
  assert.doesNotMatch(sidebar, /sidebar-bottom-primary-actions/);
  assert.doesNotMatch(sidebar, /settings-icon|feedback-icon|homepage-icon/);
});
