/**
 * Provider usage/balance 探测（纯函数，可单测）。
 *
 * 设计目标：可扩展——新增 provider 只在此处增补「候选端点 + 响应解析」，不发散到 UI/IPC。
 * 内置策略：
 *   - opencode-go（baseUrl 含 opencode.ai/zen）：GET /usage →
 *     { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
 *   - DeepSeek（baseUrl 含 api.deepseek.com）：GET /user/balance →
 *     { balance_infos: [{ currency, total_balance }] }（total_balance 可能是数字或字符串）
 *   - OpenRouter（baseUrl 含 openrouter.ai）：GET /credits →
 *     { data: { total_credits, total_usage } }（remaining 由 total-used 反推）
 *   - Moonshot / Kimi（baseUrl 含 api.moonshot.ai / api.moonshot.cn）：GET /users/me/balance →
 *     { data: { available_balance, voucher_balance, cash_balance } }（无 currency 字段，.ai=USD/.cn=CNY）
 *   - 通用 OpenAI 兼容网关（api 归一化为 openai-completions / openai-responses / openai-codex-responses）：
 *     GET /usage → { balance, unit }（OpenAI 官方 /usage 结构；不限定 baseUrl，兜底所有 OpenAI 协议站点）
 *
 * 除内置候选外，ConfigManager 还会合并用户自定义探针（~/.pi/agent/usage-probes.json），
 * 两者共用同一套候选结构与解析器。
 */
import type {
	ProviderUsageBooster,
	ProviderUsageCredits,
	ProviderUsageKind,
	ProviderUsagePeriod,
} from "../../shared/types/providerUsage";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { resolveCustomUsage } from "./providerUsageCustom";
import { getByPath, toNumber } from "./providerUsagePath";
export { getByPath, toNumber } from "./providerUsagePath";

/** 多窗口条目的两种形态：绝对路径单窗 / 数组遍历匹配单窗（如智谱按 unit 分类）。 */
export type UsageProbeWindow =
	| {
			key: string;
			totalPath: string;
			usedPath: string;
			remainingPath?: string;
	  }
	| {
			key: string;
			/** 数组路径（如 "data.limits"）：在该数组里按 where 找第一个全部条件匹配的元素。 */
			listPath: string;
			/** 匹配条件（AND）：元素上 getByPath(path) 严格等于 eq。
			 *  多条件用于区分同 unit 但不同 type 的条目（如智谱 5h 窗需 type 为 CREDIT_LIMIT）。 */
			where: { path: string; eq: unknown }[];
			totalPath: string;
			usedPath: string;
			remainingPath?: string;
	  };

/**
 * 独立货币额度解析规格（如 Kimi booster 点数）：
 * 定点余额 / 分钱字段由 fixedPointPerCent 换算成主单位（元）。
 */
export type UsageProbeBooster = {
	/** 余额路径（定点数，如 "boosterWallet.balance.amountLeft"）。 */
	balancePath: string;
	/** 总额路径（定点数）。 */
	totalPath?: string;
	/** 币种路径。 */
	currencyPath?: string;
	/** 本月已用路径（priceInCents 分钱）。 */
	monthlyUsedCentsPath?: string;
	/** 月限额路径（priceInCents 分钱）。 */
	monthlyChargeLimitCentsPath?: string;
	/** 月限额是否启用（boolean）路径；显式 false 视为 unlimited。 */
	monthlyChargeLimitEnabledPath?: string;
	/** 定点换算：余额除以该值得到「分」，再除 100 得主单位（Kimi 为 1_000_000 定点 = 1 分）。 */
	fixedPointPerCent?: number;
};

export type UsageProbeParse =
	/** 三档百分比（默认；不填 parse 即此形态）。 */
	| { kind: "periods" }
	/** 剩余额度：valuePath 必填，currencyPath 可选。 */
	| { kind: "balance"; valuePath: string; currencyPath?: string }
	/**
	 * 额度点数：三个路径至少给一个；remaining 缺省由 total-used 反推。
	 * scale 可选：命中值先除以它（New API 等中转站的 quota 是原始积分，500000 积分 = 1 美元）。
	 * windows 可选：同一响应里的并列限额窗口（如智谱 5h 窗 + 周窗），
	 * 逐条解析进 credits.windows；主 total/used/remaining 仍由三个 path 解析。
	 * booster 可选：同响应里的独立货币（如 Kimi Boost 点数），解析进结果 booster。
	 */
	| {
			kind: "credits";
			totalPath?: string;
			usedPath?: string;
			remainingPath?: string;
			scale?: number;
			windows?: UsageProbeWindow[];
			booster?: UsageProbeBooster;
	  }
	/**
	 * 专用解析器：响应结构特殊（cent 包装、percent/count 混合、多端点链），
	 * 声明式路径表达不了，注册专用函数解析。目前支持 xai-billing / codex-usage /
	 * commandcode-credits。
	 */
	| { kind: "custom"; resolver: "xai-billing" | "codex-usage" | "commandcode-credits" };

