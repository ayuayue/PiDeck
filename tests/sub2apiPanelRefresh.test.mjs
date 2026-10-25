import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const session = loadTsCommonJs("src/main/config/sub2apiPanelSession.ts");

/** 造一个 payload 里带 exp 的 JWT（只需三段结构，签名内容不参与判定）。 */
function jwtWithExpiry(expSeconds) {
	const payload = Buffer.from(JSON.stringify({ sub: "user@example.com", exp: expSeconds }), "utf8").toString("base64url");
	return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

const REFRESH_URL = "https://api.example.com/api/v1/auth/refresh";
const ME_URL = "https://api.example.com/api/v1/auth/me";

/** 记录所有请求的假传输层：按 URL 后缀路由到给定响应。 */
function fakeRequest(routes) {
	const calls = [];
	const request = async (url, init) => {
		calls.push({ url, init });
		for (const [suffix, response] of routes) {
			if (url.endsWith(suffix)) return typeof response === "function" ? response(calls.length) : response;
		}
		return { status: 404, raw: "" };
	};
	return { request, calls };
}

test("decodeJwtExpiryMs 从 payload 取 exp 秒并换算毫秒，非 JWT 返回 undefined", () => {
	assert.equal(session.decodeJwtExpiryMs(jwtWithExpiry(1_700_000_000)), 1_700_000_000_000);
	assert.equal(session.decodeJwtExpiryMs("rt_8f3c2b1a"), undefined);
	assert.equal(session.decodeJwtExpiryMs("a.b"), undefined);
});

test("panelTokenNeedsRefresh 提前 60s 判定为需续期", () => {
	const expiryMs = 1_700_000_000_000;
	const token = jwtWithExpiry(1_700_000_000);
	assert.equal(session.panelTokenNeedsRefresh(token, expiryMs - 120_000), false);
	assert.equal(session.panelTokenNeedsRefresh(token, expiryMs - 60_000), true);
	assert.equal(session.panelTokenNeedsRefresh(token, expiryMs + 1), true);
	// 没有 exp 的令牌不下本地判断，交给服务端 401 兜底。
	assert.equal(session.panelTokenNeedsRefresh("opaque-token", expiryMs + 1), false);
});

test("parseSub2ApiRefreshResponse 兼容 data 包裹与扁平结构，缺 access_token 视为未命中", () => {
	assert.deepEqual(structuredClone(session.parseSub2ApiRefreshResponse({ code: 0, message: "success", data: { access_token: "at2", refresh_token: "rt2", expires_in: 3600 } })), { accessToken: "at2", refreshToken: "rt2", expiresInSeconds: 3600 });
	assert.deepEqual(structuredClone(session.parseSub2ApiRefreshResponse({ access_token: "at3" })), { accessToken: "at3" });
	assert.equal(session.parseSub2ApiRefreshResponse({ code: 401, message: "refresh token invalid" }), undefined);
});

test("refreshSub2ApiPanelToken 以 JSON body 提交 refresh_token，401 归因 unauthorized", async () => {
	const okRun = fakeRequest([["/auth/refresh", { status: 200, raw: JSON.stringify({ code: 0, data: { access_token: "at2", refresh_token: "rt2" } }) }]]);
	const ok = await session.refreshSub2ApiPanelToken({ urls: [REFRESH_URL], refreshToken: "rt1", timeoutMs: 1000, maxBytes: 1024, request: okRun.request, headers: { "User-Agent": "ua" } });
	assert.deepEqual(structuredClone(ok), { ok: true, pair: { accessToken: "at2", refreshToken: "rt2" } });
	assert.equal(okRun.calls.length, 1);
	assert.equal(okRun.calls[0].init.method, "POST");
	assert.equal(okRun.calls[0].init.body, JSON.stringify({ refresh_token: "rt1" }));
	assert.equal(okRun.calls[0].init.headers["Content-Type"], "application/json");
	assert.equal(okRun.calls[0].init.headers["User-Agent"], "ua");

	const unauthorized = await session.refreshSub2ApiPanelToken({ urls: [REFRESH_URL], refreshToken: "rt1", timeoutMs: 1000, maxBytes: 1024, request: fakeRequest([["/auth/refresh", { status: 401, raw: "" }]]).request, headers: {} });
	assert.deepEqual(structuredClone(unauthorized), { ok: false, reason: "unauthorized" });

	const failed = await session.refreshSub2ApiPanelToken({ urls: [REFRESH_URL], refreshToken: "rt1", timeoutMs: 1000, maxBytes: 1024, request: fakeRequest([["/auth/refresh", { error: "network" }]]).request, headers: {} });
	assert.deepEqual(structuredClone(failed), { ok: false, reason: "failed" });
});

test("本地 exp 已过期时先续期再查余额，并把轮转后的 token 对回写", async () => {
	const net = fakeRequest([
		["/auth/refresh", { status: 200, raw: JSON.stringify({ code: 0, data: { access_token: "at-new", refresh_token: "rt-new" } }) }],
		["/auth/me", { status: 200, raw: JSON.stringify({ code: 0, data: { balance: 12.34 } }) }],
	]);
	const persisted = [];
	const outcome = await session.fetchSub2ApiPanelBalanceWithRefresh({
		balanceUrls: [ME_URL],
		refreshUrls: [REFRESH_URL],
		tokens: { accessToken: jwtWithExpiry(1_699_999_000), refreshToken: "rt-old" },
		timeoutMs: 1000,
		maxBytes: 1024,
		request: net.request,
		buildAuthHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
		refreshHeaders: () => ({}),
		now: 1_700_000_000_000,
		onTokensRefreshed: (pair) => persisted.push(pair),
	});

	assert.equal(outcome.ok, true);
	assert.equal(outcome.balance.value, 12.34);
	assert.equal(outcome.balance.currency, "USD");
	assert.equal(net.calls[0].url, REFRESH_URL, "应先调 refresh 再调 /auth/me");
	assert.equal(net.calls[1].url, ME_URL);
	assert.equal(net.calls[1].init.headers.Authorization, "Bearer at-new");
	assert.deepEqual(structuredClone(persisted), [{ accessToken: "at-new", refreshToken: "rt-new" }]);
	assert.deepEqual(structuredClone(outcome.tokens), { accessToken: "at-new", refreshToken: "rt-new" });
});

test("没有 exp 但 /auth/me 返回 401 时，续期一次后重试成功", async () => {
	let meCalls = 0;
	const net = fakeRequest([
		["/auth/refresh", { status: 200, raw: JSON.stringify({ data: { access_token: "at-new" } }) }],
		[
			"/auth/me",
			() => {
				meCalls += 1;
				return meCalls === 1 ? { status: 401, raw: "" } : { status: 200, raw: JSON.stringify({ data: { balance: 5 } }) };
			},
		],
	]);
	const outcome = await session.fetchSub2ApiPanelBalanceWithRefresh({
		balanceUrls: [ME_URL],
		refreshUrls: [REFRESH_URL],
		tokens: { accessToken: "opaque", refreshToken: "rt-1" },
		timeoutMs: 1000,
		maxBytes: 1024,
		request: net.request,
		buildAuthHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
		refreshHeaders: () => ({}),
	});

	assert.equal(outcome.ok, true);
	assert.equal(outcome.balance.value, 5);
	// 未轮转时保留旧 refresh token（上游可能不下发新值）。
	assert.deepEqual(structuredClone(outcome.tokens), { accessToken: "at-new", refreshToken: "rt-1" });
	assert.equal(net.calls.filter((call) => call.url === REFRESH_URL).length, 1);
	assert.equal(meCalls, 2);
});

test("续期失败不循环：refresh 401 时只尝试一次并归因 unauthorized", async () => {
	const net = fakeRequest([
		["/auth/refresh", { status: 401, raw: "" }],
		["/auth/me", { status: 401, raw: "" }],
	]);
	const outcome = await session.fetchSub2ApiPanelBalanceWithRefresh({
		balanceUrls: [ME_URL],
		refreshUrls: [REFRESH_URL],
		tokens: { accessToken: "opaque", refreshToken: "rt-dead" },
		timeoutMs: 1000,
		maxBytes: 1024,
		request: net.request,
		buildAuthHeaders: () => ({}),
		refreshHeaders: () => ({}),
	});

	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, "unauthorized");
	assert.equal(net.calls.filter((call) => call.url === REFRESH_URL).length, 1);
	assert.equal(net.calls.filter((call) => call.url === ME_URL).length, 1);
});

