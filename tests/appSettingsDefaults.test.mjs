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

test("acpEnabled is opt-in: default false, migration and patch strictly coerce to boolean", () => {
	// ACP 是 opt-in 总开关：默认必须 false（pi 用户零运行时成本——主进程关闭时不创建 AcpAgentManager）。
	// 迁移/update 均须 `=== true` 收窄，防旧数据里 truthy 字符串意外开启。
	assert.match(settingsStore, /acpEnabled\s*:\s*false\b/, "SettingsStore 默认值应为 false（opt-in）");
	assert.match(settingsStore, /this\.settings\.acpEnabled\s*=\s*parsed\.acpEnabled\s*===\s*true\b/, "迁移必须 === true 收窄");
	assert.match(settingsStore, /safePatch\.acpEnabled\s*=\s*safePatch\.acpEnabled\s*===\s*true\b/, "update patch 必须 === true 收窄");
	const sharedSettings = read("src/shared/types/settings.ts");
	assert.match(sharedSettings, /acpEnabled\?:\s*boolean\s*;/, "Settings 需要 acpEnabled?: boolean");
	// 主进程装配按开关门控注册 ACP 网关：关闭时零成本的关键路径。
	const mainIndex = read("src/main/index.ts");
	assert.match(mainIndex, /settingsStore\.get\(\)\.acpEnabled\s*===\s*true\b/, "index.ts 装配必须以 acpEnabled === true 为门");
	// 渲染层菜单门控：关闭时隐藏 ACP 入口（acpEnabledAtom）。
	// 真正挂载的新建会话菜单是 SessionTabsBar 内部 NewSessionMenu（sidebar/同名组件已删，历史孤儿）。
	const menu = read("src/renderer/src/components/session/SessionTabsBar.tsx");
	assert.match(menu, /acpEnabledAtom/, "SessionTabsBar 新建菜单必须读 acpEnabledAtom");
	assert.match(menu, /acpVisible/, "SessionTabsBar 新建菜单必须以开关+工具表门控 ACP 组");
});
