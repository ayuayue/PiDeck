/**
 * 火山方舟（ark 服务）OpenAPI 用量查询的 AK/SK 签名与候选构造。
 *
 * 为什么需要它：方舟的套餐用量接口在**控制面 OpenAPI**，只认 AK/SK 签名，不接受推理
 * 端点的 API Key Bearer（复用推理 Key 会被网关以 400 InvalidAuthorization 拒绝）。
 * 因此用量查询无法走通用的自动补 Bearer 链路，必须按官方规范现算 Authorization。
 *
 * 签名规范（AWS SigV4 的火山变体，官方 demo：volc-openapi-demos/signature/java/Sign.java）：
 *   CanonicalRequest = HTTPMethod\nCanonicalURI\nCanonicalQueryString\nCanonicalHeaders\nSignedHeaders\nHashedRequestPayload
 *   StringToSign     = "HMAC-SHA256"\nX-Date\nCredentialScope\nSHA256(CanonicalRequest)
 *   SigningKey       = HMAC(HMAC(HMAC(HMAC(SecretKey, yyyymmdd), region), "ark"), "request")
 *
 * **三处与标准 SigV4 的致命差异（照搬标准实现会签名失败）**：
 *   1. canonical headers / SignedHeaders 用**固定顺序**
 *      `host;x-date;x-content-sha256;content-type`（不是字典序）；
 *   2. algorithm 串 `HMAC-SHA256`（无 `AWS4` 前缀），credential scope 结尾是 `request`
 *      （不是 `aws4_request`）；
 *   3. 签名密钥首段 `kDate = HMAC(SecretKey, date)`，SecretKey **不加** `AWS4` 前缀。
 * canonical query 仍按 key 字典序（Action/Region/Version），service 固定 `ark`、POST。
 *
 * 边界与取舍：
 * - host 参与 CanonicalHeaders / SignedHeaders，但**不写进实际请求头**：Chromium 视 Host
 *   为 forbidden header，electron.net.fetch 会静默丢弃；服务端按真实请求 host 校验，一致即可。
 * - X-Date 精度到秒（YYYYMMDDTHHMMSSZ），签名有效期约 ±15 分钟；签名由调用方在每次查询时
 *   现算，不缓存，避免长驻进程用过期的签名。
 * - 控制面 Host 有两种可用入口（ark.<region>.volcengineapi.com / open.volcengineapi.com，
 *   见 VOLCENGINE_API_HOST 上方注释），都与数据面推理域名（ark.<region>.volces.com）无关：
 *   Region 一方面进签名 scope，另一方面决定 ark 专属 host 的地域段。
 */
import { createHash, createHmac } from "node:crypto";
import type { UsageProbeCandidate, UsageProbeParse } from "./providerUsageProbe";

/** 火山方舟（ark 服务）用量接口的 API 版本；官方文档统一 2024-01-01。 */
export const VOLCENGINE_API_VERSION = "2024-01-01";
/** ark 服务的地域与服务名（签名 scope 的第二/三段）。 */
export const VOLCENGINE_SERVICE = "ark";
export const VOLCENGINE_REGION = "cn-beijing";
/**
 * ark 控制面 OpenAPI 的两个可用入口（都只认 AK/SK 签名，均见于官方资料）：
 *
 * 1. `ark.<region>.volcengineapi.com`：方舟文档（82379/2479847 等）与「数据面/管控面
 *    Base URL 及鉴权」文档为 GetAFPUsage 等控制面 Action 指定的入口，按账号地域拼 host；
 * 2. `open.volcengineapi.com`：OpenAPI 统一网关，Region 走 query（cc-switch 的实现即用
 *    这个入口，同样实测可通）。
 *
 * 为什么要两条：我们手里没有真实 AK/SK 可以联调，而两种入口都有第三方实现背书。
 * 按「文档优先」把 ark 专属 host 放前面，统一网关作为兜底候选——某个入口对特定账号
 * 不可用时探测会自动落到下一条（见 usageProbeTemplates 的四候选构造）。
 */
export const VOLCENGINE_API_HOST = "open.volcengineapi.com";

/** ark 服务的地域专属控制面 host（官方方舟文档为 GetAFPUsage 等 Action 指定的入口）。 */
export function volcengineArkHost(region: string): string {
	return `ark.${region}.volcengineapi.com`;
}

