import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const extensionPath = "resources/extensions/pi-deck-session-title.ts";

function compileExtension({ enabled = true, completeSimple }) {
	const source = readFileSync(extensionPath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: extensionPath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: (specifier) => {
				if (specifier === "@earendil-works/pi-ai/compat") return { completeSimple };
				return {};
			},
			process: { env: { PIDECK_AUTO_SESSION_TITLE: enabled ? "1" : "0" } },
			console,
			AbortController,
			setTimeout,
			clearTimeout,
		},
		{ filename: extensionPath },
	);
	return module.exports;
}

function userMessage(content) {
	return { role: "user", content, timestamp: Date.now() };
}

function assistantMessage(content, stopReason = "stop") {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {},
		stopReason,
		timestamp: Date.now(),
	};
}

function messageEntry(message, index) {
	return {
		type: "message",
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		timestamp: new Date().toISOString(),
		message,
	};
}

function createHarness({ enabled = true, entries = [], titleName, authBaseUrl, hasModel = true, authResolver } = {}) {
	let branch = entries;
	let sessionId = "session-1";
	let currentName = titleName;
	let nextCompletion = () => Promise.resolve(assistantMessage([{ type: "text", text: "Title: 修复登录流程！" }]));
	const handlers = new Map();
	const completeCalls = [];
	const setNames = [];
	const statusUpdates = [];
	const sessionManager = {
		getSessionId: () => sessionId,
		getBranch: () => branch,
	};
	const context = {
		mode: "rpc",
		hasUI: false,
		cwd: "C:/project",
		sessionManager,
		model: hasModel ? { provider: "test-provider", id: "test-model" } : undefined,
		ui: {
			setStatus(key, text) {
				statusUpdates.push({ key, text });
			},
		},
		modelRegistry: {
			getApiKeyAndHeaders:
				authResolver ??
				(async () => ({
					ok: true,
					apiKey: "test-key",
					headers: {},
					env: {},
					...(authBaseUrl ? { baseUrl: authBaseUrl } : {}),
				})),
		},
	};
	const completeSimple = (model, titleContext, options) => {
		completeCalls.push({ model, titleContext, options });
		return nextCompletion();
	};
	const extension = compileExtension({ enabled, completeSimple });
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		getSessionName() {
			return currentName;
		},
		setSessionName(name) {
			currentName = name;
			setNames.push(name);
		},
	};
	extension.default(pi);

	return {
		context,
		completeCalls,
		handlers,
		setNames,
		statusUpdates,
		setBranch(next) {
			branch = next;
		},
		setSessionId(next) {
			sessionId = next;
		},
		clearName() {
			currentName = undefined;
		},
		setCompletion(factory) {
			nextCompletion = factory;
		},
		async emit(event, payload = {}) {
			const handler = handlers.get(event);
			if (handler) return handler({ type: event, ...payload }, context);
			return undefined;
		},
	};
}

async function flushAsyncWork() {
	await new Promise((resolve) => setImmediate(resolve));
}

async function startFresh(harness, entries, reason = "new") {
	harness.setBranch([]);
	await harness.emit("session_start", { reason });
	harness.setBranch(entries);
}

function freshBranch({ user = "请修复登录页面", assistant = "我会先检查登录流程" } = {}) {
	return [
		messageEntry(userMessage(user), 0),
		messageEntry(
			assistantMessage([
				{ type: "thinking", thinking: "不要泄露这段思考" },
				{ type: "text", text: assistant },
			]),
			1,
		),
	];
}

test("首轮 settled 后只用最小独立 context 生成标题并写回 session_info", async () => {
	const entries = freshBranch({ user: "请修复登录页面 api_key=super-secret-value" });
	const harness = createHarness({ entries });
	await startFresh(harness, entries);
	await harness.emit("agent_settled");
	await flushAsyncWork();

	assert.deepEqual(harness.setNames, ["修复登录流程"]);
	assert.deepEqual(harness.statusUpdates, [{ key: "pideck:auto-title", text: "修复登录流程" }]);
	assert.equal(harness.completeCalls.length, 1);
	const request = harness.completeCalls[0];
	assert.equal(request.titleContext.tools, undefined);
	assert.equal(request.titleContext.messages.length, 1);
	assert.match(request.titleContext.messages[0].content, /请修复登录页面/);
	assert.match(request.titleContext.messages[0].content, /我会先检查登录流程/);
	assert.doesNotMatch(request.titleContext.messages[0].content, /super-secret-value/);
	assert.doesNotMatch(request.titleContext.messages[0].content, /不要泄露这段思考/);
	assert.equal(request.options.maxTokens, 512);
});

