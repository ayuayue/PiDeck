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
  // 4 项 = 3 个动作（设置/反馈/主题）+ 1 个公告中心入口。官网按钮已并入侧栏顶部的
  // AboutPopover（关于弹框，faf93859），不再占用 dock 空间。
  assert.equal((sidebar.match(/<DockItem>/g) || []).length, 4);
});

test("dock keeps the three actions and delegates the homepage link to AboutPopover", () => {
  const dockBlock = sidebar.slice(sidebar.indexOf("<Dock size={32}"));
  // 设置按钮：更新角标场景的文案进 aria-label（读屏/键盘），可见解释由 Tooltip 清单承担；
  // 首次解释气泡改挂 dock 行容器（与 Dock 同级），不再寄生在 DockItem 内（锚定契约见
  // updateDotHintAnchor.test.mjs）——它在 dockBlock 之外、行容器内。
  assert.match(sidebar, /<UpdateDotHint hasPendingUpdate=\{hasPendingUpdate\}/);
  assert.match(dockBlock, /aria-label=\{hasPendingUpdate \? t\("settings.titleWithUpdate"\) : t\("settings.title"\)\}["\s\S]*?onClick=\{props\.onOpenSettings\}/);
  assert.match(dockBlock, /<Tooltip delayDuration=\{300\}>/);
  assert.match(dockBlock, /title=\{t\("feedback.title"\)\}[\s\S]*?onClick=\{props\.onOpenFeedback\}/);
  // 主题按钮：title/aria 用当前模式的完整文案，回调走 onToggleTheme
  assert.match(dockBlock, /title=\{themeToggleTitle\} aria-label=\{themeToggleTitle\} onClick=\{props\.onToggleTheme\}/);
  // 按钮本体仍是 shadcn ghost Button（hover 观感由 utility 承担）；
  // AnnouncementCenter 内部有自己的 ghost 按钮，先把公告入口整段剔除再数动作按钮。
  const dockActions = dockBlock.replace(
    /<DockItem>\s*<AnnouncementCenter \/>\s*<\/DockItem>/,
    "",
  );
  assert.equal((dockActions.match(/variant="ghost"/g) || []).length, 3);
  // 官网入口已从 dock 迁入 AboutPopover（关于弹框），官方站点链接必须仍在
  const about = readFileSync("src/renderer/src/components/app/AboutPopover.tsx", "utf8");
  assert.match(about, /WEBSITE_URL = "https:\/\/ayuayue\.github\.io\/PiDeck\/"/);
  assert.match(about, /label=\{t\("about\.website"\)\}/);
});

test("legacy toolbar/icon-button bottom bar classes are gone", () => {
  assert.doesNotMatch(sidebar, /icon-button/);
  assert.doesNotMatch(sidebar, /toolbar-actions/);
  assert.doesNotMatch(sidebar, /sidebar-bottom-primary-actions/);
  assert.doesNotMatch(sidebar, /settings-icon|feedback-icon|homepage-icon/);
});
