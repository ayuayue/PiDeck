/**
 * TokenDance 充值（Agent 支付）主进程侧：金额门禁、响应解析、status_url 白名单与请求形状。
 *
 * 覆盖 https://tokendance.space/docs/agent-payment 里的两条端点：
 * - 创建：POST /portal/api/v1/payment/sessions，body { amount }（整数元，1–100000）；
 * - 查询：GET status_url（必须同源 + payment/sessions/ 前缀，否则不得带 Bearer 发请求）。
 * 全部用例注入假传输层（不触真实网络），Key 只出现在请求头断言里。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const payment = loadTsCommonJs("src/main/config/tokendancePayment.ts");
const shared = loadTsCommonJs("src/shared/tokendance.ts");
const { TokendancePaymentStore, isValidTokendanceTopUpAmount, parseTokendancePaymentSession, isAllowedTokendancePaymentStatusUrl, isTokendanceOwnEndpoint, maskTokendanceApiKey } = payment;
const { TOKENDANCE_PAYMENT_SESSIONS_URL } = shared;

const API_KEY = "td-key-secret";
const SESSION_BODY = {
	session: {
		id: "SESSION_ID",
		amount: 10,
		status: "pending",
		payment_url: "https://pay.example.com/session/abc",
		alipay_url: "alipays://platformapi/startapp?appId=1",
		status_url: "https://tokendance.space/portal/api/v1/payment/sessions/SESSION_ID",
		expired_at: 1786500000,
		created_at: 1786499400,
	},
};

/** 假传输层：记录每次请求，按脚本返回响应（默认 201 + SESSION_BODY）。 */
function makeRequest({ status = 201, raw = JSON.stringify(SESSION_BODY), error } = {}) {
	const calls = [];
	const request = async (url, init) => {
		calls.push({ url, init });
		if (error) return { error };
		return { status, raw };
	};
	return { request, calls };
}

/** 构造 store：默认提供 Key 与官方端点；`apiKey: null` = 未配置，可覆盖端点解析结果。 */
function makeStore({ apiKey = API_KEY, baseUrl = "https://tokendance.space/gateway/v1", resolveError, ...requestOptions } = {}) {
	const { request, calls } = makeRequest(requestOptions);
	const store = new TokendancePaymentStore({
		resolveEndpoint: async () => {
			if (resolveError) throw new Error(resolveError);
			return apiKey == null ? {} : { baseUrl, apiKey };
		},
		request,
	});
	return { store, calls };
}

test("金额门禁：只接受 1–100000 的整数元", () => {
	for (const valid of [1, 10, 999, 100000]) {
		assert.equal(isValidTokendanceTopUpAmount(valid), true, `${valid} 应通过`);
	}
	for (const invalid of [0, -1, 1.5, 100001, 1e9, Number.NaN, Number.POSITIVE_INFINITY, "10", null, undefined, {}, [10]]) {
		assert.equal(isValidTokendanceTopUpAmount(invalid), false, `${String(invalid)} 应被拒`);
	}
});

test("会话解析：字段映射与可选字段降级", () => {
	const session = parseTokendancePaymentSession(SESSION_BODY);
	assert.equal(session.id, "SESSION_ID");
	assert.equal(session.amount, 10);
	assert.equal(session.status, "pending");
	assert.equal(session.paymentUrl, "https://pay.example.com/session/abc");
	assert.equal(session.alipayUrl, "alipays://platformapi/startapp?appId=1");
	assert.equal(session.statusUrl, "https://tokendance.space/portal/api/v1/payment/sessions/SESSION_ID");
	assert.equal(session.expiredAt, 1786500000);
	assert.equal(session.createdAt, 1786499400);
	assert.equal(session.paidAt, undefined, "未支付的会话不应有 paidAt");

	// 可选字段缺失不影响主流程（旧会话可能没有 alipay_url）
	const minimal = parseTokendancePaymentSession({ session: { id: "s1", amount: 1, status: "paid", payment_url: "p", status_url: "https://tokendance.space/portal/api/v1/payment/sessions/s1", paid_at: 1786499500 } });
	assert.equal(minimal.alipayUrl, undefined);
	assert.equal(minimal.paidAt, 1786499500);
	assert.equal(minimal.status, "paid");
	assert.equal(minimal.expiredAt, 0, "缺失的过期时间归 0（= 无过期信息）");

	// 必需字段缺失/类型不符一律判不可用，不拿残缺会话去渲染二维码
	for (const broken of [{}, { session: null }, { session: {} }, { session: { ...SESSION_BODY.session, id: "" } }, { session: { ...SESSION_BODY.session, payment_url: undefined } }, { session: { ...SESSION_BODY.session, status_url: 42 } }, { session: { ...SESSION_BODY.session, amount: "10" } }, null]) {
		assert.equal(parseTokendancePaymentSession(broken), null, `${JSON.stringify(broken)} 应解析失败`);
	}

	// 未知状态按 pending 处理（fail-closed：绝不误报已到账）
	const unknown = parseTokendancePaymentSession({ session: { ...SESSION_BODY.session, status: "processing" } });
	assert.equal(unknown.status, "pending");
});

