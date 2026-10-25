import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import { createProvider, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { loadDshOpenCodeHeaders, installDshOpenCodeHeaders, resolveDshPiAiEntry, isOpenCodeRoute, addOpenCodeHeaders } = loadTsCommonJs("src/main/dsh/dshOpenCodeHeaders.ts");
const adapterEntry = createRequire(import.meta.url).resolve("@deepseek-ai/dsh-llm-pi-ai");
let dispose;
beforeEach(async () => {
	// 实际加载 DSH 依赖的 pi-ai，而不是 app 顶层的新版；仅 mock 最后的网络 provider。
	dispose = await loadDshOpenCodeHeaders(adapterEntry, (url) => import(url));
});
afterEach(() => dispose());

/** 用真实 DSH adapter → pi-ai provider 调用链捕获请求参数；不启动 host、不发网络请求。 */
function createHarness({ provider = "opencode-go", baseUrl = "https://opencode.ai/zen/go", headers, modelHeaders, authHeaders, authBaseUrl } = {}) {
	const requests = [];
	const model = {
		id: "test-model",
		name: "test-model",
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		contextWindow: 32768,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		headers: modelHeaders,
	};
	const stream = (requestModel, _context, options) => {
		requests.push({ model: requestModel, options });
		const events = createAssistantMessageEventStream();
		const message = {
			role: "assistant",
			content: [],
			api: model.api,
			provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 0,
		};
		events.push({ type: "done", reason: "stop", message });
		events.end(message);
		return events;
	};
	const piProvider = createProvider({
		id: provider,
		models: [model],
		api: { stream, streamSimple: stream },
		auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test-key", headers: authHeaders, baseUrl: authBaseUrl }, source: "test" }), login: async () => ({ type: "api_key", key: "test-key" }) } },
	});
	const profile = Object.freeze({
		provider,
		displayName: provider,
		piProvider,
		headers,
		streamIdleTimeoutMs: 300000,
		maxRequestImageBytes: 20 * 1024 * 1024,
		requestImagePixelBudget: 1000000,
		requestImageMaxBytes: 1024 * 1024,
		modelErrors: new Map(),
		configuredMaxTokens: new Map(),
	});
	const profiles = new Map([[provider, profile]]);
	const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => "test-key", auth: {} });
	async function call(sessionId) {
		const prepared = await adapter.prepareCall(provider, model.id);
		const options = Object.freeze({ provider, model: model.id, sessionId, messages: [] });
		for await (const _chunk of prepared.stream(options)) {
			/* 消费真实惰性请求。 */
		}
		return requests.findLast((request) => request.options.sessionId === sessionId)?.options.headers;
	}
	return { call, requests, profile, adapter, piProvider, model };
}

test("DSH OpenCode 请求自动携带当前会话 ID 和 PiDeck 客户端标识", async () => {
	const harness = createHarness();
	const headers = await harness.call("dsh-session-one");
	assert.equal(headers["x-opencode-session"], "dsh-session-one");
	assert.equal(headers["x-opencode-client"], "pideck");
	assert.equal(harness.profile.headers, undefined, "动态会话头不能污染共享供应商配置");
});

test("共享 provider 的并发会话各自使用自己的 ID，恢复会话沿用原 ID", async () => {
	const configured = Object.freeze({ "User-Agent": "my-client/1.0", "X-Custom": "keep" });
	const harness = createHarness({ headers: configured });
	const ids = Array.from({ length: 12 }, (_, index) => `session-${index}`);
	const results = await Promise.all(ids.map((id) => harness.call(id)));
	results.forEach((headers, index) => {
		assert.equal(headers["x-opencode-session"], ids[index]);
		assert.equal(headers["x-opencode-client"], "pideck");
		assert.equal(headers["user-agent"], attributionHeaders()["user-agent"]);
		assert.equal(headers["User-Agent"], undefined, "DSH removes case-insensitive User-Agent collisions before pi-ai");
		assert.equal(headers["X-Custom"], "keep");
	});
	const restored = createHarness({ headers: configured });
	assert.equal((await restored.call(ids[0]))["x-opencode-session"], ids[0]);
	assert.deepEqual(configured, { "User-Agent": "my-client/1.0", "X-Custom": "keep" });
	assert.equal(harness.profile.headers, configured);
});

