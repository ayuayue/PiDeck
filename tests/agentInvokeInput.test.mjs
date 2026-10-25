/**
 * 智能体市场一次性调用 IPC 边界测试（agentInvokeIpc）。
 *
 * 渲染层数据一律不可信：agentId / 正文 / 附加指令长度、action 与 targetLanguage
 * 枚举、模型标识形态都在这一层拦；事件只回发给发起方（event.sender），并按受理到
 * 的 runId 配对。解析器导出供直接锁定边界，handler 用假 IpcMain 验收转发语义。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseAgentInvokeInput, registerAgentInvokeIpc } = loadTsCommonJs("src/main/ipc/agentInvokeIpc.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { AGENT_INVOKE_INSTRUCTION_MAX_CHARS, AGENT_INVOKE_TEXT_MAX_CHARS } = loadTsCommonJs("src/shared/types/agentProfile.ts");

/** 生产模块跑在 vm realm，对象原型不同：结构断言前先 JSON 归一化。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const VALID = {
	agentId: "builtin-translate",
	text: "Good morning",
	action: "translate",
	targetLanguage: "zh-CN",
	instruction: "翻译成中文",
	model: { provider: "kimi-coding", modelId: "kimi-k2" },
};

const MINIMAL = { agentId: "builtin-translate", text: "Good morning", model: { provider: "kimi-coding", modelId: "kimi-k2" } };

test("解析：合法入参只保留白名单字段，额外字段被丢弃", () => {
	assert.deepEqual(plain(parseAgentInvokeInput({ ...VALID, context: "渲染层多带", model: { ...VALID.model, extra: 1 } })), VALID);
	assert.deepEqual(plain(parseAgentInvokeInput(MINIMAL)), MINIMAL);
	// 可选字段缺省时不能凭空补值（渲染层按字段存在与否决定展示）。
	assert.deepEqual(Object.keys(plain(parseAgentInvokeInput(MINIMAL))).sort(), ["agentId", "model", "text"]);
});

test("解析：真实目录里的模型键形态必须放行（冒号/斜杠/URL/空格/中文）", () => {
	const models = [
		{ provider: "builtin:bigmodel-start-plan", modelId: "GLM-5.3-Flash" },
		{ provider: "https://open.mwy.asia", modelId: "gpt-5.6-luna" },
		{ provider: "workbuddy", modelId: "cn:deepseek-v4.1-flash" },
		{ provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" },
		{ provider: "我的供应商", modelId: "深度思考模型" },
		{ provider: "p".repeat(200), modelId: "模".repeat(200) },
	];
	for (const model of models) assert.deepEqual(plain(parseAgentInvokeInput({ ...MINIMAL, model }).model), model);
});

test("拒绝：非对象与顶层字段类型错误", () => {
	for (const input of [undefined, null, "str", 42, [], {}]) {
		assert.throws(() => parseAgentInvokeInput(input), /Invalid agent invoke input/);
	}
	const badAgentIds = ["", "   ", 42, "x".repeat(201)];
	for (const agentId of badAgentIds) assert.throws(() => parseAgentInvokeInput({ ...MINIMAL, agentId }), /Invalid agent invoke input: agentId/);
	const badTexts = ["", "   ", 42, "x".repeat(AGENT_INVOKE_TEXT_MAX_CHARS + 1)];
	for (const text of badTexts) assert.throws(() => parseAgentInvokeInput({ ...MINIMAL, text }), /Invalid agent invoke input: text/);
});

test("拒绝：附加指令超长/非字符串，action 与 targetLanguage 越出枚举", () => {
	assert.throws(() => parseAgentInvokeInput({ ...MINIMAL, instruction: 42 }), /Invalid agent invoke input: instruction/);
	assert.throws(() => parseAgentInvokeInput({ ...MINIMAL, instruction: "x".repeat(AGENT_INVOKE_INSTRUCTION_MAX_CHARS + 1) }), /Invalid agent invoke input: instruction/);
	for (const action of ["rewrite", "", 5, null]) assert.throws(() => parseAgentInvokeInput({ ...MINIMAL, action }), /Invalid agent invoke input: action/);
	for (const targetLanguage of ["xx-XX", "zh-TW", "", 5, null]) assert.throws(() => parseAgentInvokeInput({ ...MINIMAL, targetLanguage }), /Invalid agent invoke input: targetLanguage/);
});

test("拒绝：模型缺字段、空白、控制字符与超长", () => {
	const badModels = [undefined, null, [], {}, { provider: "", modelId: "m" }, { provider: "p", modelId: "  " }, { provider: 42, modelId: "m" }, { provider: "p".repeat(201), modelId: "m" }, { provider: "a\nname", modelId: "m" }, { provider: "p", modelId: "a\u2028b" }];
	for (const model of badModels) assert.throws(() => parseAgentInvokeInput({ ...MINIMAL, model }), /Invalid agent invoke input: model/);
});

test("边界长度：正文与附加指令到达上限仍受理", () => {
	const parsed = parseAgentInvokeInput({ ...MINIMAL, text: "x".repeat(AGENT_INVOKE_TEXT_MAX_CHARS), instruction: "x".repeat(AGENT_INVOKE_INSTRUCTION_MAX_CHARS) });
	assert.equal(parsed.text.length, AGENT_INVOKE_TEXT_MAX_CHARS);
	assert.equal(parsed.instruction.length, AGENT_INVOKE_INSTRUCTION_MAX_CHARS);
});

function createFakeIpc() {
	const handlers = new Map();
	return { handlers, handle: (channel, fn) => handlers.set(channel, fn) };
}

function createFakeService() {
	const calls = { invoke: [], cancel: 0 };
	let callbacks = null;
	return {
		calls,
		callbacks: () => callbacks,
		service: {
			invoke: async (input, cb) => {
				callbacks = cb;
				calls.invoke.push(input);
				return { ok: true, runId: "run-1" };
			},
			cancel: () => {
				calls.cancel += 1;
			},
		},
	};
}

function createEvent() {
	const sent = [];
	return {
		sent,
		event: { sender: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) } },
	};
}

function register(service) {
	const ipc = createFakeIpc();
	registerAgentInvokeIpc(ipc, service);
	return {
		invoke: ipc.handlers.get(ipcChannels.agentProfilesInvoke),
		cancel: ipc.handlers.get(ipcChannels.agentProfilesInvokeCancel),
	};
}

test("通道名与契约常量一致（三处同步的最后一道防线）", () => {
	assert.equal(ipcChannels.agentProfilesInvoke, "agent-profiles:invoke");
	assert.equal(ipcChannels.agentProfilesInvokeCancel, "agent-profiles:invoke-cancel");
	assert.equal(ipcChannels.agentProfilesInvokeEvent, "agent-profiles:invoke-event");
});

test("合法受理：校验后的入参进服务，started 回发发起方", async () => {
	const fake = createFakeService();
	const handlers = register(fake.service);
	const { event, sent } = createEvent();
	const result = await handlers.invoke(event, { ...VALID, extra: "忽略" });
	assert.deepEqual(plain(result), { ok: true, runId: "run-1" });
	assert.deepEqual(plain(fake.calls.invoke), [VALID]);
	assert.deepEqual(plain(sent), [{ channel: "agent-profiles:invoke-event", payload: { runId: "run-1", phase: "started" } }]);
});

test("非法入参：直接拒绝且不调用服务", async () => {
	const fake = createFakeService();
	const handlers = register(fake.service);
	await assert.rejects(() => handlers.invoke(createEvent().event, { ...VALID, text: "   " }), /Invalid agent invoke input: text/);
	await assert.rejects(() => handlers.invoke(createEvent().event, null), /Invalid agent invoke input/);
	assert.deepEqual(fake.calls.invoke, []);
});

test("回调事件按受理到的 runId 回发；窗口销毁后静默丢弃", async () => {
	const fake = createFakeService();
	const handlers = register(fake.service);
	// 受理后服务才开始跑模型：销毁的 sender 不应炸主进程。
	const destroyed = { sender: { isDestroyed: () => true, send: () => assert.fail("destroyed sender must not be sent") } };
	await handlers.invoke(destroyed, VALID);
	fake.callbacks().onDelta("早上好");
	fake.callbacks().onDone("早上好");

	const { event, sent } = createEvent();
	await handlers.invoke(event, VALID);
	fake.callbacks().onDelta("早");
	fake.callbacks().onDone("早上好");
	fake.callbacks().onAborted();
	fake.callbacks().onError("model-not-found", "gone");
	assert.deepEqual(plain(sent), [
		{ channel: "agent-profiles:invoke-event", payload: { runId: "run-1", phase: "started" } },
		{ channel: "agent-profiles:invoke-event", payload: { runId: "run-1", phase: "delta", text: "早" } },
		{ channel: "agent-profiles:invoke-event", payload: { runId: "run-1", phase: "done", text: "早上好" } },
		{ channel: "agent-profiles:invoke-event", payload: { runId: "run-1", phase: "aborted" } },
		{ channel: "agent-profiles:invoke-event", payload: { runId: "run-1", phase: "error", errorKind: "model-not-found", message: "gone" } },
	]);
});

test("取消：返回 { ok: true } 并转发服务 cancel", async () => {
	const fake = createFakeService();
	const handlers = register(fake.service);
	assert.deepEqual(plain(await handlers.cancel(createEvent().event)), { ok: true });
	assert.equal(fake.calls.cancel, 1);
});

test("服务未装配：invoke 返回结构化错误，cancel 仍是 no-op", async () => {
	const handlers = register(null);
	const result = await handlers.invoke(createEvent().event, VALID);
	assert.deepEqual(plain(result), { ok: false, errorKind: "sdk-unavailable", message: "agent-invoke-unavailable" });
	// 校验先于判空：非法入参不会因装配状态改变返回形状。
	await assert.rejects(() => handlers.invoke(createEvent().event, { ...VALID, action: "chatx" }), /Invalid agent invoke input: action/);
	assert.deepEqual(plain(await handlers.cancel(createEvent().event)), { ok: true });
});