/** 链式预检（如 xAI 需先查 identity 拿 userId 再查 billing）：
 *  先请求预检端点，把响应里 capture.path 的值注入主请求的 capture.header。 */
export type UsageProbePreflight = {
	/** 预检端点路径（相对 baseUrl；拼接规则与主端点一致）。 */
	path: string;
	/** 预检端点挂在完全不同 host（如 xAI cli-chat-proxy）时直接给完整 URL，不拼 baseUrl。 */
	absoluteUrl?: string;
	/** 预检额外请求头（{{apiKey}} 占位）。 */
	headers?: Record<string, string>;
	/** 从预检响应取值（getByPath），注入主请求的该 header。 */
	capture: { path: string; header: string };
};

export type UsageProbeCandidate = {
	/** 相对 baseUrl 的路径（如 "/usage"），探测时会先拼版本化 baseUrl。 */
	path: string;
	/**
	 * 端点挂在与 baseUrl 完全不同的 host（如 xAI 用量端点在 cli-chat-proxy.grok.com）：
	 * 直接使用该完整 URL，不拼 baseUrl 也不走版本化补齐。仅限代码内置的官方域名。
	 */
	absoluteUrl?: string;
	/** HTTP 方法；缺省 GET（绝大多数用量/余额端点是 GET）。 */
	method?: "GET" | "POST";
	/** POST 请求体（JSON 序列化）；GET 忽略。 */
	body?: unknown;
	/**
	 * 额外请求头；值里可用 {{apiKey}} 占位，发送前替换成真实 key。
	 * 未显式给出 Authorization 时，自动补 Bearer {apiKey}。
	 */
	headers?: Record<string, string>;
	/** 判定该 provider 适用此候选的条件：baseUrl 包含任一关键字（小写匹配）。 */
	baseUrlContains?: string[];
	/** 判定适用的 api 类型（normalizeApiType 归一化后；缺省任意）。 */
	apiTypes?: string[];
	/**
	 * 端点挂在 host 根而非 baseUrl 路径下（如智谱监控 API /api/monitor/…，与
	 * OpenAI 兼容端点 /api/paas/v4 不在同一 base）：true 时只取 baseUrl 的 origin
	 * 拼接 path，跳过版本化补齐与路径段拼接。
	 */
	rootPath?: boolean;
	/**
	 * 基础地址本身就是管理根（如 New API 模板已在构建时剥离 /v1）：true 时跳过版本化
	 * 补齐，只尝试「原样 baseUrl + path」——补 /v1 只会多一次必 404 的尝试。
	 */
	noVersionPath?: boolean;
	/**
	 * 候选自带自定义鉴权（如 Cookie 登录态 / 非标准头）且与 apiKey 冲突（双凭证），
	 * 或接口根本不接受 Bearer：true 时禁止 buildProbeHeaders 自动补 Authorization，
	 * 避免「Cookie 与 Bearer 凭证不一致」类 400/401（Token Rhythm 实测 AMBIGUOUS_CREDENTIALS）。
	 */
	noBearer?: boolean;
	/** 链式预检：先请求预检端点再请求主端点（如 xAI identity → billing）。 */
	preflight?: UsageProbePreflight;
	/** 响应解析规格；缺省走 periods（opencode-go 兼容）。 */
	parse?: UsageProbeParse;
	/**
	 * 内置候选的模板 id：识别命中后作为 per-provider 配置的默认模板（enabled 门控据此路由），
	 * 类别登记见 usageProbeTemplates.USAGE_PROBE_CATEGORY_BY_TEMPLATE_ID（新增候选需同步登记）。
	 */
	templateId?: string;
};