/** 签名头必须与实际发送的 Content-Type 完全一致（参与 CanonicalHeaders）。 */
const SIGNED_CONTENT_TYPE = "application/json; charset=utf-8";
/** 参与签名的 header 名：**固定顺序**，火山特有（标准 SigV4 是字典序，这里写死官方值）。 */
const SIGNED_HEADER_NAMES = ["host", "x-date", "x-content-sha256", "content-type"] as const;

/** 无参 OpenAPI 调用（Action/Version/Region 全在 query）的请求体：POST 固定 "{}"。 */
const EMPTY_JSON_BODY = "{}";

export type VolcengineSignRequest = {
	/** Access Key ID（火山引擎控制台「访问控制 → 密钥管理」）。 */
	accessKeyId: string;
	/** Secret Access Key；只用于本地派生签名，不写入任何落盘配置与日志。 */
	secretAccessKey: string;
	/** 接口 Action，如 "GetAFPUsage" / "GetCodingPlanUsage"。 */
	action: string;
	/** 接口 Version，缺省 2024-01-01。 */
	version?: string;
	/** 目标 host，默认 ark.<region>.volcengineapi.com（必须与请求 URL 的 host 一致，否则签名不匹配）。 */
	host?: string;
	/** 请求体（JSON 字符串）；用量查询为无参调用，缺省 "{}"。 */
	body?: string;
	/** 地域，默认 cn-beijing（从数据面 base_url 可推断出别的 Region，见 buildVolcengineUsageCandidate）。 */
	region?: string;
	/** 服务名，默认 ark。 */
	service?: string;
	/** 签名时刻（测试注入用；缺省当前时间）。 */
	now?: Date;
};

