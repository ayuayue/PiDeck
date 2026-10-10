import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Issue #218 WSL 回归护栏：WSL 慢链路下「终止回复」曾 100% 把会话打死。
 *
 * 两个根因都用源码契约锁定（AgentManager 深度集成，源码断言是本仓库既定模式）：
 * 1. abort 升级链不感知 ack：pi 的 abort RPC 语义是「中止并等 idle 才响应」，
 *    WSL 下 ack 迟到让 1.5s 兜底必触发，对正在收尾的 pi 补 abort_bash + 二次 abort
 *    （老版本 pi 对 abort 期间的重复中止有 unhandled rejection 崩溃史，上游 #2716）。
 * 2. abort 窗口内进程意外退出被标成 closed 终态：pi 崩溃（任意退出码）= 会话死亡，
 *    而不是按会话文件重连一次保住会话。
 */
test("abort escalation is ack-aware and never double-aborts a winding-down pi", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	// abort 升级判定/补刀收口在 AbortStreamGateController；AgentManager 只保留登记与清理调用。
	const controller = readFileSync("src/main/pi/abortStreamGateController.ts", "utf8");

	// 1) abort() 必须登记升级上下文（工具在跑 + ack 状态）
	assert.match(agentManager, /const\s+escalation\s*=\s*this\.abortGate\.beginEscalation\(agentId,\s*hadActiveTool\);/);
	assert.match(agentManager, /this\.abortGate\.markAbortAcked\(agentId,\s*escalation\);/);
	assert.match(agentManager, /this\.abortGate\.markAbortFailed\(agentId,\s*escalation\);/);

	// 2) 升级判定必须按 ack/工具状态分派，而不是无条件补刀
	assert.match(controller, /const\s+shouldSendAbortBash\s*=\s*escalation\.hadActiveTool;/);
	assert.match(controller, /const\s+shouldResendAbort\s*=\s*escalation\.failed;/);
	assert.match(controller, /if \(!shouldSendAbortBash && !shouldResendAbort\) \{[\s\S]*?Abort escalation skipped/);

	// 3) abort_bash 只在有工具执行时发送；二次 abort 只在 RPC 失败/超时时补发
	const escalateBlock = controller.match(/private async escalateIfStillRunning\(agentId: string\): Promise<void> \{[\s\S]*?\n\t\}/)?.[0] ?? "";
	assert.match(escalateBlock, /if \(shouldSendAbortBash\) \{[\s\S]*?type: "abort_bash"/);
	assert.match(escalateBlock, /if \(shouldResendAbort\) \{[\s\S]*?type: "abort"/);

	// 4) 升级上下文随生命周期清理：新一轮 run 与 agent 终态都要清，防慢泄漏
	assert.match(agentManager, /this\.abortGate\.clearEscalation\(agentId\);/);
	assert.ok((agentManager.match(/this\.abortGate\.clearEscalation\(agentId\);/g) ?? []).length >= 2, "abort escalation context must be cleaned up on both agent_start and clearAgentState");
});

test("process exit inside the abort window reattaches the session instead of closing it", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const zh = readFileSync("src/shared/i18n/mainProcessCopy.ts", "utf8");

	// 1) 终止窗口判定 + 单次重连保护
	assert.match(agentManager, /lastAbortAtByAgent/);
	assert.match(agentManager, /ABORT_EXIT_REATTACH_WINDOW_MS/);
	assert.match(agentManager, /withinAbortWindow && !this\.autoRestartAttempted\.has\(agentId\) && tab\.sessionPath/);
	assert.match(agentManager, /withinAbortWindow && !this\.autoRestartAttempted\.has\(agentId\) && runtime\.tab\.sessionPath/);

	// 2) 两条 exit 路径（create / reattach）都要有终止窗口重连
	assert.match(agentManager, /Agent exited during abort window; reattaching session/);
	assert.match(agentManager, /Agent exited during abort window; reattaching session \(reattach path\)/);

	// 3) 重连成功/失败的用户可见反馈走 i18n
	assert.match(agentManager, /"diagnostic\.abortReconnected"/);
	assert.match(zh, /"diagnostic\.abortReconnected":/);

	// 4) 窗口时间戳随生命周期清理（clearAgentState），防键残留慢泄漏
	assert.match(agentManager, /this\.lastAbortAtByAgent\.delete\(agentId\);/);
});
