import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { deferred, plain } from "./helpers/sessionRunControlHarness.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
const { SessionRuntimeCoordinator } = loadTsCommonJs("src/main/sessions/SessionRuntimeCoordinator.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const AGENT_ID = "model-owner";
const SESSION_ID = "session-a";
const modelState = { model: { provider: "provider-a", id: "model-a", name: "Source model" }, thinkingLevel: "high" };

/** 暂停真实模型命令及状态查询，不启动 pi、不读取用户配置或会话。 */
function harness({ waitAt, failure, state = modelState } = {}) {
	const entered = deferred();
	const release = deferred();
	const requests = [];
	const events = [];
	const warnings = [];
	const pause = async (step, value) => {
		if (waitAt === step) {
			entered.resolve();
			await release.promise;
		}
		if (step === "get_state" && failure === "transport") throw new Error("RPC unavailable");
		return value;
	};
	const process = {
		client: {
			request: (input) => {
				requests.push(plain(input));
				return pause(input.type, failure && failure !== "transport" ? { success: false, error: failure } : { success: true, data: state });
			},
		},
	};
	const runtime = {
		tab: { id: AGENT_ID, projectId: "project-a", cwd: "C:/project", title: "Source", status: "idle", deckSessionId: SESSION_ID, runtimeGeneration: 1, sessionPath: "C:/project/session.jsonl", createdAt: 1 },
		process,
	};
	const manager = new AgentManager(
		() => ({ id: "project-a", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{ getModelsConfig: () => pause("catalog", { parsed: { providers: { "provider-a": { models: [{ id: "model-a" }] } } } }) },
		undefined,
		{ warn: (...args) => warnings.push(plain(args)) },
	);
	manager.agents.set(AGENT_ID, runtime);
	manager.onOutput((channel) => {
		if (channel === ipcChannels.agentsState) events.push(channel);
	});
	return { manager, runtime, process, entered, release, requests, events, warnings };
}

/** 立即观察拒绝，允许安全地在 RPC 未完成时换绑。 */
function outcome(promise) {
	return promise.then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
}

const operations = [
	{ name: "set_model", run: (manager) => manager.setModel(AGENT_ID, "provider-a", "model-a") },
	{ name: "set_thinking_level", run: (manager) => manager.setThinking(AGENT_ID, "high") },
	{ name: "get_state", run: (manager) => manager.getRuntimeModelThinkingState(AGENT_ID) },
];

/** 模拟退役、同身份自动重连及会话代次变更。 */
function changeOwner(h, change) {
	if (change === "remove") h.manager.agents.delete(AGENT_ID);
	else if (change === "process") h.runtime.process = { client: { request: async () => ({ success: true, data: modelState }) } };
	else if (change === "runtime") h.manager.agents.set(AGENT_ID, { ...h.runtime, tab: { ...h.runtime.tab } });
	else if (change === "runtimeGeneration") h.runtime.tab.runtimeGeneration += 1;
	else h.runtime.tab[change] = "replacement";
}

for (const operation of operations) {
	for (const change of ["remove", "process", "runtimeGeneration"]) {
		test(`a late ${operation.name} response cannot succeed after ${change}`, async () => {
			const h = harness({ waitAt: operation.name });
			const pending = outcome(operation.run(h.manager));
			await h.entered.promise;
			changeOwner(h, change);
			h.release.resolve();
			const result = await pending;
			assert.match(result.error?.message ?? "", /runtime changed/);
			assert.deepEqual(h.events, [], "a retired command must not publish a current-agent state");
		});
	}
}

for (const change of ["runtime", "deckSessionId", "sessionPath"]) {
	test(`the model snapshot is rejected after changing ${change}`, async () => {
		const h = harness({ waitAt: "get_state" });
		const pending = outcome(h.manager.getRuntimeModelThinkingState(AGENT_ID));
		await h.entered.promise;
		changeOwner(h, change);
		h.release.resolve();
		const result = await pending;
		assert.match(result.error?.message ?? "", /runtime changed/);
	});
}

test("a successful model selection on the current runtime sends only set_model and publishes once", async () => {
	const h = harness();
	await h.manager.setModel(AGENT_ID, "provider-a", "model-a");
	assert.deepEqual(h.requests, [{ type: "set_model", provider: "provider-a", modelId: "model-a" }]);
	assert.equal(h.events.length, 1);
});

test("a successful effort selection on the current runtime sends only set_thinking_level and publishes once", async () => {
	const h = harness();
	await h.manager.setThinking(AGENT_ID, "high");
	assert.deepEqual(h.requests, [{ type: "set_thinking_level", level: "high" }]);
	assert.equal(h.events.length, 1);
});

test("the current model snapshot keeps Pi's actual model name and effort", async () => {
	const h = harness();
	assert.deepEqual(plain(await h.manager.getRuntimeModelThinkingState(AGENT_ID)), { provider: "provider-a", modelId: "model-a", modelName: "Source model", thinkingLevel: "high" });
	assert.deepEqual(h.requests, [{ type: "get_state" }]);
});

test("a model-state transport failure retains the unavailable-state fallback for the current process", async () => {
	const h = harness({ failure: "transport" });
	assert.equal(await h.manager.getRuntimeModelThinkingState(AGENT_ID), undefined);
	assert.equal(h.warnings.length, 1);
});

test("a failed model-state query after reconnect must not become a valid preference fallback", async () => {
	const h = harness({ waitAt: "get_state", failure: "transport" });
	const pending = outcome(h.manager.getRuntimeModelThinkingState(AGENT_ID));
	await h.entered.promise;
	changeOwner(h, "process");
	h.release.resolve();
	const result = await pending;
	assert.match(result.error?.message ?? "", /runtime changed/);
});

test("model-not-found classification cannot ask to restart a replacement process", async () => {
	const h = harness({ waitAt: "catalog", failure: "Model not found: provider-a/model-a" });
	const pending = outcome(h.manager.setModel(AGENT_ID, "provider-a", "model-a"));
	await h.entered.promise;
	changeOwner(h, "process");
	h.release.resolve();
	const result = await pending;
	assert.match(result.error?.message ?? "", /runtime changed/);
	assert.equal(result.error?.needsRestart, undefined);
});

/** 使用真实 Coordinator 与 AgentManager，证明进程换代也不能写回 catalog。 */
function coordinatorHarness(options) {
	const h = harness(options);
	const entry = { id: SESSION_ID, projectId: "project-a", title: "Source", source: "pi", environment: "native", status: "active", createdAt: 1, updatedAt: 1, model: { provider: "provider-old", modelId: "model-old", modelName: "Saved model" }, thinkingLevel: "low" };
	const updates = [];
	const catalog = {
		get: (sessionId) => (sessionId === SESSION_ID ? { ...entry } : undefined),
		update: async (sessionId, patch) => {
			updates.push({ sessionId, patch: plain(patch) });
			Object.assign(entry, patch);
			return { ...entry };
		},
	};
	const coordinator = new SessionRuntimeCoordinator(catalog, h.manager, async () => ({ accepted: true }));
	const runtimeGeneration = coordinator.bindExistingAgent(SESSION_ID, AGENT_ID);
	const target = { sessionId: SESSION_ID, agentId: AGENT_ID, runtimeGeneration };
	return { ...h, coordinator, target, entry, updates };
}

for (const operation of ["model", "thinking"]) {
	for (const step of ["command", "state"]) {
		test(`reconnecting while ${operation} selection waits for ${step} leaves the saved preference unchanged`, async () => {
			const h = coordinatorHarness({ waitAt: step === "state" ? "get_state" : operation === "model" ? "set_model" : "set_thinking_level" });
			const before = plain(h.entry);
			const pending = operation === "model" ? h.coordinator.setRuntimeModel(h.target, "provider-a", "model-a") : h.coordinator.setRuntimeThinking(h.target, "high");
			await h.entered.promise;
			// 自动重连保持逻辑三元组不变；仅检查 Coordinator lease 捕捉不到它。
			changeOwner(h, "process");
			h.release.resolve();
			const result = await pending;
			assert.equal(result.ok, false);
			assert.equal(result.error.code, "SESSION_RUNTIME_CHANGED");
			assert.match(result.error.debugDetails, /runtime changed/);
			assert.deepEqual(h.updates, []);
			assert.deepEqual(plain(h.entry), before);
		});
	}
}

test("a valid model selection persists the actual Pi model and effort through the coordinator", async () => {
	const h = coordinatorHarness();
	const result = await h.coordinator.setRuntimeModel(h.target, "provider-a", "model-a", "Local alias");
	assert.equal(result.ok, true);
	assert.deepEqual(plain(h.entry.model), { provider: "provider-a", modelId: "model-a", modelName: "Source model" });
	assert.equal(h.entry.thinkingLevel, "high");
	assert.equal(h.updates.length, 1);
});

test("a valid effort selection persists the actual Pi level through the coordinator", async () => {
	const h = coordinatorHarness();
	const result = await h.coordinator.setRuntimeThinking(h.target, "max");
	assert.equal(result.ok, true);
	assert.equal(h.entry.thinkingLevel, "high");
	assert.equal(h.updates.length, 1);
});
