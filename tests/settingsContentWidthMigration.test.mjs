import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 内容宽度百分比重构契约：contentMaxWidth(px) → chatContentWidthPct(%)
const settingsType = readFileSync("src/shared/types/settings.ts", "utf8");
const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const appShell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");
const splitStage = readFileSync("src/renderer/src/components/session/SessionSplitStage.tsx", "utf8");
const modal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
const appearanceTab = readFileSync("src/renderer/src/components/app/settings/AppearanceTab.tsx", "utf8");
const tailwind = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
const composerArea = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
const composerPanels = readFileSync("src/renderer/src/components/session/ComposerPanels.tsx", "utf8");
const runtimeOverlay = readFileSync("src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx", "utf8");
const chatContentWidth = readFileSync("src/renderer/src/components/session/chatContentWidth.ts", "utf8");
const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("settings type keeps legacy contentMaxWidth for read compat and adds chatContentWidthPct", () => {
	assert.match(settingsType, /contentMaxWidth: number/);
	assert.match(settingsType, /chatContentWidthPct: number/);
	// 旧字段必须保留（旧 settings.json 读取兼容），不能删成可选（否则全链路 undefined 传播）
	assert.match(settingsType, /@deprecated 由 chatContentWidthPct 取代/);
});

test("SettingsStore default is 80% (readable width, not full width)", () => {
	assert.match(store, /chatContentWidthPct: 80/);
});

test("SettingsStore migrates legacy px via linear mapping on load", () => {
	// 迁移必须在 load() 的兼容迁移区调用（commit-mono 迁移之后、catch 之前）
	assert.match(store, /this\.migrateContentWidth\(\)/);
	// 线性映射公式：px∈[800,1800) → pct∈[60,100)；其余（≤0 或 ≥1800=不限）→ 100
	assert.match(store, /\(\(legacyPx - 800\) \/ 1000\) \* 40 \+ 60/);
	assert.match(store, /legacyPx > 0 && legacyPx < 1800/);
	// 已存在新值（已迁移/用户已设置）时不得覆盖
	assert.match(store, /if \(typeof pct === "number" && Number\.isFinite\(pct\)\) return/);
	// 迁移后写回持久化
	assert.match(store, /this\.save\(\)\.catch/);
});

test("AppShell always injects --chat-content-pct-set without conditional branch", () => {
	// 始终注入（100% 时由 CSS max() 回退最小边距），不再有 contentMaxWidth 条件注入
	assert.match(appShell, /"--chat-content-pct-set": `\$\{chatContentWidthPct\}%/);
	assert.doesNotMatch(appShell, /--content-max-width/);
	// 容器查询锚点必须下沉到每个会话栏；chat-pane 只负责传递设置变量。
	assert.doesNotMatch(appShell, /chat-pane @container/);
	assert.match(splitStage, /chat-content-width @container/);
});

test("UI 2.0: messages and composer share inline width, not parent padding", () => {
	// 59eb1948 起：min() 把百分比封顶到 calc(100% - 48px)——100% 时两侧各留 24px 空隙，
	// 低于 100% 宽屏不受影响；仍是同一基准的 inline width 契约
	assert.match(chatContentWidth, /width: "min\(var\(--chat-content-pct-set, 80%\), calc\(100% - 48px\)\)"/);
	assert.match(chatContentWidth, /marginInline: "auto"/);
	// 时间线侧：宽度 style 挂在 MessageScroller 的 contentProps（内层 [role=log]）上，
	// 视口铺满面板、滚动条贴面板最右；内容列仍与 composer 同宽居中。
	// 例外：空态（起始页/EmptyState）去掉约束——起始页自带 max-w-[980px]，
	// 保持与引导页一致（见 SessionMessageTimeline.showSurfaceEmptyState）。
	assert.match(timeline, /contentProps=\{showSurfaceEmptyState \? undefined : \{ style: chatContentWidthStyle \}\}/);
	assert.match(composerArea, /\.\.\.chatContentWidthStyle/);
	assert.doesNotMatch(tailwind, /100cqi|--chat-inline-pad|--chat-side-gap|@utility chat-content-width/);
	assert.doesNotMatch(foundation, /--chat-inline-pad|--chat-side-gap|--content-max-width|@container/);
	assert.match(foundation, /\.message-timeline \{[\s\S]*?padding-block: 18px 24px;[\s\S]*?padding-inline: 0;/);
	assert.doesNotMatch(timeline, /--chat-inline-pad|@max-\[1100px\]:px-6/);
	assert.doesNotMatch(composerArea, /--chat-inline-pad|@max-\[1100px\]:px-6/);
	assert.match(composerArea, /className="composer[^"]*px-0 pb-2"/);
	assert.match(timelineCss, /\.composer \{[\s\S]*?padding-inline: 0;/);
	assert.doesNotMatch(timelineCss, /\.composer \{[\s\S]*?padding: var\(--space-1\) var\(--space-2\)/);
	assert.match(timeline, /className="message-list min-w-0 w-full mx-auto transition-opacity duration-fast"/);
	assert.match(composerPanels, /<ComposerWidgetFrame[\s\S]*?className="queued-track"/);
	assert.match(runtimeOverlay, /ask-inline-bar ask-inline-bar--active w-full/);
});

test("Appearance tab slider is 60–100 with always-visible save button", () => {
	// 内容宽度滑块位于外观设置 tab（AppearanceTab，自 SettingsModal 拆分）
	assert.match(appearanceTab, /min="60"/);
	assert.match(appearanceTab, /max="100"/);
	assert.match(appearanceTab, /step="1"/);
	assert.match(appearanceTab, /updateDraft\(\{ chatContentWidthPct: parseInt/);
	// 保存按钮常驻且不因「无修改」禁用（无修改也允许再次保存）；
	// 保存中禁用防重复提交；视觉桥开启但未选模型时也禁用（无效配置不允许保存，悬停提示选模型）；
	// 快捷键存在冲突时同样禁用（settingsContentWidthMigration 与快捷键注册表共用保存入口）
	assert.match(modal, /disabled=\{\s*visionDraft\.saving\s*\|\|\s*\(visionDraft\.dirty && visionDraft\.modelMissing\)\s*\|\|\s*shortcutsInvalid\s*\}/);
	assert.match(modal, /t\("settings\.vision\.modelRequired"\)/);
	// 视觉桥脏标记并入头部保存/取消按钮的判定（hasAnyDirtyChanges = hasDirtyChanges || visionDraft.dirty）
	assert.match(modal, /hasAnyDirtyChanges = hasDirtyChanges \|\| visionDraft\.dirty/);
	// 紧凑单行：不渲染示意图/留白附加行（用户要求去丑）
	assert.doesNotMatch(modal, /sideGapPct/);
	assert.doesNotMatch(modal, /contentWidthGap/);
});

test("i18n has new keys in both locales and legacy width keys are gone", () => {
	for (const locale of [zh, en]) {
		assert.match(locale, /"settings\.contentWidthPct"/);
		assert.match(locale, /"settings\.contentWidthPctDesc"/);
		assert.doesNotMatch(locale, /"settings\.contentMaxWidth"/);
		assert.doesNotMatch(locale, /contentWidthGap/);
	}
});
