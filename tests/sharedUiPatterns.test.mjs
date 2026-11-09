import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "src");

const read = (relative) => readFileSync(join(rendererRoot, relative), "utf8");

const PAGE_HEADER = read("components/common/PageHeader.tsx");
const ASYNC_STATE = read("components/common/AsyncState.tsx");
const DIALOG_SIZE = read("components/common/workbenchDialogSize.ts");
const CHANGELOG_SHELL = read("components/app/settings/ChangelogReaderDialog.tsx");
const CHANGELOG_DESKTOP = read("components/app/settings/ChangelogDialog.tsx");
const CHANGELOG_PI = read("components/app/settings/PiChangelogDialog.tsx");
const SKILL_PICKER = read("components/session/ComposerSkillPicker.tsx");
const COMPOSER = read("components/session/ComposerComponents.tsx");
const THEME_SECTION = read("components/app/settings/CustomThemeSection.tsx");
const WALLPAPER = read("components/app/wallpaper/WallpaperVideoLayer.tsx");
const TIMELINE_CONTROLLER = read("hooks/useSessionTimelineController.ts");

test("PageHeader 壳契约：语义化标题层级 + 统一 header 排版", () => {
	// h1 语义标题 + truncate，供全部工作区页复用（Wave 2 §3.1）
	assert.match(PAGE_HEADER, /<h1[^>]*truncate[^>]*>/, "PageHeader 必须渲染 h1 语义标题");
	assert.match(PAGE_HEADER, /border-b border-border\/40 px-5 py-3/, "统一 header 底边与内边距契约");
	assert.match(PAGE_HEADER, /aria-labelledby=\{headingId\}/, "header 需要可访问名称（指向 h1）");
	assert.match(PAGE_HEADER, /<h1 id=\{headingId\}/, "h1 携带 id 供 labelledby 引用");
	// 调用点：4 个工作区页都消费共享壳而非各自排版
	for (const [src, icon] of [
		["components/agents/market/AgentMarketHeader.tsx", /icon=\{Bot\}/],
		["components/favorites/FavoritesWorkspace.tsx", /icon=\{Star\}/],
		["components/automation/AutomationWorkspace.tsx", /icon=\{Clock\}/],
	]) {
		const content = read(src);
		assert.match(content, /<PageHeader/, `${src} 应使用 PageHeader`);
		assert.match(content, icon, `${src} 应传语义图标`);
	}
});

test("AsyncState 契约：loading 是 status live region，空态有标题与说明槽", () => {
	assert.match(ASYNC_STATE, /role="status"/, "AsyncLoadingBlock 必须是 status role");
	assert.match(ASYNC_STATE, /aria-live="polite"/, "loading 提示须为 polite live region（屏幕阅读器可感知加载完成）");
	assert.match(ASYNC_STATE, /AsyncEmptyBlock[\s\S]*?title[\s\S]*?description[\s\S]*?action/, "空态组件需要 title/description/action 三槽");
	// 调用点
	assert.match(read("components/favorites/FavoritesWorkspace.tsx"), /AsyncLoadingBlock/);
	assert.match(read("components/automation/AutomationTaskList.tsx"), /AsyncEmptyBlock/);
	assert.match(read("components/agents/market/AgentMarketGrid.tsx"), /AsyncEmptyBlock/);
});

