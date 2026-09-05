/**
 * 用量探针专用解析器（结构特殊、声明式路径表达不了的响应，如 xAI billing / Codex usage）。
 *
 * 与 providerUsageProbe 的声明式 parse 不同：这些响应是 percent 桶、cent-wrapper、
 * 多端点链的混合结构，逐字段写路径配置会变成又长又脆的字符串地狱，故注册专用函数。
 * 新增此类 provider 时：在这里加解析函数 → 注册进 CUSTOM_RESOLVERS → 候选表
 * parse 写 { kind: "custom", resolver: "<名字>" }。
 */
import type { ProviderUsageCredits } from "../../shared/types/providerUsage";
import type { UsageProbeResponse } from "./providerUsageProbe";
import { getByPath, toNumber } from "./providerUsagePath";

/** 专用解析器表：kind:"custom" 的 resolver 名称 → 解析函数。 */
const CUSTOM_RESOLVERS: Record<
	"xai-billing" | "codex-usage" | "commandcode-credits",
	(body: unknown, raw: string) => UsageProbeResponse
> = {
	"xai-billing": parseXaiBilling,
	"codex-usage": parseCodexUsage,
	"commandcode-credits": parseCommandcodeCredits,
};

/** 按 resolver 名解析（未注册的 resolver 返回 undefined，由调用方回退 raw）。 */
export function resolveCustomUsage(
	resolver: string | undefined,
	body: unknown,
	raw: string,
): UsageProbeResponse | undefined {
	if (!resolver) return undefined;
	const fn = CUSTOM_RESOLVERS[resolver as keyof typeof CUSTOM_RESOLVERS];
	return fn ? fn(body, raw) : undefined;
}

/** xAI 金额字段是 { val: cents } 包装：取 val 除 100 得主单位（元）。 */
function centWrapperToNumber(value: unknown): number | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const val = toNumber((value as Record<string, unknown>).val);
	return val === undefined ? undefined : val / 100;
}

/**
 * xAI consumer billing（/v1/billing?format=credits）解析：
 * config.creditUsagePercent 是套餐内额度占用百分比（0-100），否则回退 monthlyLimit/used
 * （cent wrapper）成美元桶；onDemandCap/onDemandUsed 是超出套餐的按需用量（美元）；
 * prepaidBalance 是预付余额（美元）。
 * 输出 credits.windows：套餐内额度 + 按需用量两条进度条（与智谱多窗口同版式）。
 */
function parseXaiBilling(body: unknown, raw: string): UsageProbeResponse {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { matched: false, raw };
	const config = getByPath(body, "config");
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		return { matched: false, raw };
	}
	const cfg = config as Record<string, unknown>;
	const windows: NonNullable<ProviderUsageCredits["windows"]> = [];
	// 套餐内额度：百分比优先；没有百分比时用月限额/已用（美元）。
	const percent = toNumber(cfg.creditUsagePercent);
	if (percent !== undefined && percent >= 0 && percent <= 100) {
		windows.push({ key: "included", used: percent, total: 100 });
	} else {
		const limit = centWrapperToNumber(cfg.monthlyLimit);
		const used = centWrapperToNumber(cfg.used);
		if (limit !== undefined || used !== undefined) {
			const total = limit ?? used ?? 0;
			windows.push({ key: "included", used: used ?? 0, total });
		}
	}
	// 按需用量（美元）：cap/used 至少有一个才展示。
	const onDemandCap = centWrapperToNumber(cfg.onDemandCap);
	const onDemandUsed = centWrapperToNumber(cfg.onDemandUsed);
	if (onDemandCap !== undefined || onDemandUsed !== undefined) {
		windows.push({ key: "onDemand", used: onDemandUsed ?? 0, total: onDemandCap ?? onDemandUsed ?? 0 });
	}
	if (windows.length === 0) return { matched: false, raw };
	return { matched: true, kind: "credits", credits: { windows } };
}

/**
 * OpenAI Codex（chatgpt.com/backend-api/wham/usage）解析：
 * rate_limit.primary/secondary_window 是 percent 桶（used_percent/limit_window_seconds/reset_at），
 * credits.balance 是剩余点数（has_credits 时），rate_limit_reset_credits.available_count 是兑换重置次数。
 * 输出 credits：主 remaining=credits 余额，windows=primary/secondary 两条 percent 进度条。
 */