test("没有 refresh token 时保持旧行为：401 直接归因 unauthorized，不发续期请求", async () => {
	const net = fakeRequest([["/auth/me", { status: 401, raw: "" }]]);
	const outcome = await session.fetchSub2ApiPanelBalanceWithRefresh({
		balanceUrls: [ME_URL],
		refreshUrls: [REFRESH_URL],
		tokens: { accessToken: "opaque" },
		timeoutMs: 1000,
		maxBytes: 1024,
		request: net.request,
		buildAuthHeaders: () => ({}),
		refreshHeaders: () => ({}),
	});

	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, "unauthorized");
	assert.equal(
		net.calls.some((call) => call.url === REFRESH_URL),
		false,
	);
});

test("余额响应结构不匹配时归因 failed（续期不重复触发）", async () => {
	const net = fakeRequest([["/auth/me", { status: 200, raw: JSON.stringify({ data: { email: "x@example.com" } }) }]]);
	const outcome = await session.fetchSub2ApiPanelBalanceWithRefresh({
		balanceUrls: [ME_URL],
		refreshUrls: [REFRESH_URL],
		tokens: { accessToken: "opaque", refreshToken: "rt-1" },
		timeoutMs: 1000,
		maxBytes: 1024,
		request: net.request,
		buildAuthHeaders: () => ({}),
		refreshHeaders: () => ({}),
	});

	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, "failed");
	assert.equal(net.calls.filter((call) => call.url === REFRESH_URL).length, 0);
});