test("status_url 白名单：只放行 https + 同源 + payment/sessions/ 前缀", () => {
	const allowed = ["https://tokendance.space/portal/api/v1/payment/sessions/SESSION_ID", "https://tokendance.space/portal/api/v1/payment/sessions/SESSION_ID?x=1"];
	for (const url of allowed) assert.equal(isAllowedTokendancePaymentStatusUrl(url), true, `${url} 应放行`);
	const rejected = [
		// 降级协议 / 篡改域名 / 相似域名（Key 外泄的主要风险点）
		"http://tokendance.space/portal/api/v1/payment/sessions/x",
		"https://tokendance.space.evil.com/portal/api/v1/payment/sessions/x",
		"https://evil.com/portal/api/v1/payment/sessions/x",
		"https://tokendance.space:8443/portal/api/v1/payment/sessions/x",
		// 同源但非支付路径（拿 Key 打其它接口）
		"https://tokendance.space/portal/api/v1/user/balance",
		"https://tokendance.space/portal/api/v1/payment/sessions",
		"https://tokendance.space/portal/api/v1/payment/sessions-other/x",
		"javascript:alert(1)",
		"",
	];
	for (const url of rejected) assert.equal(isAllowedTokendancePaymentStatusUrl(url), false, `${url} 应拒绝`);
});

test("创建会话：金额非法/未配置 Key 时不发请求", async () => {
	const invalid = makeStore();
	const invalidResult = await invalid.store.createSession(1.5);
	assert.equal(invalidResult.ok, false);
	assert.equal(invalidResult.code, "invalid-amount");
	assert.equal(invalid.calls.length, 0, "非法金额不得发出网络请求");

	const noKey = makeStore({ apiKey: null });
	const noKeyResult = await noKey.store.createSession(10);
	assert.equal(noKeyResult.ok, false);
	assert.equal(noKeyResult.code, "not-configured");
	assert.equal(noKey.calls.length, 0, "无 Key 不得发出网络请求");

	// 端点解析抛错同样归 not-configured（用户要做的动作一致：先完成配置）
	const broken = makeStore({ resolveError: "models.json unreadable" });
	const brokenResult = await broken.store.createSession(10);
	assert.equal(brokenResult.ok, false);
	assert.equal(brokenResult.code, "not-configured");
	assert.equal(broken.calls.length, 0);
});

test("创建会话：POST 到支付端点并带 Bearer Key", async () => {
	const { store, calls } = makeStore();
	const result = await store.createSession(10);
	assert.equal(result.ok, true);
	assert.equal(result.session.id, "SESSION_ID");
	assert.equal(result.session.amount, 10);

	assert.equal(calls.length, 1);
	const [call] = calls;
	assert.equal(call.url, TOKENDANCE_PAYMENT_SESSIONS_URL);
	assert.equal(call.init.method, "POST");
	assert.equal(call.init.headers.Authorization, `Bearer ${API_KEY}`);
	assert.equal(call.init.headers["Content-Type"], "application/json");
	assert.deepEqual(JSON.parse(call.init.body), { amount: 10 });
	assert.equal(typeof call.init.timeoutMs, "number");
	assert.equal(typeof call.init.maxBytes, "number");
	assert.ok(call.init.maxBytes <= 64 * 1024, "响应体必须有字节上界");

	// Key 不得混进回传渲染层的结果里
	assert.equal(JSON.stringify(result).includes(API_KEY), false, "结果里不得出现 API Key");
});

test("Key 掩码：只留末 4 位，短 Key 整体掩掉", () => {
	assert.equal(maskTokendanceApiKey("td-1234567890ab12"), "••••ab12");
	assert.equal(maskTokendanceApiKey("  td-1234567890ab12  "), "••••ab12", "首尾空白不影响结果");
	assert.equal(maskTokendanceApiKey("12345678"), "••••", "恰好 8 位仍整体掩掉");
	assert.equal(maskTokendanceApiKey("short"), "••••");
	assert.equal(maskTokendanceApiKey(""), "••••");
});