function parseCodexUsage(body: unknown, raw: string): UsageProbeResponse {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { matched: false, raw };
	const windows: NonNullable<ProviderUsageCredits["windows"]> = [];
	for (const position of ["primary", "secondary"] as const) {
		const window = getByPath(body, `rate_limit.${position}_window`);
		if (!window || typeof window !== "object" || Array.isArray(window)) continue;
		const used = toNumber((window as Record<string, unknown>).used_percent);
		if (used === undefined) continue;
		windows.push({ key: position, used: Math.min(100, Math.max(0, used)), total: 100 });
	}
	const credits = getByPath(body, "credits");
	const creditsBalance =
		credits && typeof credits === "object" && !Array.isArray(credits)
			? toNumber((credits as Record<string, unknown>).balance)
			: undefined;
	const creditsUnlimited =
		credits && typeof credits === "object" && !Array.isArray(credits)
			? (credits as Record<string, unknown>).has_credits === true &&
			  (credits as Record<string, unknown>).unlimited === true
			: false;
	if (windows.length === 0 && creditsBalance === undefined) return { matched: false, raw };
	return {
		matched: true,
		kind: "credits",
		credits: {
			// has_credits=true 且 unlimited 时没有具体余额数值，只在 windows 里表达占用。
			...(creditsBalance !== undefined && !creditsUnlimited ? { remaining: creditsBalance } : {}),
			...(windows.length > 0 ? { windows } : {}),
		},
	};
}

/**
 * Command Code（commandcode.ai）用量解析。
 *
 * /alpha/billing/credits 响应（API key Bearer 鉴权，与 token-monitor 抓的 web internal
 * 端点同数据，经实测）：
 *   { credits: { monthlyCredits, purchasedCredits, ... }, windowLimits: { fiveHour|five_hour, weekly } }
 * 5h / 周窗口的 used/cap 直接来自响应；月度只有「剩余额度」（credits.monthlyCredits），上限
 * **不在任何接口里**，只能按官方定价表（https://commandcode.ai/docs/plans/*）推算，且必须
 * 双重校验：wire 上报的 5h/周 cap 与套餐表恰好一致 + 剩余额度不超过月度上限。校验不过就
 * 降级为「只显剩余不给百分比」（fail-closed，防止套餐调价后臆造分母）。
 * 输出三窗口：fiveHour / weekly（wire 值）+ monthly（套餐额度池，剩余随之展示）。
 */

/** Command Code 官方套餐定价（来源 commandcode.ai/docs/plans/*，2026-08 核对；仅用于月度分母推算）。 */
const COMMANDCODE_PLANS: ReadonlyArray<{
	id: string;
	label: string;
	monthlyCreditsUsd: number;
	fiveHourCapUsd: number;
	weeklyCapUsd: number;
}> = [
	{ id: "individual-go", label: "Go", monthlyCreditsUsd: 10, fiveHourCapUsd: 3, weeklyCapUsd: 6 },
	{ id: "individual-goat", label: "GOAT", monthlyCreditsUsd: 70, fiveHourCapUsd: 14, weeklyCapUsd: 35 },
	{ id: "individual-pro", label: "Pro", monthlyCreditsUsd: 80, fiveHourCapUsd: 16, weeklyCapUsd: 40 },
	{ id: "individual-max", label: "Max 10x", monthlyCreditsUsd: 150, fiveHourCapUsd: 45, weeklyCapUsd: 90 },
	{ id: "individual-ultra", label: "Max 20x", monthlyCreditsUsd: 300, fiveHourCapUsd: 90, weeklyCapUsd: 180 },
];

/**
 * 由 wire 上报的 5h/周 cap 反查套餐（cap 组合全表唯一）校验剩余额度不超月度上限后，
 * 返回可信的月度分母；查不到套餐或校验失败返回 undefined（调用方降级只显剩余）。
 */
