import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 默认值「三处同源」契约：设置的实际默认值分布在渲染层 atom / 主进程 SettingsStore /
// 预览 mock 三条独立通路里。任何一处漏改或写成相反值，都会出现「首屏/预览窗口与真实设置不一致」
// 的闪变（过程组显示默认 true，任何一处漏改都会让首屏闪回平铺渲染）。
// 正则必须空白容忍：仓库格式化基线不做折行，但 `:` 前后与逗号间距仍可能被调整。
const read = (path) => readFileSync(path, "utf8");
const appUiAtoms = read("src/renderer/src/atoms/app-ui-atoms.ts");
const settingsStore = read("src/main/settings/SettingsStore.ts");
const previewApi = read("src/renderer/src/previewApi.ts");

test("processGroupDisplay defaults to true in all three default-value sources", () => {
	const sources = [
		["src/renderer/src/atoms/app-ui-atoms.ts", appUiAtoms],
		["src/main/settings/SettingsStore.ts", settingsStore],
		["src/renderer/src/previewApi.ts", previewApi],
	];
	for (const [path, source] of sources) {
		assert.match(source, /processGroupDisplay\s*:\s*true\b/, `${path} 应把 processGroupDisplay 默认值设为 true`);
		// 防止有人把默认值改回 false（过程组显示现为默认开启，用户可在设置中关回平铺显示）
		assert.doesNotMatch(source, /processGroupDisplay\s*:\s*false\b/, `${path} 不得把 processGroupDisplay 默认值改为 false`);
	}
});

test("processGroupDisplay is part of the shared Settings and TurnFlowSettings contracts", () => {
	const sharedSettings = read("src/shared/types/settings.ts");
	assert.match(sharedSettings, /processGroupDisplay\s*:\s*boolean\s*;/, "Settings 需要 processGroupDisplay: boolean");
	assert.match(appUiAtoms, /processGroupDisplay\s*:\s*boolean\s*;/, "TurnFlowSettings 需要 processGroupDisplay: boolean");
});

test("processGroupDisplay is synced from settings into turnFlowSettingsAtom with its dependency", () => {
	// App 的同步 effect 必须带上新字段本身与依赖数组项，否则设置页改动不会即时反映到时间线。
	const app = read("src/renderer/src/App.tsx");
	const syncStart = app.indexOf("setTurnFlowSettings({");
	assert.ok(syncStart > 0, "App 中存在 turnFlowSettingsAtom 同步 effect");
	const syncBlock = app.slice(syncStart, syncStart + 700);
	assert.match(syncBlock, /processGroupDisplay\s*:\s*settings\.processGroupDisplay/, "同步 effect 应写入 settings.processGroupDisplay");
	assert.match(syncBlock, /settings\.processGroupDisplay\s*,/, "同步 effect 依赖数组应包含 settings.processGroupDisplay");
});
