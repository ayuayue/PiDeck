import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * 停止时撤回 pi 排队消息（clear_queue + abort，pi 交互 Esc 语义）。
 *
 * 背景：pi 的 abort RPC 只停当前 run，队列里剩余的 steering/followUp 消息会被继续
 * 投递并另起 run。busy 时用户点停止，旧实现只发 abort，现象是「点了停止，排队的
 * 消息还在跑」。修复在 abort RPC 之前先发 clear_queue（pi 0.85.1+ 命令），撤回的
 * 消息文本经 agents:queue-cleared 事件回写输入框。
 *
 * 回归保护：请求顺序（clear_queue 必须先于 abort）、旧版本 pi（unknown-command）
 * 下降级为 abort-only 不阻断停止、空队列不广播。
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
	const emits = [];
	manager.onOutput((channel, payload) => emits.push({ channel, payload }));
	return { manager, runtime, emits };
}

/** 等 scheduleAbortSettledFallback 等 abort 路径上的定时器落地，避免测试进程挂住。 */
async function settleAbortTimers() {
	for (let i = 0; i < 20; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

test("abort 先发 clear_queue 再发 abort，撤回的排队消息广播 agents:queue-cleared", async () => {
	const requests = [];
	const { manager, emits } = createManager(async (payload) => {
		requests.push(payload.type);
		if (payload.type === "clear_queue") return { success: true, data: { steering: ["改一下方向"], followUp: ["最后总结"] } };
		return { success: true, data: {} };
	});

	await manager.abort("agent-1");
	await settleAbortTimers();

	assert.deepEqual(requests, ["clear_queue", "abort"], "clear_queue 必须先于 abort（pi Esc 语义）");
	const cleared = emits.find((entry) => entry.channel === "agents:queue-cleared");
	assert.ok(cleared, "有撤回消息时应广播 agents:queue-cleared");
	assert.equal(cleared.payload.agentId, "agent-1", "宿主 runtime 事件桥按 agentId 路由，缺身份就无法回填草稿");
	assert.equal(cleared.payload.sessionId, "session-original");
	assert.equal(cleared.payload.runtimeGeneration, 1);
	assert.deepEqual(cleared.payload.steering, ["改一下方向"]);
	assert.deepEqual(cleared.payload.followUp, ["最后总结"]);
});

test("clear_queue 不被老版本 pi 支持（unknown command）时仍完成 abort，不阻断停止", async () => {
	const requests = [];
	const { manager, emits } = createManager(async (payload) => {
		requests.push(payload.type);
		// pi <0.85.1 对未知命令回 error（request 会 reject）
		if (payload.type === "clear_queue") throw new Error("Unknown command: clear_queue");
		return { success: true, data: {} };
	});

	await manager.abort("agent-1");
	await settleAbortTimers();

	assert.deepEqual(requests, ["clear_queue", "abort"], "clear_queue 失败不能吞掉 abort");
	assert.equal(
		emits.some((entry) => entry.channel === "agents:queue-cleared"),
		false,
		"无撤回内容时不广播",
	);
});

test("队列为空时 clear_queue 返回空列表：仍按顺序发两条命令、不广播", async () => {
	const requests = [];
	const { manager, emits } = createManager(async (payload) => {
		requests.push(payload.type);
		if (payload.type === "clear_queue") return { success: true, data: { steering: [], followUp: [] } };
		return { success: true, data: {} };
	});

	await manager.abort("agent-1");
	await settleAbortTimers();

	assert.deepEqual(requests, ["clear_queue", "abort"]);
	assert.equal(
		emits.some((entry) => entry.channel === "agents:queue-cleared"),
		false,
	);
});

/** 让队列撤回停在 await 边界，观察旧停止请求是否影响后来的生命周期。 */
function deferredQueue() {
	let resolve;
	const promise = new Promise((done) => (resolve = done));
	return { promise, resolve };
}

for (const change of ["closed agent", "new process", "new session binding", "new runtime generation"]) {
	test(`a late clear_queue response cannot resume abort after ${change}`, async (t) => {
		const queue = deferredQueue();
		const requests = [];
		const { manager, runtime, emits } = createManager(async (payload) => {
			requests.push(payload.type);
			return payload.type === "clear_queue" ? queue.promise : { success: true };
		});
		t.after(() => manager.stopAll());
		const pending = manager.abort("agent-1");
		assert.deepEqual(requests, ["clear_queue"]);
		if (change === "closed agent") await manager.stop("agent-1");
		else if (change === "new process") {
			manager.agents.set("agent-1", { ...runtime, tab: { ...runtime.tab, status: "running" }, process: { ...runtime.process, client: { request: async () => ({ success: true }) } } });
		} else if (change === "new session binding") runtime.tab.deckSessionId = "session-new";
		else runtime.tab.runtimeGeneration = 2;
		emits.length = 0;
		queue.resolve({ success: true, data: { steering: ["原会话排队消息"], followUp: [] } });
		await pending;
		assert.deepEqual(requests, ["clear_queue"], "退出/换绑后的旧请求不得再发 abort");
		assert.deepEqual(emits, [], "迟到结果不得发布队列、idle、notice 或复活旧状态");
		if (change === "new process") assert.equal(manager.agents.get("agent-1").tab.status, "running");
		if (change === "closed agent") assert.equal(manager.toolExecutingByAgent.has("agent-1"), false);
	});
}

test("a late clear_queue response restores withdrawn prompts without stopping the next turn", async (t) => {
	const queue = deferredQueue();
	const requests = [];
	const { manager, runtime, emits } = createManager(async (payload) => {
		requests.push(payload.type);
		return payload.type === "clear_queue" ? queue.promise : { success: true };
	});
	t.after(() => manager.stopAll());
	const pending = manager.abort("agent-1");
	manager.handlePiEvent("agent-1", { type: "agent_start" });
	emits.length = 0;
	queue.resolve({ success: true, data: { steering: ["已撤回消息"], followUp: [] } });
	await pending;
	assert.deepEqual(requests, ["clear_queue"], "新回合使原停止操作失效，不能再发 abort");
	assert.equal(runtime.tab.status, "running", "旧停止不能覆盖新回合状态");
	assert.deepEqual(
		emits.map((event) => event.channel),
		["agents:queue-cleared"],
		"已撤回文本仍恢复到原会话草稿，但不能发布旧停止状态",
	);
	assert.deepEqual(emits[0].payload.steering, ["已撤回消息"]);
});

test("renderer 桥消费 agents:queue-cleared 并 append 写回输入框（不清空草稿）", () => {
	const source = readFileSync(new URL("../src/renderer/src/hooks/useSessionRuntimeBridge.ts", import.meta.url), "utf8");
	assert.match(source, /event\.sourceChannel === "agents:queue-cleared"/, "桥应识别 agents:queue-cleared 通道");
	assert.match(source, /setSessionDraftAtom/, "撤回消息应写回 composer 草稿");
	assert.match(source, /current\.trim\(\) \? `\$\{current\}\\n\\n\$\{joined\}` : joined/, "应 append 到现有草稿而非替换");
});
