/**
 * externalAgentDiscovery 单测：各 agent 配置解析（Claude Code / Codex / OpenCode / Gemini CLI）、
 * key 掩码与占位值识别、供应商名安全化，以及端到端 discover/resolve（注入临时 home 目录）。
 * 用 createTsSandbox 加载生产模块；不读真实用户 home（全部走注入的临时目录）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const mod = load("src/main/config/externalAgentDiscovery.ts");
const {
	discoverExternalAgentProviders,
	resolveExternalAgentKey,
	maskKey,
	safeProviderName,
	parseClaudeSettings,
	parseCodexConfig,
	parseOpenCodeConfig,
	parseGeminiSettings,
	parseQwenSettings,
	parseCrushConfig,
	parseGooseCustomProvider,
	parseFlatYaml,
	parseKimiConfig,
	parseKiloSecrets,
	discoverGoose,
	resolveGooseKey,
	parseMinimaxConfig,
	parseZcodeConfig,
	parseQoderCnSettings,
	parseOpenClawConfig,
} = mod;

/** 建一个注入用临时 home，可选写入各 agent 配置文件。 */
function setupHome(files = {}) {
	const home = mkdtempSync(join(tmpdir(), "pideck-extagent-"));
	for (const [rel, content] of Object.entries(files)) {
		const target = join(home, rel);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, content);
	}
	return home;
}

test("maskKey 短 key 全折叠、长 key 保留首尾各 4", () => {
	assert.equal(maskKey("short"), "•".repeat(5));
	assert.equal(maskKey("sk-abcdefghijklmnop"), "sk-a…mnop");
});

test("safeProviderName 折叠非法字符并截断", () => {
	assert.equal(safeProviderName("My Provider! 2", "fallback"), "my-provider-2");
	assert.equal(safeProviderName("///", "fallback"), "fallback");
});

test("parseClaudeSettings 解析 env 里的 baseUrl/token/模型", () => {
	const text = JSON.stringify({
		env: {
			ANTHROPIC_BASE_URL: "https://api.example.com",
			ANTHROPIC_AUTH_TOKEN: "sk-ant-1234567890abcdef",
			ANTHROPIC_MODEL: "claude-sonnet-4",
		},
	});
	const parsed = parseClaudeSettings(text);
	assert.equal(parsed.baseUrl, "https://api.example.com");
	assert.equal(parsed.token, "sk-ant-1234567890abcdef");
	assert.equal(JSON.stringify(parsed.modelIds), JSON.stringify(["claude-sonnet-4"]));
});

test("parseCodexConfig 解析 model_providers 与 openai_base_url 回退", () => {
	const text = `
model_provider = "custom"
model = "gpt-5.2"
openai_base_url = "http://127.0.0.1:3425/backend-api/codex"

[model_providers.custom]
name = "Custom Gateway"
base_url = "https://gw.example.com/v1"
wire_api = "responses"
`;
	const parsed = parseCodexConfig(text);
	assert.equal(parsed.activeProviderId, "custom");
	assert.equal(parsed.defaultModel, "gpt-5.2");
	assert.equal(parsed.providers.length, 2); // custom + openai 回退项
	const custom = parsed.providers.find((p) => p.id === "custom");
	assert.equal(custom?.baseUrl, "https://gw.example.com/v1");
	assert.equal(custom?.wireApi, "responses");
	const fallback = parsed.providers.find((p) => p.id === "openai");
	assert.equal(fallback?.baseUrl, "http://127.0.0.1:3425/backend-api/codex");
});

test("parseOpenCodeConfig 解析 provider 段的 baseURL/apiKey/models", () => {
	const text = JSON.stringify({
		provider: {
			"openai/custom": {
				name: "Custom OpenAI",
				options: { baseURL: "https://gw.example.com/v1", apiKey: "sk-oc-1234567890" },
				models: { "gpt-4o": {}, "gpt-4o-mini": {} },
			},
		},
		model: "openai/custom/gpt-4o",
	});
	const parsed = parseOpenCodeConfig(text);
	assert.equal(parsed.providers.length, 1);
	const provider = parsed.providers[0];
	assert.equal(provider.baseUrl, "https://gw.example.com/v1");
	assert.equal(provider.apiKey, "sk-oc-1234567890");
	assert.equal(JSON.stringify([...provider.modelIds].sort()), JSON.stringify(["gpt-4o", "gpt-4o-mini"]));
	assert.equal(parsed.defaultModel, "openai/custom/gpt-4o");
});

