import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * M2 回归：stop()（agents.delete + clearAgentState → clearStreamGate 删封印）后，
 * 迟到 pi 流式事件不得为死 agentId 重建 messages/streamingAgents 键并外发——
 * 六处流式分支守卫补 `!runtime`（message_start/update/end +
 * tool_execution_start/end/update），拒绝「agents map 里已无 runtime」的迟到事件。
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
			id: "agent-live",
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
	manager.agents.set("agent-live", runtime);
	return manager;
}

const assistantStart = {
	type: "message_start",
	message: { role: "assistant", content: [{ type: "text", text: "" }] },
};

test("stop() 后迟到的 message_start 不得为死 agentId 重建消息（M2 回归）", () => {
	const manager = createManager();
	// agent-dead 从未注册 runtime：模拟 stop() 已 agents.delete + clearAgentState
	// （clearStreamGate 删掉了封印，这正是旧代码的泄漏窗口）
	manager.handlePiEvent("agent-dead", assistantStart);
	assert.equal(manager.messages.has("agent-dead"), false, "不得为死 agentId 重建 messages 键");
	assert.equal(manager.streamingAgents.has("agent-dead"), false, "不得重激活流式状态");
});

test("活 runtime 的 message_start 照常建流（护栏：不误伤正常路径）", () => {
	const manager = createManager();
	manager.handlePiEvent("agent-live", assistantStart);
	assert.equal(manager.streamingAgents.has("agent-live"), true);
});

test("源码契约：六个流式分支的闸门都必须同时拒绝无 runtime", () => {
	const src = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const guarded = src.match(/if \(!runtime \|\| this\.isAgentStreamSealed\(agentId\)\)/g) ?? [];
	assert.equal(guarded.length, 6, "message_start/update/end + tool_execution_start/end/update");
	// 最小改动版：仅 :5670（handleAssistantMessageEvent 内、message_update 分支被拦后
	// 不可达的纵深守卫）允许残留一个只查封印的旧写法
	const bareSeal = src.match(/if \(this\.isAgentStreamSealed\(agentId\)\)/g) ?? [];
	assert.equal(bareSeal.length, 1, "只允许 :5670 纵深守卫残留 bareSeal");
});