test("profile 显式头优先，大小写不同也不追加重复键", async () => {
	const configured = Object.freeze({ "X-OpenCode-Session": "manual-session", "X-OPENCODE-CLIENT": "manual-client", "X-Other": "untouched" });
	const headers = await createHarness({ headers: configured }).call("automatic-session");
	assert.equal(headers["X-OpenCode-Session"], "manual-session");
	assert.equal(headers["X-OPENCODE-CLIENT"], "manual-client");
	assert.equal(headers["X-Other"], "untouched");
	assert.equal(Object.keys(headers).filter((name) => name.toLowerCase() === "x-opencode-session").length, 1);
	assert.equal(Object.keys(headers).filter((name) => name.toLowerCase() === "x-opencode-client").length, 1);
});

test("model 与 auth 头在自动值之前合并，用户无需在 profile 重复配置", async () => {
	const headers = await createHarness({
		modelHeaders: Object.freeze({ "X-OpenCode-Session": "model-session" }),
		authHeaders: Object.freeze({ "X-OpenCode-Client": "auth-client" }),
	}).call("automatic-session");
	assert.equal(headers["X-OpenCode-Session"], "model-session");
	assert.equal(headers["X-OpenCode-Client"], "auth-client");
	assert.equal(headers["x-opencode-session"], undefined);
	assert.equal(headers["x-opencode-client"], undefined);
});

test("自动 OpenCode 头保留 DSH 在进入 pi-ai 前强制设置的 User-Agent", async () => {
	const headers = await createHarness({ headers: { "User-Agent": "custom-pi-ua", "X-Custom": "keep" } }).call("session-with-dsh-ua");
	// 当前 adapter 的 requestHeaders() 先移除所有同名 UA，再写 attribution；
	// 本兼容层只补 OpenCode 元数据，不把被 DSH 移除的自定义 UA 偷偷恢复。
	assert.equal(headers["User-Agent"], undefined);
	assert.equal(headers["user-agent"], attributionHeaders()["user-agent"]);
	assert.equal(headers["X-Custom"], "keep");
	assert.equal(headers["x-opencode-session"], "session-with-dsh-ua");
});

test("空串和 null 是显式覆盖，不自动补回被用户关闭的头", async () => {
	const explicit = Object.freeze({ "X-OpenCode-Session": "", "X-OpenCode-Client": null });
	const result = addOpenCodeHeaders(explicit, "automatic-session");
	assert.deepEqual(Object.entries(result), Object.entries(explicit));
	assert.notEqual(result, explicit);
	const headers = await createHarness({ headers: { "X-OpenCode-Session": "", "X-OpenCode-Client": "" } }).call("automatic-session");
	assert.equal(headers["X-OpenCode-Session"], "");
	assert.equal(headers["X-OpenCode-Client"], "");
});

test("无 sessionId 的辅助请求不生成随机会话 ID，仍可标识客户端", async () => {
	const harness = createHarness();
	for (const id of [undefined, ""]) {
		const headers = await harness.call(id);
		assert.equal(headers["x-opencode-session"], undefined);
		assert.equal(headers["x-opencode-client"], "pideck");
	}
});

test("官方端点自定义别名和 opencode 目录路由都自动添加头", async () => {
	for (const route of [
		{ provider: "my-go", baseUrl: "https://opencode.ai/zen/go" },
		{ provider: "opencode", baseUrl: "https://opencode.ai/zen/v1" },
	]) {
		const headers = await createHarness(route).call("session-alias");
		assert.equal(headers["x-opencode-session"], "session-alias");
		assert.equal(headers["x-opencode-client"], "pideck");
	}
});

test("其它供应商和伪装 URL 不泄露会话头，已有普通头保持不变", async () => {
	for (const baseUrl of ["https://api.example.com/v1", "https://opencode.ai.evil.test/v1", "https://opencode.ai@evil.test/v1", "https://evil.test/opencode.ai", "https://api.opencode.ai/v1", "not a URL", "file://opencode.ai/v1"]) {
		const headers = await createHarness({ provider: "other-provider", baseUrl, headers: { "X-Custom": "keep" } }).call("private-session");
		assert.equal(headers["x-opencode-session"], undefined, baseUrl);
		assert.equal(headers["x-opencode-client"], undefined, baseUrl);
		assert.equal(headers["X-Custom"], "keep");
	}
	assert.equal(isOpenCodeRoute({ provider: "other", baseUrl: "https://OPENCODE.AI:443/zen/go" }), true);
});

