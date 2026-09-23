import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildDshProviderFromDraft } = loadTsCommonJs("src/renderer/src/config/dshProviderDraft.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const draft = (overrides = {}) => ({ name: "中文供应商", baseUrl: "https://example.com/v1", api: "openai-completions", apiKey: "test-only-key", models: [{ id: "test-model", name: "Test Model", input: ["text", "image"] }], catalogProvider: false, ...overrides });

test("custom DSH draft maps Base URL and model fields without leaking API keys into settings", () => {
	const result = plain(buildDshProviderFromDraft(draft()));
	assert.equal(result.name, "中文供应商");
	assert.equal(result.profile.baseURL, "https://example.com/v1");
	assert.equal(result.profile.api, "openai-completions");
	assert.match(result.profile.apiKeyEnv, /^PIDECK_[A-F0-9]+_API_KEY$/);
	assert.equal(result.apiKey, "test-only-key");
	assert.deepEqual(result.profile.models, draft().models);
	assert.equal(JSON.stringify(result.profile).includes("test-only-key"), false);
	assert.equal(Object.hasOwn(result.profile, "apiKey"), false);
	assert.equal(Object.hasOwn(result.profile, "baseUrl"), false);
	assert.equal(Object.hasOwn(result.profile, "compat"), false);
});

test("built-in provider inherits adapter API/catalog rather than overwriting with Pi defaults", () => {
	const result = plain(buildDshProviderFromDraft(draft({ name: "anthropic", baseUrl: "", models: [], catalogProvider: true })));
	assert.deepEqual(result.profile, { apiKeyEnv: "ANTHROPIC_API_KEY" });
});

test("draft normalization preserves explicit DSH model capabilities", () => {
	const result = plain(buildDshProviderFromDraft(draft({ name: "  供应商 2  ", baseUrl: " https://example.com/v1 ", models: [{ id: " model-a ", name: "  ", contextWindow: 128000, maxTokens: 8000, reasoningEfforts: { high: "high" }, input: ["text"] }] })));
	assert.equal(result.name, "供应商 2");
	assert.deepEqual(result.profile.models, [{ id: "model-a", contextWindow: 128000, maxTokens: 8000, reasoningEfforts: { high: "high" }, input: ["text"] }]);
});