/** UTC 时间戳格式化成火山要求的 YYYYMMDDTHHMMSSZ（秒级，过期即失效）。 */
function formatXDate(date: Date): string {
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** RFC3986 编码：除 A-Za-z0-9-._~ 外全部转义（query 参数可能含特殊字符）。 */
function uriEncode(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmacSha256(key: string | Buffer, value: string): Buffer {
	return createHmac("sha256", key).update(value, "utf8").digest();
}

/** 派生 SigningKey：SecretKey → 日期 → 地域 → 服务 → "request"（官方规定的四级 HMAC 链）。 */
function deriveSigningKey(secretAccessKey: string, shortDate: string, region: string, service: string): Buffer {
	// 注意：SecretKey 不加 "AWS4" 前缀，终止串是 "request" 而非 "aws4_request"。
	const kDate = hmacSha256(secretAccessKey, shortDate);
	const kRegion = hmacSha256(kDate, region);
	const kService = hmacSha256(kRegion, service);
	return hmacSha256(kService, "request");
}

/** 构造按 key 字典序排序的 canonical query：Action / Region / Version。 */
export function buildVolcengineCanonicalQuery(action: string, region: string, version = VOLCENGINE_API_VERSION): string {
	return [`Action=${uriEncode(action)}`, `Region=${uriEncode(region)}`, `Version=${uriEncode(version)}`].sort().join("&");
}

/**
 * 生成一组已签名的请求头（Authorization / Content-Type / X-Date / X-Content-Sha256）。
 * 纯函数：同一入参得到同一输出，便于单测逐字段断言。
 * body 只填被 JSON.parse 后可 JSON.stringify 回同一字符串的值（本模板固定 "{}"）：
 * 请求体参与签名，与实际发送体必须逐字节一致。
 */
export function buildVolcengineSignedHeaders(request: VolcengineSignRequest): Record<string, string> {
	const version = request.version ?? VOLCENGINE_API_VERSION;
	const region = request.region ?? VOLCENGINE_REGION;
	const service = request.service ?? VOLCENGINE_SERVICE;
	const host = request.host ?? volcengineArkHost(region);
	const payload = request.body ?? EMPTY_JSON_BODY;
	const xDate = formatXDate(request.now ?? new Date());
	const shortDate = xDate.slice(0, 8);
	const payloadSha = sha256Hex(payload);
	const credentialScope = `${shortDate}/${region}/${service}/request`;

	const canonicalQuery = buildVolcengineCanonicalQuery(request.action, region, version);
	// 固定顺序（host → x-date → x-content-sha256 → content-type），每个头一行 "name:value\n"。
	const canonicalHeaders = SIGNED_HEADER_NAMES.map((name) => (name === "host" ? `host:${host}` : name === "x-date" ? `x-date:${xDate}` : name === "x-content-sha256" ? `x-content-sha256:${payloadSha}` : `content-type:${SIGNED_CONTENT_TYPE}`)).join("\n") + "\n";
	const signedHeaders = SIGNED_HEADER_NAMES.join(";");
	const canonicalRequest = ["POST", "/", canonicalQuery, canonicalHeaders, signedHeaders, payloadSha].join("\n");
	const stringToSign = ["HMAC-SHA256", xDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
	const signature = hmacSha256(deriveSigningKey(request.secretAccessKey, shortDate, region, service), stringToSign).toString("hex");

	return {
		Authorization: `HMAC-SHA256 Credential=${request.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
		"Content-Type": SIGNED_CONTENT_TYPE,
		"X-Date": xDate,
		"X-Content-Sha256": payloadSha,
	};
}

/**
 * 从数据面 base_url 推断控制面 OpenAPI 需要的 Region（如 `ark.cn-beijing.volces.com` → `cn-beijing`）。
 * Region 既是签名 scope 的地域段，也是 ark 专属控制面 host 的地域段；识别不了回落 cn-beijing。
 */
export function resolveVolcengineRegion(baseUrl: string): string {
	// 防御：调用方理论上可能拿到 undefined（配置缺 baseUrl），按兜底默认地域处理。
	if (typeof baseUrl !== "string" || !baseUrl.trim()) return VOLCENGINE_REGION;
	// 用户在设置里可能粘贴不带协议的 base_url（直接「ark.cn-shanghai.volces.com」），这里两种形态都吃。
	const withoutScheme = baseUrl.includes("://") ? (baseUrl.split("://")[1] ?? "") : baseUrl;
	const host = withoutScheme.split("/")[0] ?? "";
	const region = host.split(".").find((part) => /^(cn|ap)-[a-z-]+$/i.test(part));
	return region?.toLowerCase() ?? VOLCENGINE_REGION;
}

/**
 * 构造一个火山用量查询候选（AK/SK 签名头 + 空 body POST）。
 *
 * 为什么每次查询都要重签：签名带 X-Date（有效期 ±15 分钟），SignatoryHeaders 里已含
 * buildVolcengineSignedHeaders 的调用，候选构造即签名，长驻进程反复查询也不会用过期签名。
 *
 * host 决定请求落在哪个控制面入口：默认 ark.<region>.volcengineapi.com（官方方舟文档为
 * GetAFPUsage 指定的入口），也可显式传 VOLCENGINE_API_HOST 走统一网关兜底。host 必须与
 * absoluteUrl 的 host 完全一致，否则 CanonicalHeaders 里的 host 与真实请求不符 → 签名不匹配。
 *
 * parse 固定 custom 解析器 volcengine-plan：AFP 与 CodingPlan 两种响应形态由
 * providerUsageCustom.parseVolcenginePlan 按结构二分，这里不区分（探测顺序见模板）。
 */
export function buildVolcengineUsageCandidate(action: string, credentials: { accessKeyId: string; secretAccessKey: string }, options: { region?: string; version?: string; host?: string } = {}): UsageProbeCandidate {
	const region = options.region ?? VOLCENGINE_REGION;
	const version = options.version ?? VOLCENGINE_API_VERSION;
	// Region 同时进 query 与签名 scope：统一网关入口靠 query 里的 Region 定位地域，
	// ark 专属入口靠 host 段，两种入口都带 Region 是两者的交集，安全。
	const query = buildVolcengineCanonicalQuery(action, region, version);
	const host = options.host ?? volcengineArkHost(region);
	const parse: UsageProbeParse = { kind: "custom", resolver: "volcengine-plan" };
	return {
		// path 仅作尝试明细里的可读标识（绝对 URL 已给全路径，实际不使用它拼接）。
		path: `/?${query}`,
		// 绝对 URL：Host 是控制面入口，与 baseUrl 不同域，不能拼在推理端点之下。
		absoluteUrl: `https://${host}/?${query}`,
		method: "POST",
		// version 必须同时喂给签名与 URL：CanonicalQueryString 与真实 query 不一致会签名不匹配。
		headers: buildVolcengineSignedHeaders({ accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, action, region, version, host }),
		// 签名头里没有 Bearer：必须关掉自动补的 Authorization，否则它会把签名值覆盖掉。
		noBearer: true,
		body: {},
		parse,
	};
}
