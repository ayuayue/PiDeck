/**
 * 打开数据目录契约：调试设置里「打开数据目录」必须 IPC 三处同步（通道/主进程/preload），
 * 且主进程用 Electron 跨平台 shell.openPath（explorer / Finder / xdg-open），
 * 禁止硬编码平台命令或路径分隔符，避免 Windows 路径空格问题。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const appTypes = readFileSync("src/shared/types/app.ts", "utf8");
const devTab = readFileSync("src/renderer/src/components/app/settings/DevTab.tsx", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("app:open-data-dir channel is defined in shared IPC contract", () => {
	assert.match(ipc, /appOpenDataDir: "app:open-data-dir"/);
});

test("main handler opens userData via cross-platform shell.openPath", () => {
	// 三处同步：主进程 handler 必须引用同一通道常量，而不是散落字符串
	assert.match(systemIpc, /ipcChannels\.appOpenDataDir/);
	// 数据目录取实际生效路径（便携版/安装版/dev 后缀统一由 app.getPath 解析）
	assert.match(systemIpc, /app\.getPath\("userData"\)/);
	// 用受保护的统一入口（内部仍是 Electron 跨平台 shell.openPath）：不手拼 explorer/xdg-open 等平台命令。
	// issue #396：Linux 上 shell.openPath 的回调被丢弃、Promise 永不 settle，直接 await 会让本 handler 不回包。
	assert.match(systemIpc, /openSystemPath\s*\(/);
	// 打开失败时返回结构化错误，不抛裸异常跨 IPC
	assert.match(systemIpc, /return error \? \{ ok: false, error \} : \{ ok: true \}/);
	// 禁止硬编码平台路径分隔符（Windows 反斜杠 / Unix 斜杠都不得出现）
	assert.doesNotMatch(systemIpc, /openSystemPath\(.*["'`]\\\\["'`]/);
	assert.doesNotMatch(systemIpc, /openSystemPath\(.*["'`]\/["'`]/);
});

test("AppInfo exposes userDataDir and preload bridges openDataDir", () => {
	assert.match(appTypes, /userDataDir: string/);
	assert.match(systemIpc, /userDataDir: app\.getPath\("userData"\)/);
	assert.match(preload, /openDataDir:/);
	assert.match(preload, /ipcChannels\.appOpenDataDir/);
});

test("DevTab shows the data dir path and open button, with both i18n locales", () => {
	assert.match(devTab, /desktopApi\.app\.openDataDir\(\)/);
	assert.match(devTab, /props\.appInfo\.userDataDir/);
	assert.match(zh, /"settings\.openDataDir"/);
	assert.match(en, /"settings\.openDataDir"/);
});
