import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 最近一次回复的性能指标（TTFT/总耗时/TPS）由主进程在流式事件上本地计时，
// 经 AgentRuntimeState 下发，渲染层在 ctx.detail 面板展示。pi 不暴露任何耗时字段，
// 因此这三个指标完全由 PiDeck 计算——此处静态断言计算与展示链路完整。
// 计时域收口在 src/main/pi/messagePerfTracker.ts（2026-03 从 AgentManager 迁出，行为零变化）。

const readAgentManager = () => readFileSync("src/main/pi/AgentManager.ts", "utf8");
const readTracker = () => readFileSync("src/main/pi/messagePerfTracker.ts", "utf8");

test("AgentManager keeps per-agent streaming perf timers", () => {
	const source = readTracker();
	// 计时状态：sendPrompt 请求时刻起表（首个 message_start 消费），首 delta 记 firstDeltaAt，正文首 delta 记 firstTextAt
	// 泛型参数可整体内联为一行，断言只锁字段名与类型语义。
	assert.match(source, /perfByAgent = new Map<[\s\S]{0,20}?string,[\s\S]{0,20}?\{ startedAt: number; firstDeltaAt: number; firstTextAt: number \}[\s\S]{0,20}?>\(\)/);
	assert.match(source, /lastPerfByAgent = new Map<string, MessagePerfSnapshot>\(\)/);
	// AgentManager 持有唯一实例（域收口后不再有散落 Map）
	assert.match(readAgentManager(), /private readonly messagePerf = new MessagePerfTracker\(\);/);
});

test("AgentManager starts the perf timer on message_start (idempotent)", () => {
	const source = readTracker();
	// ensureTimer 幂等：顶层 message_start 与 message_update start 两条路径都可能先到，
	// 只在尚无计时器时创建，避免覆盖丢失 startedAt
	const ensure = source.slice(source.indexOf("ensureTimer(agentId: string): void {"), source.indexOf("settle(agentId: string"));
	assert.match(ensure, /if \(!this\.perfByAgent\.has\(agentId\)\)/);
	// 起点优先取 sendPrompt 记录的请求发出时刻（消费后删除），无请求起点时回退事件到达时刻
	assert.match(ensure, /const requestedAt = this\.promptRequestedAtByAgent\.get\(agentId\);/);
	assert.match(ensure, /if \(requestedAt !== undefined\) this\.promptRequestedAtByAgent\.delete\(agentId\);/);
	assert.match(ensure, /startedAt: requestedAt \?\? Date\.now\(\),/);
	assert.match(ensure, /firstDeltaAt: 0,/);
	assert.match(ensure, /firstTextAt: 0,/);
	// 顶层 message_start（mock/pi 均走此路径）与 message_update start 都接入计时
	const agentManager = readAgentManager();
	assert.match(agentManager, /typed\.type === "message_start" && startMessage\?\.role === "assistant"/);
	assert.match(agentManager, /eventType === "start" \|\| eventType === "message_start"/);
	const startBranch = agentManager.slice(agentManager.indexOf('typed.type === "message_start" && startMessage?.role === "assistant"'), agentManager.indexOf('typed.type === "auto_retry_start"'));
	assert.match(startBranch, /this\.messagePerf\.ensureTimer\(agentId\);/);
});

test("first content delta (text or thinking) stamps firstDeltaAt once", () => {
	const source = readTracker();
	// 首 token 判定：text_delta 与 thinking_delta 都算（用户最先感知到的是二者之一）
	const markFirstDeltaBody = source.slice(source.indexOf("markFirstDelta(agentId: string): void {"), source.indexOf("ensureTimer(agentId: string): void {"));
	assert.match(markFirstDeltaBody, /if \(perf && perf\.firstDeltaAt === 0\)/);
	assert.match(markFirstDeltaBody, /perf\.firstDeltaAt = Date\.now\(\);/);
	// 正文首 delta 单独计时：思考模式下用户感知的首字是正文首字，只在 text_delta 分支记
	assert.match(markFirstDeltaBody, /if \(perf && perf\.firstTextAt === 0\)/);
	assert.match(markFirstDeltaBody, /perf\.firstTextAt = Date\.now\(\);/);
	const agentManager = readAgentManager();
	const textDeltaBranch = agentManager.slice(agentManager.indexOf('eventType === "text_delta"'), agentManager.indexOf('eventType === "thinking_delta"'));
	assert.match(textDeltaBranch, /this\.messagePerf\.markFirstText\(agentId\);/);
});

