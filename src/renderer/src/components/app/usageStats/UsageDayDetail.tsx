/**
 * 按周期用量明细（日/周/月/年）。
 *
 * 顶部工具栏：UsagePeriodPicker 档位切换 + 周期选择；非当前周期时显示回退按钮。
 * 明细区：4 卡（tokens/费用/轮次/会话数）+ provider 堆叠条与图例 + 模型表 + 项目表。
 * 选中周期无记录时显示空态（选择器仍可继续选其他周期）。
 *
 * 数据来自主进程聚合的 daily 行（UsageDayRow 已含 byModel/byProject 明细），
 * 通过 usagePeriodModel 的 aggregateRange 按选中周期再聚合；无新 IPC 通道。
 * 样式走 Tailwind utility + 既有 usage-stats-* 语义 class。
 */

import { useMemo, useState } from "react";
import type { UsageDayRow } from "../../../../../shared/types";
import { getI18nLocale, t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { SettingsSection } from "../settings/SettingsStorageTab";
import { aggregateRange, dayKeyOf, earliestYear, formatPeriodTitle, isCurrentPeriod, resolvePeriod, type UsagePeriodMode } from "./usagePeriodModel";
import { UsagePeriodPicker } from "./UsagePeriodPicker";
import { colorForProvider } from "./providerColors";
import { UsageTable } from "./UsageTable";
import { formatCost, formatTokens } from "./format";

/** 周期卡片（与 UsageStatsTab 的 SummaryCard 同构）。 */
function DayCard(props: { label: string; value: React.ReactNode; sub?: string }) {
	return (
		<div className="usage-stats-card">
			<div className="usage-stats-card-label">{props.label}</div>
			<div className="usage-stats-card-value">{props.value}</div>
			{props.sub && <div className="usage-stats-card-sub">{props.sub}</div>}
		</div>
	);
}

/** provider 堆叠条：色块宽度 = tokens 占比，hover 显示 provider/tokens/费用。 */
function ProviderBar(props: { providers: Array<{ provider: string; tokens: number; cost: number }> }) {
	// 0 tokens 的供应商不占色块；去掉 1% 保底，避免空用量也被画出来。
	const providers = props.providers.filter((p) => p.tokens > 0);
	const total = providers.reduce((acc, p) => acc + p.tokens, 0);
	if (total <= 0) return null;
	return (
		<div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-border-subtle" aria-label={t("usageStats.dayDetail.providers")}>
			{providers.map((p) => (
				<div
					key={p.provider}
					style={{
						width: `${(p.tokens / total) * 100}%`,
						backgroundColor: colorForProvider(p.provider),
					}}
					title={`${p.provider} · ${formatTokens(p.tokens)} · ${formatCost(p.cost)}`}
				/>
			))}
		</div>
	);
}

/** provider 图例（名称 + tokens + 费用，tokens 降序）。 */
function ProviderLegend(props: { providers: Array<{ provider: string; tokens: number; cost: number }>; costKnown: boolean }) {
	const { providers, costKnown } = props;
	return (
		<ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
			{providers.map((p) => (
				<li key={p.provider} className="flex items-center gap-1.5 text-xs text-text-secondary">
					<span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: colorForProvider(p.provider) }} aria-hidden="true" />
					<span className="max-w-56 truncate">{p.provider}</span>
					<span className="tabular-nums text-muted-foreground">{formatTokens(p.tokens)}</span>
					<span className="tabular-nums text-muted-foreground">
						{formatCost(p.cost)}
						{!costKnown && <span className="usage-stats-unknown"> *</span>}
					</span>
				</li>
			))}
		</ul>
	);
}

function titleForPeriod(mode: UsagePeriodMode, selected: string, period: { start: string; end: string }, localeTag: "zh-CN" | "zh-TW" | "en-US", isCurrent: boolean): string {
	switch (mode) {
		case "day":
			return isCurrent ? t("usageStats.dayDetail.titleToday") : t("usageStats.dayDetail.titleDay", { date: selected });
		case "week":
			return isCurrent ? t("usageStats.dayDetail.titleWeek") : t("usageStats.dayDetail.titleRange", { range: formatPeriodTitle("week", period, localeTag) });
		case "month":
			return isCurrent ? t("usageStats.dayDetail.titleMonth") : t("usageStats.dayDetail.titleRange", { range: formatPeriodTitle("month", period, localeTag) });
		case "year":
			return isCurrent ? t("usageStats.dayDetail.titleYear") : t("usageStats.dayDetail.titleRange", { range: formatPeriodTitle("year", period, localeTag) });
	}
}

function emptyKeyForMode(mode: UsagePeriodMode): "usageStats.dayDetail.empty" | "usageStats.dayDetail.emptyWeek" | "usageStats.dayDetail.emptyMonth" | "usageStats.dayDetail.emptyYear" {
	switch (mode) {
		case "day":
			return "usageStats.dayDetail.empty";
		case "week":
			return "usageStats.dayDetail.emptyWeek";
		case "month":
			return "usageStats.dayDetail.emptyMonth";
		case "year":
			return "usageStats.dayDetail.emptyYear";
	}
}