test("鉴权将别名路由改到非 OpenCode 地址后不注入会话头", async () => {
	// OAuth 能在模型配置之后重定向端点；请求级捕获必须以最终目标为准。
	const harness = createHarness({ provider: "custom-alias", authBaseUrl: "https://other.example/v1", headers: { "X-Custom": "keep" } });
	const headers = await harness.call("private-session");
	assert.equal(harness.requests[0].model.baseUrl, "https://other.example/v1");
	assert.equal(headers["x-opencode-session"], undefined);
	assert.equal(headers["x-opencode-client"], undefined);
	assert.equal(headers["X-Custom"], "keep");
});

test("鉴权将别名路由改到 OpenCode 地址后仍自动携带会话头", async () => {
	const harness = createHarness({ provider: "custom-alias", baseUrl: "https://other.example/v1", authBaseUrl: "https://opencode.ai/zen/go" });
	const headers = await harness.call("resolved-opencode-session");
	assert.equal(harness.requests[0].model.baseUrl, "https://opencode.ai/zen/go");
	assert.equal(headers["x-opencode-session"], "resolved-opencode-session");
	assert.equal(headers["x-opencode-client"], "pideck");
});

test("已有异步 transformHeaders 保留且优先，不修改冻结的 request options", async () => {
	const piAi = await import(pathToFileURL(resolveDshPiAiEntry(adapterEntry)).href);
	const models = piAi.createModels();
	const harness = createHarness();
	models.setProvider(harness.piProvider);
	const abort = new AbortController();
	const transformHeaders = async (headers) => ({ ...headers, "X-OpenCode-Client": "transformed" });
	const options = Object.freeze({ sessionId: "transformed-session", signal: abort.signal, transformHeaders });
	await models.streamSimple(harness.model, { messages: [] }, options).result();
	assert.equal(harness.requests[0].options.headers["x-opencode-session"], "transformed-session");
	assert.equal(harness.requests[0].options.headers["X-OpenCode-Client"], "transformed");
	assert.equal(harness.requests[0].options.headers["x-opencode-client"], undefined);
	assert.equal(harness.requests[0].options.signal, abort.signal);
	assert.equal(options.transformHeaders, transformHeaders);
	assert.equal(options.headers, undefined);
});

test("重复安装不会叠加 wrapper，最后一个 host 释放时恢复原方法", async () => {
	dispose();
	const piAi = await import(pathToFileURL(resolveDshPiAiEntry(adapterEntry)).href);
	const original = piAi.createModels().applyAuth;
	const first = installDshOpenCodeHeaders(piAi);
	const wrapped = piAi.createModels().applyAuth;
	const second = installDshOpenCodeHeaders(piAi);
	try {
		assert.notEqual(wrapped, original);
		assert.equal(piAi.createModels().applyAuth, wrapped);
		first();
		first();
		assert.equal(piAi.createModels().applyAuth, wrapped);
		assert.equal((await createHarness().call("still-installed"))["x-opencode-session"], "still-installed");
	} finally {
		first();
		second();
	}
	assert.equal(piAi.createModels().applyAuth, original);
});

test("后装 wrapper 保留时卸载仍停用注入，再安装只启用当前一层", async () => {
	dispose();
	const piAi = await import(pathToFileURL(resolveDshPiAiEntry(adapterEntry)).href);
	const prototype = Object.getPrototypeOf(piAi.createModels());
	const original = prototype.applyAuth;
	const first = installDshOpenCodeHeaders(piAi);
	const retained = prototype.applyAuth;
	// 模拟其它插件保存并转发我们的 wrapper，不能用覆盖其方法的方式卸载。
	const later = function (...args) {
		return retained.apply(this, args);
	};
	prototype.applyAuth = later;
	let second;
	try {
		first();
		assert.equal(prototype.applyAuth, later);
		// pi-ai 1.4.0 自己就注入 x-opencode-session，卸载后仍在；本层的客户端标识必须消失。
		const afterDispose = await createHarness().call("after-dispose");
		assert.equal(afterDispose["x-opencode-client"], undefined);
		second = installDshOpenCodeHeaders(piAi);
		assert.equal((await createHarness().call("reinstalled"))["x-opencode-session"], "reinstalled");
		second();
		assert.equal(prototype.applyAuth, later);
		const afterReinstallDispose = await createHarness().call("after-reinstall-dispose");
		assert.equal(afterReinstallDispose["x-opencode-client"], undefined);
	} finally {
		second?.();
		first();
		prototype.applyAuth = original;
	}
});

