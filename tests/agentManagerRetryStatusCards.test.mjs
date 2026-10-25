import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * 自动重试状态卡：一次重试周期（auto_retry_start → auto_retry_end）一张卡。
 *
 * 旧行为是「每个 agent 只保留一条重试消息」并原地改写：第二轮重试会把上一轮已经
 * 收敛成「自动重试成功」的卡片重新刷成「正在自动重试」，时间线上永远只剩最后一条，
 * 用户看不出到底重试过几次（用户反馈：不知道重试了）。
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

function retryMessages(manager) {
	return manager.messages.get("agent-1") ?? [];
}

test("第二轮重试新建卡片：已收敛的成功卡不被改写", () => {
	const manager = createManager();

	// 第一轮：调度重试 → 成功收敛
	manager.upsertRetryStatusMessage("agent-1", { attempt: 1, maxAttempts: 3, errorMessage: "HTTP 429" }, "running");
	manager.upsertRetryStatusMessage("agent-1", { attempt: 1, maxAttempts: 3, success: true }, "success");

	// 第二轮：用户继续对话再次失败，pi 重新调度重试
	manager.upsertRetryStatusMessage("agent-1", { attempt: 1, maxAttempts: 3, delayMs: 5000, errorMessage: "HTTP 500" }, "running");

	const list = retryMessages(manager);
	assert.equal(list.length, 2, "每个重试周期应各留一张卡片");
	assert.equal(list[0].meta.status, "success");
	assert.equal(list[0].meta.i18nKey, "diagnostic.retrySucceeded");
	assert.equal(list[1].meta.status, "running");
	assert.equal(list[1].meta.i18nKey, "diagnostic.retryScheduledAfterDelay");
	assert.notEqual(list[0].id, list[1].id);

	// 同一周期内的后续事件（退避时间变化）继续复用运行中的卡片，不新增
	manager.upsertRetryStatusMessage("agent-1", { attempt: 1, maxAttempts: 3, delayMs: 30000 }, "running");
	assert.equal(retryMessages(manager).length, 2);
	assert.equal(list[1].meta.delayMs, 30000);
});

test("周期以失败收敛：卡片改写为 retryFailed，后续失败诊断仍带重试次数", () => {
	const manager = createManager();

	manager.upsertRetryStatusMessage("agent-1", { attempt: 3, maxAttempts: 3, delayMs: 60000, errorMessage: "HTTP 429" }, "running");
	manager.upsertRetryStatusMessage("agent-1", { attempt: 3, maxAttempts: 3, finalError: "HTTP 429" }, "error");

	const list = retryMessages(manager);
	assert.equal(list.length, 1, "同一周期只应有一张卡片（running → error 原地收敛）");
	assert.equal(list[0].meta.status, "error");
	assert.equal(list[0].meta.i18nKey, "diagnostic.retryFailed");
	assert.equal(list[0].meta.debugDetails, "HTTP 429");

	// 重试耗尽后的失败诊断读最新重试卡取 attempt/maxAttempts
	manager.addDetailedErrorMessage("agent-1", "HTTP 429");
	const failure = retryMessages(manager).at(-1);
	assert.equal(failure.meta.i18nKey, "diagnostic.requestFailedAfterRetries");
	assert.equal(failure.meta.i18nParams.attempt, 3);
	assert.equal(failure.meta.i18nParams.maxAttempts, 3);
});

test("仅存在已收敛卡片时没有「进行中」重试卡（agent_end willRetry 兜底要新建）", () => {
	const manager = createManager();

	manager.upsertRetryStatusMessage("agent-1", { attempt: 2, maxAttempts: 3, success: true }, "success");
	assert.equal(manager.activeRetryStatusMessageId("agent-1"), undefined);

	// 新一轮重试开始后再查，命中的是进行中的新卡
	manager.upsertRetryStatusMessage("agent-1", { attempt: 1, maxAttempts: 3 }, "running");
	const activeId = manager.activeRetryStatusMessageId("agent-1");
	assert.equal(activeId, retryMessages(manager).at(-1).id);
	assert.equal(retryMessages(manager).find((item) => item.id === activeId).meta.status, "running");
});
