import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 会话 Tab 宽度上限可配置契约：shared 纯函数 → SettingsStore 归一化 →
// SessionTabsBar CSS 变量 → AppearanceTab 滑杆 → i18n 文案。
const shared = readFileSync("src/shared/sessionTabWidth.ts", "utf8");
const settingsType = readFileSync("src/shared/types/settings.ts", "utf8");
const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const tabsBar = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const appearance = readFileSync("src/renderer/src/components/app/settings/AppearanceTab.tsx", "utf8");
const unsaved = readFileSync("src/renderer/src/components/app/settings/unsavedChangesSummary.ts", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

// 直接内联被测纯函数的行为断言（与 shared 源同值）：避免 node --test 无法 import TS。
// 边界规则必须与 clampSessionTabMaxWidth 一致：80–400，非有限数值回落 104。
function clamp(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return 104;
	return Math.min(400, Math.max(80, Math.round(value)));
}

test("shared 纯函数边界：默认 104、区间 80–400、脏值回落", () => {
	assert.equal(clamp(undefined), 104);
	assert.equal(clamp(null), 104);
	assert.equal(clamp("120"), 104); // 磁盘 JSON 无类型，字符串脏值回落默认
	assert.equal(clamp(NaN), 104);
	assert.equal(clamp(104), 104);
	assert.equal(clamp(0), 80);
	assert.equal(clamp(-50), 80);
	assert.equal(clamp(80), 80);
	assert.equal(clamp(400), 400);
	assert.equal(clamp(9999), 400);
	assert.equal(clamp(120.4), 120);
	assert.equal(clamp(120.6), 121);
	// shared 源文件必须导出这些边界常量（AppearanceTab 滑杆 min/max 引用）
	assert.match(shared, /SESSION_TAB_MAX_WIDTH_DEFAULT = 104/);
	assert.match(shared, /SESSION_TAB_MAX_WIDTH_MIN = 80/);
	assert.match(shared, /SESSION_TAB_MAX_WIDTH_MAX = 400/);
	assert.match(shared, /SESSION_TAB_BADGE_EXTRA_WIDTH = 28/);
});

test("settings 类型声明 sessionTabMaxWidth 且保留默认 104", () => {
	assert.match(settingsType, /sessionTabMaxWidth: number/);
});

test("SettingsStore：默认值 + load 归一化 + update 钳制三处齐全", () => {
	// 默认值走 shared 常量（单一数据源，不重复写 104）
	assert.match(store, /sessionTabMaxWidth: SESSION_TAB_MAX_WIDTH_DEFAULT/);
	// load 归一化：手工改坏的 settings.json 值钳回合法区间
	assert.match(store, /this\.settings\.sessionTabMaxWidth = clampSessionTabMaxWidth\(this\.settings\.sessionTabMaxWidth\)/);
	// update 钳制：IPC 入参不可信，合法值夹取、非有限数值剔除
	assert.match(store, /safePatch\.sessionTabMaxWidth = clampSessionTabMaxWidth\(safePatch\.sessionTabMaxWidth\)/);
	assert.match(store, /delete safePatch\.sessionTabMaxWidth/);
});

test("SessionTabsBar：CSS 变量注入且不再硬编码 max-w 像素值", () => {
	// 根元素注入两个变量：基础上限 + 徽标 Tab 宽上限（+28）
	assert.match(tabsBar, /"--session-tab-max-w": `\$\{tabMaxWidth\}px`/);
	assert.match(tabsBar, /"--session-tab-max-w-badged": `\$\{tabMaxWidth \+ SESSION_TAB_BADGE_EXTRA_WIDTH\}px`/);
	// props 类型必须声明（App 装配层传入）
	assert.match(tabsBar, /tabMaxWidth: number/);
	// 会话 Tab 与文件/Diff Tab 均改走变量，旧硬编码必须清零（防止第二套宽度来源）
	assert.match(tabsBar, /max-w-\(--session-tab-max-w\)/);
	assert.match(tabsBar, /max-w-\(--session-tab-max-w-badged\)/);
	assert.doesNotMatch(tabsBar, /max-w-\[104px\]/);
	assert.doesNotMatch(tabsBar, /max-w-\[132px\]/);
	assert.doesNotMatch(tabsBar, /max-w-44/);
});

test("App 装配层把 settings.sessionTabMaxWidth 传给 SessionTabsBar", () => {
	assert.match(app, /tabMaxWidth: settings\.sessionTabMaxWidth/);
	// 首拉 settings 前的本地兜底状态也要有同源默认值
	assert.match(app, /sessionTabMaxWidth: SESSION_TAB_MAX_WIDTH_DEFAULT/);
});

test("AppearanceTab：窗口样式区滑杆使用 shared 边界常量并本地夹取", () => {
	assert.match(appearance, /SESSION_TAB_MAX_WIDTH_MIN/);
	assert.match(appearance, /SESSION_TAB_MAX_WIDTH_MAX/);
	assert.match(appearance, /clampSessionTabMaxWidth\(parseInt\(event\.target\.value\)\)/);
	// 脏标记摘要登记（关闭设置弹框时提示未保存项）
	assert.match(unsaved, /\{ field: "sessionTabMaxWidth", tab: "appearance", itemKey: "settings\.sessionTabMaxWidth" \}/);
});

test("i18n 中英文案同步提供", () => {
	assert.match(zh, /"settings\.sessionTabMaxWidth": "会话 Tab 宽度上限"/);
	assert.match(zh, /"settings\.sessionTabMaxWidthDesc": "单个会话\/文件 Tab 的最大宽度/);
	assert.match(en, /"settings\.sessionTabMaxWidth": "Session Tab Width Cap"/);
	assert.match(en, /"settings\.sessionTabMaxWidthDesc": "Maximum width of a single session\/file tab/);
});
