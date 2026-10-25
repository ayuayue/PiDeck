/**
 * 独立货币额度（如 Kimi Boost 点数）解析器。
 *
 * 业务背景：
 * 部分模型供应商（如 Kimi For Coding）在常规周期额度（5小时/周/月）之外，
 * 还提供独立计费的货币钱包（boosterWallet）。这类货币通常采用大整数定点存储
 * （例如 Kimi 1,000,000 定点单位 = 1 分钱），且有自己的本月消耗与月度限额。
 * 将解析逻辑独立，可供声明式探针与自定义专用探针复用，避免跨模块循环依赖。
 */
import type { ProviderUsageBooster } from "../../shared/types/providerUsage";
import { getByPath, toNumber } from "./providerUsagePath";

/**
 * 独立货币额度解析规格（如 Kimi booster 点数）：
 * 与主 credits 并存，响应里挂在单独字段（如 boosterWallet），金额用单独单位（如分/微元）。
 * 由 parseUsageResponseBody 提取进 ProviderUsageResult.booster，不混进主 credits。
 */
export interface UsageProbeBooster {
	/** 当前可用余额路径（如 boosterWallet.balance.amountLeft）。必须有值才算提取成功。 */
	balancePath: string;
	/** 总额度路径（可选，如 boosterWallet.balance.amount）。 */
	totalPath?: string;
	/** 定点换算：余额除以该值得到「分」，再除 100 得主单位（Kimi 为 1_000_000 定点 = 1 分）。 */
	fixedPointPerCent?: number;
	/** 币种路径（可选，如 boosterWallet.monthlyUsed.currency）。 */
	currencyPath?: string;
	/** 本月已用（分）路径（可选，如 boosterWallet.monthlyUsed.priceInCents）。 */
	monthlyUsedCentsPath?: string;
	/** 月限额（分）路径（可选，如 boosterWallet.monthlyChargeLimit.priceInCents）。 */
	monthlyChargeLimitCentsPath?: string;
	/** 月限额是否启用路径（可选，布尔；显式 false 表示不封顶）。 */
	monthlyChargeLimitEnabledPath?: string;
}

/** 独立货币（如 Kimi Boost 点数）解析：定点余额/分钱换算成主单位，任一字段缺省则省略。 */
export function parseBooster(body: unknown, spec: UsageProbeBooster): ProviderUsageBooster | undefined {
	const fixedPointPerCent = spec.fixedPointPerCent ?? 1_000_000;
	const toMajor = (value: number) => value / fixedPointPerCent / 100;
	const balanceRaw = toNumber(getByPath(body, spec.balancePath));
	if (balanceRaw === undefined) return undefined;
	const totalRaw = spec.totalPath ? toNumber(getByPath(body, spec.totalPath)) : undefined;
	const monthlyUsedRaw = spec.monthlyUsedCentsPath ? toNumber(getByPath(body, spec.monthlyUsedCentsPath)) : undefined;
	const monthlyLimitRaw = spec.monthlyChargeLimitCentsPath ? toNumber(getByPath(body, spec.monthlyChargeLimitCentsPath)) : undefined;
	const enabledRaw = spec.monthlyChargeLimitEnabledPath ? getByPath(body, spec.monthlyChargeLimitEnabledPath) : undefined;
	// 显式 false = 服务端声明月限额不封顶（unlimited）；true/缺省则展示限额数值（有的话）。
	const unlimitedMonthly = enabledRaw === false;
	const currencyRaw = spec.currencyPath ? getByPath(body, spec.currencyPath) : undefined;
	const currency = typeof currencyRaw === "string" && currencyRaw.trim() !== "" ? currencyRaw.trim() : undefined;
	return {
		balance: toMajor(balanceRaw),
		...(totalRaw !== undefined ? { total: toMajor(totalRaw) } : {}),
		...(currency ? { currency } : {}),
		...(monthlyUsedRaw !== undefined ? { monthlyUsed: monthlyUsedRaw / 100 } : {}),
		...(monthlyLimitRaw !== undefined && !unlimitedMonthly ? { monthlyChargeLimit: monthlyLimitRaw / 100 } : {}),
		...(unlimitedMonthly ? { unlimitedMonthly: true } : {}),
	};
}
