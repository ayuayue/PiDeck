/**
 * ConfigManager.validateModels 加固单测。
 *
 * 背景：用户反馈「改参数 + 改供应商名称后配置损坏，模型加载为空」。
 * 保存前在 main 侧做最终校验：provider 名（宽松安全校验，防路径穿越/控制字符）、
 * model id（拒绝控制字符/超长）、baseUrl（拒绝控制字符），阻断坏配置落盘。
 *
 * 注意：provider 名的严格白名单（字母开头、无空格特殊字符）仍只用于前端
 * 新增/重命名入口；main 侧用 isSafeProviderName 宽松校验，避免卡历史数据。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const syncRequire = createRequire(import.meta.url);
const MODULE_PATH = "src/main/config/ConfigManager.ts";

/** 记录最后一次写盘的 JSON 文本，用于断言「保存后的文件内容」。 */
let lastWrittenJson = null;

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
		if (specifier.startsWith("node:")) {
			// fs/promises 用替身：合法数据不真写盘，但记录写入文本供断言。
			if (specifier === "node:fs/promises") {
				return {
					readFile: async () => {
						const e = new Error("ENOENT");
						e.code = "ENOENT";
						throw e;
					},
					writeFile: async (_path, content) => {
						lastWrittenJson = content;
					},
					mkdir: async () => {},
					rename: async () => {},
				};
			}
			return syncRequire(specifier);
		}
		if (specifier === "electron") return { net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) } };
		// provider 名宽松校验（与 providerMigration.isSafeProviderName 同规则）。
		if (specifier === "./providerMigration") {
			return {
				isSafeProviderName: (name) => typeof name === "string" && name.trim().length > 0 && name.trim().length <= 80 && !/[\\/]/.test(name) && !name.includes(".."),
			};
		}
		// saveModelsConfig 会调用归因兜底（仅依赖纯常量，无副作用），加载真实实现避免空对象 stub
		// 配置写盘留痕（ConfigManager.writeJsonFile 调 getAppLogger()?.info）；validate 路径只断言校验结果，未安装 logger 时返回 undefined。
		if (specifier === "../logging/sharedLogger") {
			return { getAppLogger: () => undefined };
		}
		if (specifier === "./tokendanceAttribution") {
			return loadTsCommonJs("src/main/config/tokendanceAttribution.ts");
		}
		if (specifier.includes("mainProcessCopy")) {
			return { mainProcessT: (_locale, key) => key };
		}
		// validateModels 路径不依赖其余模块（parse/usage/catalog 等），返回空对象即可。
		return {};
	};
	vm.runInNewContext(output, { module, exports: module.exports, require: localRequire, console }, { filename: MODULE_PATH });
	return module.exports;
}

const { ConfigManager } = compile();

/**
 * 用记录 fetch 调用的替身重新编译一次 ConfigManager（module 级缓存会跨用例串状态，
 * 而 fetchProviderModels 的「不发请求」需要看真实调用计数）。
 * onFetch(url) 在每次请求时被调用，返回 200 + 单条模型。
 */