test("推理模型吃光输出预算时升级预算重发一次并完成命名", async () => {
	const entries = freshBranch({ user: "排查越界 bug" });
	const harness = createHarness({ entries });
	let calls = 0;
	harness.setCompletion(() => {
		calls += 1;
		// 第一次：输出预算全被 thinking 吃掉（stopReason=length，没有正文）
		if (calls === 1) {
			return Promise.resolve(assistantMessage([{ type: "thinking", thinking: "先想想标题怎么写" }], "length"));
		}
		return Promise.resolve(assistantMessage([{ type: "text", text: "越界 bug 排查" }]));
	});
	await startFresh(harness, entries);
	await harness.emit("agent_settled");
	await flushAsyncWork();
	await flushAsyncWork();

	assert.deepEqual(
		harness.completeCalls.map((call) => call.options.maxTokens),
		[512, 2048],
	);
	assert.deepEqual(harness.setNames, ["越界 bug 排查"]);
});

test("非截断的空标题响应不做升级重发", async () => {
	const entries = freshBranch();
	const harness = createHarness({ entries });
	harness.setCompletion(() => Promise.resolve(assistantMessage([], "stop")));
	await startFresh(harness, entries);
	await harness.emit("agent_settled");
	await flushAsyncWork();

	assert.equal(harness.completeCalls.length, 1);
	assert.deepEqual(harness.setNames, []);
});

test("两次预算都被推理吃光时放弃命名，同一轮不重复重发", async () => {
	const entries = freshBranch();
	const harness = createHarness({ entries });
	harness.setCompletion(() => Promise.resolve(assistantMessage([{ type: "thinking", thinking: "一直在想标题" }], "length")));
	await startFresh(harness, entries);
	await harness.emit("agent_settled");
	await flushAsyncWork();
	await flushAsyncWork();
	assert.equal(harness.completeCalls.length, 2);
	assert.deepEqual(harness.setNames, []);

	// 同一轮重复 settled 不得再发（升级重发不能放大成每轮多次请求）
	await harness.emit("agent_settled");
	await flushAsyncWork();
	assert.equal(harness.completeCalls.length, 2);

	// 下一轮 agent run 才重新尝试（MAX_TITLE_ATTEMPTS = 2）
	harness.setCompletion(() => Promise.resolve(assistantMessage([{ type: "text", text: "重试成功" }])));
	await harness.emit("agent_start");
	await harness.emit("agent_settled");
	await flushAsyncWork();
	await flushAsyncWork();
	assert.equal(harness.completeCalls.length, 3);
	assert.deepEqual(harness.setNames, ["重试成功"]);
});

test("uses a credential-provided base URL for the independent request", async () => {
	const entries = freshBranch();
	const harness = createHarness({ entries, authBaseUrl: "http://127.0.0.1:43123/v1" });
	await startFresh(harness, entries);
	await harness.emit("agent_settled");
	await flushAsyncWork();
	assert.equal(harness.completeCalls[0].model.baseUrl, "http://127.0.0.1:43123/v1");
});

test("captures a durable session id that appears after session_start", async () => {
	const entries = freshBranch({ user: "修复匿名会话" });
	const harness = createHarness({ entries });
	harness.setSessionId(undefined);
	harness.setBranch([]);
	await harness.emit("session_start", { reason: "new" });
	harness.setSessionId("session-2");
	harness.setBranch(entries);
	await harness.emit("agent_settled");
	await flushAsyncWork();
	assert.deepEqual(harness.setNames, ["修复登录流程"]);
});

test("disabled setting prevents the built-in extension from making a request", async () => {
	const entries = freshBranch();
	const harness = createHarness({ enabled: false, entries });
	await startFresh(harness, entries);
	await harness.emit("agent_settled");
	await flushAsyncWork();
	assert.equal(harness.completeCalls.length, 0);
	assert.deepEqual(harness.setNames, []);
});

