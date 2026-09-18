import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const indexSource = readFileSync("src/main/index.ts", "utf8");
const systemIpcSource = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const sessionIpcSource = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
const preloadSource = readFileSync("src/preload/index.ts", "utf8");
const ipcSource = readFileSync("src/shared/ipc.ts", "utf8");
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const rendererMainSource = readFileSync("src/renderer/src/main.tsx", "utf8");

test("agent startup writes diagnostics across renderer IPC and pi launch boundaries", () => {
	assert.match(ipcSource, /rendererLog:\s*"renderer:log"/);
	assert.match(
		preloadSource,
		/rendererLog:\s*\(\s*level: AppLogLevel,\s*scope: string,\s*message: string,\s*detail\?: unknown,/,
	);
	assert.match(systemIpcSource, /ipcChannels\.rendererLog/);
	assert.doesNotMatch(
		indexSource,
		/Agent create IPC received|ipcChannels\.agentsCreate/,
	);
	assert.match(mainSource, /Agent create requested/);
	assert.match(mainSource, /Agent ensure trusted directory start/);
	assert.match(mainSource, /Agent ensure trusted directory completed/);
	assert.match(mainSource, /Agent pi process start/);
	assert.match(mainSource, /Agent get_state request start/);
	assert.match(mainSource, /handshakePiProcess/);
	assert.match(mainSource, /retrying without extensions/);
	// 启动握手（首次 get_state）必须用专用超时（90s 上限），不吃给长任务的 rpcTimeout：
	// 沿用它会让「进程活着但不就绪」静默等满 10 分钟——现场表现是「不返回失败，直接超时」，
	// 超时前既没有回退也没有诊断。真正的启动失败（spawn 失败/进程 exit）由 PiProcess 立即终结，
	// 毫秒级返回，不等超时。长任务路径仍吃用户配置。
	assert.match(
		mainSource,
		/client\.request\(\s*\{ type: "get_state" \},\s*this\.startupHandshakeTimeoutMs,\s*\)/,
	);
	assert.match(mainSource, /get startupHandshakeTimeoutMs\(\): number/);
	assert.match(mainSource, /STARTUP_HANDSHAKE_TIMEOUT_MS = 90_000/);
	assert.match(mainSource, /get rpcTimeoutMs\(\): number/);
	assert.match(mainSource, /this\.settingsStore\.get\(\)\.rpcTimeout/);
	assert.match(mainSource, /Prompt RPC request started/);
	assert.match(mainSource, /Prompt RPC response received/);
	assert.match(mainSource, /rpcMs/);
	assert.match(mainSource, /Agent create failed/);
	assert.match(sessionIpcSource, /Session prompt IPC received/);
	assert.match(sessionIpcSource, /sessionRuntimeCoordinator\.send\(input\)/);
	assert.match(sessionIpcSource, /Session prompt IPC completed/);
	assert.match(sessionIpcSource, /Session prompt IPC failed/);
	assert.doesNotMatch(appSource, /api\.agents\.create\(/);
});

test("renderer startup reports bootstrap mount and global errors", () => {
	assert.match(rendererMainSource, /Renderer bootstrap started/);
	assert.match(rendererMainSource, /Renderer React tree mounted/);
	// main.tsx 文案已从 "Renderer startup ..." 收敛为更通用的 runtime 前缀
	assert.match(rendererMainSource, /Renderer uncaught error/);
	assert.match(rendererMainSource, /Renderer React update depth diagnostic/);
	assert.match(rendererMainSource, /Maximum update depth exceeded/);
	assert.match(rendererMainSource, /lastUpdateDepthDiagnosticAt/);
	assert.match(rendererMainSource, /Renderer root element missing/);
	assert.match(rendererMainSource, /function dismissBootOverlay\(\)/);
	assert.match(
		rendererMainSource,
		/window\.setTimeout\(dismissBootOverlay, 1500\)/,
	);
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
