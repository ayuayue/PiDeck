import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * 双份回归（第二半）：loadMessages 重载（compaction_end/重连等）替换消息列表后，
 * 「终态事件迟到」的 upsert 必须命中列表里已有的同内容投影版（更新 + 重定向），
 * 而不是把运行期副本 append 到列表尾部——旧行为会在尾部再造一份，
 * 同一条中间回复以两个身份进入渲染层、被切分到两个 run。
 *
 * 场景复现：流式中的 assistant A（运行期 id）在重载后落盘为投影版 A'
 * （id=agent-1-history-e2）；A 的 message_end 事件随后到达——activeAssistantMessageIds
 * 仍指向运行期 id，列表里找不到 → 旧逻辑 append 完整版到尾部（双份）。
 */

function createManager() {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	const runtime = {
		tab: {
			id: "agent-1",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "running",
			sessionPath: "C:/project/.pi/sessions/xxx.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: { client: { request: async () => ({ success: true, data: {} }) } },
	};
	manager.agents.set("agent-1", runtime);
	return manager;
}

/** 模拟重载后的投影列表：一条带 entryId 的 assistant 中间回复。 */
function seedProjectedMessages(manager, text = "好的，我来画", thinking = "") {
	const projected = {
		id: "agent-1-history-e2",
		agentId: "agent-1",
		role: "assistant",
		text,
		timestamp: 1_000,
		meta: { entryId: "e2", _piDeckMsgSeq: 1 },
		...(thinking ? { thinking } : {}),
	};
	manager.messages.set("agent-1", [projected]);
	return projected;
}

const assistantEvent = (text, stopReason = "stop", thinking) => ({
	role: "assistant",
	content: [...(thinking ? [{ type: "thinking", thinking }] : []), { type: "text", text }],
	stopReason,
	timestamp: 2_000,
});

test("message_end 迟到：更新投影版并重定向，不 append 副本（旧行为双份）", () => {
	const manager = createManager();
	const projected = seedProjectedMessages(manager, "好的，我来画");
	// 重载前运行期流式骨架的 id 仍登记在 activeAssistantMessageIds
	manager.activeAssistantMessageIds.set("agent-1", "run-uuid-1");

	manager.upsertAssistantMessage("agent-1", assistantEvent("好的，我来画", "stop"));

	const list = manager.messages.get("agent-1");
	assert.equal(list.length, 1, "同一条 pi 消息不得出现两份");
	assert.equal(list[0].id, projected.id, "更新的是投影版（保留 entryId 身份）");
	assert.equal(list[0].text, "好的，我来画");
	assert.equal(list[0].stopReason, "stop", "终态 stopReason 写入投影版");
	// 后续终态事件（同一条消息，text 一致）继续命中同一投影版，不 append
	manager.upsertAssistantMessage("agent-1", assistantEvent("好的，我来画", "stop"));
	assert.equal(manager.messages.get("agent-1").length, 1, "连续事件不得再造副本");
	assert.equal(manager.messages.get("agent-1")[0].text, "好的，我来画");
});

test("tool_execution_end 迟到：按 toolCallId 更新已有工具消息，不 append 副本", () => {
	const manager = createManager();
	// 重载后列表里已有投影版工具消息（带 entryId 与 toolCallId）
	manager.messages.set("agent-1", [
		{
			id: "agent-1-history-e3",
			agentId: "agent-1",
			role: "tool",
			text: "✓ image_gen",
			timestamp: 1_000,
			meta: { entryId: "e3", toolCallId: "tc-1", status: "done" },
		},
	]);
	// 重载前运行期 toolMessageIds 登记的原 id（重载后列表里不存在）
	manager.toolMessageIds.set("agent-1", new Map([["tc-1", "run-tool-uuid"]]));

	manager.upsertToolMessage("agent-1", { toolName: "image_gen", toolCallId: "tc-1", result: { content: [{ text: "done" }] } }, "done");

	const list = manager.messages.get("agent-1");
	assert.equal(list.length, 1, "工具消息不得双份");
	assert.equal(list[0].meta.entryId, "e3", "更新的是投影版");
	assert.equal(list[0].meta.toolCallId, "tc-1");
});

test("finalizeThinkingIntoMessage 终态：更新投影版不 append 副本", () => {
	const manager = createManager();
	// 投影版 text 与终态事件 extractText 同规则（thinking 块包 <thinking> 标签）
	const projected = seedProjectedMessages(manager, "<thinking>思考内容</thinking>");
	manager.activeAssistantMessageIds.set("agent-1", "run-uuid-1");
	// 重载后思考段仍登记（运行期段身份），终态写入时须命中投影版
	manager.liveStream.thinkingSegmentByAgent.set("agent-1", {
		id: "msg-thinking-run-uuid-1",
		assistantMessageId: "run-uuid-1",
		startedAt: 500,
		endedAt: 900,
	});
	manager.liveStream.streamingThinking.set("agent-1", "思考内容");

	manager.finalizeThinkingIntoMessage("agent-1", assistantEvent("", "stop", "思考内容"));

	const list = manager.messages.get("agent-1");
	assert.equal(list.length, 1, "思考终态不得再造副本");
	assert.equal(list[0].id, projected.id);
	assert.equal(list[0].thinking, "思考内容");
});

test("rebindInFlightMessages：流式中间态重载后身份重定向到投影版", () => {
	const manager = createManager();
	// 投影快照捕捉到流式中间态：未完成 assistant（无 stopReason、有部分文本）
	const projected = {
		id: "agent-1-history-e9",
		agentId: "agent-1",
		role: "assistant",
		text: "正在生成图片（部分）",
		timestamp: 1_000,
		meta: { entryId: "e9" },
	};
	// 运行期骨架（空文本，preserved 保护保留在尾部）
	const skeleton = {
		id: "run-uuid-9",
		agentId: "agent-1",
		role: "assistant",
		text: "",
		timestamp: 2_000,
	};
	manager.activeAssistantMessageIds.set("agent-1", "run-uuid-9");
	manager.liveStream.thinkingSegmentByAgent.set("agent-1", {
		id: "msg-thinking-run-uuid-9",
		assistantMessageId: "run-uuid-9",
		startedAt: 800,
		endedAt: 0,
	});

	const next = [projected, skeleton];
	manager.rebindInFlightMessages("agent-1", next, [projected]);
	// loadMessages 的衔接：rebind 后写回消息缓存（测试单独调 rebind 需手动补齐）
	manager.messages.set("agent-1", next);

	assert.equal(next.length, 1, "骨架被移除，不残留双份");
	assert.equal(next[0].id, projected.id, "保留投影版（位置正确、带 entryId）");
	assert.equal(manager.activeAssistantMessageIds.get("agent-1"), projected.id, "后续 message_end 事件命中投影版，不再 append 副本");
	const segment = manager.liveStream.thinkingSegmentByAgent.get("agent-1");
	assert.equal(segment.assistantMessageId, projected.id, "思考段身份同步重定向");
	assert.equal(segment.id, `msg-thinking-${projected.id}`);

	// 重定向后 message_end 终态更新投影版，不产生第二份
	manager.upsertAssistantMessage("agent-1", assistantEvent("正在生成图片（部分）", "stop"));
	assert.equal(next.length, 1);
	assert.equal(next[0].stopReason, "stop");
});

test("rebindInFlightMessages：运行中工具消息重载后按 toolCallId 重定向", () => {
	const manager = createManager();
	const projectedTool = {
		id: "agent-1-history-e10",
		agentId: "agent-1",
		role: "tool",
		text: "✓ image_gen",
		timestamp: 1_000,
		meta: { entryId: "e10", toolCallId: "tc-9", status: "done" },
	};
	const runningTool = new Map([["tc-9", "run-tool-uuid-9"]]);
	manager.toolMessageIds.set("agent-1", runningTool);

	const next = [projectedTool];
	manager.rebindInFlightMessages("agent-1", next, [projectedTool]);

	assert.equal(runningTool.get("tc-9"), projectedTool.id, "工具身份映射重定向到投影版");
});