test("missing model or credentials leaves the existing fallback untouched", async () => {
	const entries = freshBranch();
	const noModel = createHarness({ entries, hasModel: false });
	await startFresh(noModel, entries);
	await noModel.emit("agent_settled");
	await flushAsyncWork();
	assert.equal(noModel.completeCalls.length, 0);
	assert.deepEqual(noModel.setNames, []);

	const noCredentials = createHarness({
		entries,
		authResolver: async () => ({ ok: false, error: "No API key" }),
	});
	await startFresh(noCredentials, entries);
	await noCredentials.emit("agent_settled");
	await flushAsyncWork();
	assert.equal(noCredentials.completeCalls.length, 0);
	assert.deepEqual(noCredentials.setNames, []);
});

test("cleans model formatting, removes emoji, and enforces the short title contract", async () => {
	const { cleanTitle, redactSensitiveText } = compileExtension({ completeSimple: () => Promise.reject(new Error("unused")) });
	assert.equal(cleanTitle("**Title: Fix login API! 🚀**\nextra explanation"), "Fix login API");
	assert.equal(cleanTitle("```text\n修复登录流程。\n```"), "修复登录流程");
	assert.equal(cleanTitle("Untitled"), undefined);
	assert.equal(cleanTitle("Fix api_key=super-secret-value"), undefined);
	assert.equal(cleanTitle("sk-abcdefghijklmnop"), undefined);
	assert.doesNotMatch(redactSensitiveText('password="my secret phrase"'), /my secret phrase/);
	assert.equal(cleanTitle("x"), undefined);
	// 不再硬截断：模型输出由提示词约束长度，超长时不切碎词、原样保留（2026 现场："issue" → "issu"）。
	assert.equal(cleanTitle("一个非常非常非常非常非常非常长的标题"), "一个非常非常非常非常非常非常长的标题");
	assert.equal(cleanTitle("Fix: DSH session files not removed from the workspace"), "Fix: DSH session files not removed from the workspace");
});

test("names an interrupted first run from the user request", async () => {
	const entries = [messageEntry(userMessage("修复构建失败"), 0), messageEntry(assistantMessage([{ type: "text", text: "检索尚未完成" }], "aborted"), 1)];
	const harness = createHarness({ entries });
	await startFresh(harness, entries);
	await harness.emit("agent_settled");
	await flushAsyncWork();

	assert.equal(harness.completeCalls.length, 1);
	assert.match(harness.completeCalls[0].titleContext.messages[0].content, /修复构建失败/);
	assert.doesNotMatch(harness.completeCalls[0].titleContext.messages[0].content, /检索尚未完成/);
});

test("names an errored first run from the user request", async () => {
	const entries = [messageEntry(userMessage("修复启动报错"), 0), messageEntry(assistantMessage([], "error"), 1)];
	const harness = createHarness({ entries });
	await startFresh(harness, entries);
	await harness.emit("agent_settled");
	await flushAsyncWork();

	assert.equal(harness.completeCalls.length, 1);
	assert.match(harness.completeCalls[0].titleContext.messages[0].content, /修复启动报错/);
});

test("prewarms credentials before an interrupted run settles", async () => {
	let resolveAuth;
	const authReady = new Promise((resolve) => {
		resolveAuth = resolve;
	});
	let authCalls = 0;
	const entries = [messageEntry(userMessage("中断后仍应生成标题"), 0), messageEntry(assistantMessage([], "aborted"), 1)];
	const harness = createHarness({ entries });
	harness.context.modelRegistry.getApiKeyAndHeaders = async () => {
		authCalls += 1;
		return authReady;
	};

	await startFresh(harness, entries);
	await flushAsyncWork();
	assert.equal(authCalls, 1);

	await harness.emit("agent_start");
	await flushAsyncWork();
	assert.equal(authCalls, 1);

	await harness.emit("agent_settled");
	await flushAsyncWork();
	assert.equal(harness.completeCalls.length, 0);

	resolveAuth({ ok: true, apiKey: "test-key", headers: {}, env: {} });
	await flushAsyncWork();
	assert.equal(harness.completeCalls.length, 1);
	assert.deepEqual(harness.setNames, ["修复登录流程"]);
});