function recompileWithFetchProbe(onFetch) {
	const source = readFileSync(MODULE_PATH, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
		fileName: MODULE_PATH,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => {
		if (specifier.startsWith("node:")) return syncRequire(specifier);
		if (specifier === "electron") {
			return {
				net: {
					fetch: async (url) => {
						onFetch(url);
						return { ok: true, status: 200, statusText: "OK", headers: { get: () => "application/json" }, json: async () => ({ data: [{ id: "probe-model" }] }) };
					},
				},
				session: {},
			};
		}
		if (specifier === "./parseProviderModels") return loadTsCommonJs("src/main/config/parseProviderModels.ts");
		if (specifier === "./baseUrlPath") return loadTsCommonJs("src/main/config/baseUrlPath.ts");
		if (specifier.includes("mainProcessCopy")) return { mainProcessT: (_locale, key) => key };
		return {};
	};
	vm.runInNewContext(output, { module, exports: module.exports, require: localRequire, console, setTimeout, clearTimeout, AbortController, URL }, { filename: MODULE_PATH });
	return module.exports;
}
const manager = new ConfigManager(undefined, (key) => key);

function makeModels(providerName, modelId = "gpt-4o", baseUrl = "https://api.example.com/v1") {
	return {
		providers: {
			[providerName]: { baseUrl, api: "openai-completions", models: [{ id: modelId }] },
		},
	};
}

test("合法配置通过校验", async () => {
	const result = await manager.saveModelsConfig(makeModels("openai"));
	assert.equal(result.valid, true);
});

test("provider 名含路径分隔符被拒（路径穿越）", async () => {
	const result = await manager.saveModelsConfig(makeModels("../evil"));
	assert.equal(result.valid, false);
	assert.match(result.error, /providerNameInvalid/);
});

test("provider 名含换行控制字符被拒", async () => {
	const result = await manager.saveModelsConfig(makeModels("openai\nmalicious"));
	assert.equal(result.valid, false);
	assert.match(result.error, /providerNameInvalid/);
});

test("model id 含换行控制字符被拒", async () => {
	const result = await manager.saveModelsConfig(makeModels("openai", "gpt-4o\r\nx"));
	assert.equal(result.valid, false);
	assert.match(result.error, /modelIdInvalid/);
});

test("model id 超长被拒", async () => {
	const result = await manager.saveModelsConfig(makeModels("openai", "x".repeat(300)));
	assert.equal(result.valid, false);
	assert.match(result.error, /modelIdInvalid/);
});

test("baseUrl 含换行控制字符被拒", async () => {
	const result = await manager.saveModelsConfig(makeModels("openai", "gpt-4o", "https://api.example.com/v1\nx"));
	assert.equal(result.valid, false);
	assert.match(result.error, /baseUrlInvalid/);
});

test("model id 含 / 与 - 等常见字符仍合法", async () => {
	const result = await manager.saveModelsConfig(makeModels("openai", "deepseek-ai/DeepSeek-V3.2"));
	assert.equal(result.valid, true);
});

test("normalizeModelsForPi 剥离空 name 键（对齐 pi schema minLength:1）", () => {
	const data = {
		providers: {
			openai: {
				baseUrl: "https://api.example.com/v1",
				api: "openai-completions",
				models: [
					{ id: "gpt-4o", name: "" },
					{ id: "gpt-4o-mini", name: "GPT-4o mini" },
				],
			},
		},
	};
	// TS 的 private 只是编译期可见性，transpile 后是可调用普通方法，可直接断言归一结果。
	const result = manager.normalizeModelsForPi(data);
	const models = result.providers.openai.models;
	// 空 name 应删键（可选字段缺省，pi 视为合法），非空 name 原样保留。
	assert.equal(Object.hasOwn(models[0], "name"), false);
	assert.equal(models[1].name, "GPT-4o mini");
});

// ── 保存不得改坏 api：未知/新增协议必须原样保留 ──────────────
//
// 背景（真实故障面）：pi 1.0.3 起 provider 键从 azure-openai-responses 改名 azure，
// 同时 registry 里还有 google-vertex / bedrock-converse-stream / pi-messages 等
// 协议。旧实现把保存路径与「拉取模型列表」共用同一个 normalizeApiType，未命中
// 六项枚举的值一律被兜底改写成 openai-completions —— 用户只要点一次保存，
// Azure / Vertex / Bedrock 的 api 就被静默改成 OpenAI 协议，会话直接失败。
// 拉取列表沿用兜底（用最通用协议试探是合理的），保存必须原样保留。

test("保存保留新增协议 azure-openai-responses（不被兜底成 openai-completions）", async () => {
	lastWrittenJson = null;
	const data = { providers: { azure: { baseUrl: "https://x.openai.azure.com/openai/v1", api: "azure-openai-responses", models: [{ id: "gpt-4.1" }] } } };
	const result = await manager.saveModelsConfig(data);
	assert.equal(result.valid, true);
	const written = JSON.parse(lastWrittenJson);
	assert.equal(written.providers.azure.api, "azure-openai-responses");
});

test("保存保留无枚举来源的协议 google-vertex / bedrock-converse-stream / pi-messages", async () => {
	for (const api of ["google-vertex", "bedrock-converse-stream", "pi-messages"]) {
		lastWrittenJson = null;
		const data = { providers: { custom: { baseUrl: "https://example.com/v1", api, models: [{ id: "m1" }] } } };
		const result = await manager.saveModelsConfig(data);
		assert.equal(result.valid, true, `${api} 应通过校验`);
		assert.equal(JSON.parse(lastWrittenJson).providers.custom.api, api, `${api} 必须原样写回`);
	}
});

test("保存保留未知自定义 api（第三方扩展可注册任意 id，不篡改）", async () => {
	lastWrittenJson = null;
	const data = { providers: { ext: { baseUrl: "https://example.com/v1", api: "my-extension-api", models: [{ id: "m1" }] } } };
	const result = await manager.saveModelsConfig(data);
	assert.equal(result.valid, true);
	assert.equal(JSON.parse(lastWrittenJson).providers.ext.api, "my-extension-api");
});

test("保存仍归一已知历史别名（anthropic / openai-chat-completions）", async () => {
	lastWrittenJson = null;
	const data = {
		providers: {
			a: { baseUrl: "https://a.example.com", api: "anthropic", models: [{ id: "m1" }] },
			b: { baseUrl: "https://b.example.com", api: "openai-chat-completions", models: [{ id: "m2" }] },
		},
	};
	const result = await manager.saveModelsConfig(data);
	assert.equal(result.valid, true);
	const written = JSON.parse(lastWrittenJson);
	assert.equal(written.providers.a.api, "anthropic-messages");
	assert.equal(written.providers.b.api, "openai-completions");
});

test("保存不发明 provider api 默认值：缺省或空白时删键（交给 pi 继承模型级 api）", async () => {
	lastWrittenJson = null;
	const data = {
		providers: {
			blank: { baseUrl: "https://example.com/v1", api: "   ", models: [{ id: "m1", api: "openai-completions" }] },
			missing: { baseUrl: "https://example.com/v1", models: [{ id: "m2", api: "anthropic-messages" }] },
		},
	};
	const result = await manager.saveModelsConfig(data);
	assert.equal(result.valid, true);
	const written = JSON.parse(lastWrittenJson);
	assert.equal(Object.hasOwn(written.providers.blank, "api"), false, "空白 api 不应被写成 openai-completions");
	assert.equal(Object.hasOwn(written.providers.missing, "api"), false, "原本缺省的 api 不应被补写");
	assert.equal(written.providers.blank.models[0].api, "openai-completions");
	assert.equal(written.providers.missing.models[0].api, "anthropic-messages");
});

test("保存不发明模型级 api：未写 api 时不补键（继承 provider 协议）", async () => {
	lastWrittenJson = null;
	const data = { providers: { p: { baseUrl: "https://example.com/v1", api: "openai-completions", models: [{ id: "m1" }, { id: "m2", api: "" }] } } };
	const result = await manager.saveModelsConfig(data);
	assert.equal(result.valid, true);
	const written = JSON.parse(lastWrittenJson);
	assert.equal(Object.hasOwn(written.providers.p.models[0], "api"), false, "模型未写 api → 不应补写");
	assert.equal(Object.hasOwn(written.providers.p.models[1], "api"), false, "模型 api 为空 → 删键而非补默认值");
	assert.equal(written.providers.p.api, "openai-completions");
});

// ── 网络探测路径仍可兜底 ────────────────────────────────
// 保存与「拉取模型列表」必须是两条规则：探测遇到未知协议时用最通用的
// openai-completions 形状试探是合理的，这里锁定该行为不被本修复误伤。

test("拉取模型列表路径对未知 api 仍兜底 openai-completions（与保存路径分开）", () => {
	// 两条规则必须分开：探测遇到未知协议用最通用的 openai-completions 形状试探是合理的，
	// 保存则必须原样保留（上面的保存用例已锁定）。这里直接断言探测归一化的行为。
	assert.equal(manager.normalizeApiType("my-extension-api"), "openai-completions");
	// 已内建的六项直接透传，不被改动
	for (const known of ["openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages", "google-generative-ai", "mistral-conversations"]) {
		assert.equal(manager.normalizeApiType(known), known);
	}
	// 历史别名仍在探测路径归一（保持既有行为）
	assert.equal(manager.normalizeApiType("anthropic"), "anthropic-messages");
	assert.equal(manager.normalizeApiType("openai-chat-completions"), "openai-completions");
});

// ── 无通用 /models 端点的协议：给出可操作提示，不发注定失败的请求 ────
//
// azure-openai-responses / google-vertex / bedrock-converse-stream / pi-messages
// 都是 pi 合法聊天协议，但它们的 baseUrl 不是 OpenAI 兼容根（Bedrock 是
// bedrock-runtime.<region>.amazonaws.com）。若照旧用 openai-completions 形状发
// /v1/models，用户看到的是 404/TLS 误导报错，而正确动作是手填模型 ID。

test("无列表端点的协议：不发请求，直接返回「请手填模型 ID」提示", async () => {
	for (const api of ["azure-openai-responses", "google-vertex", "bedrock-converse-stream", "pi-messages"]) {
		let fetched = false;
		const isolated = recompileWithFetchProbe(() => {
			fetched = true;
		});
		const result = await new isolated.ConfigManager(undefined, (key, params) => ({ key, params })).fetchProviderModels("https://example.invalid/v1", "sk-test", api);
		assert.equal(result.success, false, `${api} 应返回失败而不是拿错误形状去试探`);
		assert.equal(fetched, false, `${api} 不应发出任何 HTTP 请求`);
		assert.equal(result.error.key, "mainConfig.fetchModelsUnsupportedApi");
		assert.equal(result.error.params.api, api);
	}
});

test("可探测协议不受影响：开方 / Anthropic / Google 仍正常发请求", async () => {
	const requested = [];
	const isolated = recompileWithFetchProbe((url) => requested.push(url));
	const mgr = new isolated.ConfigManager(undefined, (key) => key);
	for (const api of ["openai-completions", "anthropic-messages", "google-generative-ai"]) {
		requested.length = 0;
		const result = await mgr.fetchProviderModels("https://example.invalid/v1", "sk-test", api);
		assert.equal(result.success, true, `${api} 应能正常拉取`);
		assert.ok(requested.length > 0, `${api} 应发出请求`);
	}
});
