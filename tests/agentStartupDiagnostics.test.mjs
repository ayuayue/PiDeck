import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const indexSource = readFileSync("src/main/index.ts", "utf8");
const preloadSource = readFileSync("src/preload/index.ts", "utf8");
const ipcSource = readFileSync("src/shared/ipc.ts", "utf8");
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const rendererMainSource = readFileSync("src/renderer/src/main.tsx", "utf8");

test("agent startup writes diagnostics across renderer IPC and pi launch boundaries", () => {
	assert.match(ipcSource, /rendererLog:\s*"renderer:log"/);
	assert.match(preloadSource, /rendererLog:\s*\(\s*level: AppLogLevel,\s*scope: string,\s*message: string,\s*detail\?: unknown,/);
	assert.match(indexSource, /ipcChannels\.rendererLog/);
	assert.match(indexSource, /Agent create IPC received/);
	assert.match(indexSource, /Agent create IPC completed/);
	assert.match(mainSource, /Agent create requested/);
	assert.match(mainSource, /Agent ensure trusted directory start/);
	assert.match(mainSource, /Agent ensure trusted directory completed/);
	assert.match(mainSource, /Agent pi process start/);
	assert.match(mainSource, /Agent get_state request start/);
	assert.match(mainSource, /Agent get_state request completed/);
	assert.match(mainSource, /Agent create failed/);
	assert.match(appSource, /api\.app\.rendererLog\("info", "renderer", "Agent create requested"/);
	assert.match(appSource, /api\.app\.rendererLog\("info", "renderer", "Agent create completed"/);
	assert.match(appSource, /api\.app\.rendererLog\("warn", "renderer", "Agent create failed"/);
});

test("renderer startup reports bootstrap mount and global errors", () => {
	assert.match(rendererMainSource, /Renderer bootstrap started/);
	assert.match(rendererMainSource, /Renderer React tree mounted/);
	// main.tsx 文案已从 "Renderer startup ..." 收敛为更通用的 runtime 前缀
	assert.match(rendererMainSource, /Renderer uncaught error/);
	assert.match(rendererMainSource, /Renderer unhandled rejection/);
	assert.match(rendererMainSource, /Renderer root element missing/);
});

test("agent create IPC and process handlers keep structured crash diagnostics", () => {
	assert.match(indexSource, /Agent create IPC failed/);
	assert.match(indexSource, /Child process gone/);
	assert.match(indexSource, /platform: process\.platform/);
	assert.match(mainSource, /attachPiProcessLifecycle/);
	assert.match(mainSource, /buildStartupFailureMessage/);
	assert.match(mainSource, /handlePiEvent failed/);
	// spawn error 必须在 start 前可被业务侧接住，避免 mac 上闪退难排查
	assert.match(mainSource, /监听器必须在 process\.start\(\) 之前挂上/);
});
