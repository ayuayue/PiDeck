import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 逐条消息记录所用模型（时间线行头在时间后显示）。
 *
 * 三条来源必须同源写入 `ChatMessage.model = { provider, modelId }`：
 * - 历史：pi 会话文件每条 assistant 消息自带 provider/model（AgentMessageProjector）；
 * - 实时：message_end 的完整消息（AgentManager.upsertAssistantMessage）；
 * - DSH：request/context 上报的路由模型（dshEventProjector 的 state.model）。
 *
 * 回归点：用户会频繁换模型，缺 provider 或 model 时不得写半截字段（渲染层会显示
 * 空字符串），delta 路径缺字段时不得清掉已写入的模型。
 */

const { AgentMessageProjector } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts", {
	stubs: {
		"./messageContent": {
			extractMessageText: (content) =>
				Array.isArray(content)
					? content
							.filter((item) => item?.type === "text")
							.map((item) => item.text ?? "")
							.join("\n")
					: typeof content === "string"
						? content
						: "",
		},
	},
});
const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
const { projectDshEvent } = loadTsCommonJs("src/main/dsh/dshEventProjector.ts");
const { sameChatMessageForRender } = loadTsCommonJs("src/renderer/src/components/app/AppUtils.ts");

function createProjector() {
	return new AgentMessageProjector({ translate: (key) => key, isAskAborted: () => false });
}

/** 与 agentManagerUpsertDedup.test.mjs 同款最小 manager 夹具。 */
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

const dshEvent = (type, seq, data = {}) => ({ type, seq, time: 1_700_000_000_000 + seq, data });

test("历史投影：assistant 消息带 provider/model 时写入 message.model", () => {
	const messages = createProjector().convert("agent", [{ role: "assistant", content: [{ type: "text", text: "你好" }], timestamp: 1, provider: "siliconflow", model: "deepseek-v4.1-flash" }], ["entry-1"]);
	assert.equal(messages.length, 1);
	assert.deepEqual({ ...messages[0].model }, { provider: "siliconflow", modelId: "deepseek-v4.1-flash" });
});

test("历史投影：缺 provider 或 model 时不写半截字段", () => {
	const onlyModel = createProjector().convert("agent", [{ role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 1, model: "m" }], ["entry-1"]);
	assert.equal(onlyModel[0].model, undefined);
	const onlyProvider = createProjector().convert("agent", [{ role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 1, provider: "p" }], ["entry-1"]);
	assert.equal(onlyProvider[0].model, undefined);
});

test("实时路径：message_end 带 provider/model 时写入，后续 delta 缺字段不覆盖", () => {
	const manager = createManager();
	manager.upsertAssistantMessage("agent-1", { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "pending" }, "", { allowEmpty: true });
	manager.upsertAssistantMessage("agent-1", { role: "assistant", content: [{ type: "text", text: "答案" }], stopReason: "stop", provider: "anthropic", model: "claude-sonnet-4" });

	const list = manager.messages.get("agent-1");
	assert.equal(list.length, 1, "骨架与终态是同一条消息");
	assert.deepEqual({ ...list[0].model }, { provider: "anthropic", modelId: "claude-sonnet-4" });

	manager.upsertAssistantMessage("agent-1", { role: "assistant", content: [{ type: "text", text: "答案" }], stopReason: "stop" });
	assert.deepEqual({ ...manager.messages.get("agent-1")[0].model }, { provider: "anthropic", modelId: "claude-sonnet-4" }, "delta 缺字段不得清掉已写入的模型");
});

test("实时路径：缺 provider 或 model 时不写半截字段", () => {
	const manager = createManager();
	manager.upsertAssistantMessage("agent-1", { role: "assistant", content: [{ type: "text", text: "答案" }], stopReason: "stop", model: "claude-sonnet-4" });
	assert.equal(manager.messages.get("agent-1")[0].model, undefined);
});

test("DSH 路径：request/context 上报路由模型后，assistant 终态消息带 model", () => {
	const agent = "dsh:session-test";
	let projection = projectDshEvent(undefined, dshEvent("request/context", 1, { provider: "deepseek", model: "deepseek-chat" }), agent);
	projection = projectDshEvent(projection, dshEvent("assistant/message", 2, { message: { content: [{ type: "text", text: "答" }] } }), agent);

	const assistant = projection.messages.find((message) => message.role === "assistant");
	assert.ok(assistant, "assistant 终态必须落成消息");
	assert.deepEqual({ ...assistant.model }, { provider: "deepseek", modelId: "deepseek-chat" });
});

test("渲染比较：model 变化判为不等（否则 reconcileRuns 复用旧引用，底部模型不刷新）", () => {
	const base = { id: "m1", agentId: "agent-1", role: "assistant", text: "x", timestamp: 1, stopReason: "stop" };
	assert.equal(sameChatMessageForRender(base, { ...base }), true);
	// 思考骨架先建、message_end 才补 provider/model：只有 model 变化时也必须重渲染
	assert.equal(sameChatMessageForRender(base, { ...base, model: { provider: "p", modelId: "m" } }), false);
	assert.equal(sameChatMessageForRender({ ...base, model: { provider: "p", modelId: "m" } }, { ...base, model: { provider: "p", modelId: "m2" } }), false);
	assert.equal(sameChatMessageForRender({ ...base, model: { provider: "p", modelId: "m" } }, { ...base, model: { provider: "p2", modelId: "m" } }), false);
});
