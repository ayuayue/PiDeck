/**
 * ConfigManager.fetchProviderModels 自定义 headers（含 User-Agent）单测。
 *
 * 背景：provider 在 models.json 里配置了 headers（如把 User-Agent 设为浏览器 UA），
 * 「测试连接」早已透传这些 headers，但「获取模型」此前忽略了它们，导致被
 * 按 User-Agent 拦截的服务（如 bailucode 把 OpenAI/JS 6.26.0 整段 403）无法拉取列表。
 *
 * 断言两条：
 *  1. 传了自定义 User-Agent 时，/models 请求必须用它，而不是 SDK 默认 UA；
 *  2. 没传时仍回退到 SDK 默认 UA（保证既有行为不回退、不误伤）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const syncRequire = createRequire(import.meta.url);

const MODULE_PATH = "src/main/config/ConfigManager.ts";

/** 记录请求头，供断言 */
let lastRequestHeaders = null;

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
		// electron：只暴露 net.fetch，供 fetchProviderModels 使用
		if (specifier === "electron") {
			return {
				net: {
					fetch: async (url, init) => {
						lastRequestHeaders = init?.headers ?? null;
						return {
							ok: true,
							status: 200,
							statusText: "OK",
							json: async () => ({
								object: "list",
								data: [{ id: "bailu-test", object: "model" }],
							}),
						};
					},
				},
			};
		}
		// baseUrlPath 里的版本路径/改写建议：本用例传入已带 /v1 的地址，
		// 这些函数不参与字节级断言，用最小桩即可。
		if (specifier === "./baseUrlPath") {
			return {
				ensureOpenAiVersionPath: (u) => u,
				needsSessionBaseUrlVersionHint: () => false,
				suggestNormalizedBaseUrl: () => null,
			};
		}
		// 目录富化：已从 fetchProviderModels 移除，测试只关心请求头。
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
		// 其余（shared 类型、i18n、parseProviderModels 等）在 fetchProviderModels
		// 路径里要么已被擦除、要么被上面的桩/传入的 translate 覆盖。
		return {};
	};
	vm.runInNewContext(output, { module, exports: module.exports, require: localRequire, console, setTimeout, clearTimeout, AbortController }, { filename: MODULE_PATH });
	return module.exports;
}

const { ConfigManager } = compile();

test("携带自定义 User-Agent 时，/models 请求使用它而非 SDK 默认", async () => {
	lastRequestHeaders = null;
	// translate 固定为同一实现，避免依赖 mainProcessCopy 桩
	const manager = new ConfigManager(undefined, (key, params) => ({ key, params }));
	const result = await manager.fetchProviderModels("https://bailucode.com/openapi/v1", "sk-test", "openai-completions", { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) fake-browser" });
	assert.equal(result.success, true, "自定义 UA 下应能成功拉取模型列表");
	assert.ok(lastRequestHeaders, "应发起一次 /models 请求");
	const ua = lastRequestHeaders["User-Agent"];
	assert.equal(ua, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) fake-browser", "必须使用 provider 配置的 User-Agent，而不是 OpenAI/JS 默认值");
});

test("未配置 User-Agent 时仍回退到 SDK 默认 UA（不回归）", async () => {
	lastRequestHeaders = null;
	const manager = new ConfigManager(undefined, (key, params) => ({ key, params }));
	const result = await manager.fetchProviderModels("https://bailucode.com/openapi/v1", "sk-test", "openai-completions");
	assert.equal(result.success, true);
	assert.equal(lastRequestHeaders["User-Agent"], "OpenAI/JS 6.26.0", "未配置自定义 UA 时应保持 SDK 默认值，避免影响既有 provider 的检测一致性");
});
