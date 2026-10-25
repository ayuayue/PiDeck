import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { classifyAuthFailure, describeAuthProviderRow, filterAuthProviders } = loadTsCommonJs("src/renderer/src/utils/providerLoginList.ts");

// loadTsCommonJs 在独立 VM realm 执行，跨 realm 对象原型不同，比较前统一 JSON 归一化。
const json = (value) => JSON.stringify(value);

function provider(overrides = {}) {
	return { id: "kimi", name: "Kimi", ambientOnly: false, ...overrides };
}

test("filterAuthProviders：空关键词保持 pi 给出的顺序", () => {
	const list = [provider({ id: "b", name: "B" }), provider({ id: "a", name: "A" })];
	assert.deepEqual(json(filterAuthProviders(list, "   ").map((item) => item.id)), json(["b", "a"]));
});

test("filterAuthProviders：命中 id / 名称 / 登录方式标签，且大小写不敏感", () => {
	const list = [
		provider({ id: "anthropic", name: "Anthropic", oauth: { label: "Anthropic (Claude Pro/Max)", isSubscription: true } }),
		provider({ id: "kimi", name: "Kimi", oauth: { label: "Sign in with Kimi Code", isSubscription: true } }),
		provider({ id: "bedrock", name: "Amazon Bedrock", apiKey: { name: "AWS credentials or bearer token", canLogin: true } }),
	];
	const idsOf = (query) => filterAuthProviders(list, query).map((item) => item.id);
	assert.deepEqual(json(idsOf("KIMI")), json(["kimi"]));
	assert.deepEqual(json(idsOf("claude pro")), json(["anthropic"]));
	// 「AWS」只在 apiKey 的展示名里出现：搜索必须覆盖登录方式，否则用户按按钮文案搜不到。
	assert.deepEqual(json(idsOf("aws")), json(["bedrock"]));
	assert.deepEqual(json(idsOf("deepseek")), json([]));
});

test("describeAuthProviderRow：oauth 在前，apiKey 仅在可交互录入时才算登录方式", () => {
	assert.deepEqual(json(describeAuthProviderRow(provider({ oauth: { label: "O", isSubscription: false }, apiKey: { name: "K", canLogin: true } }))), json({ loggedIn: false, methods: ["oauth", "api_key"] }));
	// canLogin=false 只能靠环境变量/凭据文件，给按钮必然失败，因此不算可点方式
	assert.deepEqual(json(describeAuthProviderRow(provider({ apiKey: { name: "Env only", canLogin: false }, ambientOnly: true }))), json({ loggedIn: false, methods: [] }));
	assert.deepEqual(json(describeAuthProviderRow(provider({ credential: { type: "oauth" } }))), json({ loggedIn: true, methods: [] }));
});

test("classifyAuthFailure：地区限制优先于网络/授权码，未知则不给建议", () => {
	// openai 的 token 交换在受限地区返回的就是这个串（用户反馈的 codex 卡住根因）
	assert.equal(classifyAuthFailure("something failed: unsupported_country_region_territory"), "region");
	assert.equal(classifyAuthFailure("Country, region, or territory not supported"), "region");
	assert.equal(classifyAuthFailure("fetch failed"), "network");
	assert.equal(classifyAuthFailure("getaddrinfo ENOTFOUND auth.openai.com"), "network");
	assert.equal(classifyAuthFailure("invalid_grant: code expired"), "code-expired");
	assert.equal(classifyAuthFailure("boom: token exchange failed"), "none");
	assert.equal(classifyAuthFailure(undefined), "none");
	// 同时出现地区与网络特征时按地区解释：只说「检查网络」会误导用户反复重试
	assert.equal(classifyAuthFailure("unsupported_country_region_territory (fetch failed)"), "region");
});
