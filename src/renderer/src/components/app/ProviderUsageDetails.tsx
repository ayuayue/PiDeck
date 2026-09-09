/**
 * Provider 用量/余额详情块（cc-switch 展开模式 TierBar 语言）：
 * 模型选择器展开分组与 SessionContextMeter 圆球面板共用的唯一渲染；供应商配置页不再挂载。
 *
 * 版式学自 cc-switch SubscriptionQuotaFooter/UsageFooter：
 * - 头部：标题 + Clock 相对更新时间 + 刷新按钮（右对齐）；
 * - 百分比窗口（智谱 5h/周/MCP、xAI 套餐/按需、opencode 三档）：label + 圆角进度条
 *   （绿/橙/红按 70/90 阈值）+ 彩色粗体百分比 + 剩余小字；
 * - 余额/credits：灰标签 + 彩色粗体数字（剩 ≤0 红、<10% 橙、其余绿）；
 * - booster（Kimi Boost 等独立货币）：主额度下方子块，不与主额度混单位；
 * - 未启用（徽章/弹窗里的开关关着）：灰字「用量查询未开启」+ 「去配置」，不再空着不解释；
 * - 失败：红字 + 重试 + 「配置用量查询」（onConfigureUsage 深链模型设置）。
 * 数据源 provider-usage-atoms 与 inline 行同一份缓存。
 */
import { AlertCircle, Clock, RefreshCw } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import type {
	ProviderUsageResult,
	UsageProbeBackend,
} from "../../../../shared/types/providerUsage";
import { useProviderUsageEntry, useProviderUsageRefresh, useProviderUsageState } from "../../hooks/useProviderUsage";
import {
	formatAmount,
	formatBalance,
	relativeTimeParts,
	USAGE_TONE_BAR_CLASS,
	USAGE_TONE_TEXT_CLASS,
	usageToneForPercent,
	usageWindowLabelText,
	type UsageTone,
} from "../../utils/providerUsageDisplay";

/** cc-switch TierBar 行：label + 圆角进度条 + 彩色粗体百分比 + 右侧小字。 */
function UsageBarRow(props: {
	label: string;
	percent: number | null;
	/** 进度条右侧的小字（如「剩 12.5」），缺省不显示。 */
	trailing?: string;
}) {
	const tone: UsageTone = usageToneForPercent(props.percent);
	const pct = props.percent == null ? null : Math.min(100, props.percent);
	return (
		<div className="flex items-center gap-2.5">
			<span className="w-14 flex-none truncate text-caption leading-5 text-text-secondary" title={props.label}>
				{props.label}
			</span>
			<span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
				<span
					className={`block h-full rounded-full transition-all ${USAGE_TONE_BAR_CLASS[tone]}`}
					style={{ width: `${pct ?? 0}%` }}
				/>
			</span>
			<span className={`w-9 flex-none text-right font-mono text-caption font-semibold tabular-nums ${USAGE_TONE_TEXT_CLASS[tone]}`}>
				{pct != null ? `${pct}%` : t("sessionContext.usageUnknown")}
			</span>
			{props.trailing && (
				<span className="min-w-0 flex-none text-right font-mono text-micro text-text-tertiary">
					{props.trailing}
				</span>
			)}
		</div>
	);
}

/** 独立货币子块（如 Kimi Boost 点数）：与主额度并存的级联小字排版。 */
function BoosterBlock(props: { booster: NonNullable<ProviderUsageResult["booster"]> }) {
	const booster = props.booster;
	const asBalance = (value: number): string =>
		formatBalance({ value, currency: booster.currency });
	return (
		<div
			className="mt-1 space-y-0.5 border-t border-border/60 pt-1.5"
			data-testid="provider-usage-booster"
		>
			<div className="flex items-center justify-between gap-4 px-0.5">
				<span className="shrink-0 text-caption leading-5 text-text-secondary">
					{t("sessionContext.usageBoosterBalance")}
				</span>
				<span className="min-w-0 text-right font-mono font-semibold tabular-nums text-green-600 dark:text-green-400">
					{asBalance(booster.balance)}
				</span>
			</div>
			{booster.monthlyUsed != null && (
				<div className="flex items-center justify-between gap-4 px-0.5">
					<span className="shrink-0 text-caption leading-5 text-text-secondary">
						{t("sessionContext.usageBoosterMonthlyUsed")}
					</span>
					<span className="min-w-0 text-right font-mono tabular-nums text-text-tertiary">
						{asBalance(booster.monthlyUsed)}
					</span>
				</div>
			)}
			{booster.unlimitedMonthly ? (
				<div className="flex items-center justify-between gap-4 px-0.5">
					<span className="shrink-0 text-caption leading-5 text-text-secondary">
						{t("sessionContext.usageBoosterMonthlyLimit")}
					</span>
					<span className="min-w-0 text-right font-mono tabular-nums text-text-tertiary">
						{t("sessionContext.usageBoosterUnlimited")}
					</span>
				</div>
			) : booster.monthlyChargeLimit != null ? (
				<div className="flex items-center justify-between gap-4 px-0.5">
					<span className="shrink-0 text-caption leading-5 text-text-secondary">
						{t("sessionContext.usageBoosterMonthlyLimit")}
					</span>
					<span className="min-w-0 text-right font-mono tabular-nums text-text-tertiary">
						{asBalance(booster.monthlyChargeLimit)}
					</span>
				</div>
			) : null}
		</div>
	);
}

