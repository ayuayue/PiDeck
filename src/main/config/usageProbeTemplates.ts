/**
 * 用量查询模板目录（主进程，纯函数可单测）。
 *
 * 学 cc-switch 的「预设模板」分层，但收敛为四类声明式模板（用户可选）：
 * - general：通用 OpenAI 兼容 /usage（{ balance, unit }），端点/密钥可用供应商配置或显式覆盖；
 * - newapi：New API / OneAPI 中转站 /api/user/self（访问令牌 + 用户 ID，积分 /500000 → USD）；
 * - cookie：自研网关网页后台接口（如 /api/wallet/summary），用登录态 Cookie 而非 apiKey
 *   （noBearer 防止与自动补的 Bearer 构成双凭证冲突，见 AMBIGUOUS_CREDENTIALS 坑）；
 * - volcengine：火山方舟 AK/SK（控制面 OpenAPI 签名，双 plan 自动探测，凭据在专用弹层填写）；
 * - sub2api：Sub2API 自部署网关 /v1/usage（钱包余额/订阅限额/Key 额度三形态由专用解析器分流）。
 *
 * 「自定义接口（高级）」不开放：用户和我们都不需要脚本级自定义；旧 probes 数组
 * 仅保留读取兼容（AI 直接写），UI 不再暴露字段级表单。
 *
 * 内置候选表（providerUsageProbe.ts）自动识别命中的模板不允许用户改写结构，
 * 只提供「识别结果」让弹窗显示说明（模型：内置默认开、零配置）。
 */
import { stripOpenAiVersionPath } from "./baseUrlPath";
import type { UsageProbeProviderConfig, UsageProbeTemplateCategory, UsageProbeTemplateMeta } from "../../shared/types/providerUsage";
import type { UsageProbeCandidate } from "./providerUsageProbe";
import { buildVolcengineUsageCandidate, resolveVolcengineRegion, VOLCENGINE_API_HOST } from "./volcengineSign";

/** 声明式模板元数据（渲染层 pills 数据源；id 稳定，文案走 i18n）。 */
export const USAGE_PROBE_TEMPLATES: readonly UsageProbeTemplateMeta[] = [
	{ id: "general", category: "general" },
	{ id: "newapi", category: "newapi" },
	{ id: "cookie", category: "cookie" },
	// 火山方舟 AK/SK：凭据不是 apiKey 而是控制台密钥对，入参由专用弹层收集。
	{ id: "volcengine", category: "plan" },
	// Sub2API 网关：/v1/usage 与推理端点同 base，凭据就是供应商 apiKey，零必填字段。
	{ id: "sub2api", category: "sub2api" },
];

/**
 * 内置候选 templateId → 展示类别（识别命中的弹窗默认态）。
 * 与 USAGE_PROBE_CANDIDATES 的 templateId 标记一一对应；新增内置候选时同步登记。
 */
export const USAGE_PROBE_CATEGORY_BY_TEMPLATE_ID: Record<string, UsageProbeTemplateCategory> = {
	"opencode-usage": "plan",
	"deepseek-balance": "balance",
	"openrouter-credits": "balance",
	"kimi-credits": "plan",
	"moonshot-balance": "balance",
	"zhipu-quota": "plan",
	"codex-usage": "subscription",
	"xai-billing": "subscription",
	"commandcode-credits": "plan",
	"tokendance-balance": "balance",
};

/** 声明式模板 id 是否合法（general / newapi / cookie / volcengine / sub2api）。 */
export function isDeclarativeTemplateId(id: string): boolean {
	return id === "general" || id === "newapi" || id === "cookie" || id === "volcengine" || id === "sub2api";
}

/**
 * 由声明式模板 id + provider 配置构建探测候选。
 * baseUrl/apiKey 取自「配置显式覆盖 ?? 供应商端点解析结果」，调用方传入有效值。
 * 返回 { candidate, candidates }（可用）或 { error }（缺必填字段/非法 id）。
 *
 * 为什么同时给 candidate 与 candidates：绝大多数模板只有一个请求，读取方直接用 candidate；
 * 火山方舟是「双 plan 自动探测」的例外，candidates 按顺序尝试（先解析成功者生效）。
 */
