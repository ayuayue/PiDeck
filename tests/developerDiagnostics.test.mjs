/**
 * 开发诊断开关契约：设置项默认关；开启后 IPC/preload/设置页必须成对出现。
 * 用来追查「点 pi 会话整窗卡死」时主进程是否被堵住，不能只靠环境变量。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsType = readFileSync("src/shared/types/settings.ts", "utf8");
const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const indexSource = readFileSync("src/main/index.ts", "utf8");
const agent = readFileSync("src/main/pi/AgentManager.ts", "utf8");
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
	assert.match(agent, /this\.recordTiming\("session.history.load"/);
});

test("settings UI and i18n expose the diagnostics toggle", () => {
	assert.match(devTab, /DiagnosticsPanel/);
	assert.match(panel, /draft\.developerDiagnostics|props\.enabled/);
	assert.match(zh, /settings\.developerDiagnostics/);
	assert.match(en, /settings\.developerDiagnostics/);
	assert.match(zh, /settings\.developerDiagnosticsOpenFolder/);
	assert.match(en, /settings\.developerDiagnosticsOpenFolder/);
});