/** 行标签统一样式（灰标签 + 右侧数值，cc-switch UsageFooter 同款对齐）。 */
const LABEL_CLASS = "shrink-0 text-caption leading-5 text-text-secondary";

export function ProviderUsageDetails(props: {
	provider: string;
	/** 查询/缓存链路：dsh（$DSH_HOME 配置 + DSH 凭据库）或 pi（缺省）。
	 *  圆球面板按会话后端透传——DSH 会话配在 dsh 链路的探针不会被当成 pi 配置漏查。 */
	backend?: UsageProbeBackend;
	/** 失败态「去配置」动作：圆球面板/选择器深链模型设置。缺省不渲染按钮。 */
	onConfigureUsage?: () => void;
	className?: string;
}) {
	const entry = useProviderUsageEntry(props.provider || undefined, props.backend);
	const state = useProviderUsageState(props.provider || undefined, props.backend);
	const refresh = useProviderUsageRefresh();
	if (!props.provider) return null;
	const loading = entry.status === "loading";
	const result = entry.result;
	// 开关关着（默认态）：不查也不空着——直接告诉用户去哪开。
	const notEnabled = state != null && !state.enabled;
	const balance = result?.kind === "balance" && result.success ? result.balance : undefined;
	const credits = result?.kind === "credits" && result.success ? result.credits : undefined;
	const periods = result?.kind === "periods" && result.success ? result.periods : undefined;
	const windows = credits?.windows ?? [];
	const booster = result?.success ? result.booster : undefined;
	const failed = result != null && !result.success;
	const time = entry.fetchedAt != null ? relativeTimeParts(entry.fetchedAt) : null;

	return (
		<div
			className={cn("space-y-1.5 border-t border-border pt-2", props.className)}
			data-testid="provider-usage-details"
			data-provider={props.provider}
			data-status={entry.status}
			data-enabled={state ? (state.enabled ? "true" : "false") : undefined}
		>
			<div className="flex items-center gap-1.5 px-0.5">
				<span className="text-micro font-semibold uppercase tracking-wide text-text-tertiary">
					{t("sessionContext.usageHeader")}
				</span>
				{time && !loading && (
					<span className="inline-flex items-center gap-0.5 text-[10px] text-text-tertiary">
						<Clock size={10} aria-hidden="true" />
						{t(time.key, time.params)}
					</span>
				)}
				<button
					type="button"
					data-testid="provider-usage-refresh"
					title={t("config.usage.refresh")}
					aria-label={t("config.usage.refresh")}
					onClick={() => refresh(props.provider, props.backend)}
					className="ml-auto flex h-5 w-5 flex-none items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-muted/60 hover:text-foreground"
				>
					<RefreshCw size={12} className={loading ? "animate-pideck-spin" : undefined} />
				</button>
			</div>
			{loading && result == null ? (
				<div className="px-0.5 text-caption leading-5 text-text-tertiary">
					{t("sessionContext.usageRefreshing")}
				</div>
			) : null}
			{balance ? (
				<div className="flex items-center justify-between gap-4 px-0.5">
					<span className={LABEL_CLASS}>{t("sessionContext.usageBalance")}</span>
					<span className={`min-w-0 text-right font-mono font-semibold tabular-nums ${
						balance.value <= 0 ? USAGE_TONE_TEXT_CLASS.empty : USAGE_TONE_TEXT_CLASS.ok
					}`}>
						{formatBalance(balance)}
					</span>
				</div>
			) : null}
			{windows.length > 0 ? (
				<div className="space-y-1">
					{/* 多窗口并列限额（cc-switch TierBar）：逐窗口 label + 进度条 + 百分比 + 剩余小字；
					   主值不重复渲染，避免数字冗余。 */}
					{windows.map((window) => {
						const total = window.total;
						const used = window.used;
						const remaining =
							window.remaining ??
							(total != null && used != null ? Math.max(0, total - used) : undefined);
						// 百分比 = 已用/总额；用超（used>total）封顶 100。total 缺失时不显示百分比。
						const pct =
							total != null && used != null && total > 0
								? Math.min(100, Math.round((used / total) * 100))
								: null;
						// 用量≥90% 红、≥70% 橙、其余绿（cc-switch utilizationColor 阈值）
						const urgent = pct != null && pct >= 90;
						// 窗口名与 inline 行共用 providerUsageDisplay 的统一映射（未知 key 原样展示）。
						const label = usageWindowLabelText(window.key, t);
						return (
							<UsageBarRow
								key={window.key}
								label={label}
								percent={pct}
								trailing={
									remaining != null && !urgent
										? t("sessionContext.usageWindowRemaining", { n: formatAmount(remaining) })
										: undefined
								}
							/>
						);
					})}
					{booster ? <BoosterBlock booster={booster} /> : null}
				</div>
			) : credits ? (
				<div className="space-y-1">
					{credits.remaining != null && (
						<div className="flex items-center justify-between gap-4 px-0.5">
							<span className={LABEL_CLASS}>{t("sessionContext.usageCreditsRemaining")}</span>
							<span className={`min-w-0 text-right font-mono font-semibold tabular-nums ${
								credits.remaining <= 0
									? USAGE_TONE_TEXT_CLASS.empty
									: USAGE_TONE_TEXT_CLASS.ok
							}`}>
								{formatAmount(credits.remaining)}
							</span>
						</div>
					)}
					{credits.used != null && (
						<div className="flex items-center justify-between gap-4 px-0.5">
							<span className={LABEL_CLASS}>{t("sessionContext.usageCreditsUsed")}</span>
							<span className="min-w-0 text-right font-mono tabular-nums text-text-tertiary">
								{formatAmount(credits.used)}
							</span>
						</div>
					)}
					{booster ? <BoosterBlock booster={booster} /> : null}
				</div>
			) : periods ? (
				<div className="space-y-1">
					{(["rolling", "weekly", "monthly"] as const).map((key) => {
						const period = periods[key];
						const label = key === "rolling"
							? t("sessionContext.usageRolling")
							: key === "weekly"
								? t("sessionContext.usageWeekly")
								: t("sessionContext.usageMonthly");
						if (!period) return null;
						return (
							<UsageBarRow
								key={key}
								label={label}
								percent={period.percent ?? null}
							/>
						);
					})}
				</div>
			) : null}
			{notEnabled ? (
				// 未启用：与失败态同一行布局，但用中性色（不是错误，只是没开）。
				<div className="flex items-center gap-1.5 px-0.5 text-caption leading-5 text-text-tertiary">
					<AlertCircle size={12} aria-hidden="true" />
					<span>{t("config.usage.notEnabled")}</span>
					{props.onConfigureUsage && (
						<button
							type="button"
							data-testid="provider-usage-configure"
							onClick={props.onConfigureUsage}
							className="ml-auto inline-flex flex-none items-center rounded px-1.5 py-0.5 text-caption text-text-secondary transition-colors hover:bg-muted/60 hover:text-foreground"
						>
							{t("config.usage.configure")}
						</button>
					)}
				</div>
			) : failed ? (
				// 失败态只占一行（cc-switch 同款极简）：红字提示；「去配置」是行内小链接，
				// 不再渲染全宽大按钮；重试统一走头部的刷新按钮（只保留一个刷新入口）。
				// 结构性「未开启」给专属引导文案（用量查询未开启 → 去配置），其余失败给通用文案。
				<div
					className="flex items-center gap-1.5 px-0.5 text-caption leading-5 text-red-500 dark:text-red-400"
					title={result?.error ?? undefined}
				>
					<AlertCircle size={12} aria-hidden="true" />
					<span>{result?.disabled ? t("config.usage.notEnabled") : t("sessionContext.usageError")}</span>
					{props.onConfigureUsage && (
						<button
							type="button"
							data-testid="provider-usage-configure"
							onClick={props.onConfigureUsage}
							className="ml-auto inline-flex flex-none items-center rounded px-1.5 py-0.5 text-caption text-text-secondary transition-colors hover:bg-muted/60 hover:text-foreground"
						>
							{t("config.usage.configure")}
						</button>
					)}
				</div>
			) : null}
		</div>
	);
}
