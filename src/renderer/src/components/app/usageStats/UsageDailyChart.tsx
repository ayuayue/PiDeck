/**
 * 每日用量堆叠柱状图（Recharts）。
 *
 * 视图切换：日（近 30 天）/ 周（近 12 周聚合）/ 月（近 12 月聚合）。
 * 每根柱按 provider 堆叠；0 tokens 的天/供应商不占柱、不进 tooltip。
 */

import { useMemo, useState, type ComponentProps } from "react";
import type { UsageAggregated } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipContent } from "../../ui-shadcn/chart";
import { formatTokens } from "./format";
import { barMinPointSize, buildBuckets, type RangeMode } from "./usageDailyChartModel";

/** 堆叠列对缺失 provider 填 0；tooltip 只列出实际有用量的供应商。 */
function UsageChartTooltip(props: ComponentProps<typeof ChartTooltipContent>) {
	const payload = (props.payload ?? []).filter((item) => Number(item.value) > 0);
	return <ChartTooltipContent {...props} payload={payload} />;
}

const RANGE_LABELS: Record<RangeMode, string> = {
	day: t("usageStats.daily.rangeDay"),
	week: t("usageStats.daily.rangeWeek"),
	month: t("usageStats.daily.rangeMonth"),
};

export function UsageDailyChart(props: { data: UsageAggregated }) {
	const [mode, setMode] = useState<RangeMode>("day");
	const { data } = props;

	const buckets = useMemo(() => buildBuckets(data.daily, mode, new Date()), [data.daily, mode]);
	// provider 名可能包含 `/`、`.` 等字符，不能直接作为 CSS 变量名；使用稳定的
	// provider key 避免 ChartContainer 生成无效变量后，Recharts 柱体退回黑色。
	const providers = [...new Set(buckets.flatMap((bucket) => bucket.byProvider.map((item) => item.provider)))];
	const providerKeys = providers.map((provider, index) => ({ provider, key: `provider_${index}` }));
	const chartData = buckets.map((bucket) => ({
		...bucket,
		...Object.fromEntries(providerKeys.map(({ provider, key }) => [key, bucket.byProvider.find((item) => item.provider === provider)?.tokens ?? 0])),
	}));
	const chartConfig = Object.fromEntries(providerKeys.map(({ provider, key }, index) => [key, { label: provider, color: `hsl(${(index * 67 + 250) % 360} 75% 65%)` }]));

	return (
		<div className="usage-stats-chart">
			<div className="usage-stats-chart-toolbar">
				{(["day", "week", "month"] as RangeMode[]).map((m) => (
					<Button key={m} variant={mode === m ? "default" : "ghost"} size="sm" onClick={() => setMode(m)}>
						{RANGE_LABELS[m]}
					</Button>
				))}
			</div>
			{buckets.length === 0 ? (
				<div className="usage-stats-hint">{t("usageStats.table.empty")}</div>
			) : (
				<ChartContainer config={chartConfig} className="h-[240px] w-full aspect-auto">
					<BarChart data={chartData} margin={{ top: 12, right: 16, left: 12, bottom: 4 }} barCategoryGap="28%">
						<CartesianGrid vertical={false} stroke="var(--color-border-subtle)" />
						<XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
						<YAxis tickLine={false} axisLine={false} width={58} tickFormatter={(value: number) => formatTokens(Number(value))} />
						<Tooltip cursor={{ fill: "var(--color-muted)", opacity: 0.35 }} content={<UsageChartTooltip />} />
						{providerKeys.map(({ provider, key }) => (
							<Bar key={provider} dataKey={key} stackId="usage" fill={`var(--color-${key})`} radius={2} minPointSize={barMinPointSize} />
						))}
					</BarChart>
				</ChartContainer>
			)}
		</div>
	);
}