export type UsageProbeResponse = {
	/** 探测候选是否命中且解析成功。 */
	matched: boolean;
	/** 解析出的展示形态。 */
	kind?: ProviderUsageKind;
	/** kind=periods 的三档用量。 */
	periods?: Partial<Record<"rolling" | "weekly" | "monthly", ProviderUsagePeriod>>;
	/** kind=balance 的剩余额度。 */
	balance?: { value: number; currency?: string };
	/** kind=credits 的额度点数（含可选的多窗口并列限额）。 */
	credits?: ProviderUsageCredits;
	/** 与主额度并存的独立货币（如 Kimi Boost 点数）。 */
	booster?: ProviderUsageBooster;
	/** 未命中或解析失败时保留的原始文本（脱敏后），供 UI 兜底展示。 */
	raw?: string;
};

/** 候选端点表：新增 provider 适配器时在此注册（用户探针会追加在之后）。 */
export const USAGE_PROBE_CANDIDATES: UsageProbeCandidate[] = [
	// opencode-go Zen：/v1/usage 直接给出三档占用百分比 + 重置时间。
	{
		path: "/usage",
		baseUrlContains: ["opencode.ai/zen"],
		templateId: "opencode-usage",
	},
	// DeepSeek：/user/balance 给出余额信息（total_balance 在部分部署里是字符串，解析器已兼容）。
	{
		path: "/user/balance",
		baseUrlContains: ["api.deepseek.com"],
		templateId: "deepseek-balance",
		parse: {
			kind: "balance",
			valuePath: "balance_infos[0].total_balance",
			currencyPath: "balance_infos[0].currency",
		},
	},
	// OpenRouter：/api/v1/key 直接给出 per-key 额度与已用（无需 Management key，普通
	// inference key 即可；/credits 需要 Management key 已被此端点取代）。
	// baseUrl 已含 /api/v1，path 相对其拼接；响应 { data: { limit, usage, limit_remaining } }，
	// remaining 直接用 API 给的值（有 per-key limit 时才存在；免费层 limit 为 null 会被跳过）。
	{
		path: "/key",
		baseUrlContains: ["openrouter.ai"],
		templateId: "openrouter-credits",
		parse: {
			kind: "credits",
			totalPath: "data.limit",
			usedPath: "data.usage",
			remainingPath: "data.limit_remaining",
		},
	},
	// Kimi For Coding（kimi-coding，baseUrl 默认 https://api.kimi.com/coding/v1）：
	// GET /usages 返回周计划主额度 + 子窗口截，字段在 used/remaining 间有历史漂移，
	// 故三个 path 都挂上（remainingPath 命中即用 API 给的剩余，否则由 total-used 反推）。
	// boosterWallet（Boost 点数）是独立货币：定点 1,000,000 单位/分，月限额用分钱
	// priceInCents，与主额度语义不同，故单独解析进结果 booster 字段（不混进主 credits），
	// UI 在主额度下方追加展示，避免误导用户当成同一单位。
	{
		path: "/usages",
		baseUrlContains: ["api.kimi.com"],
		templateId: "kimi-credits",
		parse: {
			kind: "credits",
			totalPath: "usage.limit",
			usedPath: "usage.used",
			remainingPath: "usage.remaining",
			booster: {
				balancePath: "boosterWallet.balance.amountLeft",
				totalPath: "boosterWallet.balance.amount",
				currencyPath: "boosterWallet.monthlyUsed.currency",
				monthlyUsedCentsPath: "boosterWallet.monthlyUsed.priceInCents",
				monthlyChargeLimitCentsPath: "boosterWallet.monthlyChargeLimit.priceInCents",
				monthlyChargeLimitEnabledPath: "boosterWallet.monthlyChargeLimitEnabled",
			},
		},
	},
	// Moonshot / Kimi（国内 .cn 与国际 .ai 是同一个 balance 端点）：/users/me/balance
	// 返回 { data: { available_balance, voucher_balance, cash_balance } }，available_balance=现金+赠送券，
	// ≤0 不可调用推理 API；无 currency 字段（.ai 计 USD、.cn 计 CNY），故不标币种。
	{
		path: "/users/me/balance",
		baseUrlContains: ["api.moonshot.ai", "api.moonshot.cn"],
		templateId: "moonshot-balance",
		parse: {
			kind: "balance",
			valuePath: "data.available_balance",
		},
	},
	// 智谱 GLM Coding Plan：监控 API 挂在 host 根（/api/monitor/…），与 OpenAI 兼容端点
	// /api/paas/v4 不在同一 base 下，故用 rootPath 只取 baseUrl 的 origin 拼接。
	// 认证要求裸 apiKey（Authorization 不加 Bearer 前缀）。
	// limits 是数组，按 unit/type 遍历分类而非硬编码下标（下标顺序不稳定）：
	//   unit:3 → 5h 滚动窗、unit:6 → 周窗（自下单起 7 天周期重置）、
	//   type:TIME_LIMIT → MCP 月度额度（usage=总配额、currentValue=已用）。
	// 任一耗尽都可能 429，都要给用户看到；percentage 只是百分比，不能当 used 参与计算。
	// 放在通用 OpenAI 候选之前：命中 open.bigmodel.cn 时优先走本候选。
	{
		path: "/api/monitor/usage/quota/limit",
		rootPath: true,
		templateId: "zhipu-quota",
		// api.z.ai 是 GLM Coding Plan 的国际版 origin，与 open.bigmodel.cn 同一监控端点。
		baseUrlContains: ["open.bigmodel.cn", "api.z.ai"],
		headers: { Authorization: "{{apiKey}}" },
		parse: {
			kind: "credits",
			// 主值兜底取 5h 窗；windows 非空时 UI 只渲染 windows，主值不参与展示。
			totalPath: "data.limits[0].usage",
			usedPath: "data.limits[0].currentValue",
			// 双限额窗口并列展示：limits[0]=5h 滚动窗（unit:3,number:5）、limits[1]=周窗
			// （unit:6,number:1，自下单起 7 天周期重置）。任一耗尽都可能 429，两个都要给用户看到。
			windows: [
				// 5h 滚动窗与周窗都要求 type 为 CREDIT_LIMIT（plan usage）：TIME_LIMIT（MCP 月额度）
				// 也可能带 unit 3，仅按 unit 匹配会误伤，故 type+unit 双条件 AND。
				{ key: "fiveHour", listPath: "data.limits", where: [{ path: "type", eq: "CREDIT_LIMIT" }, { path: "unit", eq: 3 }], totalPath: "usage", usedPath: "currentValue" },
				{ key: "weekly", listPath: "data.limits", where: [{ path: "type", eq: "CREDIT_LIMIT" }, { path: "unit", eq: 6 }], totalPath: "usage", usedPath: "currentValue" },
				{ key: "mcpMonthly", listPath: "data.limits", where: [{ path: "type", eq: "TIME_LIMIT" }], totalPath: "usage", usedPath: "currentValue" },
			],
		},
	},
	// OpenAI Codex（ChatGPT 订阅）：用量端点是 chatgpt.com 后端的 wham/usage，与 pi 内置
	// openai-codex provider 的 baseUrl（https://chatgpt.com/backend-api）同路径下，直接相对拼接。
	// 凭据是 ChatGPT OAuth token（auth.json type:oauth）。响应是 percent 窗 + credits 余额的
	// 混合结构，用专用解析器 codex-usage。放在智谱之后、通用 OpenAI 之前：命中 chatgpt.com
	// 时优先走本候选，不会被通用 /usage 兜底抢走。
	{
		path: "/wham/usage",
		baseUrlContains: ["chatgpt.com"],
		apiTypes: ["openai-codex-responses"],
		templateId: "codex-usage",
		parse: { kind: "custom", resolver: "codex-usage" },
	},
	// xAI（Grok 消费者订阅）：用量端点在 Grok CLI 代理 cli-chat-proxy.grok.com，与官方
	// baseUrl api.x.ai 不同 host，走 absoluteUrl 固定官方域（仅代码内置，不接受用户输入）。
	// 链路是两步：先 GET /v1/user?include=subscription 拿 userId，再带 x-userid 查 billing；
	// 鉴权用 OAuth Bearer（auth.json type:oauth）+ Grok 客户端头。billing 响应是
	// percent/cent-wrapper 混合结构，用专用解析器 xai-billing。
	{
		path: "/v1/billing?format=credits",
		absoluteUrl: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
		baseUrlContains: ["api.x.ai"],
		headers: {
			"X-XAI-Token-Auth": "xai-grok-cli",
			"x-grok-client-version": "1.0.10",
			"x-grok-client-mode": "interactive",
		},
		preflight: {
			path: "/v1/user?include=subscription",
			absoluteUrl: "https://cli-chat-proxy.grok.com/v1/user?include=subscription",
			// identity 预检同样要求 Grok 客户端头 + OAuth Bearer（buildProbeHeaders 自动补）。
			headers: {
				"X-XAI-Token-Auth": "xai-grok-cli",
				"x-grok-client-version": "1.0.10",
				"x-grok-client-mode": "interactive",
			},
			capture: { path: "userId", header: "x-userid" },
		},
		templateId: "xai-billing",
		parse: { kind: "custom", resolver: "xai-billing" },
	},
	// Command Code（commandcode.ai）：用量端点在 host 根 /alpha/…（与 OpenAI 兼容端点
	// /provider/v1 不同 base），走 rootPath 只取 baseUrl 的 origin。鉴权即标准 Bearer apiKey
	// （alpha 端点与 cmd CLI /usage 同源，实测可用）。响应是「月度剩余 + 5h/周滚动窗」混合
	// 结构且月度上限不在接口里，用专用解析器 commandcode-credits：5h/周已用直接展示，
	// 月度百分比按官方定价表双重校验（cap 反查套餐 + 剩余不超上限）推算，校验不过降级只显剩余。
	{
		path: "/alpha/billing/credits",
		rootPath: true,
		baseUrlContains: ["api.commandcode.ai"],
		templateId: "commandcode-credits",
		parse: { kind: "custom", resolver: "commandcode-credits" },
	},
	// 通用 OpenAI 兼容网关：多数 OpenAI 兼容中转站实现官方 /v1/usage 端点
	// （{ balance, unit } 结构）。不限定 baseUrl，仅靠 apiTypes 收窄到 OpenAI 协议，
	// 放在数组末尾——前面带 baseUrlContains 的专有候选优先命中，不会被此条抢走。
	// 不标 templateId：用户探针强制 baseUrlContains（无域名的全局兜底探针是危险配置），
	// 且该兜底已内置生效，无需用户配置。
	{
		path: "/usage",
		apiTypes: ["openai-completions", "openai-responses", "openai-codex-responses"],
		parse: {
			kind: "balance",
			valuePath: "balance",
			currencyPath: "unit",
		},
	},
];

