import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * 模型/思考选择的 RPC 契约（用户反馈「轨迹里出现我没做过的模型切换」）。
 *
 * 历史根因：pi 的 setModel 无条件追加 model_change（值没变也写），而
 * SessionRuntimeCoordinator.applyPreferences 在每次激活/重启都会重放会话偏好。
 * 修复方式已演进为两条独立保证：
 * 1. AgentManager.setModel/setThinking 只负责发送选择命令，不预读 get_state；SessionRuntimeCoordinator
 *    在 Pi 接受命令后再读一次有效状态并写回会话记录，避免旧档位覆盖 Pi 的目标模型默认值；
 * 2. 重复偏好由 SessionRuntimeCoordinator.lastAppliedBySession 去重：同一 agent
 *    上同一份偏好不会重放 set_model（见 sessionRuntimeCoordinator.test.mjs 的
 *    「reselecting an already-applied model or thinking level skips duplicate
 *    runtime commands」）。
 *
 * 反面要求（fail-open）：模型选择命令失败时必须抛错，让上层保留旧偏好并走
 * busy/needsRestart 处理，不能静默吞掉。
 */

/** 构造一个 runtime：记录收到的 RPC 类型，返回可配置的成功/失败响应。 */
function createManager(options = {}) {
	const calls = [];
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
			sessionPath: undefined,
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: {
			client: {
				request: async (payload) => {
					calls.push(payload);
					if (options.failWith && payload.type === "set_model") {
						return { success: false, error: options.failWith };
					}
					return { success: true, data: {} };
				},
			},
		},
	};
	manager.agents.set("agent-1", runtime);
	return { manager, calls };
}

const callsOfType = (calls, type) => calls.filter((item) => item.type === type);

test("重复选择同一模型：仍只发 set_model，绝不读 get_state", async () => {
	const { manager, calls } = createManager();

	await manager.setModel("agent-1", "acme", "gpt-5");
	await manager.setModel("agent-1", "acme", "gpt-5");

	assert.deepEqual(
		callsOfType(calls, "set_model").map(({ type, provider, modelId }) => ({ type, provider, modelId })),
		[
			{ type: "set_model", provider: "acme", modelId: "gpt-5" },
			{ type: "set_model", provider: "acme", modelId: "gpt-5" },
		],
		"AgentManager 不做 get_state 预检：去重由 Coordinator 的 lastAppliedBySession 负责",
	);
	assert.deepEqual(callsOfType(calls, "get_state"), [], "选择链路不能查询运行态来决定是否发命令");
});

test("模型变了：照旧发送 set_model", async () => {
	const { manager, calls } = createManager();

	await manager.setModel("agent-1", "acme", "gpt-6");

	const sent = callsOfType(calls, "set_model");
	assert.equal(sent.length, 1);
	// 逐字段断言：模块经 vm 加载，跨 realm 的 deepEqual 会因原型不同而误报
	assert.equal(sent[0].type, "set_model");
	assert.equal(sent[0].provider, "acme");
	assert.equal(sent[0].modelId, "gpt-6");
});

test("仅 modelId 不同也算变化（不把同 provider 任意模型当相等）", async () => {
	const { manager, calls } = createManager();

	await manager.setModel("agent-1", "acme", "gpt-5-mini");

	assert.equal(callsOfType(calls, "set_model").length, 1);
});

test("setThinking 只发 set_thinking_level，不读 get_state", async () => {
	const { manager, calls } = createManager();

	await manager.setThinking("agent-1", "max");

	assert.deepEqual(
		callsOfType(calls, "set_thinking_level").map(({ type, level }) => ({ type, level })),
		[{ type: "set_thinking_level", level: "max" }],
	);
	assert.deepEqual(callsOfType(calls, "get_state"), []);
});

test("选择命令失败：抛错交给上层保留旧偏好（不静默吞掉）", async () => {
	const { manager } = createManager({ failWith: "set_model rejected" });

	await assert.rejects(() => manager.setModel("agent-1", "acme", "gpt-5"), /set_model rejected/);
});
