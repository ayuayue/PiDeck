/**
 * 退出应用 IPC 契约：崩溃页不能走 window-close（closeToTray 会 hide），
 * 必须三处同步（通道 / 主进程 / preload），语义与托盘退出一致。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const previewApi = readFileSync("src/renderer/src/previewApi.ts", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("app:quit channel is defined in shared IPC contract", () => {
	assert.match(ipc, /appQuit: "app:quit"/);
});

test("main handler quits the app instead of closing the window", () => {
	assert.match(systemIpc, /ipcChannels\.appQuit/);
	const handler = systemIpc.match(/ipcMain\.handle\(ipcChannels\.appQuit,[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(handler, /isQuitting\.value = true/);
	assert.match(handler, /app\.quit\(\)/);
	// 崩溃退出必须绕过 closeToTray：禁止 win.close() / hide()
	assert.doesNotMatch(handler, /win\.close\(/);
	assert.doesNotMatch(handler, /\.hide\(/);
	assert.doesNotMatch(handler, /app\.relaunch\(/);
});

test("preload and preview stubs expose app.quit", () => {
	assert.match(preload, /quit: \(\) =>\s*ipcRenderer\.invoke\(ipcChannels\.appQuit\)/);
	assert.match(previewApi, /quit: async \(\) => undefined/);
});

test("error-page copy uses quit, not window-close", () => {
	assert.match(zh, /"app\.quit": "退出应用"/);
	assert.match(en, /"app\.quit": "Quit"/);
	assert.match(zh, /或退出应用/);
	assert.match(en, /or quit the app/);
});
