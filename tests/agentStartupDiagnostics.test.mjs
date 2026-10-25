import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync("src/main/pi/AgentManager.ts", "utf8");
// 信任闸已迁出 AgentManager（Wave 3/4 拆分，见 docs/agent-manager-split-plan.md）：
// 启动诊断文案随实现落在 projectTrustGate.ts，契约测试跟随新性所。
const trustGateSource = readFileSync("src/main/pi/projectTrustGate.ts", "utf8");
const indexSource = readFileSync("src/main/index.ts", "utf8");
const systemIpcSource = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const sessionIpcSource = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
const preloadSource = readFileSync("src/preload/index.ts", "utf8");
const ipcSource = readFileSync("src/shared/ipc.ts", "utf8");
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const rendererMainSource = readFileSync("src/renderer/src/main.tsx", "utf8");
// 遮罩撤除实现/时机已收口到独立模块（启动交接：内容就绪再撤，见
// tests/bootOverlayDismissal.test.mjs），main.tsx 只留硬兼底超时。
const bootOverlaySource = readFileSync("src/renderer/src/utils/bootOverlay.ts", "utf8");

test("agent startup writes diagnostics across renderer IPC and pi launch boundaries", () => {
	assert.match(ipcSource, /rendererLog:\s*"renderer:log"/);
	// 参数可能内联在同一行（formatter 去掉了换行）：用 \s* 容忍即可。
	assert.match(preloadSource, /rendererLog:\s*\(?\s*level: AppLogLevel,\s*scope: string,\s*message: string,\s*detail\?: unknown/);
	assert.match(systemIpcSource, /ipcChannels\.rendererLog/);
	assert.doesNotMatch(indexSource, /Agent create IPC received|ipcChannels\.agentsCreate/);
	assert.match(mainSource, /Agent create requested/);
	assert.match(trustGateSource, /Agent ensure trusted directory start/);
	assert.match(trustGateSource, /Agent ensure trusted directory completed/);
	assert.match(mainSource, /Agent pi process start/);
	assert.match(mainSource, /Agent get_state request start/);
	assert.match(mainSource, /handshakePiProcess/);
	assert.match(mainSource, /retrying without extensions/);
	// 启动握手（首次 get_state）必须用专用超时（90s 上限），不吃给长任务的 rpcTimeout：
	// 沿用它会让「进程活着但不就绪」静默等满 10 分钟——现场表现是「不返回失败，直接超时」，
	// 超时前既没有回退也没有诊断。真正的启动失败（spawn 失败/进程 exit）由 PiProcess 立即终结，
	// 毫秒级返回，不等超时。长任务路径仍吃用户配置。
	assert.match(mainSource, /client\.request\(\{ type: "get_state" \}, this\.startupHandshakeTimeoutMs\)/);
	assert.match(mainSource, /get startupHandshakeTimeoutMs\(\): number/);
	assert.match(mainSource, /STARTUP_HANDSHAKE_TIMEOUT_MS = 90_000/);
	assert.match(mainSource, /get rpcTimeoutMs\(\): number/);
	assert.match(mainSource, /this\.settingsStore\.get\(\)\.rpcTimeout/);
	assert.match(mainSource, /Prompt RPC request started/);
	assert.match(mainSource, /Prompt RPC response received/);
	assert.match(mainSource, /rpcMs/);
	assert.match(mainSource, /Agent create failed/);
	assert.match(sessionIpcSource, /Session prompt IPC received/);
	// 绑定智能体的会话在 send 前会重组成 promptInput（注入隐藏 agentMessage），
	// 所以只锁「发送确实经过 runtime coordinator」这个契约，不锁局部变量名。
	assert.match(sessionIpcSource, /await sessionRuntimeCoordinator\.send\(/);
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
	// 良性 ResizeObserver loop 不按 error 上报（否则也进「最近 7 天报错」顶掉真实信号）
	assert.match(rendererMainSource, /isBenignResizeObserverLoop \? "info" : "error"/);
	// issue #376：良性噪音判定与聚合复用 shared 口径（main 侧镜像据此跳过，避免双写）
	assert.match(rendererMainSource, /classifyRendererNoise\(/);
	assert.match(rendererMainSource, /new RendererNoiseAggregator\(\)/);
	assert.match(bootOverlaySource, /export function dismissBootOverlay\(\)/);
	// 挂载帧不得撤遮罩（会露出无会话空态那一帧）；硬兼底必须保留
	assert.doesNotMatch(rendererMainSource, /requestAnimationFrame\(\s*dismissBootOverlay\s*\)/);
	assert.match(rendererMainSource, /window\.setTimeout\(dismissBootOverlay, 1500\)/);
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
