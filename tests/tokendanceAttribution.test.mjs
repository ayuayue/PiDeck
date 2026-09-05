/**
 * TokenDance 归因兜底：手动添加的 tokendance provider 自动补 X-App-URL。
 * 纯函数测试：只补缺失、不覆盖用户显式值、大小写不敏感、不误伤其他供应商。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const mod = loadTsCommonJs("src/main/config/tokendanceAttribution.ts");
const { isTokendanceBaseUrl, ensureTokendanceAttribution } = mod;
const APP_URL = "https://pideck.caoayu.top/";
const HEADER = "X-App-URL";

function provider(overrides = {}) {
	return { baseUrl: "https://tokendance.space/gateway/v1", models: [{ id: "deepseek-v3.2" }], ...overrides };
}

test("无 headers 的 tokendance provider 自动补 X-App-URL", () => {
	const out = ensureTokendanceAttribution({ providers: { tokendance: provider() } });
	const headers = out.providers.tokendance.headers;
	assert.equal(headers[HEADER], APP_URL);
	// 其余字段原样保留
	assert.equal(out.providers.tokendance.baseUrl, "https://tokendance.space/gateway/v1");
	assert.deepEqual(out.providers.tokendance.models, [{ id: "deepseek-v3.2" }]);
});

test("已有 headers 但缺 X-App-URL 时补上并保留其他 header", () => {
	const out = ensureTokendanceAttribution({
		providers: { tokendance: provider({ headers: { "User-Agent": "test/1.0" } }) },
	});
	assert.equal(out.providers.tokendance.headers["User-Agent"], "test/1.0");
	assert.equal(out.providers.tokendance.headers[HEADER], APP_URL);
});

test("用户显式写过 X-App-URL 时不覆盖（大小写不敏感）", () => {
	for (const explicit of ["X-App-URL", "x-app-url", "X-App-Url"]) {
		const headers = { [explicit]: "https://user-owned.example/" };
		const out = ensureTokendanceAttribution({ providers: { tokendance: provider({ headers }) } });
		assert.deepEqual(out.providers.tokendance.headers, headers, `explicit=${explicit}`);
	}
});

test("非 tokendance provider 完全不动（返回原对象）", () => {
	const models = {
		providers: {
			deepseek: { baseUrl: "https://api.deepseek.com", models: [{ id: "deepseek-chat" }] },
		},
	};
	assert.equal(ensureTokendanceAttribution(models), models);
});

test("baseUrl 畸形/缺失的 provider 跳过注入", () => {
	for (const baseUrl of [undefined, "", "not-a-url", "https://evil-tokendance.space.evil.com", "https://api.deepseek.com"]) {
		const out = ensureTokendanceAttribution({ providers: { p: provider({ baseUrl }) } });
		assert.equal(out.providers.p.headers, undefined, `baseUrl=${String(baseUrl)}`);
	}
});

test("headers 非对象（异常数据）时保持原样不动", () => {
	const out = ensureTokendanceAttribution({
		providers: { tokendance: provider({ headers: "bad" }) },
	});
	assert.equal(out.providers.tokendance.headers, "bad");
});

test("纯函数：不修改入参对象", () => {
	const input = { providers: { tokendance: provider() } };
	const snapshot = JSON.stringify(input);
	ensureTokendanceAttribution(input);
	assert.equal(JSON.stringify(input), snapshot);
});

test("isTokendanceBaseUrl 判定 hostname 精确匹配", () => {
	assert.equal(isTokendanceBaseUrl("https://tokendance.space/gateway/v1"), true);
	assert.equal(isTokendanceBaseUrl("https://tokendance.space"), true);
	assert.equal(isTokendanceBaseUrl("http://tokendance.space:8080/v1"), true);
	assert.equal(isTokendanceBaseUrl("https://sub.tokendance.space"), false);
	assert.equal(isTokendanceBaseUrl("https://tokendance.space.evil.com"), false);
	assert.equal(isTokendanceBaseUrl(undefined), false);
	assert.equal(isTokendanceBaseUrl(""), false);
});
