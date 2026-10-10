import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/** 控制真实流闸的定时器和 RPC 响应，不等待真实进程或四秒验证窗口。 */
function harness() {
	const timers = new Set();
	const requests = [];
	const notices = [];
	const warnings = [];
	const load = createTsSandbox({
		globals: {
			setTimeout: (callback, delay) => {
				const timer = { callback, delay, unref() {} };
				timers.add(timer);
				return timer;
			},
			clearTimeout: (timer) => timers.delete(timer),
		},
	});
	const { AbortStreamGateController } = load("src/main/pi/abortStreamGateController.ts");
	let handler = async () => ({ success: true, data: { isStreaming: true } });
	let client = {
		request: async (payload) => {
			requests.push(payload.type);
			return handler(payload);
		},
	};
	const gate = new AbortStreamGateController({
		getRpcClient: () => client,
		logInfo: () => {},
		logWarn: (message) => warnings.push(message),
		emitAbortSlowNotice: (agentId) => notices.push(agentId),
	});
	const begin = (hadActiveTool = true) => {
		gate.seal("agent-a");
		const escalation = gate.beginEscalation("agent-a", hadActiveTool);
		gate.scheduleSettledFallback("agent-a");
		return escalation;
	};
	const fire = async (delay) => {
		const timer = [...timers].find((entry) => entry.delay === delay);
		assert.ok(timer, `missing ${delay}ms timer`);
		timers.delete(timer);
		timer.callback();
		await setImmediate();
	};
	return {
		gate,
		timers,
		requests,
		notices,
		warnings,
		begin,
		fire,
		handle: (next) => (handler = next),
		replaceClient: (next) => (client = next),
	};
}

/** 暂停一次状态查询，让测试在 await 边界精确切换运行时/回合。 */
function deferred() {
	let resolve;
	const promise = new Promise((done) => (resolve = done));
	return { promise, resolve };
}

for (const change of ["new turn", "closed agent", "new process"]) {
	test(`an old streaming-state response cannot escalate after ${change}`, async () => {
		const h = harness();
		const response = deferred();
		h.handle(() => response.promise);
		h.begin();
		await h.fire(1500);
		assert.deepEqual(h.requests, ["get_state"]);
		const replacementRequests = [];
		if (change === "new turn") {
			h.gate.clearEscalation("agent-a");
			h.gate.openForNewRun("agent-a");
		} else if (change === "closed agent") h.gate.clearAgent("agent-a");
		else h.replaceClient({ request: async (payload) => replacementRequests.push(payload.type) });
		response.resolve({ success: true, data: { isStreaming: true } });
		await setImmediate();
		assert.deepEqual(h.requests, ["get_state"], "旧状态查询不能补刀下一轮或退出的进程");
		assert.deepEqual(replacementRequests, []);
		assert.equal(h.timers.size, 0);
		assert.deepEqual(h.notices, []);
	});
}

test("an old abort_bash completion cannot issue abort for a subsequent turn", async () => {
	const h = harness();
	const response = deferred();
	h.handle((payload) => (payload.type === "abort_bash" ? response.promise : Promise.resolve({ success: true, data: { isStreaming: true } })));
	const escalation = h.begin();
	h.gate.markAbortFailed("agent-a", escalation);
	await h.fire(1500);
	assert.deepEqual(h.requests, ["get_state", "abort_bash"]);
	h.gate.clearEscalation("agent-a");
	h.gate.openForNewRun("agent-a");
	response.resolve({ success: true });
	await setImmediate();
	assert.deepEqual(h.requests, ["get_state", "abort_bash"]);
	assert.equal(h.timers.size, 0);
});

for (const change of ["settled", "new turn", "closed agent"]) {
	test(`slow-abort verification is cancelled when the agent is ${change}`, async () => {
		const h = harness();
		h.begin();
		await h.fire(1500);
		assert.equal(h.timers.size, 1);
		if (change === "settled") h.gate.noteAbortSettled("agent-a");
		else if (change === "new turn") h.gate.clearEscalation("agent-a");
		else h.gate.clearAgent("agent-a");
		assert.equal(h.timers.size, 0, "生命周期结束必须回收验证定时器");
		assert.deepEqual(h.notices, []);
	});
}

for (const result of [
	{ name: "idle", response: { success: true, data: { isStreaming: false } } },
	{ name: "failed query", response: { success: false } },
	{ name: "malformed query", response: null },
]) {
	test(`slow-abort verification does not warn on ${result.name}`, async () => {
		const h = harness();
		h.begin();
		await h.fire(1500);
		h.handle(async () => result.response);
		await h.fire(4000);
		assert.deepEqual(h.requests, ["get_state", "abort_bash", "get_state"]);
		assert.deepEqual(h.notices, []);
		assert.equal(h.timers.size, 0);
	});
}

test("slow-abort verification warns only when the original turn is still streaming", async () => {
	const h = harness();
	h.begin();
	await h.fire(1500);
	await h.fire(4000);
	assert.deepEqual(h.requests, ["get_state", "abort_bash", "get_state"]);
	assert.deepEqual(h.notices, ["agent-a"]);
	assert.equal(h.timers.size, 0);
});

test("a late verification response cannot warn for the next turn", async () => {
	const h = harness();
	h.begin();
	await h.fire(1500);
	const response = deferred();
	h.handle(() => response.promise);
	await h.fire(4000);
	h.gate.clearEscalation("agent-a");
	h.gate.openForNewRun("agent-a");
	response.resolve({ success: true, data: { isStreaming: true } });
	await setImmediate();
	assert.deepEqual(h.notices, []);
});

test("late failure from the previous abort cannot change the next abort's escalation", async () => {
	const h = harness();
	const old = h.begin(false);
	h.gate.clearEscalation("agent-a");
	h.gate.noteAbortSettled("agent-a");
	h.gate.openForNewRun("agent-a");
	h.begin(false);
	h.gate.markAbortFailed("agent-a", old);
	await h.fire(1500);
	assert.deepEqual(h.requests, ["get_state"], "旧 RPC 失败不能让当前 ack-pending 回合被二次 abort");
	assert.equal(h.timers.size, 0);
});

test("ack-pending abort without an executing tool does not send a second abort", async () => {
	const h = harness();
	h.begin(false);
	await h.fire(1500);
	assert.deepEqual(h.requests, ["get_state"]);
	assert.equal(h.timers.size, 0);
});

test("failed abort without an executing tool retains the recovery escalation", async () => {
	const h = harness();
	const escalation = h.begin(false);
	h.gate.markAbortFailed("agent-a", escalation);
	await h.fire(1500);
	assert.deepEqual(h.requests, ["get_state", "abort"]);
	assert.equal(h.timers.size, 1);
});
