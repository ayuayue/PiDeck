import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Issue #361 回归护栏：停止不住时要给用户「能走出去」的入口，但不能替他做破坏性决定。
 *
 * 现场：Windows 下 bash 子进程（MS Store python3 shim）持有 stdout 管道，pi 主线程读到一半卡死，
 * get_state/abort 都不回包 → 用户只能看着命令继续跑，也没有任何「怎么办」的提示。
 *
 * 契约（跨主进程 / 渲染桥 / App 装配三层，源码锁定是本仓库既定模式）：
 * 1. 主进程的「停止响应较慢」notice 必须带 restartSessionRuntime 动作 id；
 * 2. 桥必须把它解析成确认型回调，不得直接在 onClick 里杀进程（误触丢一轮回答）；
 * 3. App 必须把它接到 overlays 确认框 + 现有「重启正在运行的会话」文案上，复用同一条重启路径。
 */
const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const bridge = readFileSync("src/renderer/src/hooks/useSessionRuntimeBridge.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("abort slow notice carries a recovery action id", () => {
	const block = agentManager.match(/emitAbortSlowNotice:\s*\(agentId\)\s*=>[\s\S]*?\}\),/)?.[0] ?? "";
	assert.ok(block, "emitAbortSlowNotice 注入体必须存在");
	assert.match(block, /i18nKey:\s*"app\.abortSlow"/);
	// 主进程不掌握 UI 导航，只能给符号化动作 id；没有它用户就只有一句「停止慢」而无从下手。
	assert.match(block, /action:\s*"restartSessionRuntime"/);
});

test("bridge routes the restart action through a confirm callback instead of killing the process", () => {
	assert.match(bridge, /notice\.action\s*===\s*"restartSessionRuntime"/);
	assert.match(bridge, /onRestartSessionRuntime\?\.\(event\.sessionId\)/, "必须转交回调，由装配层决定是否弹确认");
	// 桥层禁止直连 restartRuntime：确认框是这条路径唯一的护栏。
	assert.doesNotMatch(bridge, /desktopApi\.sessions\.restartRuntime/);
	// 回调入口必须声明在 callbacks 契约里（漏声明 = 静默失效，按钮点了没反应）。
	assert.match(bridge, /onRestartSessionRuntime\?:.*\(sessionId: string\) => void;/);
});

test("App wires the recovery entry to the existing confirm-gated restart path", () => {
	const block = app.match(/onRestartSessionRuntime:\s*\(sessionId\)\s*=>\s*\{[\s\S]*?\n\t\t\},/)?.[0] ?? "";
	assert.ok(block, "App 必须装配 onRestartSessionRuntime");
	// 与 Tab ⋯ 菜单「重启进程」同一份文案/标签，不新增第二种措辞。
	assert.match(block, /title:\s*t\("runControl\.restartRunningTitle"\)/);
	assert.match(block, /confirmLabel:\s*t\("app\.restart"\)/);
	// 复用会话运行控制那条路径而非另起一套：这里必须是 runControl 的 restartSessionAnyState。
	assert.match(block, /restartSessionAnyState\(sessionId\)/);
	assert.match(block, /overlays\.clearConfirm\(\)/, "确认后必须先关框，否则遮罩压在会话上");
	// 无 runtime 绑定的会话不该弹框（点了也是空操作）。
	assert.match(block, /if\s*\(!runtime\?\.agentId\)\s*return;/);
});

test("i18n covers both dictionaries for the notice action label", () => {
	assert.match(zh, /"notice\.restartSessionRuntime":/);
	assert.match(en, /"notice\.restartSessionRuntime":/);
});