/** 判断候选是否适用于给定 baseUrl / apiType。 */
export function candidateApplies(
	candidate: UsageProbeCandidate,
	baseUrl: string,
	apiType: string,
): boolean {
	if (candidate.baseUrlContains) {
		const lower = baseUrl.toLowerCase();
		const hit = candidate.baseUrlContains.some((needle) => lower.includes(needle));
		if (!hit) return false;
	}
	if (candidate.apiTypes && !candidate.apiTypes.includes(apiType)) return false;
	return true;
}

/** 候选适用 provider 的探测 URL 列表（含版本化 baseUrl 与原样 baseUrl 两条尝试路径）。 */
export function usageProbeUrls(
	candidate: Pick<UsageProbeCandidate, "path" | "absoluteUrl" | "rootPath" | "noVersionPath">,
	baseUrl: string,
	ensureVersionPath: (url: string) => string,
): string[] {
	// absoluteUrl：端点与 baseUrl 不同 host（如 xAI 用量端点在 cli-chat-proxy.grok.com），
	// 直接使用完整官方 URL，不拼 baseUrl、不走版本化补齐。
	if (candidate.absoluteUrl) {
		return [candidate.absoluteUrl];
	}
	// host 根端点（rootPath）：不拼 baseUrl 的路径段，只取 origin，避免把
	// /api/paas/v4 之类 OpenAI 兼容路径拼进不存在的地址。
	if (candidate.rootPath) {
		try {
			return [new URL(baseUrl).origin.replace(/\/+$/, "") + candidate.path];
		} catch {
			// baseUrl 非法：退回常规拼接，由请求层 404 兜底
		}
	}
	const u = baseUrl.replace(/\/+$/, "");
	// noVersionPath：baseUrl 已是管理根（如 New API 剥离 /v1 后），补 /v1 只会多一次必 404 的尝试。
	if (candidate.noVersionPath) {
		return [candidate.path.startsWith("/") ? `${u}${candidate.path}` : `${u}/${candidate.path}`];
	}
	const versioned = ensureVersionPath(baseUrl);
	const primary = `${versioned.replace(/\/+$/, "")}${candidate.path}`;
	const bare = `${u}${candidate.path}`;
	const urls = [primary, bare];
	return [...new Set(urls)];
}