function trustedCommandcodeAllowance(
	fiveHourCap: number | undefined,
	weeklyCap: number | undefined,
	monthlyRemaining: number,
): number | undefined {
	if (fiveHourCap === undefined || weeklyCap === undefined) return undefined;
	const plan = COMMANDCODE_PLANS.find(
		(p) => p.fiveHourCapUsd === fiveHourCap && p.weeklyCapUsd === weeklyCap,
	);
	if (!plan) return undefined;
	if (monthlyRemaining > plan.monthlyCreditsUsd) return undefined;
	return plan.monthlyCreditsUsd;
}

/**
 * Command Code credits 解析：
 * - 月度剩余 = credits.monthlyCredits（必填，缺失即不匹配）；
 * - 滚动限额曾在响应根与 credits 子对象两个位置出现（token-monitor 记录两种形态都存活），
 *   且字段名有 cap/limit、fiveHour/five_hour 两种拼写，全部兼容读取；
 * - 月度窗口按套餐表反查可信额度出百分比，否则只带 remaining（UI 灰字显示「窗口名 + 剩余」）。
 */
function parseCommandcodeCredits(body: unknown, raw: string): UsageProbeResponse {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { matched: false, raw };
	const root = body as Record<string, unknown>;
	const creditsBox = root.credits;
	const credits =
		creditsBox && typeof creditsBox === "object" && !Array.isArray(creditsBox)
			? (creditsBox as Record<string, unknown>)
			: {};
	const monthlyRemaining = toNumber(
		credits.monthlyCredits ?? credits.monthly_credits ?? root.monthlyCredits ?? root.monthly_credits,
	);
	if (monthlyRemaining === undefined) return { matched: false, raw };
	const windowBoxRaw =
		credits.windowLimits ?? credits.window_limits ?? root.windowLimits ?? root.window_limits;
	const windowBox =
		windowBoxRaw && typeof windowBoxRaw === "object" && !Array.isArray(windowBoxRaw)
			? (windowBoxRaw as Record<string, unknown>)
			: {};
	const rawWindow = (key: "fiveHour" | "weekly"): Record<string, unknown> | undefined => {
		const w = windowBox[key] ?? windowBox[key === "fiveHour" ? "five_hour" : "weekly"];
		return w && typeof w === "object" && !Array.isArray(w) ? (w as Record<string, unknown>) : undefined;
	};
	const capOf = (w?: Record<string, unknown>): number | undefined => {
		if (!w) return undefined;
		const cap = toNumber(w.cap ?? w.limit);
		return cap !== undefined && cap > 0 ? cap : undefined;
	};
	const usedOf = (w?: Record<string, unknown>): number | undefined => {
		if (!w) return undefined;
		const used = toNumber(w.used);
		return used === undefined ? undefined : Math.max(0, used);
	};
	const fiveHourCap = capOf(rawWindow("fiveHour"));
	const fiveHourUsed = usedOf(rawWindow("fiveHour"));
	const weekCap = capOf(rawWindow("weekly"));
	const weekUsed = usedOf(rawWindow("weekly"));
	const windows: NonNullable<ProviderUsageCredits["windows"]> = [];
	if (fiveHourCap !== undefined && fiveHourUsed !== undefined) {
		windows.push({ key: "fiveHour", total: fiveHourCap, used: fiveHourUsed });
	}
	if (weekCap !== undefined && weekUsed !== undefined) {
		windows.push({ key: "weekly", total: weekCap, used: weekUsed });
	}
	// 月度窗口：有可信额度出「已用/总额」百分比，否则只显剩余（不臆造百分比）。
	const allowance = trustedCommandcodeAllowance(fiveHourCap, weekCap, monthlyRemaining);
	windows.push(
		allowance === undefined
			? { key: "monthly", remaining: monthlyRemaining }
			: {
					key: "monthly",
					total: allowance,
					used: Math.max(0, Math.min(allowance, allowance - monthlyRemaining)),
					remaining: monthlyRemaining,
				},
	);
	if (windows.length === 0) return { matched: false, raw };
	return {
		matched: true,
		kind: "credits",
		credits: {
			// 主剩余兜底：窗口全部被 UI 跳过时 inline 回退到「剩 63.45」；窗口渲染期间主值不出现。
			remaining: monthlyRemaining,
			windows,
		},
	};
}