test("鉴权等待期间卸载，恢复后不再注入且保留原有 transformHeaders", async () => {
	const piAi = await import(pathToFileURL(resolveDshPiAiEntry(adapterEntry)).href);
	const models = piAi.createModels();
	const harness = createHarness();
	models.setProvider(harness.piProvider);
	// 用显式握手停在鉴权的最后一步，不依赖定时器或真实 OAuth/网络。
	const started = Promise.withResolvers();
	const resume = Promise.withResolvers();
	const stream = models.streamSimple(
		harness.model,
		{ messages: [] },
		{
			sessionId: "disposed-while-authenticating",
			transformHeaders: async (headers) => {
				started.resolve();
				await resume.promise;
				return { ...headers, "X-Custom": "transformed" };
			},
		},
	);
	try {
		await started.promise;
		dispose();
	} finally {
		resume.resolve();
	}
	await stream.result();
	const headers = harness.requests[0].options.headers;
	// 同上：上游 pi-ai 自带的会话头不由本层控制，这里验证本层不再补客户端标识。
	assert.equal(headers["x-opencode-client"], undefined);
	assert.equal(headers["X-Custom"], "transformed");
});

test("runtime 返回结构变化时透传原结果，不阻断请求", async () => {
	// 模拟升级后的私有 seam，未知数据必须 fail-open，而不是强转后解引用。
	class ChangedModels {
		async applyAuth(result) {
			return result;
		}
	}
	const module = { createModels: () => new ChangedModels() };
	const release = installDshOpenCodeHeaders(module);
	try {
		for (const result of [
			undefined,
			null,
			{},
			{ requestModel: { provider: "opencode-go" }, requestOptions: null },
			{ requestModel: { provider: "opencode-go", baseUrl: 42 }, requestOptions: {} },
			{ requestModel: { provider: "opencode-go" }, requestOptions: { sessionId: 42 } },
			{ requestModel: { provider: "opencode-go" }, requestOptions: { headers: { "X-Custom": 42 } } },
		]) {
			assert.equal(await module.createModels().applyAuth(result), result);
		}
	} finally {
		release();
	}
});

test("未知 runtime API 明确拒绝，不能悄悄装到错误对象", () => {
	for (const module of [{}, { createModels: () => ({}) }, { createModels: () => ({ streamSimple() {} }) }]) {
		assert.throws(() => installDshOpenCodeHeaders(module), /DSH pi-ai/);
	}
});

test("从 adapter 就近解析 import-only 依赖，兼容嵌套包、hoist 和路径空格", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pideck dsh headers "));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const adapter = join(root, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js");
	const nestedDir = join(dirname(dirname(adapter)), "node_modules", "@earendil-works", "pi-ai");
	const hoistedDir = join(root, "node_modules", "@earendil-works", "pi-ai");
	mkdirSync(dirname(adapter), { recursive: true });
	writeFileSync(adapter, "export {};");
	for (const dir of [nestedDir, hoistedDir]) {
		mkdirSync(join(dir, "esm"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", type: "module", exports: { ".": { types: "./types.d.ts", import: "./esm/entry.js" } } }));
		writeFileSync(join(dir, "esm", "entry.js"), "export {};");
	}
	assert.equal(resolveDshPiAiEntry(adapter), join(nestedDir, "esm", "entry.js"));
	rmSync(nestedDir, { recursive: true, force: true });
	assert.equal(resolveDshPiAiEntry(adapter), join(hoistedDir, "esm", "entry.js"));
});

test("host 在 prepare 阶段安装，并交给 fiber 清理与 logger 诊断", () => {
	const host = readFileSync("src/main/dsh/hostEntry.ts", "utf8");
	assert.match(host, /async\s*\(hostCtx:[\s\S]{0,600}?await\s+loadDshOpenCodeHeaders\(require\.resolve\("@deepseek-ai\/dsh-llm-pi-ai"\)\)/);
	assert.match(host, /hostCtx\.effect\(\(\)\s*=>\s*dispose,\s*"pideck-opencode-headers"\)/);
	assert.match(host, /catch\s*\(error\)\s*\{[\s\S]{0,300}?hostCtx\.logger\("pideck-opencode-headers"\)\.warn/);
});