test("Workbench Dialog 尺寸常量单源（Wave 2 §5.3）", () => {
	assert.match(DIALOG_SIZE, /WORKBENCH_DIALOG_SIZE_CLASS/, "常量必须导出");
	// 设置面板已是**页面内**surface（失活 hidden、不用 Radix Dialog），不再有弹窗尺寸问题；
	// 单源规则只约束真正的 Workbench Dialog（ConfigModal 等）。
	assert.match(read("ConfigModal.tsx"), /WORKBENCH_DIALOG_SIZE_CLASS/, "ConfigModal 引用共享尺寸");
	// 设置自 f66a4eec0 起是会话列里的页面 Tab（铺满整列），不再共用弹框尺寸。
	assert.doesNotMatch(read("components/app/SettingsModal.tsx"), /WORKBENCH_DIALOG_SIZE_CLASS/, "设置页面不应再套弹框尺寸");
	assert.match(read("components/app/SettingsModal.tsx"), /className="settings-modal flex min-h-0 flex-1 flex-col/, "设置页面铺满会话列");
});

test("Changelog 阅读壳单源：桌面/pi 两消费方不自带 markdown 载体", () => {
	// 壳承担 ScrollArea+markdown-body+footer；消费方只保留领域差异
	assert.match(CHANGELOG_SHELL, /markdown-body/, "壳持有 markdown-body 载体");
	assert.match(CHANGELOG_SHELL, /ScrollArea/, "壳持有滚动区");
	assert.doesNotMatch(CHANGELOG_DESKTOP, /markdown-body/, "桌面 Changelog 不应自带 markdown 载体");
	assert.doesNotMatch(CHANGELOG_PI, /markdown-body/, "pi Changelog 不应自带 markdown 载体");
	assert.match(CHANGELOG_DESKTOP, /ChangelogReaderDialog/, "桌面消费共享壳");
	assert.match(CHANGELOG_PI, /ChangelogReaderDialog/, "pi 消费共享壳");
});

test("Picker 统一：Skill/Prompt 列表走 CommandPickerDialog，不再自建 Command 壳", () => {
	assert.match(COMPOSER, /export function CommandPickerDialog/, "CommandPickerDialog 必须导出供各 picker 复用");
	// 列表态迁移后：Skill/Prompt 均不再直接用 CommandInput/CommandList
	assert.doesNotMatch(SKILL_PICKER, /CommandInput/, "Skill 列表壳应由 CommandPickerPanel 承担");
	assert.doesNotMatch(SKILL_PICKER, /<Command>/, "Skill 列表不应自建 Command 根");
	assert.match(SKILL_PICKER, /CommandPickerGroup id="skills:project"/, "项目技能分组");
	assert.match(SKILL_PICKER, /CommandPickerGroup id="skills:global"/, "全局技能分组");
	// Prompt 列表态（预览态保留 PickerDialog 合法）
	const promptList = COMPOSER.slice(COMPOSER.indexOf("prompt-template-picker"));
	assert.match(promptList, /<CommandPickerDialog/, "Prompt 列表走共享壳");
	assert.doesNotMatch(promptList, /CommandInput/, "Prompt 列表壳应由 CommandPickerPanel 承担");
});

test("Toast 单通道：迁移清单内的组件不再直接 import sonner（Wave 2 §4）", () => {
	assert.doesNotMatch(THEME_SECTION, /from "sonner"/, "CustomThemeSection 须经 showNotice");
	assert.doesNotMatch(THEME_SECTION, /\btoast\(/, "CustomThemeSection 不得直呼 toast()");
	assert.doesNotMatch(WALLPAPER, /from "sonner"/, "WallpaperVideoLayer 须经 showNotice");
	assert.doesNotMatch(TIMELINE_CONTROLLER, /from "sonner"/, "useSessionTimelineController 须经 showNotice");
	assert.match(THEME_SECTION, /showNotice/, "CustomThemeSection 使用 showNotice");
	assert.match(TIMELINE_CONTROLLER, /showNotice/, "timeline controller 使用 showNotice");
});

test("z-layer 语义 token：不再新增 9999 旁路（Wave 2 §5）", () => {
	const gitPanel = read("components/app/GitPanel.tsx");
	assert.doesNotMatch(gitPanel, /zIndex: 9999/, "GitPanel 分支下拉须用 --z-popover");
	assert.match(gitPanel, /var\(--z-popover\)/, "GitPanel 分支下拉用语义 token");
	const popoverMorph = read("components/motion/popover-morph.tsx");
	assert.doesNotMatch(popoverMorph, /z-\[9999\]/, "popover-morph 须用 --z-drawer");
	assert.match(popoverMorph, /z-\[var\(--z-drawer\)\]/, "popover-morph 用语义 token");
});
