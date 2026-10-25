import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * prompt 响应的 disposition 分流（pi CHANGELOG 0.99.0 #9098）。
 *
 * 背景：disposition === "handled" 表示这条 prompt 被扩展命令 / input handler 消费，
 * 没有启动 agent run，等 agent_end 恢复 idle 的常规链路永远等不到。PiDeck 必须在
 * 此处改走 get_state 兜底（scheduleIdleCheckAfterExtensionCommand → 100ms 后
 * markIdleIfPiReportsNoWork 发 get_state，pi 报告无工作即恢复 idle）。
 *
 * 回归保护：0.99 之前这里靠「prompt 前发一次 get_commands」的启发式预检；
 * 现在新版 pi 读 disposition、零额外往返，老版本 pi（无该字段）仍走启发式。
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
			client: { request: requestHandler },
		},
	};
	manager.agents.set("agent-1", runtime);
	return { manager, runtime };
}

/** 等待 scheduleIdleCheckAfterExtensionCommand 的 100ms 定时器与后续 get_state 完成。 */
async function waitForIdleRecovery() {
	for (let i = 0; i < 40; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

test("pi 0.99 disposition=handled：不额外发 get_commands，并走 get_state 兜底恢复 idle", async () => {
	const requests = [];
	const { manager, runtime } = createManager(async (payload) => {
		requests.push(payload.type);
		if (payload.type === "prompt") return { success: true, data: { disposition: "handled" } };
		if (payload.type === "get_state") return { success: true, data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } };
		return { success: true, data: {} };
	});

	const result = await manager.sendPrompt({ agentId: "agent-1", message: "/ctx-wrapup" });
	assert.equal(result.accepted, true);

	await waitForIdleRecovery();

	assert.ok(requests.includes("prompt"), "prompt 应已发送");
	assert.ok(!requests.includes("get_commands"), "新版 pi 不需要 get_commands 预检");
	assert.ok(requests.includes("get_state"), "handled 应触发 get_state 兜底");
	assert.equal(runtime.tab.status, "idle", "pi 报告无工作后应恢复 idle");
});

test("pi 0.99 disposition=started：不触发 get_state 兜底（正常等待 agent_end）", async () => {
	const requests = [];
	const { manager, runtime } = createManager(async (payload) => {
		requests.push(payload.type);
		if (payload.type === "prompt") return { success: true, data: { disposition: "started" } };
		if (payload.type === "get_state") return { success: true, data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } };
		return { success: true, data: {} };
	});

	const result = await manager.sendPrompt({ agentId: "agent-1", message: "总结这个仓库" });
	assert.equal(result.accepted, true);

	await waitForIdleRecovery();

	assert.ok(!requests.includes("get_commands"), "新版 pi 不需要 get_commands 预检");
	assert.ok(!requests.includes("get_state"), "started 不应提前判定 idle，否则会打断正在进行的 run");
	assert.equal(runtime.tab.status, "running");
});

test("老版本 pi（无 disposition）：仍用 get_commands 启发式，命中扩展命令才走兜底", async () => {
	const requests = [];
	const { manager, runtime } = createManager(async (payload) => {
		requests.push(payload.type);
		if (payload.type === "prompt") return { success: true, data: {} };
		if (payload.type === "get_commands") {
			return { success: true, data: { commands: [{ name: "ctx-wrapup", source: "extension" }] } };
		}
		if (payload.type === "get_state") return { success: true, data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } };
		return { success: true, data: {} };
	});

	const result = await manager.sendPrompt({ agentId: "agent-1", message: "/ctx-wrapup" });
	assert.equal(result.accepted, true);

	await waitForIdleRecovery();

	const promptIdx = requests.indexOf("prompt");
	const commandsIdx = requests.indexOf("get_commands");
	assert.ok(promptIdx >= 0 && commandsIdx > promptIdx, "get_commands 应作为 prompt 之后的回退路径");
	assert.ok(requests.includes("get_state"), "启发式命中扩展命令时应触发 get_state 兜底");
	assert.equal(runtime.tab.status, "idle");
});

test("老版本 pi 且非扩展命令：不走 get_state 兜底（保持运行直到 agent_end）", async () => {
	const requests = [];
	const { manager, runtime } = createManager(async (payload) => {
		requests.push(payload.type);
		if (payload.type === "prompt") return { success: true, data: {} };
		if (payload.type === "get_commands") return { success: true, data: { commands: [{ name: "other", source: "extension" }] } };
		if (payload.type === "get_state") return { success: true, data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } };
		return { success: true, data: {} };
	});

	const result = await manager.sendPrompt({ agentId: "agent-1", message: "/ctx-wrapup" });
	assert.equal(result.accepted, true);

	await waitForIdleRecovery();

	assert.ok(requests.includes("get_commands"), "无 disposition 时应回退启发式");
	assert.ok(!requests.includes("get_state"), "未命中扩展命令时不应提前判定 idle");
	assert.equal(runtime.tab.status, "running");
});
