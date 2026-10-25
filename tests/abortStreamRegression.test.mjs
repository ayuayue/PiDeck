import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 回归护栏：手动停止后不应再把“系统状态”写进时间线，
 * 且 abort 后的残留 thinking/text 事件必须走 generation 闸门硬拦截。
 * 这类问题修过又回归过多次，用源码契约测试锁定关键路径。
 */
test("abort feedback is toast-only and seals stream generation", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const streamGate = readFileSync("src/main/pi/streamGate.ts", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");

	// 1) 停止反馈不得再 addMessage 系统卡片
	assert.doesNotMatch(agentManager, /addMessage\(agentId,\s*"system",\s*"已请求停止当前响应"/);
	assert.match(agentManager, /ipcChannels\.agentsNotice/);
	assert.match(ipc, /agentsNotice:\s*"agents:notice"/);

	// 2) abort 必须封印 stream generation，并走 settled 协同解封
	assert.match(agentManager, /this\.sealAgentStream\(agentId\)/);
	assert.match(agentManager, /this\.openAgentStream\(agentId\)/);
	assert.match(agentManager, /this\.noteAgentAbortSettled\(agentId\)/);
	assert.match(agentManager, /isAgentStreamSealed\(agentId\)/);
	assert.match(streamGate, /sealedGeneration/);
	assert.match(streamGate, /currentGeneration/);
	assert.match(streamGate, /waitingForAbortSettled/);
	assert.match(streamGate, /pendingOpenAfterSettled/);

	// 3) message_update / tool 事件不得再依赖“有 activeAssistantMessageIds 就放行”的例外
	assert.doesNotMatch(agentManager, /recentlyAborted\.has\(agentId\)\s*&&\s*!this\.activeAssistantMessageIds\.has\(agentId\)/);
	assert.doesNotMatch(agentManager, /recentlyAborted\.has\(agentId\)\s*&&\s*!this\.activeToolCallsByAgent\.has\(agentId\)/);

	// 4) agent_settled 必须 noteAbortSettled，但不得直接 openAgentStream
	const settledBlock = agentManager.match(/if \(typed\.type === "agent_settled"\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
	assert.match(settledBlock, /noteAgentAbortSettled\(agentId\)/);
	assert.match(settledBlock, /recentlyAborted\.delete\(agentId\)/);
	assert.doesNotMatch(settledBlock, /openAgentStream/);

	// 5) 前端 notice 走 runtime bridge toast；abort 后 live 思考由 agents:thinking done 清通道
	const bridge = readFileSync("src/renderer/src/hooks/useSessionRuntimeBridge.ts", "utf8");
	const atoms = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");
	assert.match(bridge, /agents:notice/);
	assert.match(bridge, /showNotice\(/);
	assert.match(atoms, /agents:thinking/);
	assert.match(atoms, /streamingThinkingByIdAtom/);
});

test("abort failures surface to the user and escalate when pi keeps running", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const controller = readFileSync("src/main/pi/abortStreamGateController.ts", "utf8");
	const composer = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	// 运行控制（abort/stop 的 toast 与 runtimeUnavailable 提示）已迁入 useSessionRunControl。
	const runControl = readFileSync("src/renderer/src/hooks/session/useSessionRunControl.ts", "utf8");
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

	// 1) 工具执行中 abort 未被 pi 及时处理时，主进程升级：abort_bash + 二次 abort（收口在 AbortStreamGateController）
	assert.match(controller, /escalateIfStillRunning/);
	assert.match(controller, /request\(\{ type: "abort_bash"/);
	assert.match(controller, /request\(\{ type: "abort"/);
	assert.match(controller, /ABORT_ESCALATION_VERIFY_MS/);

	// 2) 升级后仍未停止必须通知用户（不能只写日志；notice 发射在 AgentManager 宿主适配里）
	assert.match(agentManager, /i18nKey: "app\.abortSlow"/);
	assert.match(zh, /"app\.abortSlow":/);
	assert.match(en, /"app\.abortSlow":/);

	// 3) 渲染层 abort 失败必须可见：try/catch + toast，禁止未处理 rejection 静默吞错
	assert.match(composer, /catch \(error\)/);
	assert.match(composer, /showNotice\(error instanceof Error \? error\.message : String\(error\)/);
	assert.match(app, /catch \(error\)/);
	assert.match(app, /showToast\(error instanceof Error \? error\.message : String\(error\)/);

	// 4) 无运行时目标时也不得静默：给出 runtimeUnavailable 提示
	assert.match(composer, /sessionCommand\.runtimeUnavailable/);
	assert.match(runControl, /sessionCommand\.runtimeUnavailable/);
});

/**
 * Issue #371：abort RPC 超时后 PiDeck 已把 tab 复位 idle，而 pi 仍在流式。
 * 本地状态不可信，必须有「pi 权威忙碌」的纠偏与发送兜底，否则用户点发送只会收到
 * pi 的 SDK 原文拒收 toast（同一 agent 会被连拒多次）。
 */
test("a stuck run is not reported idle: pi-authoritative signals reach the send path", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const controller = readFileSync("src/main/pi/abortStreamGateController.ts", "utf8");

	// 1) 发送前的忙碌判定必须并入 pi 侧权威信号，不能只看本地 tab.status
	const busyLine = agentManager.match(/const alreadyBusy = [^;]+;/)?.[0] ?? "";
	assert.match(busyLine, /piMightStillBeStreaming/, "alreadyBusy 必须并入 pi 权威信号");
	assert.match(agentManager.match(/private piMightStillBeStreaming\(agentId: string\): boolean \{[\s\S]*?\n\t\}/)?.[0] ?? "", /streamingAgents\.has\(agentId\)[\s\S]*recentlyAborted\.has\(agentId\)[\s\S]*isEscalationPending\(agentId\)/);

	// 2) 仍被拒收时按设置项补发一次带 streamingBehavior 的 prompt
	assert.match(agentManager, /isPiBusyRejection/);
	assert.match(agentManager, /Agent is already processing/i);
	assert.match(agentManager, /parseBusySendDelivery\(this\.settingsStore\.get\(\)\.busySendDelivery\)/);
	assert.match(agentManager, /streamingBehavior: busyRetryBehavior/);

	// 3) 升级确认 pi 仍在流式时，宿主必须撤销本地的乐观 idle
	const hostBlock = agentManager.match(/private readonly abortGate = new AbortStreamGateController\(\{[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(hostBlock, /noteStillStreamingAfterAbort/);
	assert.match(controller, /noteStillStreamingAfterAbort\(agentId: string\): void;/);
	assert.match(controller, /isEscalationPending/);
});