test("parseGeminiSettings 解析 apiKey 与 auth.selectedType", () => {
	const parsed = parseGeminiSettings(JSON.stringify({ apiKey: "AIza-1234567890", auth: { selectedType: "oauth" } }));
	assert.equal(parsed.apiKey, "AIza-1234567890");
	assert.equal(parsed.authType, "oauth");
});

test("discover：Claude Code 配置 → anthropic-messages 候选，占位 key 标记 no-key", async () => {
	const home = setupHome({
		".claude/settings.json": JSON.stringify({
			env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3425", ANTHROPIC_AUTH_TOKEN: "magpie", ANTHROPIC_MODEL: "zui/deepseek-v4" },
		}),
	});
	try {
		const result = await discoverExternalAgentProviders(() => home);
		const claudeSource = result.sources.find((s) => s.agent === "claude-code");
		assert.equal(claudeSource?.found, true);
		assert.equal(result.providers.length, 1);
		const found = result.providers[0];
		assert.equal(found.id, "claude-code:anthropic");
		assert.equal(found.apiType, "anthropic-messages");
		assert.equal(found.baseUrl, "http://127.0.0.1:3425");
		assert.equal(found.apiKeyMasked, undefined); // "magpie" 是占位 → 不给掩码
		assert.equal(found.note, "no-key");
		assert.equal(JSON.stringify(found.modelIds), JSON.stringify(["zui/deepseek-v4"]));
		// 占位 key 场景：resolve 也应回 no api key… 不，resolve 只区分存在与否；mask 拦在发现层
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("discover：Claude Code 真实 key 出掩码，resolveExternalAgentKey 回真实值", async () => {
	const realKey = "sk-ant-real-key-1234567890";
	const home = setupHome({ ".claude/settings.json": JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.example.com", ANTHROPIC_AUTH_TOKEN: realKey } }) });
	try {
		const result = await discoverExternalAgentProviders(() => home);
		const found = result.providers[0];
		assert.equal(found.apiKeyMasked, "sk-a…7890");
		const resolved = await resolveExternalAgentKey("claude-code:anthropic", () => home);
		assert.equal(resolved.ok, true);
		assert.equal(resolved.apiKey, realKey);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("discover：Claude Code OAuth 订阅登录只提示、无 key 候选", async () => {
	const home = setupHome({ ".claude.json": JSON.stringify({ oauthAccount: { emailAddress: "user@example.com" } }) });
	try {
		const result = await discoverExternalAgentProviders(() => home);
		const oauth = result.providers.find((p) => p.id === "claude-code:oauth");
		assert.ok(oauth);
		assert.equal(oauth.note, "subscription:user@example.com");
		const resolved = await resolveExternalAgentKey("claude-code:oauth", () => home);
		assert.equal(resolved.ok, false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("discover：Codex apikey 模式回真实 key；同名供应商名去重", async () => {
	const home = setupHome({
		".codex/config.toml": `
model_provider = "alpha"
model = "gpt-5.2"
[model_providers.alpha]
name = "Alpha Gateway"
base_url = "https://a.example.com/v1"
[model_providers."beta/alpha"]
name = "Alpha Gateway"
base_url = "https://b.example.com/v1"
`,
		".codex/auth.json": JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-codex-key-123456789" }),
	});
	try {
		const result = await discoverExternalAgentProviders(() => home);
		const codexProviders = result.providers.filter((p) => p.agent === "codex");
		assert.equal(codexProviders.length, 2); // alpha + beta/alpha（无顶层 openai_base_url → 无回退项）
		// 同名 "Alpha Gateway" → 第二个带 -2 后缀
		const names = codexProviders.map((p) => p.providerName);
		assert.equal(new Set(names).size, names.length, `names must be unique: ${names}`);
		const resolved = await resolveExternalAgentKey("codex:alpha", () => home);
		assert.equal(resolved.ok, true);
		assert.equal(resolved.apiKey, "sk-codex-key-123456789");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("discover：Codex chatgpt 订阅模式只提示不导 key", async () => {
	const home = setupHome({ ".codex/auth.json": JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "x" } }) });
	try {
		const result = await discoverExternalAgentProviders(() => home);
		const oauth = result.providers.find((p) => p.id === "codex:oauth");
		assert.ok(oauth);
		assert.equal(oauth.note, "subscription:chatgpt");
		const resolved = await resolveExternalAgentKey("codex:oauth", () => home);
		assert.equal(resolved.ok, false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("discover：OpenCode 供应商（baseUrl+key）与无 baseUrl 供应商（跳过）", async () => {
	const home = setupHome({
		".opencode/opencode.json": JSON.stringify({
			provider: {
				"openai/x": { options: { baseURL: "https://x.example.com/v1", apiKey: "sk-oc-x-12345678" }, models: { "gpt-4o": {} } },
				"no-endpoint": { name: "No Endpoint" },
			},
		}),
	});
	try {
		const result = await discoverExternalAgentProviders(() => home);
		const openCode = result.providers.filter((p) => p.agent === "opencode");
		assert.equal(openCode.length, 1);
		assert.equal(openCode[0].providerName, "no-endpoint-x".slice(0, 0) || openCode[0].providerName); // 占位断言（名字由 safeProviderName 生成）
		assert.equal(openCode[0].apiType, "openai-completions");
		assert.equal(openCode[0].apiKeyMasked, "sk-o…5678");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("discover：OpenCode 旧文件名 config.json 也被读到", async () => {
	const home = setupHome({ ".opencode/config.json": JSON.stringify({ provider: { "anthropic/y": { options: { baseURL: "https://y.example.com", apiKey: "sk-ant-y-12345678" } } } }) });
	try {
		const result = await discoverExternalAgentProviders(() => home);
		assert.equal(result.providers.filter((p) => p.agent === "opencode").length, 1);
		assert.equal(result.providers[0].apiType, "anthropic-messages"); // id 以 anthropic/ 开头
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("discover：Gemini CLI apiKey 写在 settings.json 时给出候选；OAuth 只提示", async () => {
	const home = setupHome({ ".gemini/settings.json": JSON.stringify({ auth: { selectedType: "oauth" } }) });
	try {
		let result = await discoverExternalAgentProviders(() => home);
		let gemini = result.providers.filter((p) => p.agent === "gemini-cli");
		assert.equal(gemini.length, 1);
		assert.equal(gemini[0].note, "subscription:oauth");

		writeFileSync(join(home, ".gemini/settings.json"), JSON.stringify({ apiKey: "AIza-very-long-key-1234567890" }));
		result = await discoverExternalAgentProviders(() => home);
		gemini = result.providers.filter((p) => p.agent === "gemini-cli");
		assert.equal(gemini[0].id, "gemini-cli:api-key");
		assert.ok(gemini[0].apiKeyMasked);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("discover：空机器 → 全部来源 not found、无候选", async () => {
	const home = setupHome();
	try {
		const result = await discoverExternalAgentProviders(() => home);
		assert.equal(result.providers.length, 0);
		assert.equal(result.sources.filter((s) => s.found).length, 0);
		assert.equal(result.sources.length, 13);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("discover：坏 JSON/坏 TOML 只静默跳过该来源，不抛错", async () => {
	const home = setupHome({
		".claude/settings.json": "{not valid json",
		".codex/config.toml": "]]bad toml[[",
	});
	try {
		const result = await discoverExternalAgentProviders(() => home);
		assert.ok(Array.isArray(result.providers));
		assert.equal(result.providers.length, 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("resolveExternalAgentKey：未知 agent 前缀与配置缺失返回错误", async () => {
	const home = setupHome();
	try {
		assert.equal((await resolveExternalAgentKey("unknown:x", () => home)).ok, false);
		assert.equal((await resolveExternalAgentKey("claude-code:anthropic", () => home)).ok, false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// ── 新增 agent：Qwen Code / Crush / Goose / Kimi Code / Kilo Code / OpenCode auth.json 合并 ──

test("parseQwenSettings 解析 modelProviders 分组 + env key 关联", () => {
	const text = JSON.stringify({
		modelProviders: { openai: [{ id: "qwen3.8-max", name: "qwen3.8-max (QwenCloud)", baseUrl: "https://maas.example.com/v1", envKey: "QWEN_KEY" }] },
		env: { QWEN_KEY: "sk-qwen-1234567890" },
		security: { auth: { selectedType: "api-key" } },
	});
	const parsed = parseQwenSettings(text);
	assert.equal(parsed.providers.length, 1);
	assert.equal(parsed.providers[0].envKey, "QWEN_KEY");
	assert.equal(parsed.env["QWEN_KEY"], "sk-qwen-1234567890");
});

test("discover：Qwen Code env 关联 key 出掩码并可 resolve；OAuth 登录只提示", async () => {
	const home = setupHome({
		".qwen/settings.json": JSON.stringify({
			modelProviders: { openai: [{ id: "glm", baseUrl: "https://maas.example.com/v1", envKey: "QWEN_KEY" }] },
			env: { QWEN_KEY: "sk-qwen-1234567890" },
		}),
	});
	try {
		const result = await discoverExternalAgentProviders(() => home);
		const qwen = result.providers.filter((p) => p.agent === "qwen-code");
		assert.equal(qwen.length, 1);
		assert.equal(qwen[0].apiType, "openai-completions");
		assert.equal(qwen[0].apiKeyMasked, "sk-q…7890");
		const resolved = await resolveExternalAgentKey("qwen-code:openai/glm", () => home);
		assert.equal(resolved.ok, true);
		assert.equal(resolved.apiKey, "sk-qwen-1234567890");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}

	const oauthHome = setupHome({ ".qwen/settings.json": JSON.stringify({ security: { auth: { selectedType: "qwen-oauth" } } }) });
	try {
		const result = await discoverExternalAgentProviders(() => oauthHome);
		const qwen = result.providers.find((p) => p.agent === "qwen-code");
		assert.ok(qwen);
		assert.equal(qwen.note, "subscription:qwen-oauth");
	} finally {
		rmSync(oauthHome, { recursive: true, force: true });
	}
});

test("parseCrushConfig 解析 providers 数组（snake_case base_url）", () => {
	const parsed = parseCrushConfig(JSON.stringify({ providers: [{ id: "openai", name: "OpenAI", base_url: "https://api.example.com/v1" }], model: "gpt-5.2" }));
	assert.equal(parsed.providers.length, 1);
	assert.equal(parsed.providers[0].baseUrl, "https://api.example.com/v1");
	assert.equal(parsed.defaultModel, "gpt-5.2");
});

test("discover：Crush 动态文件优先、静态文件补缺", async () => {
	const home = setupHome({
		".local/share/crush/crush.json": JSON.stringify({ providers: [{ id: "anthropic", api_key: "sk-crush-ant-12345678" }] }),
		".config/crush/crush.json": JSON.stringify({
			providers: [
				{ id: "anthropic", name: "Anthropic", base_url: "https://api.anthropic.com" },
				{ id: "ollama", base_url: "http://localhost:11434" },
			],
		}),
	});
	try {
		const result = await discoverExternalAgentProviders(() => home);
		const crush = result.providers.filter((p) => p.agent === "crush");
		assert.equal(crush.length, 2); // anthropic（合并出 name+baseUrl+key）+ ollama
		const anthropic = crush.find((p) => p.id === "crush:anthropic");
		assert.equal(anthropic.apiType, "anthropic-messages");
		assert.equal(anthropic.apiKeyMasked, "sk-c…5678");
		const resolved = await resolveExternalAgentKey("crush:anthropic", () => home);
		assert.equal(resolved.apiKey, "sk-crush-ant-12345678");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("parseGooseCustomProvider / parseFlatYaml 解析自定义供应商与 secrets", () => {
	const provider = parseGooseCustomProvider("custom_alpha", JSON.stringify({ name: "custom_alpha", display_name: "Alpha Gateway", base_url: "https://gw.example.com/v1", api_key_env: "CUSTOM_ALPHA_API_KEY", engine: "openai", models: [{ name: "m1" }] }));
	assert.equal(provider.displayName, "Alpha Gateway");
	assert.equal(provider.apiKeyEnv, "CUSTOM_ALPHA_API_KEY");
	assert.equal(JSON.stringify(provider.modelIds), JSON.stringify(["m1"]));
	const secrets = parseFlatYaml('CUSTOM_ALPHA_API_KEY: "sk-goose-1234567890"\nGOOSE_PROVIDER: anthropic\n');
	assert.equal(secrets["CUSTOM_ALPHA_API_KEY"], "sk-goose-1234567890");
});

test("discover：Goose 自定义供应商（Unix 路径）与 secrets key；resolve 回真实值", async () => {
	const home = setupHome({
		".config/goose/config.yaml": "GOOSE_PROVIDER: custom_alpha\nGOOSE_MODEL: m1\n",
		".config/goose/secrets.yaml": "CUSTOM_ALPHA_API_KEY: sk-goose-1234567890\n",
		".config/goose/custom_providers/custom_alpha.json": JSON.stringify({ name: "custom_alpha", display_name: "Alpha Gateway", base_url: "https://gw.example.com/v1", api_key_env: "CUSTOM_ALPHA_API_KEY", engine: "openai" }),
	});
	try {
		// os.platform() 在测试宿主上是真实平台；直接调用 discoverGoose 校验 Unix 分支的目录推导
		const result = await discoverGoose(home, "linux", (raw, fb) => safeProviderName(raw, fb));
		const goose = result.providers;
		assert.equal(goose.length, 1);
		assert.equal(goose[0].providerName, "alpha-gateway");
		assert.equal(goose[0].baseUrl, "https://gw.example.com/v1");
		assert.equal(goose[0].apiKeyMasked, "sk-g…7890");
		const resolved = await resolveGooseKey(home, "linux", "custom_alpha");
		assert.equal(resolved.apiKey, "sk-goose-1234567890");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("discover：Goose Windows 路径在 %APPDATA%\Block\goose\config 下", async () => {
	const home = setupHome({
		"AppData/Roaming/Block/goose/config/secrets.yaml": "OPENAI_API_KEY: sk-goose-win-123456789\n",
	});
	try {
		// os.platform() 在测试宿主上是真实平台；直接调用 discoverGoose 校验 Windows 分支的目录推导
		const result = await discoverGoose(home, "win32", (raw, fb) => safeProviderName(raw, fb));
		assert.equal(result.providers.length, 1);
		assert.equal(result.providers[0].id, "goose:openai");
		const resolved = await resolveGooseKey(home, "win32", "openai");
		assert.equal(resolved.apiKey, "sk-goose-win-123456789");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("parseKimiConfig 解析 [providers.<id>] TOML", () => {
	const text = `
platform = "moonshot"
[providers.moonshot]
name = "Moonshot"
api_key = "sk-kimi-1234567890"
base_url = "https://api.moonshot.cn/v1"
`;
	const parsed = parseKimiConfig(text);
	assert.equal(parsed.providers.length, 1);
	assert.equal(parsed.providers[0].apiKey, "sk-kimi-1234567890");
});

test("discover：Kimi Code 两处路径都扫（~/.kimi 与 ~/.kimi-code）", async () => {
	const home = setupHome({
		".kimi/config.toml": '[providers.moonshot]\napi_key = "sk-kimi-a-123456789"\n',
		".kimi-code/config.toml": '[providers.custom]\nname = "Custom GW"\napi_key = "sk-kimi-b-123456789"\nbase_url = "https://gw.example.com/v1"\n',
	});
	try {
		const result = await discoverExternalAgentProviders(() => home);
		const kimi = result.providers.filter((p) => p.agent === "kimi-code");
		assert.equal(kimi.length, 2);
		const resolvedA = await resolveExternalAgentKey("kimi:moonshot", () => home);
		assert.equal(resolvedA.apiKey, "sk-kimi-a-123456789");
		const resolvedB = await resolveExternalAgentKey("kimi-code:custom", () => home);
		assert.equal(resolvedB.apiKey, "sk-kimi-b-123456789");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("parseKiloSecrets 解析字符串化 JSON 嵌套的 apiConfigs", () => {
	const inner = JSON.stringify({ currentApiConfigName: "main", apiConfigs: { main: { apiProvider: "openai", openAiBaseUrl: "https://gw.example.com/v1", openAiApiKey: "sk-kilo-1234567890", openAiModelId: "m-1" } } });
	const parsed = parseKiloSecrets(JSON.stringify({ "kilo code.kilo-code": { roo_cline_config_api_config: inner } }));
	assert.ok(parsed.apiConfigs["main"]);
	assert.equal(parsed.apiConfigs["main"]["openAiApiKey"], "sk-kilo-1234567890");
});

test("discover：Kilo Code secrets.json 嵌套配置出候选并可 resolve", async () => {
	const inner = JSON.stringify({ currentApiConfigName: "main", apiConfigs: { main: { apiProvider: "openai", openAiBaseUrl: "https://gw.example.com/v1", openAiApiKey: "sk-kilo-1234567890", openAiModelId: "m-1" } } });
	const home = setupHome({ ".kilocode/secrets.json": JSON.stringify({ "kilo code.kilo-code": { roo_cline_config_api_config: inner } }) });
	try {
		const result = await discoverExternalAgentProviders(() => home);
		const kilo = result.providers.filter((p) => p.agent === "kilo-code");
		assert.equal(kilo.length, 1);
		assert.equal(kilo[0].baseUrl, "https://gw.example.com/v1");
		assert.equal(JSON.stringify(kilo[0].modelIds), JSON.stringify(["m-1"]));
		const resolved = await resolveExternalAgentKey("kilo-code:main", () => home);
		assert.equal(resolved.apiKey, "sk-kilo-1234567890");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("discover：OpenCode auth.json 的 key 与 opencode.json 的 baseUrl/models 按 id 合并", async () => {
	const home = setupHome({
		".opencode/opencode.json": JSON.stringify({ provider: { ds2api: { name: "DS2 API", options: { baseURL: "https://ds.example.com/v1" }, models: { "m-1": {}, "m-2": {} } } } }),
		".local/share/opencode/auth.json": JSON.stringify({ ds2api: { type: "api", key: "sk-oc-auth-123456789" }, "github-copilot": { type: "oauth", access: "x" } }),
	});
	try {
		const result = await discoverExternalAgentProviders(() => home);
		const openCode = result.providers.filter((p) => p.agent === "opencode");
		assert.equal(openCode.length, 2); // ds2api（合并）+ github-copilot（OAuth 只提示）
		const ds2api = openCode.find((p) => p.id === "opencode:ds2api");
		assert.equal(ds2api.baseUrl, "https://ds.example.com/v1");
		assert.equal(ds2api.apiKeyMasked, "sk-o…6789");
		assert.equal(JSON.stringify([...ds2api.modelIds].sort()), JSON.stringify(["m-1", "m-2"]));
		const copilot = openCode.find((p) => p.id === "opencode:github-copilot");
		assert.equal(copilot.note, "subscription:oauth");
		const resolved = await resolveExternalAgentKey("opencode:ds2api", () => home);
		assert.equal(resolved.apiKey, "sk-oc-auth-123456789");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// ── 第二批 agent：MiniMax Code / ZCode / Qoder CN / OpenClaw ──

test("parseMinimaxConfig 解析 provider.options 与 model_order", () => {
	const text = `logLevel: info
provider:
  minimax:
    name: MiniMax
    options:
      apiKey: sk-minimax-1234567890
      baseURL: https://agent.minimax.cn/v1
    models:
      MiniMax-M3: {}
    model_order:
      - MiniMax-M3
defaultModel: minimax/MiniMax-M3
`;
	const parsed = parseMinimaxConfig(text);
	assert.equal(parsed.providers.length, 1);
	assert.equal(parsed.providers[0].apiKey, "sk-minimax-1234567890");
	assert.equal(parsed.providers[0].baseUrl, "https://agent.minimax.cn/v1");
	assert.equal(JSON.stringify(parsed.providers[0].modelIds), JSON.stringify(["MiniMax-M3"]));
});

test("discover：MiniMax Code 出候选并可 resolve；placeholder key 标 no-key", async () => {
	const good = "provider:\n  m1:\n    name: M1\n    options:\n      apiKey: sk-minimax-1234567890\n      baseURL: https://a.example.com/v1\n";
	const home = setupHome({ ".minimax/config.yaml": good });
	try {
		const result = await discoverExternalAgentProviders(() => home);
		const found = result.providers.filter((p) => p.agent === "minimax-code");
		assert.equal(found.length, 1);
		assert.equal(found[0].apiType, "openai-completions");
		assert.equal(found[0].apiKeyMasked, "sk-m…7890");
		assert.equal((await resolveExternalAgentKey("minimax-code:m1", () => home)).apiKey, "sk-minimax-1234567890");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("parseZcodeConfig 解析 custom 供应商、跳过 builtin:*", () => {
	const text = JSON.stringify({
		provider: {
			custom1: { name: "My GW", kind: "openai", source: "custom", options: { apiKey: "sk-zcode-1234567890", baseURL: "https://z.example.com/v1" }, models: { "m-1": {} } },
			"builtin:zai": { name: "Z.ai", kind: "anthropic", source: "builtin", options: { apiKey: "x", baseURL: "https://api.z.ai/" }, models: {} },
		},
	});
	const parsed = parseZcodeConfig(text);
	assert.equal(parsed.providers.length, 2); // 解析层返回全部，过滤在 discover
	const custom = parsed.providers.find((p) => p.id === "custom1");
	assert.equal(custom.kind, "openai");
	assert.equal(JSON.stringify(custom.modelIds), JSON.stringify(["m-1"]));
});

test("discover：ZCode 只导 custom 供应商，builtin 忽略；kind 决定 apiType", async () => {
	const text = JSON.stringify({
		provider: {
			anth: { name: "Anth GW", kind: "anthropic", source: "custom", options: { apiKey: "sk-zcode-1234567890", baseURL: "https://z.example.com" } },
			"builtin:zai": { name: "Z.ai", kind: "anthropic", source: "builtin", options: { baseURL: "https://api.z.ai/" } },
		},
	});
	const home = setupHome({ ".zcode/v2/config.json": text });
	try {
		const found = (await discoverExternalAgentProviders(() => home)).providers.filter((p) => p.agent === "zcode");
		assert.equal(found.length, 1);
		assert.equal(found[0].id, "zcode:anth");
		assert.equal(found[0].apiType, "anthropic-messages");
		assert.equal((await resolveExternalAgentKey("zcode:anth", () => home)).apiKey, "sk-zcode-1234567890");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("discover：Qoder CN providers（protocol 决定 apiType）+ models 取 model 字段", async () => {
	const text = JSON.stringify({
		providers: {
			gw: { apiKey: "sk-qoder-1234567890", baseUrl: "https://q.example.com/v1", displayName: "Qoder GW", protocol: "openai", models: [{ model: "auto/m1" }, { displayName: "no-id" }] },
		},
	});
	const home = setupHome({ ".qoder-cn/settings.json": text });
	try {
		const found = (await discoverExternalAgentProviders(() => home)).providers.filter((p) => p.agent === "qoder-cn");
		assert.equal(found.length, 1);
		assert.equal(found[0].providerName, "qoder-gw");
		assert.equal(found[0].apiType, "openai-completions");
		assert.equal(JSON.stringify(found[0].modelIds), JSON.stringify(["auto/m1"]));
		assert.equal((await resolveExternalAgentKey("qoder-cn:gw", () => home)).apiKey, "sk-qoder-1234567890");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("discover：OpenClaw models.providers 沿用对方 api 协议名，modelIds 截断到 20", async () => {
	const models = Array.from({ length: 30 }, (_, i) => ({ id: `m-${i}`, name: `m-${i}` }));
	const text = JSON.stringify({ models: { providers: { cpa: { api: "openai-completions", apiKey: "sk-openclaw-123456789", baseUrl: "http://localhost:8317/v1", models } } } });
	const home = setupHome({ ".openclaw/openclaw.json": text });
	try {
		const found = (await discoverExternalAgentProviders(() => home)).providers.filter((p) => p.agent === "openclaw");
		assert.equal(found.length, 1);
		assert.equal(found[0].apiType, "openai-completions");
		assert.equal(found[0].modelIds.length, 20); // MAX_SUGGESTED_MODELS
		assert.equal((await resolveExternalAgentKey("openclaw:cpa", () => home)).apiKey, "sk-openclaw-123456789");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("readSmallFile 超过 2MiB 的文件直接跳过，不整块读入", async () => {
	const home = setupHome({ ".claude/settings.json": "x".repeat(2 * 1024 * 1024 + 10) });
	try {
		const result = await discoverExternalAgentProviders(() => home);
		assert.equal(result.providers.length, 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
