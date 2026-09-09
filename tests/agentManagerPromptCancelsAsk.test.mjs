import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * 验证：当 Agent 正在等待 Ask 提问时，用户直接发送新消息（sendPrompt），
 * 系统应自动取消挂起的 Ask 提问，向 pi 进程发送 extension_ui_response (value: null)
 * 解除工具阻塞，向渲染层发送 completed: true, cancelled: true 清除 Ask 卡片，
 * 并标记 abortedDuringAsk 以便工具结果渲染为「已取消」。
 */
function createManagerWithRunningAsk() {
	const emitted = [];
	const rawSent = [];
	const rpcRequests = [];

	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({ rpcTimeout: 30_000 }) },
		{},
	);

	// 监听 emit 事件
	manager.emit = (channel, ...args) => {
		emitted.push({ channel, args });
		return true;
	};

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
			client: {
				request: async (payload) => {
					rpcRequests.push(payload);
					return { success: true, data: {} };
				},
				sendRaw: (payload) => {
					rawSent.push(payload);
				},
			},
		},
	};
	manager.agents.set("agent-1", runtime);

	// 模拟当前有一个挂起的 ask_question 请求
	const raisedAt = Date.now() - 2_000;
	manager.pendingUIRequests.set(
		"agent-1",
		new Map([
			[
				"req-ask-1",
				{
					method: "select",
					title: "请选择选项",
					raisedAt,
				},
			],
		]),
	);

	return { manager, runtime, rawSent, emitted, rpcRequests };
}

test("sendPrompt 在存在 pending UI 请求时应自动取消 Ask，解除底层阻塞并通知渲染层", async () => {
	const { manager, rawSent, emitted, rpcRequests } = createManagerWithRunningAsk();

	// 用户在运行中直接发送新 prompt
	const result = await manager.sendPrompt({
		agentId: "agent-1",
		message: "继续做别的事吧",
	});

	assert.equal(result.accepted, true, "prompt 应被正常接受");

	// 1. 应向 pi 进程发送 extension_ui_response (value: null) 解除 ask 工具等待
	const cancelRaw = rawSent.find(
		(r) => r.type === "extension_ui_response" && r.id === "req-ask-1",
	);
	assert.ok(cancelRaw, "应向 pi 进程发送 extension_ui_response 解除阻塞");
	assert.equal(cancelRaw.value, null, "取消响应 value 应为 null");

	// 2. 应向渲染层广播 agentsUiRequest 取消事件
	const uiCancelEvent = emitted.find(
		(e) =>
			e.channel === ipcChannels.agentsUiRequest &&
			e.args[0]?.agentId === "agent-1" &&
			e.args[0]?.requestId === "req-ask-1",
	);
	assert.ok(uiCancelEvent, "应向渲染层广播 agentsUiRequest 取消事件");
	assert.equal(uiCancelEvent.args[0].completed, true);
	assert.equal(uiCancelEvent.args[0].cancelled, true);

	// 3. 主进程 pendingUIRequests 应已被清除
	const pending = manager.pendingUIRequests.get("agent-1");
	assert.equal(pending?.size ?? 0, 0, "pendingUIRequests 应该已被清空");

	// 4. 应标记 abortedDuringAsk 集合，以便工具卡片显示为已取消
	assert.equal(
		manager.abortedDuringAsk.has("agent-1"),
		true,
		"应记录 abortedDuringAsk 标记",
	);

	// 5. 等待时长应结算并计入 askWaitMsByAgent
	const waitMs = manager.askWaitMsByAgent.get("agent-1") ?? 0;
	assert.ok(waitMs >= 2_000, `等待时长应已结算，实际为 ${waitMs}ms`);

	// 6. 新 prompt 请求正常发出
	assert.ok(
		rpcRequests.some((r) => r.type === "prompt" && r.message === "继续做别的事吧"),
		"新 prompt 应被发送到 pi RPC",
	);
});