/**
 * 组装请求头：无自定义 Authorization 时自动补 Bearer；headers 里的 {{apiKey}} 替换成真实 key。
 * opts.noBearer（候选 noBearer / 用户探针 skipBearer）＝接口自带独立鉴权（Cookie 等）且
 * 与 apiKey 双凭证冲突时必须关闭自动补，否则服务端可能以「凭证不一致」拒绝请求。
 */
export function buildProbeHeaders(
	candidateHeaders: Record<string, string> | undefined,
	apiKey: string,
	opts?: { noBearer?: boolean },
): Record<string, string> {
	const out: Record<string, string> = {};
	const entries = Object.entries(candidateHeaders ?? {});
	const hasAuth = entries.some(([key]) => key.toLowerCase() === "authorization");
	// 未显式提供鉴权头时按惯例补 Bearer；apiKey 为空则省略（无 key 会在上层快速失败）。
	if (!hasAuth && apiKey && !opts?.noBearer) out.Authorization = `Bearer ${apiKey}`;
	for (const [key, value] of entries) {
		if (typeof value !== "string") continue;
		out[key] = value.replace(/\{\{\s*apiKey\s*\}\}/gi, apiKey);
	}
	return out;
}

/** 解析 /usage 类响应体：三种形态都接受（宽松容错，解析不出则整体回退 raw）。 */
export function parseUsageResponseBody(
	body: unknown,
	raw: string,
	parse: UsageProbeParse = { kind: "periods" },
): UsageProbeResponse {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { matched: false, raw };
	}

	// 余额形态：valuePath 取数值，currencyPath 可选。
	if (parse.kind === "balance") {
		const value = toNumber(getByPath(body, parse.valuePath));
		if (value === undefined) return { matched: false, raw };
		const currency = getByPath(body, parse.currencyPath ?? "");
		return {
			matched: true,
			kind: "balance",
			balance: {
				value,
				...(typeof currency === "string" && currency.trim() !== "" ? { currency: currency.trim() } : {}),
			},
		};
	}

	// 额度点数形态：主值三路径 / windows / booster 至少命中一处；remaining 由 total-used 反推。
	if (parse.kind === "credits") {
		// scale（原始积分 → 主单位）：命中值先除以它；非法 scale 视作 1（不缩放）。
		const scale =
			parse.scale != null && Number.isFinite(parse.scale) && parse.scale > 0 ? parse.scale : 1;
		const scaled = (value: number): number => (scale === 1 ? value : value / scale);
		const total = parse.totalPath ? toNumber(getByPath(body, parse.totalPath)) : undefined;
		const used = parse.usedPath ? toNumber(getByPath(body, parse.usedPath)) : undefined;
		const remaining = parse.remainingPath
			? toNumber(getByPath(body, parse.remainingPath))
			: undefined;
		const scaledTotal = total !== undefined ? scaled(total) : undefined;
		const scaledUsed = used !== undefined ? scaled(used) : undefined;
		const scaledRemaining = remaining !== undefined ? scaled(remaining) : undefined;
		// windows（多窗口并列限额，如智谱 5h 窗+周窗、xAI 套餐+按需）逐条解析：单窗缺值跳过，不拖垮整条。
		// 两种条目形态：绝对路径单窗（scope=body），或 listPath 数组遍历 + where 匹配（scope=命中的元素，
		// 字段路径相对元素，智谱按 unit/type 分类）。
		const windows: NonNullable<ProviderUsageCredits["windows"]> = [];
		for (const window of parse.windows ?? []) {
			const resolved =
				"listPath" in window
					? resolveWindowByList(window, body)
					: { key: window.key, totalPath: window.totalPath, usedPath: window.usedPath, remainingPath: window.remainingPath, scope: body };
			if (!resolved) continue;
			const wTotal = toNumber(getByPath(resolved.scope, resolved.totalPath));
			const wUsed = toNumber(getByPath(resolved.scope, resolved.usedPath));
			const wRemaining = resolved.remainingPath
				? toNumber(getByPath(resolved.scope, resolved.remainingPath))
				: wTotal !== undefined && wUsed !== undefined
					? wTotal - wUsed
					: undefined;
			if (wTotal === undefined && wUsed === undefined && wRemaining === undefined) continue;
			windows.push({
				key: resolved.key,
				...(wTotal !== undefined ? { total: wTotal } : {}),
				...(wUsed !== undefined ? { used: wUsed } : {}),
				...(wRemaining !== undefined ? { remaining: wRemaining } : {}),
			});
		}
		// booster（独立货币，如 Kimi Boost 点数）：与主 credits 并存，解析失败不拖垮主值。
		const booster = parse.booster ? parseBooster(body, parse.booster) : undefined;
		// 命中门槛覆盖三种取值来源：部分网关只给并列限额（windows-only）或独立货币（booster-only），
		// 主值三路径全空也是合法命中，不能误判为「结构不匹配」。
		if (
			scaledTotal === undefined &&
			scaledUsed === undefined &&
			scaledRemaining === undefined &&
			windows.length === 0 &&
			booster === undefined
		) {
			return { matched: false, raw };
		}
		return {
			matched: true,
			kind: "credits",
			credits: {
				...(scaledTotal !== undefined ? { total: scaledTotal } : {}),
				...(scaledUsed !== undefined ? { used: scaledUsed } : {}),
				...(scaledRemaining !== undefined
					? { remaining: scaledRemaining }
					: scaledTotal !== undefined && scaledUsed !== undefined
						? { remaining: scaledTotal - scaledUsed }
						: {}),
				...(windows.length > 0 ? { windows } : {}),
			},
			...(booster ? { booster } : {}),
		};
	}

	// 专用解析器（custom）：响应结构特殊，注册专用函数处理（如 xAI cent-wrapper、Codex percent 窗）。
	// 解析器实现与注册见 providerUsageCustom，probe 只负责分发（避免大文件臃肿）。
	if (parse.kind === "custom") {
		return resolveCustomUsage(parse.resolver, body, raw) ?? { matched: false, raw };
	}

	// periods（默认）：只关心 rolling/weekly/monthly 三个档位。
	const usage = (body as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
		return { matched: false, raw };
	}
	const source = usage as Record<string, unknown>;
	const periods: UsageProbeResponse["periods"] = {};
	let any = false;
	for (const key of ["rolling", "weekly", "monthly"] as const) {
		const entry = source[key];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const item = entry as Record<string, unknown>;
		const parsed: { percent?: number; resetsAt?: string; status?: string } = {};
		if (typeof item.percent === "number") { parsed.percent = item.percent; any = true; }
		if (typeof item.resetsAt === "string") { parsed.resetsAt = item.resetsAt; any = true; }
		if (typeof item.status === "string" && item.status.length > 0) { parsed.status = item.status; }
		if (Object.keys(parsed).length > 0) periods[key] = parsed;
	}
	if (!any) return { matched: false, raw };
	return { matched: true, kind: "periods", periods };
}

