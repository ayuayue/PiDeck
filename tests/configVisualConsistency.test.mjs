import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const configModal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
const skills = readFileSync("src/renderer/src/config/SkillsTab.tsx", "utf8");
const prompts = readFileSync("src/renderer/src/config/PromptsTab.tsx", "utf8");
const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const rendererStyles = readFileSync("src/renderer/src/styles.css", "utf8");
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
const commonTab = readFileSync("src/renderer/src/components/app/settings/CommonTab.tsx", "utf8");
const projectResources = readFileSync("src/renderer/src/components/app/ProjectResourcesModal.tsx", "utf8");
const zhCopy = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enCopy = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
const tabs = readFileSync("src/renderer/src/components/ui-shadcn/tabs.tsx", "utf8");
const skillTableRow = skills.slice(skills.indexOf("function SkillTableRow"));

test("config shell defines compact density and crisp system typography", () => {
  assert.match(surfaces, /\.config-modal \[data-slot="button"\]/);
  assert.match(surfaces, /\.config-modal \[data-slot="input"\]/);
  // Windows/Electron 小字号中文需要保留子像素抗锯齿；config modal 不能强制 grayscale antialiasing。
  assert.match(surfaces, /\.config-modal \{[\s\S]*-webkit-font-smoothing: subpixel-antialiased/);
  assert.match(surfaces, /\.config-modal \{[\s\S]*text-rendering: auto/);
  assert.doesNotMatch(surfaces, /\.config-modal \{[\s\S]*-webkit-font-smoothing: antialiased;/);
  assert.match(surfaces, /\.config-nav-btn \{[\s\S]*font-size:\s*14px/);
  // 选中态随 Vertical Tabs 迁移：由 TabsTrigger data-[state=active] utility 承担
  assert.match(tabs, /data-\[state=active\]:bg-bg-panel/);
  assert.doesNotMatch(surfaces, /\.config-nav-btn\.active \{/);
  assert.match(foundation, /Segoe UI Variable Text/);
  assert.match(foundation, /Microsoft YaHei UI/);
  assert.doesNotMatch(foundation, /MiSans/);
  // 语言下拉的 "system" 选项位于常用设置 tab（CommonTab，自 SettingsModal 拆分）
  assert.match(commonTab, /value: "system"/);
  assert.doesNotMatch(rendererStyles, /styles\/lxgw-wenkai\.css/);
  assert.doesNotMatch(rendererStyles, /misans/i);
  assert.equal(existsSync("src/renderer/assets/fonts/misans"), false);
  assert.equal(existsSync("src/renderer/src/styles/misans"), false);
  assert.equal(existsSync("src/renderer/assets/fonts/lxgw-wenkai"), false);
  assert.equal(existsSync("src/renderer/src/styles/lxgw-wenkai.css"), false);
  assert.doesNotMatch(rendererStyles, /lxgw-wenkai/);
  assert.doesNotMatch(surfaces, /\.config-models-grid-header[\s\S]*font-weight: 650/);
  assert.match(configModal, /configModalSizeClass/);
  assert.match(configModal, /w-\[80vw\]/);
  assert.match(configModal, /max-w-\[80vw\]/);
  assert.match(configModal, /h-\[80vh\]/);
  assert.match(configModal, /sm:max-w-\[min\(1300px,80vw\)\]/);
  assert.match(configModal, /max-\[820px\]:flex-col/);
  assert.match(configModal, /max-\[820px\]:flex-row/);
  assert.match(settingsModal, /settingsModalSizeClass/);
  assert.match(settingsModal, /w-\[80vw\]/);
  assert.match(surfaces, /\.settings-modal \{[\s\S]*width: min\(1300px, 80vw\);[\s\S]*height: min\(850px, 80vh\);/);
  assert.match(surfaces, /\.config-modal \{[\s\S]*width: min\(1300px, 80vw\);[\s\S]*height: min\(850px, 80vh\);/);
});

test("project resource menu reuses the settings resource views with a fixed project scope", () => {
  // 项目入口只保留壳层；列表、商店、编辑和操作统一由设置页 ConfigPane 提供。
  assert.match(projectResources, /<ConfigPane/);
  assert.match(projectResources, /resourceOnly/);
  assert.match(projectResources, /projectId=\{props\.project\.id\}/);
  assert.match(projectResources, /projectName=\{props\.project\.name\}/);
  assert.match(projectResources, /from "\.\.\/\.\.\/ConfigModal"/);
  assert.doesNotMatch(projectResources, /ResourceScopeSelector/);
  assert.doesNotMatch(projectResources, /<Tabs/);

  // resourceOnly 模式固定 project scope，且用静态项目标签替代下拉选择器。
  assert.match(configModal, /resourceOnly \? "project" : "global"/);
  assert.match(configModal, /resourceOnly\s*\?/);
  assert.match(configModal, /resourceScopeSelector = resourceOnly \?/);
  assert.match(configModal, /projectName\?\.trim\(\) \|\| t\("config\.resourceScope\.projectFallback"\)/);
  assert.match(configModal, /!resourceOnly && \(/);
});

test("skills and prompts use compact tab rails aligned with the extensions page", () => {
  // 用户要求技能/提示词页的两个 table（本地/商店）外框与扩展页一致：紧凑、仅包裹 tab 本身。
  // 三处现已收敛到共享 ContentTabs（beui underline），TabsList 紧凑类定义在 ContentTabs 内。
  assert.match(skills, /<ContentTabs/);
  assert.match(prompts, /<ContentTabs/);
  const contentTabs = readFileSync("src/renderer/src/config/ContentTabs.tsx", "utf8");
  assert.match(contentTabs, /<TabsList className=\{cn\("w-full justify-start gap-0"/);
  const tabs = readFileSync("src/renderer/src/components/ui-shadcn/tabs.tsx", "utf8");
  assert.match(tabs, /w-full items-center/);
  assert.match(tabs, /data-\[state=active\]:shadow-sm/);
  assert.match(tabs, /!text-\[color:var\(--color-text-secondary\)\]/);
});

test("prompt names and actions reserve enough table space", () => {
  // 名称列不能被 scope/status 徽标挤成短省略号；操作列也要容纳启停、编辑、重命名、删除四个按钮。
  assert.match(prompts, /<TableHead className="w-\[22rem\]">{t\("config\.name"\)}/);
  assert.match(prompts, /<TableCell className="w-\[22rem\] max-w-\[22rem\]">/);
  assert.match(prompts, /<strong className="min-w-0 flex-1 break-words whitespace-normal">\/\{template\.name\}<\/strong>/);
  assert.match(prompts, /<TableHead className="w-44 text-right">\{t\("config\.actions"\)\}<\/TableHead>/);
  assert.match(prompts, /<TableCell className="w-44 text-right"><div className="flex min-w-max justify-end gap-1">/);
});

test("discovered prompts are explicitly read-only instead of showing a fake toggle", () => {
  // package/settings 发现行不是 PromptManager 可写模板，因此没有安全的行内启停 IPC。
  assert.match(prompts, /Runtime-discovered package\/settings prompts are owned by pi\/package settings/);
  assert.match(prompts, /title=\{t\("config\.resourceManagedHint"\)\}/);
  assert.match(prompts, /\{t\("config\.resourceManaged"\)\}/);
});

test("skill list filtering depends on resource scope, not the new-skill destination", () => {
  assert.match(skills, /const visibleSkills = data\.skills\.filter\(\(skill\) => props\.scope/);
  assert.doesNotMatch(skills, /data\.skills\.filter\([^;]*newLocationId/);
  assert.doesNotMatch(skills, /const filteredSkills = data\.skills\.filter/);
});

test("skill table uses real aligned columns, not a colSpan card", () => {
  assert.match(skillTableRow, /<TableRow>/);
  assert.match(skillTableRow, /<TableCell className="min-w-0">/);
  // 描述列：w-2/5 固定占比（table-fixed 忽略 min-width，窗口拉小时无宽度列会被
  // 压到接近 0 成竖条）+ 长描述 3 行截断（line-clamp 包在内部 span 上，
  // 避免 display:-webkit-box 破坏 table-cell 布局），title 悬浮看全文
  assert.match(skillTableRow, /<TableCell className="w-2\/5 whitespace-normal break-words/);
  assert.match(skillTableRow, /<span className="block line-clamp-3">/);
  assert.match(skillTableRow, /<TableCell className="text-right">/);
  // 操作按钮直接放在 TableCell 内，不再包一层可点击的卡片 button。
  assert.doesNotMatch(skillTableRow, /<button[\s\S]*skill-rename-inline[\s\S]*<Button/);
  // 新建 Skill 表单已整体移除：位置选择 Select 与旧自定义下拉弹层都不应出现。
  assert.doesNotMatch(skills, /<SelectTrigger/);
  assert.doesNotMatch(skills, /skill-location-picker/);
  assert.doesNotMatch(skills, /config\.createSkill/);
});
