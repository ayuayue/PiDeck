import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * 停止后本地误判空闲导致的发送拒收（Issue #371）。
 *
 * 背景：abort RPC 超时/升级未收敛时 PiDeck 会把 tab 复位 idle，而 pi 侧 isStreaming 仍
 * 为 true。此时发 prompt 不带 streamingBehavior，pi 直接拒收
 * "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp')..."，
 * 用户看到的是 SDK 原文 toast，同一 agent 会被连拒多次。
 *
 * 两道防线：
 * 1) 发送前把 pi 侧权威信号（streamingAgents / recentlyAborted / abortGate 升级中）
 *    并入 alreadyBusy，让误复位的会话也带上 streamingBehavior；
 * 2) 仍被拒收时按设置项 busySendDelivery 补发一次带语义的 prompt，重发失败才报错。
 */
const BUSY_REJECTION = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";

function createManager(requestHandler, settings = {}) {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({ rpcTimeout: 30_000, ...settings }) },
		{},
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

test("pi 以忙碌拒收时按 busySendDelivery 补发一次，用户不收到 SDK 原文错误", async () => {
	const prompts = [];
	const { manager } = createManager(async (payload) => {
		if (payload.type === "prompt") {
			prompts.push(payload);
			// 第一次直发被拒（不带 streamingBehavior），第二次带 steer 即被接受。
			if (payload.streamingBehavior) return { success: true, data: { disposition: "started" } };
			return { success: false, error: BUSY_REJECTION };
		}
		return { success: true, data: {} };
	});

	const result = await manager.sendPrompt({ agentId: "agent-1", message: "继续" });

	assert.equal(result.accepted, true, "忙碌拒收应被兜底重发消化，不该抛给用户");
	assert.equal(prompts.length, 2, "应只补发一次");
	assert.equal(prompts[0].streamingBehavior, undefined);
	assert.equal(prompts[1].streamingBehavior, "steer", "默认投递行为是 steer");
	assert.equal(prompts[1].message, prompts[0].message, "重发内容必须与原文一致");
});

test("忙碌拒收的重发仍失败时才报错，且错误取重发原文", async () => {
	const prompts = [];
	const { manager, runtime } = createManager(async (payload) => {
		if (payload.type === "prompt") {
			prompts.push(payload);
			return { success: false, error: payload.streamingBehavior ? "queue is full" : BUSY_REJECTION };
		}
		return { success: true, data: {} };
	});

	const result = await manager.sendPrompt({ agentId: "agent-1", message: "继续" });

	assert.equal(result.accepted, false);
	assert.equal(result.error, "queue is full", "重发失败应用重发的错误原文");
	assert.equal(result.i18nKey, "diagnostic.promptRejected");
	assert.equal(prompts.length, 2);
	assert.equal(runtime.tab.status, "idle", "失败后不应把被误判的会话留在 running");
});

test("设置项 busySendDelivery=followUp 时兜底重发按 followUp 投递", async () => {
	const prompts = [];
	const { manager } = createManager(
		async (payload) => {
			if (payload.type === "prompt") {
				prompts.push(payload);
				if (payload.streamingBehavior) return { success: true, data: { disposition: "queued" } };
				return { success: false, error: BUSY_REJECTION };
			}
			return { success: true, data: {} };
		},
		{ busySendDelivery: "followUp" },
	);

	const result = await manager.sendPrompt({ agentId: "agent-1", message: "继续" });

	assert.equal(result.accepted, true);
	assert.equal(prompts[1].streamingBehavior, "followUp");
});

test("非忙碌类拒收（如模型不支持图片）不触发重发", async () => {
	const prompts = [];
	const { manager } = createManager(async (payload) => {
		if (payload.type === "prompt") {
			prompts.push(payload);
			return { success: false, error: "model does not support images" };
		}
		return { success: true, data: {} };
	});

	const result = await manager.sendPrompt({ agentId: "agent-1", message: "看图" });

	assert.equal(result.accepted, false);
	assert.equal(prompts.length, 1, "只有 pi 的忙碌拒收才补发");
});

test("abort 后等待 pi 确认期间发送自带 streamingBehavior（本地已复位 idle 也算忙碌）", async () => {
	const prompts = [];
	const { manager, runtime } = createManager(async (payload) => {
		if (payload.type === "prompt") {
			prompts.push(payload);
			return { success: true, data: { disposition: "started" } };
		}
		return { success: true, data: {} };
	});

	// 复现 Issue #371 的状态：abort 已发出（tab 被复位 idle），pi 尚未确认 settled。
	runtime.tab.status = "idle";
	manager.recentlyAborted.add("agent-1");

	const result = await manager.sendPrompt({ agentId: "agent-1", message: "继续" });

	assert.equal(result.accepted, true);
	assert.equal(prompts.length, 1, "不该先被拒再重发");
	assert.equal(prompts[0].streamingBehavior, "steer");
});
