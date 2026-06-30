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
	assert.match(rendererMainSource, /Renderer startup uncaught error/);
	assert.match(rendererMainSource, /Renderer startup unhandled rejection/);
	assert.match(rendererMainSource, /Renderer root element missing/);
});
