import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sessionIpcSource } from "./helpers/sessionIpcSources.mjs";
import { systemIpcSource } from "./helpers/systemIpcSources.mjs";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";

const entry = mainIpcSource;
const sessionIpc = sessionIpcSource;
const scratchPadIpc = readFileSync("src/main/ipc/scratchPadIpc.ts", "utf8");

test("extracted session and scratch-pad IPC modules remain registered by the main entry", () => {
	assert.match(entry, /registerScratchPadIpc\(\{\s*appLogger,?\s*\}\)/);
	assert.match(entry, /registerSessionIpc\(\{[\s\S]*projectStore,[\s\S]*settingsStore,[\s\S]*sessionScanner,[\s\S]*sessionCatalog,[\s\S]*sessionRuntimeCoordinator,[\s\S]*agentManager,[\s\S]*configManager,[\s\S]*terminalManager,[\s\S]*replaceAgentSession,[\s\S]*\}\)/);
	assert.doesNotMatch(sessionIpc, /from\s+["']\.\.\/index["']/);
	assert.doesNotMatch(scratchPadIpc, /from\s+["']\.\.\/index["']/);
});

test("catalog session loading remains owned by the registered session IPC module", () => {
	assert.match(sessionIpc, /ipcChannels\.sessionsCatalogList/);
	assert.match(sessionIpc, /sessionCatalog\.mergeScanned/);
});

const systemIpc = systemIpcSource;
test("system IPC registers Pi CLI and snapshot-driven app update channels", () => {
	// 回归：Phase 3.7 拆分后若漏传 extensionManager，pi:update-check 会静默不注册。
	assert.match(systemIpc, /ipcChannels\.piUpdateCheck/);
	assert.match(systemIpc, /if \(extensionManager\)/);
	// 应用更新不再走下载 URL/安装器 IPC，而是统一向 UpdateService 请求状态快照、下载和安装。
	assert.match(systemIpc, /ipcChannels\.appCheckUpdate/);
	assert.match(systemIpc, /ipcChannels\.appDownloadUpdate/);
	assert.match(systemIpc, /ipcChannels\.appInstallUpdate/);
	assert.match(systemIpc, /updateService\?\.getSnapshot\(\) \?\? null/);
	assert.match(systemIpc, /updateService\?\.applyAutoDownloadPreference\(\)/);
	assert.match(entry, /registerSystemIpc\(\{[\s\S]*?extensionManager,[\s\S]*?updateService: updateService \?\? undefined,[\s\S]*?\}\);/);
	assert.match(entry, /updateService = new UpdateService\(/);
	assert.match(entry, /quitCleanup\.register\("update-check", \(\) => updateService\?\.stop\(\)\)/);
	assert.doesNotMatch(systemIpc, /from\s+["']\.\.\/index["']/);
});
