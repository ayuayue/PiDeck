import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { deferred, plain } from "./helpers/sessionRunControlHarness.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const AGENT_ID = "state-owner";

/** 暂停真实运行态查询的 RPC/文件统计；不启动 pi，不读取用户会话。 */
function harness({ waitAt, rpcFails = false, cacheStats } = {}) {
	const entered = deferred();
	const release = deferred();
	const requests = [];
	const events = [];
	const pause = async (step, value) => {
		if (waitAt === step) {
			entered.resolve();
			await release.promise;
		}
		if (rpcFails && step !== "cache") throw new Error("RPC unavailable");
		return value;
	};
	const process = {
		client: {
			request: (input) => {
				requests.push(input.type);
				return pause(input.type, {
					success: true,
					data: input.type === "get_state" ? { model: { provider: "provider-a", id: "model-a", name: "Source model" }, thinkingLevel: "high" } : { contextUsage: { tokens: 250, contextWindow: 1000, percent: 25 }, tokens: { input: 50, output: 20 } },
				});
			},
		},
	};
	const runtime = {
		tab: { id: AGENT_ID, projectId: "project-a", cwd: "C:/project", title: "Source", status: "idle", deckSessionId: "session-a", runtimeGeneration: 1, sessionPath: "C:/project/session.jsonl", createdAt: 1 },
		process,
	};
	const manager = new AgentManager(
		() => ({ id: "project-a", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	manager.agents.set(AGENT_ID, runtime);
	manager.getSessionCacheHitStats = () => pause("cache", cacheStats ?? { latest: 80, average: 60, sampleCount: 2, conversationTokens: 200 });
	manager.onOutput((channel, payload) => {
		if (channel === ipcChannels.agentsRuntimeState) events.push(plain(payload));
	});
	return { manager, runtime, process, entered, release, requests, events };
}

/** 立即观察拒绝，避免换绑期间产生未处理 rejection。 */
function outcome(promise) {
	return promise.then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
}

for (const step of ["get_state", "get_session_stats", "cache"]) {
	test(`runtime state waiting for ${step} cannot return a retired snapshot`, async () => {
		const h = harness({ waitAt: step });
		const pending = outcome(h.manager.getRuntimeState(AGENT_ID));
		await h.entered.promise;
		h.manager.agents.delete(AGENT_ID);
		h.release.resolve();
		const result = await pending;
		assert.match(result.error?.message ?? "", /runtime changed/);
		assert.deepEqual(h.events, []);
	});
}

for (const binding of ["runtime", "process", "deckSessionId", "runtimeGeneration", "sessionPath"]) {
	test(`changing ${binding} while reading runtime state rejects the source result`, async () => {
		const h = harness({ waitAt: "get_state" });
		const pending = outcome(h.manager.getRuntimeState(AGENT_ID));
		await h.entered.promise;
		if (binding === "runtime") h.manager.agents.set(AGENT_ID, { ...h.runtime, tab: { ...h.runtime.tab } });
		else if (binding === "process") h.runtime.process = { client: { request: async () => ({ success: true, data: {} }) } };
		else if (binding === "runtimeGeneration") h.runtime.tab.runtimeGeneration = 2;
		else h.runtime.tab[binding] = "replacement";
		h.release.resolve();
		const result = await pending;
		assert.match(result.error?.message ?? "", /runtime changed/);
	});
}

test("runtime state still returns the source model, usage and file statistics without a rebind", async () => {
	const h = harness();
	const state = await h.manager.getRuntimeState(AGENT_ID);
	assert.equal(state.modelId, "model-a");
	assert.equal(state.modelName, "Source model");
	assert.equal(state.thinkingLevel, "high");
	assert.equal(state.contextTokens, 250);
	assert.equal(state.inputTokens, 50);
	assert.equal(state.contextMessageTokens, 200);
	assert.equal(state.cacheHitPercent, 80);
	assert.deepEqual(h.requests, ["get_state", "get_session_stats"]);
});

test("runtime state splits the context into measured system/tools and a conversation residual", async () => {
	// 从会话文件重放出的提示词装载（sections/工具声明）直接给出系统+工具两段；
	// 对话段取「总占用 − 系统 − 工具」差值（250 − 40 − 60 = 150），
	// 而不是把两段当反推值——那正是「系统 + 工具 ~0」的旧病根。
	const h = harness({ cacheStats: { latest: 80, average: 60, sampleCount: 2, conversationTokens: 9000, systemTokens: 40, toolsTokens: 60 } });
	const state = await h.manager.getRuntimeState(AGENT_ID);
	assert.equal(state.contextSystemTokens, 40);
	assert.equal(state.contextToolsTokens, 60);
	assert.equal(state.contextMessageTokens, 150);
});

test("runtime state falls back to the message estimate when the residual is unusable", async () => {
	// 差值不可用（装载两段之和已经超出上报占用）时不能显示 0：退回消息文本估算。
	const h = harness({ cacheStats: { latest: undefined, average: undefined, sampleCount: 0, conversationTokens: 200, systemTokens: 200, toolsTokens: 100 } });
	const state = await h.manager.getRuntimeState(AGENT_ID);
	assert.equal(state.contextSystemTokens, 200);
	assert.equal(state.contextToolsTokens, 100);
	assert.equal(state.contextMessageTokens, 200);
});

test("RPC failure keeps the local runtime-state fallback when the binding is unchanged", async () => {
	const h = harness({ rpcFails: true });
	h.manager.streamingAgents.add(AGENT_ID);
	const state = await h.manager.getRuntimeState(AGENT_ID);
	assert.equal(state.modelId, undefined);
	assert.equal(state.isStreaming, true);
	assert.equal(state.cacheHitPercent, 80);
});

test("RPC failure cannot return fallback state for a runtime removed while waiting", async () => {
	const h = harness({ waitAt: "get_state", rpcFails: true });
	const pending = outcome(h.manager.getRuntimeState(AGENT_ID));
	await h.entered.promise;
	h.manager.agents.delete(AGENT_ID);
	h.release.resolve();
	const result = await pending;
	assert.match(result.error?.message ?? "", /runtime changed/);
});

test("a pending full-state push is dropped rather than emitted after its runtime is replaced", async () => {
	const h = harness({ waitAt: "get_state" });
	const pending = h.manager.publishRuntimeState(AGENT_ID);
	await h.entered.promise;
	h.manager.agents.set(AGENT_ID, { ...h.runtime, tab: { ...h.runtime.tab, deckSessionId: "session-b", runtimeGeneration: 2 } });
	h.release.resolve();
	await pending;
	assert.deepEqual(h.events, []);
});

for (const change of ["remove", "rebind"]) {
	test(`a ${change} between query completion and state publication drops the completed snapshot`, async () => {
		const h = harness();
		const query = h.manager.getRuntimeState.bind(h.manager);
		h.manager.getRuntimeState = (agentId) => {
			const pending = query(agentId);
			// 注册在 emitter 的 await 之前，模拟查询正确完成后、发布恢复前的 microtask 换绑。
			pending.then(() => {
				if (change === "remove") h.manager.agents.delete(AGENT_ID);
				else h.runtime.tab.runtimeGeneration = 2;
			});
			return pending;
		};
		await h.manager.publishRuntimeState(AGENT_ID);
		assert.deepEqual(h.events, []);
	});
}

test("a valid full-state push preserves tool transitions which arrive during the RPC wait", async () => {
	const h = harness({ waitAt: "get_state" });
	const pending = h.manager.publishRuntimeState(AGENT_ID);
	await h.entered.promise;
	h.manager.toolExecutingByAgent.set(AGENT_ID, "bash");
	h.manager.emitToolRuntimeTransition(AGENT_ID, true, "bash");
	h.release.resolve();
	await pending;
	assert.equal(h.events.length, 2);
	assert.equal(h.events[0].state.isExecutingTool, true);
	assert.equal(h.events[1].state.modelId, "model-a");
	assert.equal(h.events[1].state.isExecutingTool, true);
	assert.equal(h.events[1].state.executingToolName, "bash");
	assert.equal(h.events[1].state.toolStateSequence, h.events[0].state.toolStateSequence);
});
