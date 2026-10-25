import assert from "node:assert/strict";
import test from "node:test";
import { extractVersionedBaseFromRequestUrl, hasApiVersionPath, needsSessionBaseUrlVersionHint, stripOpenAiVersionPath, suggestNormalizedBaseUrl } from "../src/main/config/baseUrlPath.ts";

test("hasApiVersionPath detects /v1 /v1beta /api", () => {
	assert.equal(hasApiVersionPath("https://api.openai.com/v1"), true);
	assert.equal(hasApiVersionPath("https://api.openai.com/v1/"), true);
	assert.equal(hasApiVersionPath("https://generativelanguage.googleapis.com/v1beta"), true);
	assert.equal(hasApiVersionPath("http://localhost:11434/api"), true);
	assert.equal(hasApiVersionPath("https://proxy.example.com"), false);
	assert.equal(hasApiVersionPath("https://proxy.example.com/openai"), false);
});

test("extractVersionedBaseFromRequestUrl strips endpoint suffix", () => {
	assert.equal(extractVersionedBaseFromRequestUrl("https://api.openai.com/v1/chat/completions"), "https://api.openai.com/v1");
	assert.equal(extractVersionedBaseFromRequestUrl("https://host.example/proxy/v1/models"), "https://host.example/proxy/v1");
	assert.equal(extractVersionedBaseFromRequestUrl("https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent?key=x"), "https://generativelanguage.googleapis.com/v1beta");
	assert.equal(extractVersionedBaseFromRequestUrl("https://host.example/models"), null);
});

test("only rewrite when versioned path actually worked", () => {
	// 根路径 /models 成功 → 不改写
	assert.equal(needsSessionBaseUrlVersionHint("https://proxy.example.com", "https://proxy.example.com/models"), false);
	assert.equal(suggestNormalizedBaseUrl("https://proxy.example.com", "https://proxy.example.com/models"), null);

	// /v1 成功 → 自动补 /v1
	assert.equal(needsSessionBaseUrlVersionHint("https://proxy.example.com", "https://proxy.example.com/v1/chat/completions"), true);
	assert.equal(suggestNormalizedBaseUrl("https://proxy.example.com", "https://proxy.example.com/v1/chat/completions"), "https://proxy.example.com/v1");

	// 已有 /v1 → 不改
	assert.equal(suggestNormalizedBaseUrl("https://proxy.example.com/v1", "https://proxy.example.com/v1/models"), null);
});

test("google root base suggests v1beta when request used it", () => {
	assert.equal(suggestNormalizedBaseUrl("https://generativelanguage.googleapis.com", "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent", "google-generative-ai"), "https://generativelanguage.googleapis.com/v1beta");
});

test("会话侧自拼版本段的协议不改写 baseUrl（issue #337：Anthropic 会话全 404）", () => {
	// 真根因：探测对任何协议都用 OpenAI 形状先试探（anthropic 的实际请求固定是
	// `<base>/v1/models`，见 ConfigManager.buildModelsRequest），走通 /v1 不代表会话端点也要
	// /v1 —— Anthropic SDK 自己拼 `/v1/messages`，补上就变成 `.../v1/v1/messages`。
	const root = "https://gateway.example/anthropic";
	const probeUrl = "https://gateway.example/anthropic/v1/models";
	assert.equal(needsSessionBaseUrlVersionHint(root, probeUrl, "anthropic-messages"), false);
	assert.equal(suggestNormalizedBaseUrl(root, probeUrl, "anthropic-messages"), null);

	// 其余自拼版本段/路径的协议同样保持用户填写值：mistral 拼 `v1/chat/completions`
	//（registry baseUrl 就是 https://api.mistral.ai）、codex 拼 `/codex/responses`、pi 直接 `/messages`
	for (const api of ["mistral-conversations", "openai-codex-responses", "pi-messages"]) {
		assert.equal(needsSessionBaseUrlVersionHint(root, probeUrl, api), false, api);
		assert.equal(suggestNormalizedBaseUrl(root, probeUrl, api), null, api);
	}

	// 未知/自定义 api id：语义不可判断时不改用户配置；api 大小写不敏感
	assert.equal(suggestNormalizedBaseUrl(root, probeUrl, "my-custom-gateway"), null);
	assert.equal(suggestNormalizedBaseUrl(root, probeUrl, "Anthropic-Messages"), null);
});

test("需要版本段的协议（含未声明 api）仍照旧补版本路径", () => {
	const root = "https://proxy.example.com";
	const probeUrl = "https://proxy.example.com/v1/models";
	// 未声明 api（表单 api 还是空时的兜底）与 openai 系都补 /v1：探测侧 normalizeApiType、
	// pi 对未声明 api 的自定义 provider 都同样回落 OpenAI 形状，保持原行为。
	for (const api of [undefined, "", "openai-completions", "openai-responses"]) {
		assert.equal(needsSessionBaseUrlVersionHint(root, probeUrl, api), true, `api=${String(api)}`);
		assert.equal(suggestNormalizedBaseUrl(root, probeUrl, api), "https://proxy.example.com/v1", `api=${String(api)}`);
	}
});

test("stripOpenAiVersionPath removes trailing version segment and keeps sub-prefix", () => {
	assert.equal(stripOpenAiVersionPath("https://88api.ai/v1"), "https://88api.ai");
	assert.equal(stripOpenAiVersionPath("https://88api.ai/v1/"), "https://88api.ai");
	assert.equal(stripOpenAiVersionPath("https://host.proxy.example/proxy/v1"), "https://host.proxy.example/proxy");
	assert.equal(stripOpenAiVersionPath("https://generativelanguage.googleapis.com/v1beta"), "https://generativelanguage.googleapis.com");
	assert.equal(stripOpenAiVersionPath("https://host.example/api"), "https://host.example");
	assert.equal(stripOpenAiVersionPath("https://host.example"), "https://host.example");
});
