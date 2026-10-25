import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const resolver = loadTsCommonJs("src/main/config/providerUsageResolver.ts");

function makeLookup({ models = {}, auth = {}, catalog = {} } = {}) {
	return {
		getModelsConfig: async () => ({ parsed: { providers: models } }),
		getAuthConfig: async () => ({ parsed: auth }),
		catalogProvider: (name) => catalog[name],
	};
}

test("models.json 精确命中返回 baseUrl/apiKey/apiType", async () => {
	const lookup = makeLookup({
		models: {
			oc: {
				baseUrl: "https://opencode.ai/zen/go/v1/",
				api: "openai-completions",
				apiKey: "sk-inline",
				models: [{ id: "deepseek-v4-flash" }],
			},
		},
	});
	const res = await resolver.resolveProviderUsageEndpoint(lookup, "oc");
	assert.equal(res.matched, true);
	assert.equal(res.provider, "oc");
	assert.equal(res.baseUrl, "https://opencode.ai/zen/go/v1/");
	assert.equal(res.apiKey, "sk-inline");
	assert.equal(res.apiType, "openai-completions");
});

test("auth.json 兜底给 key（内联缺失时）", async () => {
	const lookup = makeLookup({
		models: { myprov: { baseUrl: "https://x.test/v1", models: [] } },
		auth: { myprov: { type: "api_key", key: "sk-auth" } },
	});
	const res = await resolver.resolveProviderUsageEndpoint(lookup, "myprov");
	assert.equal(res.apiKey, "sk-auth");
	assert.equal(res.matched, true);
});

test("catalog 兜底命中（DSH route 名如 opencode-go）", async () => {
	const lookup = makeLookup({
		catalog: {
			"opencode-go": {
				baseUrl: "https://opencode.ai/zen/go/v1",
				api: "openai-completions",
				models: [{ id: "deepseek-v4-flash" }],
			},
		},
	});
	const res = await resolver.resolveProviderUsageEndpoint(lookup, "opencode-go");
	assert.equal(res.matched, true);
	assert.equal(res.baseUrl, "https://opencode.ai/zen/go/v1");
});

test("models.json 优先于 catalog（同名时取 models）", async () => {
	const lookup = makeLookup({
		models: { probe: { baseUrl: "https://models.test/v1", models: [] } },
		catalog: { probe: { baseUrl: "https://catalog.test/v1", models: [] } },
	});
	const res = await resolver.resolveProviderUsageEndpoint(lookup, "probe");
	assert.equal(res.baseUrl, "https://models.test/v1");
});

test("未知 provider 返回 matched=false 不抛错", async () => {
	const res = await resolver.resolveProviderUsageEndpoint(makeLookup(), "nope");
	assert.equal(res.matched, false);
});

test("空 provider 返回 matched=false", async () => {
	const res = await resolver.resolveProviderUsageEndpoint(makeLookup(), "  ");
	assert.equal(res.matched, false);
});

test("safeProviderHeaders 只保留字符串 header", () => {
	const config = { baseUrl: "x", models: [], headers: { "User-Agent": "pideck", bad: 1, arr: [] } };
	assert.equal(JSON.stringify(resolver.safeProviderHeaders(config)), JSON.stringify({ "User-Agent": "pideck" }));
	assert.equal(resolver.safeProviderHeaders({ models: [] }), undefined);
});
