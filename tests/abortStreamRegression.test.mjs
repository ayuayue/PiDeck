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
	assert.doesNotMatch(
		agentManager,
		/addMessage\(agentId,\s*"system",\s*"已请求停止当前响应"/,
	);
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
	assert.doesNotMatch(
		agentManager,
		/recentlyAborted\.has\(agentId\)\s*&&\s*!this\.activeAssistantMessageIds\.has\(agentId\)/,
	);
	assert.doesNotMatch(
		agentManager,
		/recentlyAborted\.has\(agentId\)\s*&&\s*!this\.activeToolCallsByAgent\.has\(agentId\)/,
	);

	// 4) agent_settled 必须 noteAbortSettled，但不得直接 openAgentStream
	const settledBlock =
		agentManager.match(
			/if \(typed\.type === "agent_settled"\) \{[\s\S]*?\n\t\t\}/,
		)?.[0] ?? "";
	assert.match(settledBlock, /noteAgentAbortSettled\(agentId\)/);
	assert.match(settledBlock, /recentlyAborted\.delete\(agentId\)/);
	assert.doesNotMatch(settledBlock, /openAgentStream/);

	// 5) 前端 notice 走 runtime bridge toast；abort 后 live 思考由 agents:thinking done 清通道
	const bridge = readFileSync(
		"src/renderer/src/hooks/useSessionRuntimeBridge.ts",
		"utf8",
	);
	const atoms = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");
	assert.match(bridge, /agents:notice/);
	assert.match(bridge, /showNotice\(/);
	assert.match(atoms, /agents:thinking/);
	assert.match(atoms, /streamingThinkingByIdAtom/);
});

test("abort failures surface to the user and escalate when pi keeps running", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const composer = readFileSync(
		"src/renderer/src/hooks/useSessionComposerController.ts",
		"utf8",
	);
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

	// 1) 工具执行中 abort 未被 pi 及时处理时，主进程升级：abort_bash + 二次 abort
	assert.match(agentManager, /escalateAbortIfStillRunning/);
	assert.match(agentManager, /request\(\{ type: "abort_bash"/);
	assert.match(agentManager, /request\(\{ type: "abort"/);
	assert.match(agentManager, /ABORT_ESCALATION_VERIFY_MS/);

	// 2) 升级后仍未停止必须通知用户（不能只写日志）
	assert.match(agentManager, /i18nKey: "app\.abortSlow"/);
	assert.match(zh, /"app\.abortSlow":/);
	assert.match(en, /"app\.abortSlow":/);

	// 3) 渲染层 abort 失败必须可见：try/catch + toast，禁止未处理 rejection 静默吞错
	assert.match(composer, /catch \(error\)/);
	assert.match(
		composer,
		/showNotice\(\s*error instanceof Error \? error\.message : String\(error\)/,
	);
	assert.match(app, /catch \(error\)/);
	assert.match(
		app,
		/showToast\(\s*error instanceof Error \? error\.message : String\(error\)/,
	);

	// 4) 无运行时目标时也不得静默：给出 runtimeUnavailable 提示
	assert.match(composer, /sessionCommand\.runtimeUnavailable/);
	assert.match(app, /sessionCommand\.runtimeUnavailable/);
});