test("创建会话：结果带目标 Key 掩码（不落明文），查询不重复回传", async () => {
	const created = await makeStore().store.createSession(10);
	assert.equal(created.keyHint, `••••${API_KEY.slice(-4)}`);
	assert.equal(JSON.stringify(created).includes(API_KEY), false, "掩码不得夹带完整 Key");

	// 失败结果不带 Key 痕迹（含掩码）
	const failed = await makeStore({ status: 402 }).store.createSession(10);
	assert.equal(failed.keyHint, undefined);

	// 轮询每 3 秒一次：不重复回掩码，避免无谓地把 Key 信息往渲染层推
	const polled = await makeStore().store.fetchSession(SESSION_BODY.session.status_url);
	assert.equal(polled.ok, true);
	assert.equal(polled.keyHint, undefined);
});

test("端点归属：provider 端点非 TokenDance 官方域名时拒绝且不发请求", async () => {
	// 官方域名（含子域）与「端点缺失（不可判定）」放行
	for (const allowed of ["https://tokendance.space/gateway/v1", "https://api.tokendance.space/gateway/v1", undefined]) {
		assert.equal(isTokendanceOwnEndpoint(allowed), true, `${String(allowed)} 应放行`);
	}
	// 第三方中转 / 相似域名 / 拿路径冒充域名 一律不放行（Key 属于别家账号，充值会记错户）
	for (const rejected of ["https://relay.example.com/v1", "https://tokendance.space.evil.com/gateway/v1", "https://relay.example.com/tokendance.space/v1", "not-a-url"]) {
		assert.equal(isTokendanceOwnEndpoint(rejected), false, `${rejected} 应拒绝`);
	}

	const { store, calls } = makeStore({ baseUrl: "https://relay.example.com/v1" });
	const result = await store.createSession(10);
	assert.equal(result.ok, false);
	assert.equal(result.code, "endpoint-mismatch");
	assert.equal(calls.length, 0, "端点跑偏时不得把 Key 发往官方支付接口");
});

test("创建会话：HTTP/超时/坏响应都映射成结构化原因码", async () => {
	const http = makeStore({ status: 402, raw: JSON.stringify({ error: "insufficient" }) });
	const httpResult = await http.store.createSession(10);
	assert.equal(httpResult.ok, false);
	assert.equal(httpResult.code, "http");
	assert.equal(httpResult.detail, "402");
	assert.equal(JSON.stringify(httpResult).includes("insufficient"), false, "不把服务端响应原文回传");

	const timeout = makeStore({ error: "timeout" });
	const timeoutResult = await timeout.store.createSession(10);
	assert.equal(timeoutResult.code, "timeout");

	const network = makeStore({ error: "network" });
	assert.equal((await network.store.createSession(10)).code, "network");

	const badJson = makeStore({ status: 201, raw: "not-json" });
	assert.equal((await badJson.store.createSession(10)).code, "bad-response");

	const emptyBody = makeStore({ status: 201, raw: JSON.stringify({}) });
	assert.equal((await emptyBody.store.createSession(10)).code, "bad-response");
});

test("查询状态：只请求白名单内的 status_url，paid 带 paidAt", async () => {
	const paidBody = { session: { ...SESSION_BODY.session, status: "paid", paid_at: 1786499999 } };
	const { store, calls } = makeStore({ status: 200, raw: JSON.stringify(paidBody) });
	const statusUrl = SESSION_BODY.session.status_url;
	const result = await store.fetchSession(statusUrl);
	assert.equal(result.ok, true);
	assert.equal(result.session.status, "paid");
	assert.equal(result.session.paidAt, 1786499999);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, statusUrl);
	assert.equal(calls[0].init.method, "GET");
	assert.equal(calls[0].init.headers.Authorization, `Bearer ${API_KEY}`);
	assert.equal(calls[0].init.body, undefined, "查询不得带请求体");
});

test("查询状态：非白名单 status_url 直接拒绝且不发请求", async () => {
	const { store, calls } = makeStore();
	for (const url of ["https://evil.com/portal/api/v1/payment/sessions/x", "http://tokendance.space/portal/api/v1/payment/sessions/x", 42, undefined]) {
		const result = await store.fetchSession(url);
		assert.equal(result.ok, false);
		assert.equal(result.code, "bad-status-url");
	}
	assert.equal(calls.length, 0, "被拒的 URL 一个请求都不能发出");
});