test("message_end/done/error settles perf and pushes a runtime-state patch", () => {
	const agentManager = readAgentManager();
	// 顶层 message_end（pi 实际走此路径，不经 message_update）也结算
	assert.match(agentManager, /typed\.type === "message_end" &&/);
	assert.match(agentManager, /this\.messagePerf\.settle\(agentId, \(channel, payload\) => this\.emit\(channel, payload\), messageEnd\);/);
	// message_update 终态（done/error）结算
	assert.match(agentManager, /eventType === "message_end" \|\| eventType === "done" \|\| eventType === "error"/);
	assert.match(agentManager, /this\.messagePerf\.settle\(agentId, \(channel, payload\) => this\.emit\(channel, payload\), partialMessage\);/);
	// 结算口径：ttft = 首字（正文首 delta 优先，无正文退回首 delta）− 请求发出时刻；
	// total = 终态 − 请求发出时刻；tps = output tokens ÷ 生成期（首 delta → 终态）
	const source = readTracker();
	const settle = source.slice(source.indexOf("settle(agentId: string"), source.indexOf("clearAgent(agentId"));
	assert.match(settle, /const totalMs = now - perf\.startedAt;/);
	assert.match(settle, /perf\.firstTextAt > 0 \? perf\.firstTextAt : perf\.firstDeltaAt > 0 \? perf\.firstDeltaAt : 0/);
	assert.match(settle, /const ttftMs =/);
	assert.match(settle, /const streamingMs = perf\.firstDeltaAt > 0 \? now - perf\.firstDeltaAt : undefined;/);
	assert.match(settle, /calculateTokensPerSecond\(outputTokens, streamingMs\)/);
	assert.match(settle, /calculateTokensPerSecond\(outputTokens, totalMs\)/);
	// 结算结果本地缓存 + 边沿推送（不触发 get_state/get_session_stats RPC）
	assert.match(settle, /lastPerfByAgent\.set\(agentId,\s*\{\s*ttftMs,\s*totalMs,\s*endToEndTps,\s*tps,\s*at:\s*now\s*\}\)/);
	assert.match(settle, /state:\s*\{\s*ttftMs,\s*totalMs,\s*endToEndTps,\s*tps,\s*perfAt:\s*now\s*\}/);
});

test("perf timer starts from the sendPrompt request time, consumed once", () => {
	const source = readTracker();
	// 起点修正：sendPrompt 在 RPC 请求发出时刻记录请求起点（而非收到 message_start 才起表），
	// 把 pi 内部排队与模型服务端等待计入用户体感的首 token 延迟，避免统计系统性偏短
	assert.match(source, /promptRequestedAtByAgent = new Map<string, number>\(\)/);
	const manager = readAgentManager();
	assert.match(manager, /if \(!alreadyBusy\) this\.messagePerf\.notePromptRequested\(input\.agentId, rpcStartedAt\);/);
	assert.match(manager, /typed\.type === "turn_start" && runtime && !this\.isAgentStreamSealed\(agentId\)/);
	// agent_end（含 willRetry）作废未结算起点：重试从新的 turn_start 重新计时
	assert.match(manager, /typed\.type === "agent_end"\) \{\n(?:\s*\/\/[^\n]*\n)*\s*this\.messagePerf\.discardInFlight\(agentId\);/);
	// 起表时消费请求起点：消费后删除，防止工具后续答回合误用上一次请求起点（应回退事件时刻）
	const ensure = source.slice(source.indexOf("ensureTimer(agentId: string): void {"), source.indexOf("settle(agentId: string"));
	assert.match(ensure, /const requestedAt = this\.promptRequestedAtByAgent\.get\(agentId\);/);
	assert.match(ensure, /if \(requestedAt !== undefined\) this\.promptRequestedAtByAgent\.delete\(agentId\);/);
	assert.match(ensure, /startedAt: requestedAt \?\? Date\.now\(\),/);
});

test("getRuntimeState merges last perf metrics", () => {
	const source = readAgentManager();
	assert.match(source, /const perf = this\.messagePerf\.getLast\(agentId\);/);
	assert.match(source, /ttftMs: perf\?\.ttftMs,/);
	assert.match(source, /totalMs: perf\?\.totalMs,/);
	assert.match(source, /tps: perf\?\.tps,/);
	assert.match(source, /perfAt: perf\?\.at,/);
});

test("AgentRuntimeState carries perf fields", () => {
	const source = readFileSync("src/shared/types/agent.ts", "utf8");
	for (const field of ["ttftMs?: number", "totalMs?: number", "endToEndTps?: number", "tps?: number", "perfAt?: number"]) {
		assert.match(source, new RegExp(field.replace("?", "\\?")), `missing ${field}`);
	}
});

test("ctx.detail shows TTFT / total time / speed with i18n labels", () => {
	const surface = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
	assert.match(surface, /state\.ttftMs != null/);
	assert.match(surface, /state\.totalMs != null/);
	assert.match(surface, /state\.tps != null/);
	assert.match(surface, /const replyPerfRows/);
	assert.match(surface, /t\("ctx\.detail\.ttft"\), value: formatDuration\(state\.ttftMs\)/);
	assert.match(surface, /t\("ctx\.detail\.total"\), value: formatDuration\(state\.totalMs\)/);
	assert.match(surface, /const throughput = buildTpsDisplay\(tpsMode, state\.tps, state\.endToEndTps, "reply"\)/);
	assert.match(surface, /label: throughput\.label, value: throughput\.value, hint: throughput\.hint/);
	assert.match(surface, /t\("ctx\.detail\.lastReply"\)/);
	assert.match(surface, /border-t border-border\/70 pt-2/);
});
