import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 回归护栏：流式期间渲染层必须拿到 isStreaming=true 才会走逐字渐显
 * （useSmoothStream），否则回答整段蹦出、滚动引擎收不到逐字增长（无滞空感）。
 *
 * 背景：isStreaming 原只来自 pi get_state 轮询，而主进程在 text_delta 期间
 * 从不 emitRuntimeState，mock/真实 pi 的轮询也无法覆盖该窗口 → 链路断裂。
 * 修复：主进程本地维护 streamingAgents，text_delta 置位、终态清除，并在
 * 50ms 消息 flush 时顺带推送轻量 isStreaming 补丁（无 RPC）。
 */
test("streaming signal: text_delta sets isStreaming locally, flush pushes lightweight patch", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");

	// 1) 本地流式标志集合存在，并在 getRuntimeState 里并入（轮询兜底）
	assert.match(
		agentManager,
		/private readonly streamingAgents = new Set<string>\(\)/,
	);
	assert.match(
		agentManager,
		/isStreaming: state\?\.isStreaming \|\| this\.streamingAgents\.has\(agentId\)/,
	);

	// 2) message_start / text_delta / thinking_delta 置位流式标志
	assert.match(agentManager, /this\.streamingAgents\.add\(agentId\)/);

	// 3) message_end / done / error 清除（回答结束不再误报流式中）
	assert.match(
		agentManager,
		/eventType === "message_end" \|\|\s*eventType === "done" \|\|\s*eventType === "error"/,
	);
	assert.match(agentManager, /this\.streamingAgents\.delete\(agentId\)/);

	// 4) agent_end / agent_settled / abort 清除（run 生命周期终点）
	assert.match(agentManager, /if \(typed\.type === "agent_end"\)/);
	assert.match(agentManager, /if \(typed\.type === "agent_settled"\)/);
	assert.match(agentManager, /this\.sealAgentStream\(agentId\)/);
	const clearCount =
		agentManager.match(/this\.streamingAgents\.delete\(agentId\)/g)?.length ?? 0;
	assert.ok(
		clearCount >= 3,
		"streamingAgents must be cleared on end/settled/abort paths",
	);

	// 5) 50ms 消息 flush 顺带推送轻量状态补丁（无 RPC）
	assert.match(
		agentManager,
		/private emitStreamingStatePatch\(agentId: string\)/,
	);
	assert.match(
		agentManager,
		/isStreaming: this\.streamingAgents\.has\(agentId\)/,
	);
	assert.match(agentManager, /emitStreamingStatePatch\(agentId\)/);
	assert.match(agentManager, /ipcChannels\.agentsRuntimeState/);
});

test("renderer uses Controls isStreaming for live run marking", () => {
	const timeline = readFileSync(
		"src/renderer/src/components/session/SessionMessageTimeline.tsx",
		"utf8",
	);
	// 2026-08 perf：接线从位置判定（isLatestTimelineRunBusy(index)）改为身份判定
	// （run id 对比 lastDisplayedItemId），流式信号 isRunStreaming 语义保持不变。
	assert.match(
		timeline,
		/const isRunStreaming = isTurnRunning && item\.id === lastDisplayedItemId;/,
	);
	assert.match(timeline, /lastDisplayedItemId/);
	assert.match(timeline, /liveThinkingId=\{liveThinkingId\}/);
	assert.match(timeline, /liveThinkingIdBySessionIdAtomFamily/);
	assert.doesNotMatch(
		timeline,
		/streamingThinking=\{isRunStreaming \? activeThinking : undefined\}/,
	);
	assert.doesNotMatch(timeline, /streamingMessageId/);
});