test("retries a failed title request only on a later agent run", async () => {
	const entries = freshBranch({ user: "修复构建失败" });
	const harness = createHarness({ entries });
	harness.setCompletion(() => Promise.reject(new Error("temporary title failure")));
	await startFresh(harness, entries);
	await harness.emit("agent_settled");
	await flushAsyncWork();
	assert.equal(harness.completeCalls.length, 1);

	harness.setCompletion(() => Promise.resolve(assistantMessage([{ type: "text", text: "构建恢复" }])));
	harness.setBranch(freshBranch({ user: "修复构建失败", assistant: "构建已经恢复" }));
	await harness.emit("agent_start");
	await harness.emit("agent_settled");
	await flushAsyncWork();
	assert.equal(harness.completeCalls.length, 2);
	assert.deepEqual(harness.setNames, ["构建恢复"]);
});

test("manual rename wins and aborts the pending title request", async () => {
	let resolveCompletion;
	const completion = new Promise((resolve) => {
		resolveCompletion = resolve;
	});
	const entries = freshBranch();
	const harness = createHarness({ entries });
	harness.setCompletion(() => completion);
	await startFresh(harness, entries);
	await harness.emit("agent_settled");
	await flushAsyncWork();
	assert.equal(harness.completeCalls.length, 1);

	await harness.emit("session_info_changed", { name: "用户手动标题" });
	assert.equal(harness.completeCalls[0].options.signal.aborted, true);
	resolveCompletion(assistantMessage([{ type: "text", text: "不应覆盖手动标题" }]));
	await flushAsyncWork();
	assert.deepEqual(harness.setNames, []);
});

test("shutdown cancels only the title side request, while an ordinary session switch event does not", async () => {
	let resolveCompletion;
	const completion = new Promise((resolve) => {
		resolveCompletion = resolve;
	});
	const entries = freshBranch();
	const harness = createHarness({ entries });
	harness.setCompletion(() => completion);
	await startFresh(harness, entries);
	await harness.emit("agent_settled");
	await flushAsyncWork();
	const signal = harness.completeCalls[0].options.signal;

	await harness.emit("session_before_switch", { reason: "resume" });
	resolveCompletion(assistantMessage([{ type: "text", text: "切换侧栏不应取消原会话标题" }]));
	await flushAsyncWork();
	assert.deepEqual(harness.setNames, ["切换侧栏不应取消原会话标题"]);

	// A real Pi runtime replacement emits session_shutdown; it must abort the side request.
	let resolveSecond;
	const secondCompletion = new Promise((resolve) => {
		resolveSecond = resolve;
	});
	harness.setCompletion(() => secondCompletion);
	harness.clearName();
	const secondEntries = freshBranch({ user: "第二个会话", assistant: "完成" });
	harness.setBranch(secondEntries);
	await startFresh(harness, secondEntries);
	await harness.emit("agent_settled");
	await flushAsyncWork();
	const secondSignal = harness.completeCalls[1].options.signal;
	await harness.emit("session_shutdown", { reason: "quit" });
	assert.equal(secondSignal.aborted, true);
	resolveSecond(assistantMessage([{ type: "text", text: "不能写入已销毁 runtime" }]));
	await flushAsyncWork();
	assert.equal(harness.setNames.length, 1);
	assert.equal(signal.aborted, false);
});

test("fork/resume sessions and duplicate settled events are not auto-named", async () => {
	const forkHarness = createHarness({ entries: freshBranch() });
	await forkHarness.emit("session_start", { reason: "fork" });
	await forkHarness.emit("agent_settled");
	assert.equal(forkHarness.completeCalls.length, 0);

	const resumeHarness = createHarness({ entries: freshBranch() });
	await resumeHarness.emit("session_start", { reason: "resume" });
	await resumeHarness.emit("agent_settled");
	assert.equal(resumeHarness.completeCalls.length, 0);

	let resolveCompletion;
	const completion = new Promise((resolve) => {
		resolveCompletion = resolve;
	});
	const duplicateEntries = freshBranch();
	const duplicateHarness = createHarness({ entries: duplicateEntries });
	duplicateHarness.setCompletion(() => completion);
	await startFresh(duplicateHarness, duplicateEntries);
	await duplicateHarness.emit("agent_settled");
	await flushAsyncWork();
	await duplicateHarness.emit("agent_settled");
	assert.equal(duplicateHarness.completeCalls.length, 1);
	resolveCompletion(assistantMessage([{ type: "text", text: "唯一标题" }]));
	await flushAsyncWork();
	assert.deepEqual(duplicateHarness.setNames, ["唯一标题"]);
});

