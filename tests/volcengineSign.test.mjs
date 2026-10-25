/**
 * 火山方舟用量查询签名单元测试（tests/volcengineSign.test.mjs）。
 *
 * 覆盖：
 * - buildVolcengineCanonicalQuery（query 按 key 字典序：Action/Region/Version）；
 * - buildVolcengineSignedHeaders（固定签名头顺序、算法串 HMAC-SHA256 无 AWS4 前缀、
 *   scope 结尾 request、确定性输出、Content-Type 与参与签名的值一致、host 必须与
 *   absoluteUrl 一致）；
 *   Authorization 用「测试内独立实现的官方规范」复算比对，而不是拿模块自身算法反推；
 * - resolveVolcengineRegion（数据面 base_url → Region，无匹配回落默认区域）；
 * - buildVolcengineUsageCandidate（控制面绝对 URL、POST 空体、签名头不含 Bearer、
 *   noBearer 关闭、custom 解析器标记 volcengine-plan）。
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";

import { buildVolcengineCanonicalQuery, buildVolcengineSignedHeaders, buildVolcengineUsageCandidate, resolveVolcengineRegion, VOLCENGINE_API_HOST, VOLCENGINE_API_VERSION, volcengineArkHost } from "../src/main/config/volcengineSign.ts";

const AK = "AKTPMjIwNDM0NzNiOTM0NjRlNGI0YjRh";
const SK = "T1RCa1lUa3lZMmd3TmpZNU5HTTNOemd6WVRrek5qST0=";
const NOW = new Date("2024-02-01T12:00:00Z");
const REGION = "cn-beijing";
const ACTION = "GetAFPUsage";

/**
 * 测试内按官方规范独立复算 Authorization：不复用被测模块的任何内部函数。
 *
 * 允许传入 host 与 X-Date：候选构造（buildVolcengineUsageCandidate）路径不注入时钟，
 * 从被测返回的头里取真实 X-Date 再复算，验证的是「签名 ↔ 实际发送的头/URL」自洽性。
 */
