import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
const { resolveClaimedPrompt } = loadTsCommonJs("src/renderer/src/utils/queuedPromptQueue.ts");
const { isSessionRuntimeBusy } = loadTsCommonJs("src/renderer/src/hooks/session/timeline/timelineSurfacePolicy.ts");

/**
 * 压缩期间投递的语义（用户反馈：压缩中回车 → 「错误诊断 消息发送失败。Cannot submit a
 * prompt while compaction is in progress」+ 队列项变「失败」）。
 *
 * pi 的 `prompt()` 在压缩期间**不看 streamingBehavior** 直接 throw（agent-session.js 的
 * `_compactionAbortController` 守卫），所以 steer / followUp 一样被拒。PiDeck 从前的做法是
 * 把它当成普通拒收：写「消息发送失败」、队列项标 failed。正确语义是**退回队列**——
 * 消息确定没送到（不能当 accepted / unknown），也不是失败（用户没做错任何事），
 * 压缩结束后由 drain 自动补发（上游 TUI 的 queueCompactionMessage 同语义）。
 */
const COMPACTION_REJECTION = "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.";

function createManager(requestHandler) {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({ rpcTimeout: 30_000 }) },
		{},
		undefined,
		undefined,
		undefined,
		() => "",
	);
	const runtime = {
		tab: {
			id: "agent-1",
			deckSessionId: "session-1",
			runtimeGeneration: 1,
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "idle",
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
	return { manager, runtime };
}

function messagesOf(manager) {
	return manager.messages.get("agent-1") ?? [];
}

function rejectionCards(manager) {
	return messagesOf(manager).filter((message) => message.role === "error" || message.meta?.i18nKey === "diagnostic.promptRejected");
}

test("压缩中发送：宿主直接退回 deferral，不发 prompt、不写失败消息、状态保持忙碌", async () => {
	const prompts = [];
	const { manager, runtime } = createManager(async (payload) => {
		if (payload.type === "prompt") prompts.push(payload);
		return { success: true, data: { disposition: "started" } };
	});
	// 手动压缩在空闲会话上起跑：status 仍是 idle，只有 compactingAgents 说明正在压缩。
	manager.compactingAgents.add("agent-1");

	const result = await manager.sendPrompt({ agentId: "agent-1", message: "综述测评章节，帮我提炼思考" });

	assert.equal(result.accepted, false);
	assert.equal(result.deferral, "compaction-in-progress", "渲染层靠这个标记把消息留在队列，而不是判失败");
	assert.equal(result.i18nKey, "diagnostic.compactionInProgress");
	assert.equal(prompts.length, 0, "压缩中连 steer 都不该发：pi 会无条件拒收");
	assert.equal(runtime.tab.status, "running", "压缩期间必须保持忙碌，否则队列会每 2s 撞一次拒收");
	assert.equal(messagesOf(manager).length, 0, "退回队列的消息不写乐观用户消息，也不写错误卡片");
});

test("压缩刚开始、宿主还没收到事件时撞上 pi 的压缩拒收：同样退回 deferral，不记发送失败", async () => {
	const { manager } = createManager(async (payload) => {
		if (payload.type === "prompt") return { success: false, error: COMPACTION_REJECTION };
		return { success: true, data: {} };
	});

	const result = await manager.sendPrompt({ agentId: "agent-1", message: "继续" });

	assert.equal(result.deferral, "compaction-in-progress");
	assert.notEqual(result.delivery, "unknown", "pi 明确拒收 = 确定没送到，不能降级成投递未知");
	assert.equal(rejectionCards(manager).length, 0, "压缩窗口里的拒收不是「消息发送失败」");
});

test("非压缩原因的拒收仍然是失败（回归）", async () => {
	const { manager } = createManager(async (payload) => {
		if (payload.type === "prompt") return { success: false, error: "model does not support images" };
		return { success: true, data: {} };
	});

	const result = await manager.sendPrompt({ agentId: "agent-1", message: "看图" });

	assert.equal(result.accepted, false);
	assert.equal(result.deferral, undefined, "只有压缩窗口才能退回队列");
	assert.equal(result.i18nKey, "diagnostic.promptRejected");
	assert.equal(rejectionCards(manager).length, 1, "普通拒收必须留下可解释的错误卡片");
});

test("压缩结束后同一条消息正常发送（守卫不粘住）", async () => {
	const prompts = [];
	const { manager } = createManager(async (payload) => {
		if (payload.type === "prompt") {
			prompts.push(payload);
			return { success: true, data: { disposition: "started" } };
		}
		return { success: true, data: {} };
	});
	manager.compactingAgents.add("agent-1");
	const deferred = await manager.sendPrompt({ agentId: "agent-1", message: "继续" });
	assert.equal(deferred.deferral, "compaction-in-progress");

	manager.compactingAgents.delete("agent-1");
	const accepted = await manager.sendPrompt({ agentId: "agent-1", message: "继续" });
	assert.equal(accepted.accepted, true);
	assert.equal(prompts.length, 1);
});

test("队列结算：deferred 退回 pending（不标失败、不丢快照）", () => {
	const queues = {
		"session-1": [{ id: "p1", message: "打包后正文", displayText: "打包后正文", behavior: "followUp", agentMode: "normal", timestamp: 1, status: "sending" }],
	};

	const next = resolveClaimedPrompt(queues, "session-1", "p1", { type: "deferred" });

	assert.equal(next["session-1"][0].status, "pending");
	assert.equal(next["session-1"][0].error, undefined);
	assert.equal(next["session-1"][0].message, "打包后正文", "消息快照必须保留，压缩结束后原样补发");
});

test("忙碌判据：空闲但压缩中 = 不可投递（手动压缩在 idle 上起跑）", () => {
	assert.equal(isSessionRuntimeBusy("idle", { isCompacting: true }), true);
	assert.equal(isSessionRuntimeBusy("idle", { isCompacting: false }), false);
	assert.equal(isSessionRuntimeBusy("running", { isCompacting: true }), true);
});