// 回归 2026-10 #250：首条消息用 /模板 时，块正文是发给主模型的上下文，不是用户意图。
// 旧实现把 1600 字预算全给了模板正文，用户真正说的话被截掉，标题变成模板里的章节名。
const templateBlock = (name, body) => `<prompt_template name="${name}">\n${body}\n</prompt_template>`;
const longTemplateBody = `# 翻译官工作规则\n${"规则正文。".repeat(500)}`;

test("只插了 /模板 没写正文时直接用模板名命名，不再请求模型", async () => {
	const entries = [messageEntry(userMessage(templateBlock("翻译官", longTemplateBody)), 0)];
	const harness = createHarness({ entries });
	await startFresh(harness, entries);
	await harness.emit("agent_settled");
	await flushAsyncWork();

	// 模板名本身就是最准确的标题：省掉一次模型请求，也不再受推理模型输出预算/超时影响。
	assert.equal(harness.completeCalls.length, 0);
	assert.deepEqual(harness.setNames, ["/翻译官"]);
});

test("首条消息带 /模板 时只把用户自己写的话送进标题请求", async () => {
	const entries = [messageEntry(userMessage(`${templateBlock("翻译官", longTemplateBody)}\n\nhow are you`), 0)];
	const harness = createHarness({ entries });
	await startFresh(harness, entries);
	await harness.emit("agent_settled");
	await flushAsyncWork();

	assert.equal(harness.completeCalls.length, 1);
	const content = harness.completeCalls[0].titleContext.messages[0].content;
	assert.match(content, /how are you/);
	// 模板正文与 XML 包装不能出现在标题请求里（否则又会总结出「翻译官工作规则」）。
	assert.doesNotMatch(content, /规则正文/);
	assert.doesNotMatch(content, /prompt_template/);
});

test("扩展自带的块清洗与 shared 解析层逐条一致", () => {
	// 扩展是 pi 用 -e 加载的独立文件，无法 import shared，只能自带一份实现；
	// 这里逐条对照，防止两侧对同一条消息得出不同标题（分叉即回归）。
	const { formatPromptTemplateBlock, textForSessionTitle } = loadTsCommonJs("src/shared/expandedRefBlocks.ts");
	const { titleTextFromUserInput } = loadTsCommonJs(extensionPath, {
		stubs: { "@earendil-works/pi-ai/compat": { completeSimple: () => Promise.reject(new Error("unused")) } },
	});
	const template = formatPromptTemplateBlock("翻译官", longTemplateBody);
	const samples = [
		`${template}\n\nhow are you`,
		template,
		`帮我翻译 ${template}\n\n这段话`,
		'<quoted_context label="引用A" message_id="m1">\nA 全文\n</quoted_context>\n照着改',
		'<referenced_session name="会话B">\n[User]: x\n</referenced_session>',
		'<skill name="cv-writer">\n指令正文\n</skill>\n帮我写简历',
		'<skill name="cv-writer">\n指令正文\n</skill>',
		`${formatPromptTemplateBlock("a", "A")}\n${formatPromptTemplateBlock("b", "B")}`,
		"普通消息，没有块",
		"<skill> 是什么意思",
	];
	for (const sample of samples) {
		assert.equal(titleTextFromUserInput(sample).text, textForSessionTitle(sample), `diverged on: ${sample.slice(0, 48)}`);
	}
	// 纯块输入必须被标记出来（调用方据此跳过模型请求）。
	assert.equal(titleTextFromUserInput(template).blockOnly, true);
	assert.equal(titleTextFromUserInput(`帮我翻译 ${template}\n\n这段话`).blockOnly, false);
	assert.equal(titleTextFromUserInput("普通消息，没有块").blockOnly, false);
});
