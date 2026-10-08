import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { CompositeAgentGateway } = loadTsCommonJs("src/main/agents/CompositeAgentGateway.ts");

/**
 * 假后端网关：按 SessionAgentGateway 形状构造，记录调用轨迹。
 * supportsOptional=false 时故意不实现 getCommands/exportHtml/editMessage/deleteMessage
 * （等价于 DshAgentManager 的「能力缺失 = 接口方法不实现」约定）。
 */
function makeFakeGateway(backend, { supportsOptional = true } = {}) {
	const tabs = [];
	const calls = [];
	const listeners = new Set();
	const gateway = {
		backend,
		capabilities: new Set(["compact", "fork", "getForkMessages", ...(supportsOptional ? ["editMessage", "deleteMessage", "getCommands", "exportHtml", "rewind"] : [])]),
		list() {
			return [...tabs];
		},
		async create(input) {
			calls.push(["create", backend, input]);
			const tab = { id: `${backend}:${tabs.length + 1}`, projectId: input.projectId, cwd: "/fake", title: input.title ?? "", status: "idle", backend, createdAt: Date.now() };
			tabs.push(tab);
			return tab;
		},
		async restart(agentId) {
			calls.push(["restart", backend, agentId]);
			const tab = tabs.find((item) => item.id === agentId);
			return tab ?? { ...tabs[0], id: agentId };
		},
		async sendPrompt(input) {
			calls.push(["sendPrompt", backend, input.agentId]);
			return { accepted: true };
		},
		getMessages(agentId) {
			calls.push(["getMessages", backend, agentId]);
			return [];
		},
		async stop(agentId) {
			calls.push(["stop", backend, agentId]);
			const index = tabs.findIndex((item) => item.id === agentId);
			if (index >= 0) tabs.splice(index, 1);
		},
		async rename(agentId, name) {
			calls.push(["rename", backend, agentId, name]);
			return tabs.find((item) => item.id === agentId);
		},
		async abort(agentId) {
			calls.push(["abort", backend, agentId]);
		},
		async compact(agentId) {
			calls.push(["compact", backend, agentId]);
			return { isStreaming: false };
		},
		async getRuntimeState(agentId) {
			calls.push(["getRuntimeState", backend, agentId]);
			return { isStreaming: false };
		},
		async getAvailableModels(agentId) {
			calls.push(["getAvailableModels", backend, agentId]);
			return [];
		},
		async prepareResendFromMessage(agentId, messageId) {
			calls.push(["prepareResendFromMessage", backend, agentId, messageId]);
			return { text: "" };
		},
		async setModel(agentId, provider, modelId) {
			calls.push(["setModel", backend, agentId, provider, modelId]);
			return {};
		},
		async setThinking(agentId, level) {
			calls.push(["setThinking", backend, agentId, level]);
			return {};
		},
		async publishRuntimeState(agentId) {
			calls.push(["publishRuntimeState", backend, agentId]);
		},
		async getForkMessages(agentId) {
			calls.push(["getForkMessages", backend, agentId]);
			return [];
		},
		async forkSession(agentId, entryId) {
			calls.push(["forkSession", backend, agentId, entryId]);
			return {};
		},
		async sendUIResponse(agentId, requestId, response) {
			calls.push(["sendUIResponse", backend, agentId, requestId, response]);
			return { accepted: true };
		},
		notifyAskPending(agentId, sessionId, sessionTitle, question) {
			calls.push(["notifyAskPending", backend, agentId, sessionId, sessionTitle, question]);
		},
		onOutput(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		// 可选能力：supportsOptional=false 时这些键不存在（同 DshAgentManager）
		...(supportsOptional
			? {
					async getCommands(agentId) {
						calls.push(["getCommands", backend, agentId]);
						return [];
					},
					async exportHtml(agentId) {
						calls.push(["exportHtml", backend, agentId]);
						return "<html />";
					},
					async editMessage(agentId, messageId, newText) {
						calls.push(["editMessage", backend, agentId, messageId, newText]);
					},
					async deleteMessage(agentId, messageId) {
						calls.push(["deleteMessage", backend, agentId, messageId]);
					},
					async listCheckpoints(agentId) {
						calls.push(["listCheckpoints", backend, agentId]);
						return [];
					},
					async getCheckpointDiff(agentId, checkpointId) {
						calls.push(["getCheckpointDiff", backend, agentId, checkpointId]);
						return "diff";
					},
					async restoreCheckpoint(agentId, checkpointId, scope) {
						calls.push(["restoreCheckpoint", backend, agentId, checkpointId, scope]);
					},
					async mutatePersistedSessionMessage(sessionPath, messageId, operation, extra) {
						calls.push(["mutatePersistedSessionMessage", backend, sessionPath, messageId, operation, extra]);
						return operation === "resend" ? { text: "hello" } : undefined;
					},
					reviveIfProcessAlive(agentId) {
						calls.push(["reviveIfProcessAlive", backend, agentId]);
						return backend === "pi";
					},
					async draftCommands(projectId) {
						calls.push(["draftCommands", backend, projectId]);
						return [{ name: `preview:${backend}`, description: "", source: "skill" }];
					},
				}
			: {}),
	};
	gateway.calls = calls;
	gateway.listeners = listeners;
	return gateway;
}

/** 造一个「pi 网关 + dsh 网关」的合成器（pi 全能力，dsh 无可选能力）。 */
function makeComposite() {
	const pi = makeFakeGateway("pi");
	const dsh = makeFakeGateway("dsh", { supportsOptional: false });
	const composite = new CompositeAgentGateway([pi, dsh]);
	return { pi, dsh, composite };
}

test("create 按 backend 路由：dsh 走 dsh 网关，pi 走 pi 网关，缺省走默认后端", async () => {
	const { pi, dsh, composite } = makeComposite();
	await composite.create({ projectId: "p1", backend: "dsh" });
	await composite.create({ projectId: "p1", backend: "pi" });
	await composite.create({ projectId: "p1" });
	// input 原样转发：显式传 backend 的记录保留该字段，缺省记录为 undefined。
	assert.deepEqual(
		pi.calls.filter(([name]) => name === "create").map(([, , input]) => input.backend),
		["pi", undefined],
	);
	assert.deepEqual(
		dsh.calls.filter(([name]) => name === "create").map(([, , input]) => input.backend),
		["dsh"],
	);
});

test("create 后 ownerByAgent 缓存命中：sendPrompt 直接路由到创建网关", async () => {
	const { dsh, composite } = makeComposite();
	const tab = await composite.create({ projectId: "p1", backend: "dsh" });
	await composite.sendPrompt({ agentId: tab.id, message: "hi" });
	assert.deepEqual(dsh.calls.at(-1), ["sendPrompt", "dsh", tab.id]);
});

test("未知 backend 抛错（装配层应保证注册完整）", async () => {
	const { composite } = makeComposite();
	await assert.rejects(composite.create({ projectId: "p1", backend: "codex" }), /no gateway for backend "codex"/);
});

test("未知 agent 抛错（Coordinator 转 SESSION_COMMAND_FAILED）", async () => {
	const { composite } = makeComposite();
	await assert.rejects(composite.sendPrompt({ agentId: "ghost", message: "hi" }), /no gateway owns agent "ghost"/);
});

test("capabilities 取所有子网关并集（含可选能力项）", async () => {
	const { composite } = makeComposite();
	assert.deepEqual([...composite.capabilities].sort(), ["compact", "deleteMessage", "editMessage", "exportHtml", "fork", "getCommands", "getForkMessages", "rewind"].sort());
});

test("可选能力缺失：getCommands/exportHtml/editMessage/deleteMessage/rewind 抛错且不落到子网关", async () => {
	const { dsh, composite } = makeComposite();
	const tab = await composite.create({ projectId: "p1", backend: "dsh" });
	await assert.rejects(composite.getCommands(tab.id), /does not support getCommands/);
	await assert.rejects(composite.exportHtml(tab.id), /does not support exportHtml/);
	await assert.rejects(composite.editMessage(tab.id, "m1", "x"), /does not support editMessage/);
	await assert.rejects(composite.deleteMessage(tab.id, "m1"), /does not support deleteMessage/);
	await assert.rejects(composite.listCheckpoints(tab.id), /does not support listCheckpoints/);
	await assert.rejects(composite.getCheckpointDiff(tab.id, "cp1"), /does not support getCheckpointDiff/);
	await assert.rejects(composite.restoreCheckpoint(tab.id, "cp1", "files"), /does not support restoreCheckpoint/);
	assert.equal(
		dsh.calls.some(([name]) => ["getCommands", "exportHtml", "editMessage", "deleteMessage", "listCheckpoints", "getCheckpointDiff", "restoreCheckpoint"].includes(name)),
		false,
	);
});

test("可选能力存在：转发到所属网关并透传参数", async () => {
	const { pi, composite } = makeComposite();
	const tab = await composite.create({ projectId: "p1", backend: "pi" });
	await composite.getCommands(tab.id);
	await composite.editMessage(tab.id, "m1", "新文本");
	await composite.deleteMessage(tab.id, "m1");
	await composite.exportHtml(tab.id);
	await composite.listCheckpoints(tab.id);
	await composite.getCheckpointDiff(tab.id, "cp-1");
	await composite.restoreCheckpoint(tab.id, "cp-1", "files");
	assert.deepEqual(pi.calls.filter(([name]) => name === "getCommands").at(-1), ["getCommands", "pi", tab.id]);
	assert.deepEqual(pi.calls.filter(([name]) => name === "editMessage").at(-1), ["editMessage", "pi", tab.id, "m1", "新文本"]);
	assert.deepEqual(pi.calls.filter(([name]) => name === "deleteMessage").at(-1), ["deleteMessage", "pi", tab.id, "m1"]);
	assert.deepEqual(pi.calls.filter(([name]) => name === "exportHtml").at(-1), ["exportHtml", "pi", tab.id]);
	assert.deepEqual(pi.calls.filter(([name]) => name === "listCheckpoints").at(-1), ["listCheckpoints", "pi", tab.id]);
	assert.deepEqual(pi.calls.filter(([name]) => name === "getCheckpointDiff").at(-1), ["getCheckpointDiff", "pi", tab.id, "cp-1"]);
	assert.deepEqual(pi.calls.filter(([name]) => name === "restoreCheckpoint").at(-1), ["restoreCheckpoint", "pi", tab.id, "cp-1", "files"]);
});

test("无 runtime 的 JSONL 改写按 pi 网关转发，不落到 DSH", async () => {
	const { pi, dsh, composite } = makeComposite();
	await composite.mutatePersistedSessionMessage("C:/sessions/a.jsonl", "m1", "edit", { newText: "x" });
	assert.deepEqual(pi.calls.filter(([name]) => name === "mutatePersistedSessionMessage").at(-1), ["mutatePersistedSessionMessage", "pi", "C:/sessions/a.jsonl", "m1", "edit", { newText: "x" }]);
	assert.equal(
		dsh.calls.some(([name]) => name === "mutatePersistedSessionMessage"),
		false,
	);
});

test("reviveIfProcessAlive 转发到 owner；dsh 未实现时返回 false 不抛错", async () => {
	const { pi, dsh, composite } = makeComposite();
	const piTab = await composite.create({ projectId: "p1", backend: "pi" });
	const dshTab = await composite.create({ projectId: "p1", backend: "dsh" });
	assert.equal(composite.reviveIfProcessAlive(piTab.id), true);
	assert.equal(composite.reviveIfProcessAlive(dshTab.id), false);
	assert.deepEqual(pi.calls.filter(([name]) => name === "reviveIfProcessAlive").at(-1), ["reviveIfProcessAlive", "pi", piTab.id]);
	assert.equal(
		dsh.calls.some(([name]) => name === "reviveIfProcessAlive"),
		false,
	);
});

test("restart 走 owner 网关且缓存保持（不因其他网关 list 内容漂移）", async () => {
	const { pi, dsh, composite } = makeComposite();
	const tab = await composite.create({ projectId: "p1", backend: "pi" });
	// 另一个网关伪装持有该 agent：ownerByAgent 缓存优先，归属不应漂移。
	dsh.list = () => [{ ...tab, id: tab.id }];
	await composite.restart(tab.id);
	assert.deepEqual(pi.calls.filter(([name]) => name === "restart").at(-1), ["restart", "pi", tab.id]);
	// 缓存仍指向 pi：后续 sendPrompt 不经过 list 兜底查找。
	await composite.sendPrompt({ agentId: tab.id, message: "hi" });
	assert.deepEqual(pi.calls.filter(([name]) => name === "sendPrompt").at(-1), ["sendPrompt", "pi", tab.id]);
	assert.equal(
		dsh.calls.some(([name]) => name === "sendPrompt"),
		false,
	);
});

test("onOutput 聚合转发所有子网关事件，退订后不再收到", async () => {
	const { pi, dsh, composite } = makeComposite();
	const received = [];
	const unsubscribe = composite.onOutput((channel, payload) => received.push([channel, payload]));
	pi.listeners.forEach((listener) => listener("agents:state", { agentId: "a1" }));
	dsh.listeners.forEach((listener) => listener("agents:message", { agentId: "a2" }));
	assert.deepEqual(received, [
		["agents:state", { agentId: "a1" }],
		["agents:message", { agentId: "a2" }],
	]);
	unsubscribe();
	received.length = 0;
	pi.listeners.forEach((listener) => listener("agents:state", { agentId: "a3" }));
	assert.equal(received.length, 0);
});

test("notifyAskPending 路由到持有该 agent 的网关", async () => {
	const { dsh, composite } = makeComposite();
	const tab = await composite.create({ projectId: "p1", backend: "dsh" });
	composite.notifyAskPending(tab.id, "s1", "标题", "问题？");
	assert.deepEqual(dsh.calls.at(-1), ["notifyAskPending", "dsh", tab.id, "s1", "标题", "问题？"]);
});

test("backend 身份：对外以默认后端自居（接口自洽）", () => {
	const { composite } = makeComposite();
	assert.equal(composite.backend, "pi");
	const custom = new CompositeAgentGateway([makeFakeGateway("dsh")], "dsh");
	assert.equal(custom.backend, "dsh");
});

test("draftCommands 只路由 pi 网关，dsh 网关实现被忽略", async () => {
	const { pi, dsh, composite } = makeComposite();
	const result = await composite.draftCommands("project-1");
	assert.deepEqual(result, [{ name: "preview:pi", description: "", source: "skill" }]);
	assert.ok(pi.calls.some(([name]) => name === "draftCommands"));
	assert.ok(!dsh.calls.some(([name]) => name === "draftCommands"), "dsh 无 standby 池，绝不能路由过去");
});
