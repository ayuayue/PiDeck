import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/** 只注入内存 RPC 替身，观察 settled 后的公开完成订阅，不启动 pi 或读取会话文件。 */
function createManager() {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "/synthetic-project" }),
		() => null,
		{ get: () => ({ rpcTimeout: 30_000 }) },
		{},
	);
	const runtime = {
		tab: {
			id: "agent-1",
			deckSessionId: "session-1",
			runtimeGeneration: 1,
			projectId: "project-1",
			cwd: "/synthetic-project",
			title: "Session",
			status: "running",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: {
			isRunning: () => true,
			getDiagnostics: () => null,
			stop: () => {},
			client: {
				request: async () => ({ success: true, data: { isStreaming: false, messages: [], entries: [] } }),
			},
		},
	};
	const completions = [];
	manager.agents.set("agent-1", runtime);
	manager.onAgentSettled((info) => completions.push(info));
	return { manager, runtime, completions };
}

for (const scenario of [
	{ name: "pi-reported cancellation without a local stop", event: { type: "agent_settled", aborted: true }, localAbort: false, expectedCompletions: 0 },
	{ name: "normal pi completion", event: { type: "agent_settled", aborted: false }, localAbort: false, expectedCompletions: 1 },
	{ name: "legacy pi completion without aborted", event: { type: "agent_settled" }, localAbort: false, expectedCompletions: 1 },
	{ name: "malformed aborted value is not a cancellation", event: { type: "agent_settled", aborted: "true" }, localAbort: false, expectedCompletions: 1 },
	{ name: "local stop remains authoritative when pi reports false", event: { type: "agent_settled", aborted: false }, localAbort: true, expectedCompletions: 0 },
	{ name: "legacy pi cancellation retains the local stop fallback", event: { type: "agent_settled" }, localAbort: true, expectedCompletions: 0 },
]) {
	test(`settled notifications: ${scenario.name}`, async (t) => {
		const { manager, runtime, completions } = createManager();
		t.after(() => manager.stopAll());
		if (scenario.localAbort) manager.recentlyAborted.add("agent-1");

		manager.handlePiEvent("agent-1", scenario.event);
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(runtime.tab.status, "idle", "取消仍须正常收敛为空闲，不能让 UI 卡在运行中");
		assert.equal(completions.length, scenario.expectedCompletions, "被取消的回合不得触发成功完成订阅");
		if (scenario.expectedCompletions) {
			assert.equal(completions[0].agentId, "agent-1");
			assert.equal(completions[0].title, "Session");
		}
	});
}

test("pi cancellation does not overwrite an existing error state", async (t) => {
	const { manager, runtime, completions } = createManager();
	t.after(() => manager.stopAll());
	runtime.tab.status = "error";

	manager.handlePiEvent("agent-1", { type: "agent_settled", aborted: true });
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(runtime.tab.status, "error");
	assert.equal(completions.length, 0);
});
