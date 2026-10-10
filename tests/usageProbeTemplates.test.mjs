import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const tpl = loadTsCommonJs("src/main/config/usageProbeTemplates.ts");

test("newapi 模板把带 /v1 的端点剥离为管理根并跳过版本化补齐", () => {
	const built = tpl.buildDeclarativeUsageProbeTemplate("newapi", { accessToken: "tok", userId: "2325" }, { baseUrl: "https://88api.ai/v1", apiKey: "sk-x" });
	assert.ok(!("error" in built), "应构建成功");
	assert.equal(built.baseUrl, "https://88api.ai");
	assert.equal(built.candidate.path, "/api/user/self");
	assert.equal(built.candidate.noVersionPath, true);
	assert.equal(built.candidate.headers["New-Api-User"], "2325");
	assert.equal(built.candidate.headers.Authorization, "Bearer tok");
});

test("newapi 模板显式覆盖的请求地址优先（同样剥离版本段）", () => {
	const built = tpl.buildDeclarativeUsageProbeTemplate("newapi", { accessToken: "tok", userId: "u1", baseUrl: "https://api.override.example/v1" }, { baseUrl: "https://88api.ai/v1", apiKey: "sk-x" });
	assert.ok(!("error" in built));
	assert.equal(built.baseUrl, "https://api.override.example");
});

test("newapi 模板缺访问令牌或用户 ID 时返回错误", () => {
	const missing = tpl.buildDeclarativeUsageProbeTemplate("newapi", { accessToken: "", userId: "" }, { baseUrl: "https://88api.ai/v1", apiKey: "sk-x" });
	assert.ok("error" in missing);
});

test("cookie 模板剥离 /v1 为管理根、带 Cookie 头并禁止自动补 Bearer", () => {
	const built = tpl.buildDeclarativeUsageProbeTemplate("cookie", { cookie: "_c=1; tr_session=sess_abc", cookiePath: "/api/wallet/summary", valuePath: "data.availableBalanceCny" }, { baseUrl: "https://tokenrhythm.studio/v1", apiKey: "sk_tr_xxx" });
	assert.ok(!("error" in built), "应构建成功");
	assert.equal(built.baseUrl, "https://tokenrhythm.studio");
	assert.equal(built.candidate.path, "/api/wallet/summary");
	assert.equal(built.candidate.method, "GET");
	assert.equal(built.candidate.headers.Cookie, "_c=1; tr_session=sess_abc");
	assert.equal(built.candidate.noVersionPath, true);
	assert.equal(built.candidate.noBearer, true);
	assert.equal(built.candidate.parse.kind, "balance");
	assert.equal(built.candidate.parse.valuePath, "data.availableBalanceCny");
});

test("cookie 模板币种字段路径可选存在", () => {
	const built = tpl.buildDeclarativeUsageProbeTemplate("cookie", { cookie: "c", cookiePath: "/api/wallet/summary", valuePath: "data.balance", currencyPath: "data.currency" }, { baseUrl: "https://tokenrhythm.studio/v1", apiKey: "sk-tr" });
	assert.ok(!("error" in built));
	assert.equal(built.candidate.parse.currencyPath, "data.currency");
});

test("cookie 模板缺 Cookie / 接口路径 / 余额字段时分别返回错误", () => {
	const endpoint = { baseUrl: "https://tokenrhythm.studio/v1", apiKey: "sk" };
	const noCookie = tpl.buildDeclarativeUsageProbeTemplate("cookie", { cookiePath: "/x", valuePath: "data.b" }, endpoint);
	assert.ok("error" in noCookie);
	assert.match(noCookie.error, /Cookie/);
	const noPath = tpl.buildDeclarativeUsageProbeTemplate("cookie", { cookie: "c", valuePath: "data.b" }, endpoint);
	assert.ok("error" in noPath);
	assert.match(noPath.error, /接口路径/);
	const noValue = tpl.buildDeclarativeUsageProbeTemplate("cookie", { cookie: "c", cookiePath: "/x" }, endpoint);
	assert.ok("error" in noValue);
	assert.match(noValue.error, /余额字段路径/);
});

test("isDeclarativeTemplateId 覆盖 cookie", () => {
	assert.equal(tpl.isDeclarativeTemplateId("newapi"), true);
	assert.equal(tpl.isDeclarativeTemplateId("cookie"), true);
	assert.equal(tpl.isDeclarativeTemplateId("sub2api"), true);
	assert.equal(tpl.isDeclarativeTemplateId("balance"), false);
});

