/**
 * Ask 提问系统通知开关（askNotificationEnabled）的接线测试。
 * 背景：非聚焦会话收到 Ask 提问时主进程会发系统通知，此前与通用会话结束通知
 * （enableNotifications，默认开）共用同一门控；用户要求拆成独立开关且默认关闭，
 * 避免升级后后台提问突然刷系统通知。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("askNotificationEnabled 三处默认值一致且默认关闭", () => {
	const settingsType = readFileSync("src/shared/types/settings.ts", "utf8");
	const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const preview = readFileSync("src/renderer/src/previewApi.ts", "utf8");
	assert.match(settingsType, /askNotificationEnabled: boolean/);
	// 默认关闭：主进程持久化默认、渲染层首屏默认、预览 mock 三处同步
	assert.match(store, /askNotificationEnabled: false/);
	assert.match(app, /askNotificationEnabled: false/);
	assert.match(preview, /askNotificationEnabled: false/);
});

test("autoSessionTitle 四处默认关闭且设置说明提示额外 token 消耗", () => {
	const settingsType = readFileSync("src/shared/types/settings.ts", "utf8");
	const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const preview = readFileSync("src/renderer/src/previewApi.ts", "utf8");
	const commonTab = readFileSync(
		"src/renderer/src/components/app/settings/CommonTab.tsx",
		"utf8",
	);
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.match(settingsType, /autoSessionTitle: boolean/);
	assert.match(store, /autoSessionTitle: false/);
	assert.match(app, /autoSessionTitle: false/);
	assert.match(preview, /autoSessionTitle: false/);
	assert.match(commonTab, /checked=\{draft\.autoSessionTitle \?\? false\}/);
	assert.match(zh, /settings\.autoSessionTitleDesc[\s\S]{0,220}token/);
	assert.match(en, /settings\.autoSessionTitleDesc[\s\S]{0,260}tokens/);
});

test("AgentManager 的 Ask 通知改由独立开关门控，与通用通知解耦", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	// 门控条件必须读新开关，而不是 enableNotifications
	assert.match(source, /if \(!settings\.askNotificationEnabled\) return;/);
	// 且不再引用通用开关作为 Ask 通知的条件
	assert.doesNotMatch(
		source,
		/notifyAskPending[\s\S]{0,400}enableNotifications/,
	);
});

test("设置面板与未保存摘要均提供该开关", () => {
	const notificationTab = readFileSync(
		"src/renderer/src/components/app/settings/NotificationTab.tsx",
		"utf8",
	);
	const summary = readFileSync(
		"src/renderer/src/components/app/settings/unsavedChangesSummary.ts",
		"utf8",
	);
	assert.match(
		notificationTab,
		/updateDraft\(\{ askNotificationEnabled: checked \}\)/,
	);
	assert.match(
		summary,
		/\{ field: "askNotificationEnabled", tab: "notification", itemKey: "settings\.askNotification" \}/,
	);
});

test("i18n 双语文案齐全且通用通知描述不再混入提问场景", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.match(zh, /"settings\.askNotification": "Ask 提问系统通知"/);
	assert.match(zh, /"settings\.askNotificationDesc":\s*"Agent 向你提问/);
	assert.match(en, /"settings\.askNotification": "Ask question notifications"/);
	assert.match(en, /"settings\.askNotificationDesc":\s*"When an agent asks/);
});
