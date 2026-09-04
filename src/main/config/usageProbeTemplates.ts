/**
 * 用量查询模板目录（主进程，纯函数可单测）。
 *
 * 学 cc-switch 的「预设模板」分层，但收敛为三类声明式模板（用户可选）：
 * - general：通用 OpenAI 兼容 /usage（{ balance, unit }），端点/密钥可用供应商配置或显式覆盖；
 * - newapi：New API / OneAPI 中转站 /api/user/self（访问令牌 + 用户 ID，积分 /500000 → USD）；
 * - cookie：自研网关网页后台接口（如 /api/wallet/summary），用登录态 Cookie 而非 apiKey
 *   （noBearer 防止与自动补的 Bearer 构成双凭证冲突，见 AMBIGUOUS_CREDENTIALS 坑）。
 *
 * 「自定义接口（高级）」不开放：用户和我们都不需要脚本级自定义；旧 probes 数组
 * 仅保留读取兼容（AI 直接写），UI 不再暴露字段级表单。
 *
 * 内置候选表（providerUsageProbe.ts）自动识别命中的模板不允许用户改写结构，
 * 只提供「识别结果」让弹窗显示说明（模型：内置默认开、零配置）。
 */
import { stripOpenAiVersionPath } from "./baseUrlPath";
import type {
	UsageProbeProviderConfig,
	UsageProbeTemplateCategory,
	UsageProbeTemplateMeta,
} from "../../shared/types/providerUsage";
import type { UsageProbeCandidate, UsageProbeParse } from "./providerUsageProbe";

/** 声明式模板元数据（渲染层 pills 数据源；id 稳定，文案走 i18n）。 */
export const USAGE_PROBE_TEMPLATES: readonly UsageProbeTemplateMeta[] = [
	{ id: "general", category: "general" },
	{ id: "newapi", category: "newapi" },
	{ id: "cookie", category: "cookie" },
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
};

/** 声明式模板 id 是否合法（general / newapi）。 */
export function isDeclarativeTemplateId(id: string): boolean {
	return id === "general" || id === "newapi" || id === "cookie";
}

/**
 * 由声明式模板 id + provider 配置构建探测候选。
 * baseUrl/apiKey 取自「配置显式覆盖 ?? 供应商端点解析结果」，调用方传入有效值。
 * 返回 { candidate }（可用）或 { error }（缺必填字段/非法 id）。
 */
export function buildDeclarativeUsageProbeTemplate(
	templateId: string,
	config: Pick<
		UsageProbeProviderConfig,
		"apiKey" | "baseUrl" | "accessToken" | "userId" | "cookie" | "cookiePath" | "valuePath" | "currencyPath"
	>,
	endpoint: { baseUrl: string; apiKey: string },
): { candidate: UsageProbeCandidate; baseUrl: string; apiKey: string } | { error: string } {
	if (templateId === "general") {
		return {
			candidate: generalUsageProbe(),
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
		return {
			candidate: {
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
			},
			baseUrl,
			apiKey: endpoint.apiKey,
		};
	}
	if (templateId === "cookie") {
		const cookie = config.cookie?.trim() ?? "";
		const cookiePath = config.cookiePath?.trim() ?? "";
		const valuePath = config.valuePath?.trim() ?? "";
		if (!cookie || !cookiePath || !valuePath) {
			return {
				error: !cookie
					? "Cookie 模板需要网页登录态 Cookie（F12 → Network → 请求头 Cookie）"
					: !cookiePath
						? "Cookie 模板需要接口路径（如 /api/wallet/summary）"
						: "Cookie 模板需要余额字段路径（如 data.availableBalanceCny）",
			};
		}
		// 与 newapi 同理：管理接口挂在站点根，baseUrl 常带 /v1，剥离版本段得到管理根，
		// 用户只配一次推理地址。noBearer 必须关闭自动补的 Bearer（Cookie 登录态接口与
		// apiKey 双凭证；如 Token Rhythm 会返回 AMBIGUOUS_CREDENTIALS 400）。
		const baseUrl = stripOpenAiVersionPath(config.baseUrl?.trim() || endpoint.baseUrl);
		return {
			candidate: {
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
			},
			baseUrl,
			apiKey: endpoint.apiKey,
		};
	}
	return { error: `未知模板：${templateId}` };
}

/**
 * 通用模板候选：多数 OpenAI 兼容网关实现官方 /v1/usage（{ balance, unit }）。
 * 与内置候选表末尾的通用兜底同构（内置兜底不标 templateId，管理面用本模板）。
 */
export function generalUsageProbe(): UsageProbeCandidate {
	const parse: UsageProbeParse = {
		kind: "balance",
		valuePath: "balance",
		currencyPath: "unit",
	};
	return { path: "/usage", parse };
}