/** windows 数组遍历条目解析：在 listPath 数组里找第一个 where 匹配的元素，作为字段取值基准。 */
function resolveWindowByList(
	window: Extract<UsageProbeWindow, { listPath: string }>,
	body: unknown,
):
	| {
			key: string;
			totalPath: string;
			usedPath: string;
			remainingPath?: string;
			scope: unknown;
	  }
	| undefined {
	const list = getByPath(body, window.listPath);
	if (!Array.isArray(list)) return undefined;
	const found = list.find((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return false;
		return window.where.every((cond) => getByPath(item, cond.path) === cond.eq);
	});
	if (found === undefined || found === null || typeof found !== "object" || Array.isArray(found)) {
		return undefined;
	}
	return {
		key: window.key,
		totalPath: window.totalPath,
		usedPath: window.usedPath,
		...(window.remainingPath ? { remainingPath: window.remainingPath } : {}),
		scope: found,
	};
}

/** 独立货币（如 Kimi Boost 点数）解析：定点余额/分钱换算成主单位，任一字段缺省则省略。 */
function parseBooster(body: unknown, spec: UsageProbeBooster): ProviderUsageBooster | undefined {
	const fixedPointPerCent = spec.fixedPointPerCent ?? 1_000_000;
	const toMajor = (value: number) => value / fixedPointPerCent / 100;
	const balanceRaw = toNumber(getByPath(body, spec.balancePath));
	if (balanceRaw === undefined) return undefined;
	const totalRaw = spec.totalPath ? toNumber(getByPath(body, spec.totalPath)) : undefined;
	const monthlyUsedRaw = spec.monthlyUsedCentsPath
		? toNumber(getByPath(body, spec.monthlyUsedCentsPath))
		: undefined;
	const monthlyLimitRaw = spec.monthlyChargeLimitCentsPath
		? toNumber(getByPath(body, spec.monthlyChargeLimitCentsPath))
		: undefined;
	const enabledRaw = spec.monthlyChargeLimitEnabledPath
		? getByPath(body, spec.monthlyChargeLimitEnabledPath)
		: undefined;
	// 显式 false = 服务端声明月限额不封顶（unlimited）；true/缺省则展示限额数值（有的话）。
	const unlimitedMonthly = enabledRaw === false;
	const currencyRaw = spec.currencyPath ? getByPath(body, spec.currencyPath) : undefined;
	const currency =
		typeof currencyRaw === "string" && currencyRaw.trim() !== "" ? currencyRaw.trim() : undefined;
	return {
		balance: toMajor(balanceRaw),
		...(totalRaw !== undefined ? { total: toMajor(totalRaw) } : {}),
		...(currency ? { currency } : {}),
		...(monthlyUsedRaw !== undefined ? { monthlyUsed: monthlyUsedRaw / 100 } : {}),
		...(monthlyLimitRaw !== undefined && !unlimitedMonthly
			? { monthlyChargeLimit: monthlyLimitRaw / 100 }
			: {}),
		...(unlimitedMonthly ? { unlimitedMonthly: true } : {}),
	};
}

