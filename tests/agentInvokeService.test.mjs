/**
 * 智能体市场一次性调用服务（AgentInvokeService）的行为测试。
 *
 * 补全通道用假实现替换：锁定的是服务层职责——入参校验、角色设定解析、用户消息
 * 拼装、用量记账尽力而为、取消转发。「受理后终态恰好一次 / 超时 / 进程死亡」
 * 属于侧车语义，见 tests/enhancePromptService.test.mjs。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentInvokeService } = loadTsCommonJs("src/main/agents/AgentInvokeService.ts");
const { AGENT_INVOKE_INSTRUCTION_MAX_CHARS, AGENT_INVOKE_TEXT_MAX_CHARS, BUILTIN_TRANSLATE_AGENT_ID } = loadTsCommonJs("src/shared/types/agentProfile.ts");

/** 生产模块跑在 vm realm，对象原型不同：结构断言前先 JSON 归一化。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

function createProfile(overrides = {}) {
	return {
		id: BUILTIN_TRANSLATE_AGENT_ID,
		name: "翻译官",
		description: "中英互译",
		icon: "🌐",
		systemPrompt: "你是专业翻译，只输出译文。",
		category: "translation",
		builtin: true,
		createdAt: 1,
		updatedAt: 1,
		usageCount: 0,
		...overrides,
	};
}

function createRecorder() {
	const events = [];
	return {
		events,
		callbacks: {
			onDelta: (text) => events.push({ kind: "delta", text }),
			onDone: (text) => events.push({ kind: "done", text }),
			onAborted: () => events.push({ kind: "aborted" }),
			onError: (errorKind, message) => events.push({ kind: "error", errorKind, message }),
		},
	};
}

function createCompletion(result) {
	const calls = [];
	const callbackSets = [];
	let cancels = 0;
	return {
		calls,
		cancels: () => cancels,
		latestCallbacks: () => callbackSets.at(-1),
		runner: {
			enhance: async (input, callbacks) => {
				calls.push(input);
				callbackSets.push(callbacks);
				return result ?? { ok: true, runId: "run-1" };
			},
			cancel: () => {
				cancels += 1;
			},
		},
	};
}

function createService(options = {}) {
	const profiles = options.profiles ?? [createProfile()];
	const byId = new Map(profiles.map((profile) => [profile.id, profile]));
	const usage = [];
	const warnings = [];
	const lookup = {
		get: (agentId) => byId.get(agentId),
		recordUsage:
			options.recordUsage ??
			(async (agentId) => {
				usage.push(agentId);
			}),
	};
	const completion = createCompletion(options.result);
	const service = new AgentInvokeService({
		profiles: lookup,
		completion: completion.runner,
		logger: { warn: (message) => warnings.push(message), error: (message) => warnings.push(message) },
	});
	return { service, completion, usage, warnings };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const BASE_INPUT = { agentId: BUILTIN_TRANSLATE_AGENT_ID, text: "Good morning", action: "translate", targetLanguage: "zh-CN", model: { provider: "kimi-coding", modelId: "kimi-k2" } };

test("受理成功：返回 runId、下发角色设定与正文，流式回调原样转发，用量记账一次", async () => {
	const { service, completion, usage } = createService();
	const recorder = createRecorder();
	const result = await service.invoke(BASE_INPUT, recorder.callbacks);
	assert.deepEqual(plain(result), { ok: true, runId: "run-1" });
	assert.deepEqual(plain(completion.calls), [{ provider: "kimi-coding", modelId: "kimi-k2", userText: "Good morning", systemPrompt: "你是专业翻译，只输出译文。" }]);

	completion.latestCallbacks().onDelta("早上好");
	completion.latestCallbacks().onDone("早上好");
	assert.deepEqual(recorder.events, [
		{ kind: "delta", text: "早上好" },
		{ kind: "done", text: "早上好" },
	]);

	await flush();
	assert.deepEqual(usage, [BUILTIN_TRANSLATE_AGENT_ID]);
});

test("自定义智能体：按 agentId 取角色设定，两端空白裁掉", async () => {
	const { service, completion } = createService({ profiles: [createProfile({ id: "agent-custom", systemPrompt: "\n  只输出 JSON。  \n" })] });
	const result = await service.invoke({ ...BASE_INPUT, agentId: "agent-custom" }, createRecorder().callbacks);
	assert.equal(result.ok, true);
	assert.equal(completion.calls[0].systemPrompt, "只输出 JSON。");
});

test("附加指令：空行拼接在正文之后；未提供或纯空白时只发正文", async () => {
	const { service, completion } = createService();
	await service.invoke({ ...BASE_INPUT, instruction: "翻译成中文，保留技术术语" }, createRecorder().callbacks);
	await service.invoke(BASE_INPUT, createRecorder().callbacks);
	// 纯空白指令不产生多余空行：content 与无指令时完全一致。
	await service.invoke({ ...BASE_INPUT, instruction: "   \n " }, createRecorder().callbacks);
	assert.deepEqual(
		completion.calls.map((call) => call.userText),
		["Good morning\n\n翻译成中文，保留技术术语", "Good morning", "Good morning"],
	);
});

test("智能体不存在：invalid-request + agent-not-found，不触达补全通道也不记用量", async () => {
	const { service, completion, usage } = createService();
	const result = await service.invoke({ ...BASE_INPUT, agentId: "missing-agent" }, createRecorder().callbacks);
	assert.deepEqual(plain(result), { ok: false, errorKind: "invalid-request", message: "agent-not-found" });
	assert.deepEqual(completion.calls, []);
	await flush();
	assert.deepEqual(usage, []);
});

test("智能体角色设定为空：拒绝而不是回落内置增强模板", async () => {
	const { service, completion } = createService({ profiles: [createProfile({ systemPrompt: "   " })] });
	const result = await service.invoke(BASE_INPUT, createRecorder().callbacks);
	assert.deepEqual(plain(result), { ok: false, errorKind: "invalid-request", message: "agent-system-prompt-empty" });
	assert.deepEqual(completion.calls, []);
});

test("正文校验：空白与超长直接拒绝，边界长度仍可受理", async () => {
	const { service, completion } = createService();
	const rejected = ["", "   ", "\n\t", "x".repeat(AGENT_INVOKE_TEXT_MAX_CHARS + 1)];
	for (const text of rejected) {
		const result = await service.invoke({ ...BASE_INPUT, text }, createRecorder().callbacks);
		assert.deepEqual(plain(result), { ok: false, errorKind: "invalid-request", message: "invalid-text" }, JSON.stringify(text.slice(0, 8)));
	}
	assert.deepEqual(completion.calls, []);
	const boundary = await service.invoke({ ...BASE_INPUT, text: "x".repeat(AGENT_INVOKE_TEXT_MAX_CHARS) }, createRecorder().callbacks);
	assert.equal(boundary.ok, true);
	assert.equal(completion.calls[0].userText.length, AGENT_INVOKE_TEXT_MAX_CHARS);
});

test("附加指令超长：直接拒绝，不触达补全通道", async () => {
	const { service, completion } = createService();
	const oversized = await service.invoke({ ...BASE_INPUT, instruction: "x".repeat(AGENT_INVOKE_INSTRUCTION_MAX_CHARS + 1) }, createRecorder().callbacks);
	assert.deepEqual(plain(oversized), { ok: false, errorKind: "invalid-request", message: "invalid-instruction" });
	assert.deepEqual(completion.calls, []);
	const boundary = await service.invoke({ ...BASE_INPUT, instruction: "x".repeat(AGENT_INVOKE_INSTRUCTION_MAX_CHARS) }, createRecorder().callbacks);
	assert.equal(boundary.ok, true);
});

test("取消：转发到补全通道（无进行中的 run 也静默）", () => {
	const { service, completion } = createService();
	service.cancel();
	service.cancel();
	assert.equal(completion.cancels(), 2);
});

test("补全通道受理失败：原样返回错误，不记用量", async () => {
	const { service, usage } = createService({ result: { ok: false, errorKind: "sdk-unavailable", message: "增强助手启动失败，请重试" } });
	const result = await service.invoke(BASE_INPUT, createRecorder().callbacks);
	assert.deepEqual(plain(result), { ok: false, errorKind: "sdk-unavailable", message: "增强助手启动失败，请重试" });
	await flush();
	assert.deepEqual(usage, []);
});

test("用量记账失败：只告警，已受理的调用仍返回成功", async () => {
	const { service, warnings } = createService({
		recordUsage: async () => {
			throw new Error("disk full");
		},
	});
	const result = await service.invoke(BASE_INPUT, createRecorder().callbacks);
	assert.deepEqual(plain(result), { ok: true, runId: "run-1" });
	await flush();
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /智能体用量记账失败（builtin-translate）：disk full/);
});