function recomputeAuthorization(host = volcengineArkHost(REGION), xDate = "20240201T120000Z") {
	const shortDate = xDate.slice(0, 8);
	const payloadSha = createHash("sha256").update("{}", "utf8").digest("hex");
	const scope = `${shortDate}/${REGION}/ark/request`;
	const canonicalQuery = ["Action=GetAFPUsage", "Region=cn-beijing", "Version=2024-01-01"].sort().join("&");
	// 固定顺序：host;x-date;x-content-sha256;content-type（火山特有，非字典序）。
	const canonicalHeaders = [`host:${host}`, `x-date:${xDate}`, `x-content-sha256:${payloadSha}`, "content-type:application/json; charset=utf-8"].join("\n") + "\n";
	const signedHeaders = "host;x-date;x-content-sha256;content-type";
	const canonicalRequest = ["POST", "/", canonicalQuery, canonicalHeaders, signedHeaders, payloadSha].join("\n");
	const stringToSign = ["HMAC-SHA256", xDate, scope, createHash("sha256").update(canonicalRequest, "utf8").digest("hex")].join("\n");
	const kDate = createHmac("sha256", SK).update(shortDate, "utf8").digest();
	const kRegion = createHmac("sha256", kDate).update(REGION, "utf8").digest();
	const kService = createHmac("sha256", kRegion).update("ark", "utf8").digest();
	const kSigning = createHmac("sha256", kService).update("request", "utf8").digest();
	const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
	return `HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

test("buildVolcengineCanonicalQuery 按 key 字典序输出 Action/Region/Version", () => {
	const query = buildVolcengineCanonicalQuery(ACTION, REGION);
	assert.equal(query, "Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01");
	// region 传特殊字符时需 RFC3986 编码（中文 region 不会出现，但冒号/斜杠必须安全）。
	assert.equal(buildVolcengineCanonicalQuery(ACTION, "ap/southeast:1"), "Action=GetAFPUsage&Region=ap%2Fsoutheast%3A1&Version=2024-01-01");
});

test("buildVolcengineSignedHeaders 与官方规范逐字段一致（默认 ark 地域专属入口）", () => {
	const headers = buildVolcengineSignedHeaders({ accessKeyId: AK, secretAccessKey: SK, action: ACTION, region: REGION, now: NOW });
	// Authorization 由测试内独立实现复算：保证规格被完整实现（含固定 header 顺序、request 结尾）。
	assert.equal(headers.Authorization, recomputeAuthorization());
	// 算法串是 HMAC-SHA256 且 scope 结尾 request（火山变体，不是标准 SigV4 的 AWS4-HMAC-SHA256/aws4_request）。
	assert.doesNotMatch(headers.Authorization, /AWS4/);
	assert.doesNotMatch(headers.Authorization, /aws4_request/);
	// X-Date 秒级 UTC，X-Content-Sha256 是 POST 空体 "{}" 的摘要（body 参与签名）。
	assert.equal(headers["X-Date"], "20240201T120000Z");
	assert.equal(headers["X-Content-Sha256"], createHash("sha256").update("{}", "utf8").digest("hex"));
	// Content-Type 必须与 CanonicalHeaders 里的值完全一致（多一个分号都会签名不匹配）。
	assert.equal(headers["Content-Type"], "application/json; charset=utf-8");
});

test("buildVolcengineSignedHeaders 同一时刻输出确定，region 缺省回落默认地域", () => {
	const first = buildVolcengineSignedHeaders({ accessKeyId: AK, secretAccessKey: SK, action: ACTION, now: NOW });
	const second = buildVolcengineSignedHeaders({ accessKeyId: AK, secretAccessKey: SK, action: ACTION, now: NOW });
	assert.deepEqual(first, second);
	// region 不传：scope 用默认地域（调用方通常已从 base_url 推断，这里是兜底）。
	assert.match(first.Authorization, new RegExp(`Credential=${AK}/20240201/cn-beijing/ark/request`));
	// 自定义接口版本要能覆盖默认 2024-01-01（方舟未来若升版本，签名与 URL 必须同步变）。
	const upgraded = buildVolcengineUsageCandidate(ACTION, { accessKeyId: AK, secretAccessKey: SK }, { version: "2025-01-01" });
	assert.equal(new URL(String(upgraded.absoluteUrl)).searchParams.get("Version"), "2025-01-01");
});

test("resolveVolcengineRegion 从数据面域名推断区域，无匹配回落默认区域", () => {
	assert.equal(resolveVolcengineRegion("https://ark.cn-beijing.volces.com/api/v3"), "cn-beijing");
	assert.equal(resolveVolcengineRegion("https://ark.cn-shanghai.volces.com"), "cn-shanghai");
	assert.equal(resolveVolcengineRegion("ark.ap-southeast.volces.com/api/v3"), "ap-southeast");
	assert.equal(resolveVolcengineRegion("https://ark.ap-southeast.volces.com/api/v3"), "ap-southeast");
	// 无 <region> 子域的域名（如文档里的海外示例）不能瞎猜，回落默认区域。
	assert.equal(resolveVolcengineRegion("https://ark.bytedanceapi.com"), "cn-beijing");
	assert.equal(resolveVolcengineRegion(""), "cn-beijing");
	assert.equal(resolveVolcengineRegion(undefined), "cn-beijing");
});

test("buildVolcengineSignedHeaders 自定义 host（统一网关兜底入口）按该 host 签", () => {
	// host 参与 CanonicalHeaders：签名里的 host 必须与真实请求 URL 一致，否则服务端校验失败。
	// 统一网关入口是模板里的兜底候选，必须能按 open.volcengineapi.com 正确签出来。
	const headers = buildVolcengineSignedHeaders({ accessKeyId: AK, secretAccessKey: SK, action: ACTION, region: REGION, host: VOLCENGINE_API_HOST, now: NOW });
	assert.equal(headers.Authorization, recomputeAuthorization(VOLCENGINE_API_HOST));
	// 同一 host 签名确定；换 host 签名必须变（证明 host 真的进了签名，而不是只拼在 URL 上）。
	const arkHeaders = buildVolcengineSignedHeaders({ accessKeyId: AK, secretAccessKey: SK, action: ACTION, region: REGION, now: NOW });
	assert.notEqual(headers.Authorization, arkHeaders.Authorization);
});

test("buildVolcengineUsageCandidate 构造控制面 POST 候选（绝对 URL + 无 Bearer + 签名头）", () => {
	const candidate = buildVolcengineUsageCandidate(ACTION, { accessKeyId: AK, secretAccessKey: SK }, { region: REGION, now: NOW });
	// 默认 host 是 ark 地域专属控制面入口（官方方舟文档为 GetAFPUsage 指定的入口）。
	const url = new URL(String(candidate.absoluteUrl));
	assert.equal(url.hostname, volcengineArkHost(REGION));
	assert.equal(url.searchParams.get("Action"), ACTION);
	assert.equal(url.searchParams.get("Version"), VOLCENGINE_API_VERSION);
	assert.equal(url.searchParams.get("Region"), REGION);
	assert.equal(candidate.method, "POST");
	// 无参 OpenAPI：固定空 JSON 体（与签名时用的 payload 一致）。
	assert.deepEqual(candidate.body, {});
	// noBearer：签名头里已有 Authorization，自动补的 Bearer 会把它覆盖成无效签名。
	assert.equal(candidate.noBearer, true);
	assert.deepEqual(candidate.parse, { kind: "custom", resolver: "volcengine-plan" });
	assert.equal(candidate.headers?.["Content-Type"], "application/json; charset=utf-8");
	assert.match(String(candidate.headers?.Authorization), /^HMAC-SHA256 Credential=/);
	assert.doesNotMatch(String(candidate.headers?.Authorization), /^Bearer /);
	assert.equal(candidate.headers?.["X-Content-Sha256"], createHash("sha256").update("{}", "utf8").digest("hex"));
	// 签名里的 host 必须就是 URL 的 host（CanonicalHeaders 与真实请求不一致 = 签名不匹配）。
	// X-Date 从被测返回的头里取：候选构造路径用真实时钟，取它再复算等于校验签名自洽。
	const candidateXDate = String(candidate.headers?.["X-Date"]);
	assert.match(candidateXDate, /^\d{8}T\d{6}Z$/);
	assert.equal(candidate.headers?.Authorization, recomputeAuthorization(volcengineArkHost(REGION), candidateXDate));
});

test("buildVolcengineUsageCandidate 可显式指定 host 并同步改写签名", () => {
	const candidate = buildVolcengineUsageCandidate(ACTION, { accessKeyId: AK, secretAccessKey: SK }, { region: REGION, host: VOLCENGINE_API_HOST });
	assert.equal(new URL(String(candidate.absoluteUrl)).hostname, VOLCENGINE_API_HOST);
	// 用真实 X-Date 复算同一 host 的签名：证明 host 既在 URL 里也进了 CanonicalHeaders。
	assert.equal(candidate.headers?.Authorization, recomputeAuthorization(VOLCENGINE_API_HOST, String(candidate.headers?.["X-Date"])));
	// 非默认地域：region 既进签名 scope，也决定 ark 专属 host 的地域段。
	const shanghai = buildVolcengineUsageCandidate(ACTION, { accessKeyId: AK, secretAccessKey: SK }, { region: "cn-shanghai", now: NOW });
	assert.equal(new URL(String(shanghai.absoluteUrl)).hostname, "ark.cn-shanghai.volcengineapi.com");
	assert.match(String(shanghai.headers?.Authorization), /\/cn-shanghai\/ark\/request/);
});

test("canonical query 对真实入参无需转义（Action/Region/Version 全是 [A-Za-z0-9-]）", () => {
	// 火山签名把三个参数放在 query 里，而它们的合法取值（GetAFPUsage / cn-beijing / 2024-01-01）
	// 只含字母数字与连字符，uriEncode 是恒等变换。锁住这一点：将来若引入含特殊字符的取值
	// （如 Region 别名），必须回来核对官方 demo 的转义表，而不是默认继承标准 SigV4。
	const query = buildVolcengineCanonicalQuery("GetCodingPlanUsage", REGION);
	assert.equal(query, "Action=GetCodingPlanUsage&Region=cn-beijing&Version=2024-01-01");
	assert.doesNotMatch(query, /%/);
});

test("buildVolcengineSignedHeaders 同一 region 重复签名结果一致（确定性）", () => {
	const now = new Date("2026-06-01T10:20:30Z");
	const first = buildVolcengineSignedHeaders({ accessKeyId: AK, secretAccessKey: SK, action: ACTION, region: REGION, now });
	const second = buildVolcengineSignedHeaders({ accessKeyId: AK, secretAccessKey: SK, action: ACTION, region: REGION, now });
	assert.deepEqual(first, second);
	assert.equal(first["X-Date"], "20260601T102030Z");
});