/** 专用解析器表：kind:"custom" 的 resolver 名称 → 解析函数。 */


/**
 * 单次探测失败明细（用于全部候选失败时生成可排查的错误提示）。
 * 失败分类三种：HTTP 状态码已知（status）、响应 200 但结构不符（shape）、
 * 网络层失败（超时/不可达，error 字段）。url/body 均已脱敏或截断后再写入。
 */
export type UsageProbeAttempt =
	| { url: string; method: string; status: number; body?: string }
	| { url: string; method: string; kind: "shape" }
	| { url: string; method: string; error: "timeout" | "network" };

/**
 * 失败原因归纳 hint：按「最具解释力」的状态归类，返回 i18n key；无尝试记录返回空串。
 * 优先级：结构不符（多数网关 404 才是常态，200+结构不符是最可疑的接口变更信号）
 *       → 鉴权（401/403 全量）→ 404（全量，多是地址问题）→ 5xx → 超时/网络 → 混合。
 */
export function classifyUsageProbeFailureHint(
	attempts: readonly UsageProbeAttempt[],
): MainProcessTranslationKey | "" {
	if (attempts.length === 0) return "";
	// 全部为 200 但结构不匹配：端点存在，只是字段/格式对不上（接口变更或非预期响应）。
	if (attempts.some((a) => "kind" in a && a.kind === "shape") && attempts.every((a) => "kind" in a && a.kind === "shape")) {
		return "mainConfig.providerUsageHintShape";
	}
	const statuses = attempts.filter((a) => "status" in a).map((a) => a.status);
	if (attempts.length > 0 && statuses.length === attempts.length) {
		if (statuses.every((s) => s === 401 || s === 403)) return "mainConfig.providerUsageHintAuth";
		if (statuses.every((s) => s === 404)) return "mainConfig.providerUsageHintNotFound";
		if (statuses.some((s) => s >= 500)) return "mainConfig.providerUsageHintServer";
	}
	// 全部尝试都没拿到 HTTP 状态（超时 / 网络错误）。
	if (statuses.length === 0 && attempts.every((a) => "error" in a)) {
		return "mainConfig.providerUsageHintTimeout";
	}
	return "mainConfig.providerUsageHintMixed";
}

