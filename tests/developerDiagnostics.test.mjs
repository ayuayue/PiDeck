/**
 * 开发诊断开关契约：设置项默认关；开启后 IPC/preload/设置页必须成对出现。
 * 用来追查「点 pi 会话整窗卡死」时主进程是否被堵住，不能只靠环境变量。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { systemIpcSource } from "./helpers/systemIpcSources.mjs";
import { preloadSource } from "./helpers/preloadSources.mjs";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";
import { agentManagerSource } from "./helpers/agentManagerSources.mjs";

const settingsType = readFileSync("src/shared/types/settings.ts", "utf8");
const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const preload = preloadSource;
const systemIpc = systemIpcSource;
const indexSource = mainIpcSource;
const agent = agentManagerSource;
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
const devTab = readFileSync("src/renderer/src/components/app/settings/DevTab.tsx", "utf8");
const panel = readFileSync("src/renderer/src/components/app/settings/DiagnosticsPanel.tsx", "utf8");

test("developerDiagnostics is a persisted setting defaulting to off", () => {
	assert.match(settingsType, /developerDiagnostics: boolean/);
	assert.match(store, /developerDiagnostics: false/);
});

test("diagnostics IPC is registered with preload and system handlers", () => {
	assert.match(ipc, /diagnosticsSnapshot: "system:diagnostics-snapshot"/);
	assert.match(ipc, /diagnosticsOpenFolder: "system:diagnostics-open-folder"/);
	assert.match(preload, /getDiagnosticsSnapshot:/);
	assert.match(preload, /openDiagnosticsFolder:/);
	assert.match(systemIpc, /ipcChannels\.diagnosticsSnapshot/);
	assert.match(systemIpc, /ipcChannels\.diagnosticsOpenFolder/);
	assert.match(systemIpc, /developerDiagnostics/);
});

test("main process wires DiagnosticsMonitor before IPC and records agent timings", () => {
	assert.match(indexSource, /new DiagnosticsMonitor/);
	assert.match(indexSource, /agentManager\.setDiagnosticsSink/);
	const agentAt = indexSource.indexOf("agentManager = new AgentManager");
	const monitorAt = indexSource.indexOf("diagnosticsMonitor = new DiagnosticsMonitor");
	// registerIpc() 调用点（不是函数定义里的 registerSystemIpc）必须在监视器创建之后。
	const ipcCallAt = indexSource.indexOf("registerIpc();");
	assert.ok(agentAt >= 0 && monitorAt > agentAt);
	assert.ok(ipcCallAt > monitorAt, "monitor must exist before registerIpc() runs");
	assert.match(agent, /this\.recordTiming\("agent.create"/);
	// 历史加载已迁到协作者（runtimeHistoryLoader.ts），打点经 host 转发：只断言打点名，不绑调用形态。
	assert.match(agent, /recordTiming\("session\.history\.load"/);
});

test("settings UI and i18n expose the diagnostics toggle", () => {
	assert.match(devTab, /DiagnosticsPanel/);
	assert.match(panel, /draft\.developerDiagnostics|props\.enabled/);
	assert.match(zh, /settings\.developerDiagnostics/);
	assert.match(en, /settings\.developerDiagnostics/);
	assert.match(zh, /settings\.developerDiagnosticsOpenFolder/);
	assert.match(en, /settings\.developerDiagnosticsOpenFolder/);
});