function backKeyForMode(mode: UsagePeriodMode): "usageStats.dayDetail.backToday" | "usageStats.dayDetail.backWeek" | "usageStats.dayDetail.backMonth" | "usageStats.dayDetail.backYear" {
	switch (mode) {
		case "day":
			return "usageStats.dayDetail.backToday";
		case "week":
			return "usageStats.dayDetail.backWeek";
		case "month":
			return "usageStats.dayDetail.backMonth";
		case "year":
			return "usageStats.dayDetail.backYear";
	}
}

export function UsageDayDetail(props: { rows: UsageDayRow[]; costKnown: boolean }) {
	const { rows, costKnown } = props;
	const today = dayKeyOf(new Date());
	const [mode, setMode] = useState<UsagePeriodMode>("day");
	const [selected, setSelected] = useState<string>(today);
	const localeMode = getI18nLocale();
	// zh-TW 也走中文日历（同 UsagePeriodPicker），只有 en-US / pseudo 用英文
	const localeTag = localeMode === "en-US" || localeMode === "pseudo" ? "en-US" : localeMode;
	const periodWord = t(`usageStats.dayDetail.periodWord.${mode}`);

	const handleModeChange = (m: UsagePeriodMode) => {
		setMode(m);
		setSelected(dayKeyOf(new Date()));
	};

	const period = useMemo(() => resolvePeriod(mode, selected), [mode, selected]);
	const agg = useMemo(() => aggregateRange(rows, period), [rows, period]);
	const isCurrent = isCurrentPeriod(mode, selected, new Date());
	const title = useMemo(() => titleForPeriod(mode, selected, period, localeTag, isCurrent), [mode, selected, period, localeTag, isCurrent]);

	// 0 tokens 的供应商不进堆叠条/图例，避免空色块占位。
	const visibleProviders = agg.byProvider.filter((p) => p.tokens > 0);

	return (
		<SettingsSection divided boxed={false} title={title}>
			{/* 周期选择工具栏：档位 + 周期选择器 + 回当前周期 */}
			<div className="mb-2 flex flex-wrap items-center gap-2">
				<UsagePeriodPicker mode={mode} anchor={selected} minYear={earliestYear(rows)} onModeChange={handleModeChange} onAnchorChange={setSelected} />
				{!isCurrent && (
					<Button variant="ghost" size="sm" onClick={() => setSelected(today)}>
						{t(backKeyForMode(mode))}
					</Button>
				)}
			</div>

			{agg.days === 0 ? (
				<div className="usage-stats-hint">{t(emptyKeyForMode(mode))}</div>
			) : (
				<>
					<div className="usage-stats-cards">
						<DayCard label={t("usageStats.dayDetail.cards.tokens", { period: periodWord })} value={formatTokens(agg.totals.tokens)} />
						<DayCard
							label={t("usageStats.dayDetail.cards.cost", { period: periodWord })}
							value={
								<span title={costKnown ? undefined : t("usageStats.cards.costUnknown")}>
									{formatCost(agg.totals.cost)}
									{!costKnown && <span className="usage-stats-unknown"> *</span>}
								</span>
							}
						/>
						<DayCard label={t("usageStats.dayDetail.cards.turns", { period: periodWord })} value={String(agg.totals.turns)} />
						<DayCard label={t("usageStats.dayDetail.cards.sessions", { period: periodWord })} value={String(agg.totals.sessions.length)} />
					</div>

					{visibleProviders.length > 1 && (
						<>
							<ProviderBar providers={visibleProviders} />
							<ProviderLegend providers={visibleProviders} costKnown={costKnown} />
						</>
					)}

					{/* 周期模型/项目明细：独立淡色块 + 小节标题，与下方累计表明确区分 */}
					<div className="mt-4 rounded-md border border-border-subtle bg-bg-panel px-3 py-2.5">
						<div className="grid gap-4 xl:grid-cols-2">
							<div>
								<h4 className="mb-1.5 text-caption font-semibold text-text-secondary">{t("usageStats.dayDetail.modelsTitle", { period: periodWord })}</h4>
								<UsageTable headers={[t("usageStats.models.col.model"), t("usageStats.models.col.tokens"), t("usageStats.models.col.cost"), t("usageStats.models.col.turns")]} rows={agg.byModel.map((m) => [m.model, formatTokens(m.tokens), formatCost(m.cost), String(m.turns)])} />
							</div>
							<div>
								<h4 className="mb-1.5 text-caption font-semibold text-text-secondary">{t("usageStats.dayDetail.projectsTitle", { period: periodWord })}</h4>
								<UsageTable headers={[t("usageStats.projects.col.project"), t("usageStats.models.col.tokens"), t("usageStats.models.col.cost"), t("usageStats.models.col.turns")]} rows={agg.byProject.map((p) => [p.project, formatTokens(p.tokens), formatCost(p.cost), String(p.turns)])} />
							</div>
						</div>
					</div>
				</>
			)}
		</SettingsSection>
	);
}
