/**
 * ConfigManager.fetchProviderModels 的「非 JSON 响应」分类单测。
 *
 * 背景（真实故障）：第三方网关在 WAF / 人机验证拦截时，会返回 **HTTP 200**
 * 但正文是 HTML 挑战页（实测 agentrouter.org 返回阿里云 WAF 的 15886 字节
 * 挑战页，`<meta name="aliyun_waf_aa">` + `acw_tc` cookie），任何客户端都拿不到
 * JSON。旧实现的处理路径是 `res.json()` 直接抛错，用户看到的只是笼统的
 * 「获取模型列表失败」，无从判断是网络出口问题还是配置写错。
 *
 * 期望行为：content-type 为 HTML（或 body 解析不出 JSON）时，返回专门的
 * 「被拦截」错误文案，引导用户切换代理 / 配置白名单 UA。
 *
 * 同时也覆盖网络层错误分类：TLS 被干扰与彻底连不上必须给不同提示。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const syncRequire = createRequire(import.meta.url);
const MODULE_PATH = "src/main/config/ConfigManager.ts";

/** 由各用例注入：模拟一次 /models 响应（Error 实例表示网络层抛错）。 */
let responder = null;

function compile() {
	const source = readFileSync(MODULE_PATH, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: MODULE_PATH,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => {
		if (specifier.startsWith("node:")) return syncRequire(specifier);
		if (specifier === "electron") {
			return {
				net: {
					// responder 是 Error 时模拟网络层失败（Chromium 会把 ERR_* 包成 Error 抛出）
					fetch: async () => {
						if (responder instanceof Error) throw responder;
						return responder;
					},
				},
				session: {},
			};
		}
		if (specifier === "./baseUrlPath") {
			return {
				ensureOpenAiVersionPath: (url) => url,
				needsSessionBaseUrlVersionHint: () => false,
				suggestNormalizedBaseUrl: () => null,
			};
		}
		if (specifier === "./parseProviderModels") {
			return {
				parseProviderModelsResponse: (body) => (Array.isArray(body?.data) ? body.data.map((m) => ({ id: m.id })) : []),
			};
		}
		if (specifier === "./mcpConfig") {
			return {
				loadMcpConfigSnapshot: () => null,
				mcpDocsUrl: "",
				probeMcpServer: async () => ({ ok: false }),
				validateMcpConfigFile: () => undefined,
			};
		}
		if (specifier === "./providerUsageProbe") {
			return {
				candidateApplies: () => false,
				parseUsageResponseBody: () => null,
				USAGE_PROBE_CANDIDATES: [],
				usageProbeUrls: () => [],
			};
		}
		if (specifier === "../logging/sharedLogger") {
			// 生产代码错误路径用 getAppLogger()?.error(...) 留痕；测试无主进程 logger，返回 null 即走静默分支
			return { getAppLogger: () => null };
		}
		return {};
	};
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: localRequire,
			console,
			setTimeout,
			clearTimeout,
			AbortController,
			URL,
			TextEncoder,
			TextDecoder,
		},
		{ filename: MODULE_PATH },
	);
	return module.exports;
}

const { ConfigManager } = compile();

/**
 * translate 桩：把 key 原样返回，便于断言「命中哪条专用文案」。
 * 真实文案在 src/shared/i18n/mainProcessCopy.ts，不在这里重复。
 */
function makeManager() {
	return new ConfigManager(undefined, (key) => key);
}

function htmlResponse(body = '<html><meta name="aliyun_waf_aa"></html>') {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
		json: async () => {
			throw new SyntaxError("Unexpected token '<'");
		},
		text: async () => body,
	};
}

test("HTTP 200 + text/html（WAF 挑战页）→ 专用「被拦截」文案，而非笼统失败", async () => {
	responder = htmlResponse();
	const result = await makeManager().fetchProviderModels("https://agentrouter.org/v1", "sk-test", "openai-completions");
	assert.equal(result.success, false);
	assert.equal(result.error, "mainConfig.fetchBlockedByHtml");
	// 关键：不能只给笼统的 fetchModelsFailed，否则用户会被引去改 baseUrl / API Key
	assert.notEqual(result.error, "mainConfig.fetchModelsFailed");
});

test("content-type 声称 JSON 但正文不是 → 同样归入「被拦截」", async () => {
	responder = {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: { get: () => "application/json" },
		json: async () => {
			throw new SyntaxError("Unexpected token '<'");
		},
	};
	const result = await makeManager().fetchProviderModels("https://agentrouter.org/v1", "sk-test", "openai-completions");
	assert.equal(result.success, false);
	assert.equal(result.error, "mainConfig.fetchBlockedByHtml");
});

test("网络错误分类：TLS / SSL 相关 → fetchTlsBlocked", async () => {
	// 国内直连 anyrouter.top 的真实形态：TLS 被中间设备干扰，开代理才能通
	responder = Object.assign(new Error("ERR_SSL_VERSION_OR_CIPHER_MISMATCH"), { name: "Error" });
	const result = await makeManager().fetchProviderModels("https://anyrouter.top/v1", "sk-test", "openai-completions");
	assert.equal(result.success, false);
	assert.equal(result.error, "mainConfig.fetchTlsBlocked");
});

test("网络错误分类：连接超时 / 不可达 → fetchUnreachable", async () => {
	for (const message of ["ERR_CONNECTION_TIMED_OUT", "ERR_CONNECTION_REFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
		responder = Object.assign(new Error(message), { name: "Error" });
		const result = await makeManager().fetchProviderModels("https://agentrouter.org/v1", "sk-test", "openai-completions");
		assert.equal(result.success, false, `${message} 应判定为失败`);
		assert.equal(result.error, "mainConfig.fetchUnreachable", `${message} 应给出不可达提示`);
	}
});

test("未知网络错误 → 回落默认文案（不误报为 TLS/不可达）", async () => {
	responder = Object.assign(new Error("some totally unknown failure"), { name: "Error" });
	const result = await makeManager().fetchProviderModels("https://example.com/v1", "sk-test", "openai-completions");
	assert.equal(result.success, false);
	assert.equal(result.error, "mainConfig.fetchModelsFailed");
});
