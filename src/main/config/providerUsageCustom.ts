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
import { parseBooster } from "./providerUsageBooster";

/** 专用解析器表：kind:"custom" 的 resolver 名称 → 解析函数。 */
const CUSTOM_RESOLVERS: Record<"xai-billing" | "codex-usage" | "commandcode-credits" | "kimi-credits" | "volcengine-plan" | "sub2api-usage", (body: unknown, raw: string) => UsageProbeResponse> = {
	"xai-billing": parseXaiBilling,
	"codex-usage": parseCodexUsage,
	"commandcode-credits": parseCommandcodeCredits,
	"kimi-credits": parseKimiCredits,
	"volcengine-plan": parseVolcenginePlan,
	"sub2api-usage": parseSub2ApiUsage,
};

/** 按 resolver 名解析（未注册的 resolver 返回 undefined，由调用方回退 raw）。 */
export function resolveCustomUsage(resolver: string | undefined, body: unknown, raw: string): UsageProbeResponse | undefined {
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
	const creditsBalance = credits && typeof credits === "object" && !Array.isArray(credits) ? toNumber((credits as Record<string, unknown>).balance) : undefined;
	const creditsUnlimited = credits && typeof credits === "object" && !Array.isArray(credits) ? (credits as Record<string, unknown>).has_credits === true && (credits as Record<string, unknown>).unlimited === true : false;
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
function trustedCommandcodeAllowance(fiveHourCap: number | undefined, weeklyCap: number | undefined, monthlyRemaining: number): number | undefined {
	if (fiveHourCap === undefined || weeklyCap === undefined) return undefined;
	const plan = COMMANDCODE_PLANS.find((p) => p.fiveHourCapUsd === fiveHourCap && p.weeklyCapUsd === weeklyCap);
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
	const credits = creditsBox && typeof creditsBox === "object" && !Array.isArray(creditsBox) ? (creditsBox as Record<string, unknown>) : {};
	const monthlyRemaining = toNumber(credits.monthlyCredits ?? credits.monthly_credits ?? root.monthlyCredits ?? root.monthly_credits);
	if (monthlyRemaining === undefined) return { matched: false, raw };
	const windowBoxRaw = credits.windowLimits ?? credits.window_limits ?? root.windowLimits ?? root.window_limits;
	const windowBox = windowBoxRaw && typeof windowBoxRaw === "object" && !Array.isArray(windowBoxRaw) ? (windowBoxRaw as Record<string, unknown>) : {};
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

/** 宽松对象收窄：响应字段是 gin.H 动态拼的，逐字段防御式取值。 */
function asBox(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Sub2API 网关 GET /v1/usage 解析（自部署中转站；结构来源 sub2api 源码
 * backend/internal/handler/gateway_handler.go 的 Usage()，响应随计费形态分三支）：
 * - 钱包（按量分组）：顶层 balance/remaining 同值 + unit（"USD"）；输出 balance 形态。
 * - 订阅（不限量分组的订阅形态）：subscription.{daily,weekly,monthly}_usage_usd 与
 *   *_limit_usd（limit 为 null = 该档不限）；顶层 remaining = 各已配置限额剩余的最小值，
 *   -1 = 未配置任何限额；输出 credits + 多窗口。旧版部署（如 zuiapi）字段名是
 *   used_quota/total_quota/expire_time，作月档窗口的别名兜底。
 * - quota_limited（key 配了总额度或速率限制）：quota.{limit,used,remaining} 三件套 +
 *   rate_limits[]（window "5h"/"1d"/"7d"，各自 limit/used）；输出 credits + 速率窗口。
 * usage.total.actual_cost（该 key 的真实美元消耗）作主值已用的兜底：订阅未配任何限额时
 * （zuiapi 实测形态）没有窗口也没有可用 remaining，只剩「已用」可展示。
 */
function parseSub2ApiUsage(body: unknown, raw: string): UsageProbeResponse {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { matched: false, raw };
	const root = body as Record<string, unknown>;
	const unitRaw = root.unit;
	const unit = typeof unitRaw === "string" && unitRaw.trim() !== "" ? unitRaw.trim() : undefined;
	// 钱包分支：只有钱包形态给顶层 balance（订阅/额度形态不给）；balance 与 remaining 同值。
	const walletBalance = toNumber(root.balance);
	if (walletBalance !== undefined && !asBox(root.subscription)) {
		return { matched: true, kind: "balance", balance: { value: walletBalance, ...(unit ? { currency: unit } : {}) } };
	}
	const windows: NonNullable<ProviderUsageCredits["windows"]> = [];
	// quota_limited：key 总额度三件套 → 主值；速率限制数组 → 并列窗口（5h/1d/7d → 既有窗口 key）。
	const quota = asBox(root.quota);
	const quotaTotal = quota ? toNumber(quota.limit) : undefined;
	const quotaUsed = quota ? toNumber(quota.used) : undefined;
	const quotaRemaining = quota ? toNumber(quota.remaining) : undefined;
	for (const item of Array.isArray(root.rate_limits) ? root.rate_limits : []) {
		const entry = asBox(item);
		if (!entry) continue;
		const windowName = typeof entry.window === "string" ? entry.window : "";
		const key = windowName === "5h" ? "fiveHour" : windowName === "1d" ? "daily" : windowName === "7d" ? "weekly" : null;
		if (!key) continue;
		const total = toNumber(entry.limit);
		const used = toNumber(entry.used);
		if (total === undefined && used === undefined) continue;
		windows.push({ key, ...(total !== undefined ? { total } : {}), ...(used !== undefined ? { used } : {}) });
	}
	// 订阅分支：日/周/月三档 usage/limit 对；limit 缺省或 <=0 = 该档不限额，不出窗口
	//（否则会造出「已用 x / 总额 0」的假窗口）。
	const subscription = asBox(root.subscription);
	if (subscription) {
		const tiers: [key: string, usageField: string, limitField: string][] = [
			["daily", "daily_usage_usd", "daily_limit_usd"],
			["weekly", "weekly_usage_usd", "weekly_limit_usd"],
			["monthly", "monthly_usage_usd", "monthly_limit_usd"],
		];
		for (const [key, usageField, limitField] of tiers) {
			const limit = toNumber(subscription[limitField]);
			if (limit === undefined || limit <= 0) continue;
			const used = toNumber(subscription[usageField]);
			windows.push({ key, total: limit, used: Math.max(0, used ?? 0) });
		}
		// 旧版部署别名：没有 *_limit_usd，只有 used_quota/total_quota，作月档兜底。
		if (!windows.some((window) => window.key === "monthly")) {
			const totalQuota = toNumber(subscription.total_quota);
			if (totalQuota !== undefined && totalQuota > 0) {
				const usedQuota = toNumber(subscription.used_quota);
				windows.push({ key: "monthly", total: totalQuota, used: Math.max(0, usedQuota ?? 0) });
			}
		}
	}
	// 主值：remaining 仅取 >= 0（订阅不限额时是 -1，展示出来会误导成「剩 -1」）。
	const remainingRaw = toNumber(root.remaining);
	const remaining = remainingRaw !== undefined && remainingRaw >= 0 ? remainingRaw : quotaRemaining !== undefined && quotaRemaining >= 0 ? quotaRemaining : undefined;
	// quota_limited 的主值已用取 quota.used（与 total/remaining 同口径）；其余形态取真实消耗。
	const usageTotal = asBox(asBox(root.usage)?.total);
	const actualCost = usageTotal ? toNumber(usageTotal.actual_cost) : undefined;
	const total = quotaTotal !== undefined && quotaTotal > 0 ? quotaTotal : undefined;
	const used = total !== undefined ? quotaUsed : actualCost;
	if (windows.length === 0 && remaining === undefined && used === undefined && total === undefined) {
		return { matched: false, raw };
	}
	return {
		matched: true,
		kind: "credits",
		credits: {
			...(total !== undefined ? { total } : {}),
			...(used !== undefined ? { used } : {}),
			...(remaining !== undefined ? { remaining } : {}),
			...(windows.length > 0 ? { windows } : {}),
		},
	};
}

/**
 * 火山方舟套餐用量解析（GetAFPUsage / GetCodingPlanUsage 二合一）。
 *
 * 业务背景：方舟两种套餐的用量接口响应结构完全不同，但语义都是「几个窗口 + 已用/总额或
 * 百分比」，正好映射到现有 periods 三档（5h → rolling、周 → weekly、月 → monthly）：
 * - Agent Plan（GetAFPUsage）：Result 下 AFPFiveHour/Weekly/Monthly 各带 { Quota, Used,
 *   ResetTime（epoch ms） }，需自行算百分比；Quota<=0 表示该窗口未订阅；
 *   全部窗口 Quota<=0 = 账号没有 Agent Plan（调用方据此回落 Coding Plan）。
 *   AFPDaily 被官方控制台隐藏（其 Quota 常高于周上限，属历史默认值），故与官方展示口径
 *   一致只取 5h/周/月三档。
 * - Coding Plan（GetCodingPlanUsage）：Result.QuotaUsage[] 已给 Percent（0-100）与秒级
 *   重置时间。官方文档未给逐字段规格（依据官方 ark-cli 描述与实测），因此字段名做**防御式
 *   多别名**匹配：数组 QuotaUsage/Usages/Details、窗口名 Level/Type/Period/Label/Window、
 *   百分比 Percent/UsedPercent/UsagePercent、重置 ResetTimestamp/ResetTime；
 *   session 的重置时间为 -1 表示无活跃窗口。
 *
 * 形态判别用「结构特征」而非 Action 名：同一解析器要被两个 Action 共用（双 plan 自动探测），
 * 解析器拿不到请求上下文，按响应结构二分最稳（有 QuotaUsage 即 Coding Plan，否则按 AFP）。
 */
function parseVolcenginePlan(body: unknown, raw: string): UsageProbeResponse {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { matched: false, raw };
	const root = body as Record<string, unknown>;
	// 官方响应是 { ResponseMetadata, Result } 包裹；Result 缺失时退回根对象（网关直出/旧版无包裹）。
	const box = root.Result ?? root;
	if (!box || typeof box !== "object" || Array.isArray(box)) return { matched: false, raw };
	const result = box as Record<string, unknown>;
	const codingList = volcengineCodingPlanList(result);
	if (codingList) {
		const coding = parseVolcengineCodingPlanWindows(codingList);
		return Object.keys(coding).length > 0 ? { matched: true, kind: "periods", periods: coding } : { matched: false, raw };
	}
	const afp = parseVolcengineAfpWindows(result);
	return Object.keys(afp).length > 0 ? { matched: true, kind: "periods", periods: afp } : { matched: false, raw };
}

/** Coding Plan 的窗口数组：官方主名 QuotaUsage，Usages/Details 作兼容别名。 */
function volcengineCodingPlanList(result: Record<string, unknown>): unknown[] | null {
	for (const field of ["QuotaUsage", "Usages", "Details"]) {
		const value = result[field];
		if (Array.isArray(value)) return value;
	}
	return null;
}

/** Coding Plan：QuotaUsage[] → periods；只认 session/weekly/monthly，未知窗口跳过。 */
function parseVolcengineCodingPlanWindows(list: unknown[]): NonNullable<UsageProbeResponse["periods"]> {
	const periods: NonNullable<UsageProbeResponse["periods"]> = {};
	for (const item of list) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const entry = item as Record<string, unknown>;
		// 窗口名主名 Level（实测 2026-06：session/weekly/monthly），其余字段名是防御式别名。
		const key = volcengineCodingPlanWindowKey([entry.Level, entry.Type, entry.Period, entry.Label, entry.Window]);
		if (!key) continue;
		const percent = clampPercent(toNumber(entry.Percent ?? entry.UsedPercent ?? entry.UsagePercent));
		if (percent === undefined) continue;
		periods[key] = volcenginePeriod(percent, entry.ResetTimestamp ?? entry.ResetTime);
	}
	return periods;
}

/** Agent Plan：Result 下的 AFP* 桶 → periods；Quota<=0 的窗口视为未订阅而跳过。 */
function parseVolcengineAfpWindows(result: Record<string, unknown>): NonNullable<UsageProbeResponse["periods"]> {
	const periods: NonNullable<UsageProbeResponse["periods"]> = {};
	// 与控制台展示口径一致：5h/周/月三档（AFPDaily 隐藏，见函数注释）。
	const buckets: [keyof NonNullable<UsageProbeResponse["periods"]>, string][] = [
		["rolling", "AFPFiveHour"],
		["weekly", "AFPWeekly"],
		["monthly", "AFPMonthly"],
	];
	for (const [key, field] of buckets) {
		const bucket = result[field];
		if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
		const box = bucket as Record<string, unknown>;
		const quota = toNumber(box.Quota);
		const used = toNumber(box.Used);
		// Quota 缺失或 <=0：该窗口未订阅（控制台同样不展示），不出桶，避免算出 0/0 的假百分比。
		if (quota === undefined || quota <= 0) continue;
		const percent = clampPercent(used === undefined ? undefined : (used / quota) * 100);
		if (percent === undefined) continue;
		periods[key] = volcenginePeriod(percent, box.ResetTime ?? box.ResetTimestamp);
	}
	return periods;
}

/** Coding Plan 的窗口名（多别名任一命中）→ periods 档位；未知窗口返回 null 由调用方跳过。 */
function volcengineCodingPlanWindowKey(labels: unknown[]): keyof NonNullable<UsageProbeResponse["periods"]> | null {
	for (const label of labels) {
		if (typeof label !== "string") continue;
		const normalized = label.trim().toLowerCase();
		if (normalized === "session" || normalized === "5h" || normalized === "fivehour" || normalized === "five_hour" || normalized === "rolling_5h") return "rolling";
		if (normalized === "weekly" || normalized === "week" || normalized === "7d") return "weekly";
		if (normalized === "monthly" || normalized === "month") return "monthly";
	}
	return null;
}

/** 百分比收敛到 0-100：超卖/脏数据不展示成 >100% 的进度条。 */
function clampPercent(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(100, value));
}

/**
 * 组装一档 periods；重置时间秒/毫秒混用要自适应：
 * AFP 用毫秒时间戳（13 位，官方样例 1778806800000），Coding Plan 用秒（10 位，1782057600）；
 * 0/-1/缺失 = 无重置时间，省略字段（UI 不显示重置行）。
 */
function volcenginePeriod(percent: number, resetValue: unknown): { percent: number; resetsAt?: string } {
	const resetsAt = volcengineResetTime(resetValue);
	return { percent, ...(resetsAt ? { resetsAt } : {}) };
}

function volcengineResetTime(value: unknown): string | undefined {
	const raw = toNumber(value);
	if (raw === undefined || raw <= 0) return undefined;
	// >1e12 视为毫秒（13 位时间戳约在 2001 年之后），否则按秒处理。
	const ms = raw > 1e12 ? raw : raw * 1000;
	const date = new Date(ms);
	return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/**
 * 辅助从 Detail 对象中提取数字（兼容 string 与 number）。
 */
function readDetailNumber(detail: Record<string, unknown> | undefined, key: string): number | undefined {
	if (!detail) return undefined;
	return toNumber(detail[key]);
}

/**
 * Kimi For Coding（api.kimi.com/coding/v1/usages）多窗口用量解析：
 * 业务背景与规则：
 * 1. 5小时滚动限制：在 limits[] 数组中，window.duration === 300 且 timeUnit === "MINUTE" (或 "TIME_UNIT_MINUTE")；
 *    若存在其他自定义 duration/unit，自动提取为对应 label（如 5h、1d 等）；
 * 2. 周限额（7天）：在 usage 对象中（limit/used/remaining）；
 * 3. 月度会员总额度（totalQuota）：
 *    - 正常状态下 totalQuota 常见为 { limit: 100, remaining: 99 }，used 字段经常缺省，且 remaining: 99 是粘性值；
 *    - 冻结/超额状态下（403 access_terminated）会带有 used > 0（如 used: 1）；
 *    - 当 totalQuota 包含用于判断的字段时：
 *      - 若 used 存在且 > 0，说明已达上限/冻结，标记为 total: 1, used: 1, remaining: 0；
 *      - 若 used 为 0 或缺省（仅有 remaining/limit），说明额度可用，标记为 total: 100 (或 limit), remaining: remaining, used: total - remaining（或 100/100 绿条）；
 *        为更直观展示用户看到的“99”，当 remaining 有值时我们保留真实的 limit/remaining/used，使用户清晰看到剩余 99。
 * 4. 独立 Boost 钱包（boosterWallet）：通过 parseBooster 提取，不与普通请求数混淆。
 */
function parseKimiCredits(body: unknown, raw: string): UsageProbeResponse {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { matched: false, raw };
	const root = body as Record<string, unknown>;

	const windows: NonNullable<ProviderUsageCredits["windows"]> = [];

	// 1. 5小时及子窗口限额（limits 列表）
	const limits = root.limits;
	if (Array.isArray(limits)) {
		for (const item of limits) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const limitObj = item as Record<string, unknown>;
			const windowMeta = limitObj.window as Record<string, unknown> | undefined;
			const detail = limitObj.detail as Record<string, unknown> | undefined;
			if (!detail) continue;

			const duration = toNumber(windowMeta?.duration) ?? 0;
			const unitRaw = String(windowMeta?.timeUnit ?? "")
				.toUpperCase()
				.replace(/^TIME_UNIT_/, "");

			// 计算窗口标识 key
			let windowKey: string;
			if (duration === 300 && unitRaw === "MINUTE") {
				windowKey = "fiveHour";
			} else if (duration > 0 && unitRaw) {
				const unitChar = unitRaw.startsWith("HOUR") ? "h" : unitRaw.startsWith("DAY") ? "d" : unitRaw.startsWith("MIN") ? "m" : unitRaw.toLowerCase();
				windowKey = `${duration}${unitChar}`;
			} else {
				windowKey = typeof detail.name === "string" && detail.name ? detail.name : "window";
			}

			const limitNum = readDetailNumber(detail, "limit");
			const usedNum = readDetailNumber(detail, "used");
			let remainingNum = readDetailNumber(detail, "remaining");

			// 只有 remaining 缺省且 total/used 都在时反推 remaining
			if (remainingNum === undefined && limitNum !== undefined && usedNum !== undefined) {
				remainingNum = Math.max(0, limitNum - usedNum);
			}

			if (limitNum !== undefined || usedNum !== undefined || remainingNum !== undefined) {
				windows.push({
					key: windowKey,
					total: limitNum,
					used: usedNum,
					remaining: remainingNum,
				});
			}
		}
	}

	// 2. 周限额（usage 对象）
	const usage = root.usage as Record<string, unknown> | undefined;
	let weeklyRemaining: number | undefined;
	let weeklyTotal: number | undefined;
	let weeklyUsed: number | undefined;
	if (usage && typeof usage === "object" && !Array.isArray(usage)) {
		weeklyTotal = readDetailNumber(usage, "limit");
		weeklyUsed = readDetailNumber(usage, "used");
		weeklyRemaining = readDetailNumber(usage, "remaining");

		// 只有 remaining 缺省且 total/used 都在时反推 remaining
		if (weeklyRemaining === undefined && weeklyTotal !== undefined && weeklyUsed !== undefined) {
			weeklyRemaining = Math.max(0, weeklyTotal - weeklyUsed);
		}

		if (weeklyTotal !== undefined || weeklyUsed !== undefined || weeklyRemaining !== undefined) {
			windows.push({
				key: "weekly",
				total: weeklyTotal,
				used: weeklyUsed,
				remaining: weeklyRemaining,
			});
		}
	}

	// 3. 月度会员限额（totalQuota 对象）
	const totalQuota = root.totalQuota as Record<string, unknown> | undefined;
	if (totalQuota && typeof totalQuota === "object" && !Array.isArray(totalQuota)) {
		const qLimit = readDetailNumber(totalQuota, "limit") ?? 100;
		const qUsed = readDetailNumber(totalQuota, "used");
		const qRemaining = readDetailNumber(totalQuota, "remaining");

		// 若 used 明确 > 0 则表示超额/冻结
		const isExhausted = qUsed !== undefined && qUsed > 0;
		if (isExhausted) {
			windows.push({
				key: "monthly",
				total: qLimit,
				used: qLimit,
				remaining: 0,
			});
		} else if (qRemaining !== undefined || qLimit !== undefined) {
			const used = qUsed ?? (qRemaining !== undefined ? Math.max(0, qLimit - qRemaining) : 0);
			windows.push({
				key: "monthly",
				total: qLimit,
				used,
				remaining: qRemaining ?? Math.max(0, qLimit - used),
			});
		}
	}

	// 4. Boost 钱包独立解析（如果有）
	const booster = parseBooster(body, {
		balancePath: "boosterWallet.balance.amountLeft",
		totalPath: "boosterWallet.balance.amount",
		currencyPath: "boosterWallet.monthlyUsed.currency",
		monthlyUsedCentsPath: "boosterWallet.monthlyUsed.priceInCents",
		monthlyChargeLimitCentsPath: "boosterWallet.monthlyChargeLimit.priceInCents",
		monthlyChargeLimitEnabledPath: "boosterWallet.monthlyChargeLimitEnabled",
	});

	if (windows.length === 0 && weeklyTotal === undefined && weeklyRemaining === undefined) {
		return { matched: false, raw };
	}

	// 主 credits 兜底：以周限额（或首个有效窗口）为主值
	const mainRemaining = weeklyRemaining ?? windows[0]?.remaining;
	const mainTotal = weeklyTotal ?? windows[0]?.total;
	const mainUsed = weeklyUsed ?? windows[0]?.used;

	return {
		matched: true,
		kind: "credits",
		credits: {
			...(mainTotal !== undefined ? { total: mainTotal } : {}),
			...(mainUsed !== undefined ? { used: mainUsed } : {}),
			...(mainRemaining !== undefined ? { remaining: mainRemaining } : {}),
			...(windows.length > 0 ? { windows } : {}),
		},
		...(booster ? { booster } : {}),
	};
}

/**
 * Sub2API 面板用户信息（GET /api/v1/auth/me，网页后台 JWT 鉴权）解析。
 *
 * 上游通用路由（auth_handler.GetCurrentUser → response.Success 包一层
 * { code, message, data }，data 即 userProfileResponse 内嵌 dto.User）：
 *   { "code": 0, "message": "success", "data": { ..., "balance": 12.34, "frozen_balance": 0, ... } }
 * balance 是账户钱包余额（USD），与 API key 维度的用量数字并列展示；冻结额不扣减
 * （与网页面板同口径）。取不到 data.balance 视为未命中——JWT 失效（401 在请求层已被
 * 挡下）或上游结构变更时静默降级，调用方只丢余额段、不影响主用量结果。
 */
export function parseSub2ApiPanelBalance(body: unknown, raw: string): UsageProbeResponse {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { matched: false, raw };
	const data = getByPath(body, "data");
	if (!data || typeof data !== "object" || Array.isArray(data)) return { matched: false, raw };
	const balance = toNumber((data as Record<string, unknown>).balance);
	if (balance === undefined) return { matched: false, raw };
	return { matched: true, kind: "balance", balance: { value: balance, currency: "USD" } };
}