/** 拼接失败明细文本：尝试行（方法 + URL + 状态/错误 + 响应摘要）+ 归纳提示。 */
export function buildProbeFailureDetail(
	attempts: readonly UsageProbeAttempt[],
	translate: (key: MainProcessTranslationKey) => string,
): string {
	if (attempts.length === 0) return "";
	const lines: string[] = [translate("mainConfig.providerUsageAttemptsTitle")];
	for (const a of attempts) {
		if ("status" in a) {
			lines.push(`${a.method} ${a.url} → HTTP ${a.status}`);
			// 服务端错误摘要（已脱敏截断），保留前 240 字符足够定位是「路径不对」还是「非法请求」。
			if (a.body) lines.push(`  ${a.body.slice(0, 240)}`);
		} else if ("kind" in a && a.kind === "shape") {
			lines.push(`${a.method} ${a.url} → HTTP 200（响应结构与预期不符）`);
		} else {
			lines.push(
				`${a.method} ${a.url} → ${translate(
					"error" in a && a.error === "timeout"
						? "mainConfig.providerUsageAttemptTimeout"
						: "mainConfig.providerUsageAttemptNetwork",
				)}`,
			);
		}
	}
	const hintKey = classifyUsageProbeFailureHint(attempts);
	if (hintKey) {
		lines.push("", `${translate("mainConfig.providerUsageHintTitle")}${translate(hintKey)}`);
	}
	return lines.join("\n");
}
