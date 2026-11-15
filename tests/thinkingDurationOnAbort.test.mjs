import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * 停止（abort）后思考耗时不得归零。
 *
 * 事故：用户点「停止当前响应」后，时间线上每条思考折叠行从实时秒表变成「思考了 0ms」。
 * 机理：abort 路径写入 messages 时若拿不到 LiveStream 的思考段（段已被并发清理或重建），
 * startedAt 与 endedAt 双双回落到同一次 Date.now()，差值为 0 并被持久化进消息。
 * 本测试走与事故同源的路径（thinking_delta → abort），不经过历史重放。
 */
function createManager(requestHandler) {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({ rpcTimeout: 30_000 }) },
		{},
	);
	const runtime = {
		tab: {
			id: "agent-1",
			deckSessionId: "session-original",
			runtimeGeneration: 1,
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "running",
			sessionPath: "C:/project/.pi/sessions/xxx.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: {
			isRunning: () => true,
			getDiagnostics: () => null,
			stop: () => {},
			client: { request: requestHandler },
		},
	};
	manager.agents.set("agent-1", runtime);
	manager.onOutput(() => {});
	return { manager, runtime };
}

const thinkingDelta = (delta) => ({
	type: "message_update",
	assistantMessageEvent: { type: "thinking_delta", delta },
	message: { role: "assistant", content: [{ type: "thinking", thinking: delta }] },
});

async function settleTimers() {
	for (let i = 0; i < 24; i += 1) await new Promise((r) => setTimeout(r, 25));
}

test("停止后思考耗时不得归零（thinking_delta → abort）", async () => {
	const { manager } = createManager(async () => ({ success: true, data: null }));
	manager.handlePiEvent("agent-1", thinkingDelta("先想第一步，再想第二步。"));
	// 让思考段至少跨过几毫秒，0ms 才可能是缺陷而不是同毫秒巧合
	await new Promise((r) => setTimeout(r, 60));
	await manager.abort("agent-1");
	await settleTimers();

	const messages = manager.messages.get("agent-1") ?? [];
	const withThinking = messages.filter((m) => m.thinking?.trim());
	assert.ok(withThinking.length > 0, "abort 后应至少有一条带思考内容的消息");
	for (const m of withThinking) {
		assert.equal(typeof m.thinkingStartedAt, "number", "缺少 thinkingStartedAt");
		assert.equal(typeof m.thinkingEndedAt, "number", "缺少 thinkingEndedAt");
		assert.ok(m.thinkingEndedAt > m.thinkingStartedAt, `思考耗时被写成 ${m.thinkingEndedAt - m.thinkingStartedAt}ms`);
	}
});

test("停止后同一段思考的耗时与停止前秒表一致（不被二次写入覆盖）", async () => {
	const { manager } = createManager(async () => ({ success: true, data: null }));
	manager.handlePiEvent("agent-1", thinkingDelta("思考中"));
	await new Promise((r) => setTimeout(r, 50));
	const segmentBefore = manager.liveStream.getSegment("agent-1");
	await manager.abort("agent-1");
	await settleTimers();
	const messages = manager.messages.get("agent-1") ?? [];
	const m = messages.find((x) => x.thinking?.trim());
	assert.ok(m, "应有带思考内容的消息");
	if (segmentBefore) {
		assert.equal(m.thinkingStartedAt, segmentBefore.startedAt, "startedAt 应沿用思考段首 delta 时刻");
	}
});
test("思考结束（thinking_end）后消息就带上区间，不等 abort", async () => {
	const { manager } = createManager(async () => ({ success: true, data: null }));
	manager.handlePiEvent("agent-1", thinkingDelta("先想第一步，再想第二步。"));
	await new Promise((r) => setTimeout(r, 60));
	manager.handlePiEvent("agent-1", {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_end", content: "先想第一步，再想第二步。" },
		message: { role: "assistant", content: [{ type: "thinking", thinking: "先想第一步，再想第二步。" }] },
	});
	manager.handlePiEvent("agent-1", {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "结论如下。" },
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "先想第一步，再想第二步。" },
				{ type: "text", text: "结论如下。" },
			],
		},
	});
	manager.handlePiEvent("agent-1", {
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "先想第一步，再想第二步。" },
				{ type: "text", text: "结论如下。" },
			],
		},
	});
	await settleTimers();
	const messages = manager.messages.get("agent-1") ?? [];
	const m = messages.find((x) => x.thinking?.trim());
	assert.ok(m, "应有带思考内容的消息");
	assert.equal(typeof m.thinkingStartedAt, "number", "消息缺少 thinkingStartedAt：渲染层会回落到 message.timestamp，两端同值 → 0ms");
	assert.equal(typeof m.thinkingEndedAt, "number", "消息缺少 thinkingEndedAt");
	assert.ok(m.thinkingEndedAt - m.thinkingStartedAt > 0, `思考耗时被写成 ${m.thinkingEndedAt - m.thinkingStartedAt}ms`);
});