export function buildDeclarativeUsageProbeTemplate(
	templateId: string,
	config: Pick<UsageProbeProviderConfig, "apiKey" | "baseUrl" | "accessToken" | "userId" | "cookie" | "cookiePath" | "valuePath" | "currencyPath" | "accessKeyId" | "secretAccessKey">,
	endpoint: { baseUrl: string; apiKey: string },
): { candidates: UsageProbeCandidate[]; candidate: UsageProbeCandidate; baseUrl: string; apiKey: string } | { error: string } {
	if (templateId === "general") {
		return {
			candidate: generalUsageProbe(),
			candidates: [generalUsageProbe()],
			// 显式覆盖优先（用量端点可能与推理端点不同域），否则用供应商解析结果。
			baseUrl: config.baseUrl?.trim() || endpoint.baseUrl,
			apiKey: config.apiKey?.trim() || endpoint.apiKey,
		};
	}
	if (templateId === "newapi") {
		const accessToken = config.accessToken?.trim() ?? "";
		const userId = config.userId?.trim() ?? "";
		if (!accessToken || !userId) {
			return { error: "New API 模板需要访问令牌和用户 ID" };
		}
		// New API 管理端点（/api/user/self）挂在站点根，不在 OpenAI 兼容端点（baseUrl 常带 /v1）
		// 之下：显式覆盖的 baseUrl 优先，未覆盖时从供应商端点解析结果剥离版本段，得到「管理根」。
		// 这样用户只配一次 baseUrl（推理端点），用量查询自动指向管理面，无需猜测或重复填。
		const baseUrl = stripOpenAiVersionPath(config.baseUrl?.trim() || endpoint.baseUrl);
		const candidate: UsageProbeCandidate = {
			path: "/api/user/self",
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"New-Api-User": userId,
			},
			parse: {
				kind: "credits",
				// New API 积分：500000 积分 = 1 美元（scale 命中后统一除）。
				remainingPath: "data.quota",
				usedPath: "data.used_quota",
				scale: 500000,
			},
			// baseUrl 已是管理根：跳过 /v1 版本化补齐，避免先打一个必 404 的 /v1/... 请求。
			noVersionPath: true,
		};
		return { candidate, candidates: [candidate], baseUrl, apiKey: endpoint.apiKey };
	}
	if (templateId === "cookie") {
		const cookie = config.cookie?.trim() ?? "";
		const cookiePath = config.cookiePath?.trim() ?? "";
		const valuePath = config.valuePath?.trim() ?? "";
		if (!cookie || !cookiePath || !valuePath) {
			return {
				error: !cookie ? "Cookie 模板需要网页登录态 Cookie（F12 → Network → 请求头 Cookie）" : !cookiePath ? "Cookie 模板需要接口路径（如 /api/wallet/summary）" : "Cookie 模板需要余额字段路径（如 data.availableBalanceCny）",
			};
		}
		// 与 newapi 同理：管理接口挂在站点根，baseUrl 常带 /v1，剥离版本段得到管理根，
		// 用户只配一次推理地址。noBearer 必须关闭自动补的 Bearer（Cookie 登录态接口与
		// apiKey 双凭证；如 Token Rhythm 会返回 AMBIGUOUS_CREDENTIALS 400）。
		const baseUrl = stripOpenAiVersionPath(config.baseUrl?.trim() || endpoint.baseUrl);
		const candidate: UsageProbeCandidate = {
			path: cookiePath,
			method: "GET",
			headers: { Cookie: cookie },
			parse: {
				kind: "balance",
				valuePath,
				...(config.currencyPath?.trim() ? { currencyPath: config.currencyPath.trim() } : {}),
			},
			noVersionPath: true,
			noBearer: true,
		};
		return { candidate, candidates: [candidate], baseUrl, apiKey: endpoint.apiKey };
	}
	if (templateId === "volcengine") {
		const accessKeyId = config.accessKeyId?.trim() ?? "";
		const secretAccessKey = config.secretAccessKey?.trim() ?? "";
		if (!accessKeyId || !secretAccessKey) {
			return {
				error: !accessKeyId ? "火山方舟模板需要 API Key ID（AK，控制台「访问控制 → 密钥管理」）" : "火山方舟模板需要 Secret Access Key（SK）",
			};
		}
		// Region 从数据面 base_url 推断（如 ark.cn-beijing.volces.com → cn-beijing）：它既是
		// 签名 scope 的地域段，也决定 ark 专属控制面 host（ark.<region>.volcengineapi.com）的地域段。
		const region = resolveVolcengineRegion(config.baseUrl?.trim() || endpoint.baseUrl);
		const credentials = { accessKeyId, secretAccessKey };
		// 双 plan × 双入口共 4 个候选，探测在上层按顺序尝试，命中即停：
		// 1. 双 plan：Agent Plan（GetAFPUsage）与 Coding Plan（GetCodingPlanUsage）是两个独立
		//    Action，同一账号可以只订阅其一。未订阅的那个返回 200 但解析不出窗口
		//    （Quota<=0 / QuotaUsage 空数组），自动落到下一条，不需要调用方判断套餐类型。
		// 2. 双入口：ark.<region>.volcengineapi.com（官方方舟文档为这些 Action 指定的控制面
		//    host）优先，open.volcengineapi.com（OpenAPI 统一网关）兜底。我们无法用真实
		//    AK/SK 联调，两种入口都有官方资料/第三方实现背书，某个入口对特定账号不可用时
		//    由探测自动切换；AK/SK 本身错误则四条同样失败，最终错误里会带每次尝试的
		//    HTTP 状态与响应摘要，用户能看出是密钥问题而不是套餐问题。
		const volcengineEntries = [
			{ action: "GetAFPUsage", host: undefined },
			{ action: "GetAFPUsage", host: VOLCENGINE_API_HOST },
			{ action: "GetCodingPlanUsage", host: undefined },
			{ action: "GetCodingPlanUsage", host: VOLCENGINE_API_HOST },
		];
		const candidates = volcengineEntries.map(({ action, host }) => buildVolcengineUsageCandidate(action, credentials, { region, host }));
		return {
			candidates,
			candidate: candidates[0],
			baseUrl: `https://${VOLCENGINE_API_HOST}`,
			// 凭据已签进请求头；apiKey 传 AK 只为通过「无 key 快速失败」门禁，不作为 Bearer。
			apiKey: accessKeyId,
		};
	}
	if (templateId === "sub2api") {
		// Sub2API 网关：/v1/usage 与 OpenAI 兼容端点同 base（与 newapi/cookie 相反，不剥 /v1，
		// 版本化补齐交给探测层）；鉴权就是供应商 apiKey（自动补 Bearer）。三种计费形态
		//（钱包/订阅/key 额度）结构差异大且随部署版本漂移，交给专用解析器 sub2api-usage 分流。
		return {
			candidate: sub2apiUsageProbe(),
			candidates: [sub2apiUsageProbe()],
			baseUrl: config.baseUrl?.trim() || endpoint.baseUrl,
			apiKey: config.apiKey?.trim() || endpoint.apiKey,
		};
	}
	return { error: `未知模板：${templateId}` };
}

/**
 * 通用模板候选：多数 OpenAI 兼容网关实现官方 /v1/usage（{ balance, unit }）。
 * 与内置候选表末尾的通用兜底同构（内置兜底不标 templateId，管理面用本模板）。
 */
export function generalUsageProbe(): UsageProbeCandidate {
	const parse = {
		kind: "balance",
		valuePath: "balance",
		currencyPath: "unit",
	} as const;
	return { path: "/usage", parse };
}

/** Sub2API 模板候选：钱包余额/订阅限额/Key 额度三形态由专用解析器按响应结构分流。 */
export function sub2apiUsageProbe(): UsageProbeCandidate {
	return { path: "/usage", parse: { kind: "custom", resolver: "sub2api-usage" } };
}