test("volcengine 模板：AK/SK 双 Action × 双入口候选，签名头不带 Bearer", () => {
	const built = tpl.buildDeclarativeUsageProbeTemplate("volcengine", { accessKeyId: "AKLTfake", secretAccessKey: "c2VjcmV0" }, { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "ark-key" });
	assert.ok(!("error" in built), "应构建成功");
	// baseUrl 仅作尝试明细的展示兜底：真实请求走 absoluteUrl（控制面入口与推理域不同域）。
	assert.equal(built.baseUrl, "https://open.volcengineapi.com");
	// apiKey 传 AK：只为通过上层「无 key 快速失败」门禁，签名头里另有 Authorization。
	assert.equal(built.apiKey, "AKLTfake");
	// 双 plan（GetAFPUsage / GetCodingPlanUsage）× 双入口（ark 地域专属 / 统一网关）= 4 个候选。
	assert.equal(built.candidates.length, 4);
	const urls = built.candidates.map((c) => new URL(String(c.absoluteUrl)));
	const actions = urls.map((u) => u.searchParams.get("Action"));
	// 跨 realm 深比较会因 Array 原型不同失败（helper 用 vm 沙箱加载 TS），逐项断言更稳。
	assert.equal(actions.length, 4);
	assert.equal(actions[0], "GetAFPUsage");
	assert.equal(actions[1], "GetAFPUsage");
	assert.equal(actions[2], "GetCodingPlanUsage");
	assert.equal(actions[3], "GetCodingPlanUsage");
	// 每个 plan 内部：ark.<region> 地域专属入口优先（官方方舟文档指定），统一网关兜底。
	assert.equal(urls[0].hostname, "ark.cn-beijing.volcengineapi.com");
	assert.equal(urls[1].hostname, "open.volcengineapi.com");
	assert.equal(urls[2].hostname, "ark.cn-beijing.volcengineapi.com");
	assert.equal(urls[3].hostname, "open.volcengineapi.com");
	for (const candidate of built.candidates) {
		assert.equal(candidate.method, "POST");
		assert.equal(candidate.noBearer, true);
		assert.equal(candidate.parse.kind, "custom");
		assert.equal(candidate.parse.resolver, "volcengine-plan");
		assert.match(String(candidate.headers.Authorization), /^HMAC-SHA256 Credential=AKLTfake\//);
		assert.doesNotMatch(String(candidate.headers.Authorization), /^Bearer /);
	}
	// 签名里的 host 必须与各自 URL 的 host 一致，否则服务端按真实 host 校验会失败。
	assert.notEqual(built.candidates[0].headers.Authorization, built.candidates[1].headers.Authorization);
});

test("volcengine 模板：Region 从数据面 base_url 推断并进签名 scope", () => {
	const built = tpl.buildDeclarativeUsageProbeTemplate("volcengine", { accessKeyId: "AK", secretAccessKey: "SK" }, { baseUrl: "https://ark.ap-southeast.volces.com/api/v3", apiKey: "k" });
	assert.ok(!("error" in built));
	for (const candidate of built.candidates) {
		assert.equal(new URL(String(candidate.absoluteUrl)).searchParams.get("Region"), "ap-southeast");
		assert.match(String(candidate.headers.Authorization), /ap-southeast\/ark\/request,/);
	}
});

test("volcengine 模板：缺 AK/SK 分别给出对应人话错误", () => {
	const noAk = tpl.buildDeclarativeUsageProbeTemplate("volcengine", { secretAccessKey: "SK" }, { baseUrl: "https://ark.cn-beijing.volces.com/v3", apiKey: "k" });
	assert.ok("error" in noAk);
	assert.match(String(noAk.error), /API Key ID/);
	const noSk = tpl.buildDeclarativeUsageProbeTemplate("volcengine", { accessKeyId: "AK" }, { baseUrl: "https://ark.cn-beijing.volces.com/v3", apiKey: "k" });
	assert.ok("error" in noSk);
	assert.match(String(noSk.error), /Secret Access Key/);
});

test("sub2api 模板：/usage 与推理端点同 base（不剥 /v1）、凭据默认取供应商 apiKey", () => {
	const built = tpl.buildDeclarativeUsageProbeTemplate("sub2api", {}, { baseUrl: "https://api.zuiapi.ccwu.cc/v1", apiKey: "sk-zui" });
	assert.ok(!("error" in built), "应构建成功（零必填字段）");
	// 与 newapi/cookie 相反：Sub2API 的 /v1/usage 与兼容端点同根，保留 /v1 交给探测层版本化补齐。
	assert.equal(built.baseUrl, "https://api.zuiapi.ccwu.cc/v1");
	assert.equal(built.apiKey, "sk-zui");
	assert.equal(built.candidate.path, "/usage");
	assert.equal(built.candidate.noVersionPath, undefined);
	assert.equal(built.candidate.parse.kind, "custom");
	assert.equal(built.candidate.parse.resolver, "sub2api-usage");
	// 单候选：钱包/订阅/Key 额度三形态由解析器按响应结构分流，无需多候选探测。
	assert.equal(built.candidates.length, 1);
});

test("sub2api 模板：可选覆盖 baseUrl/apiKey 优先于供应商条目", () => {
	const built = tpl.buildDeclarativeUsageProbeTemplate("sub2api", { baseUrl: "https://gw.override.example/v1", apiKey: "sk-other" }, { baseUrl: "https://api.zuiapi.ccwu.cc/v1", apiKey: "sk-zui" });
	assert.ok(!("error" in built));
	assert.equal(built.baseUrl, "https://gw.override.example/v1");
	assert.equal(built.apiKey, "sk-other");
});
