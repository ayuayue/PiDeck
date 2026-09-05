/**
 * Provider 用量 inline 展示（学 cc-switch UsageFooter inline / TierBadge）：
 * - variant="row"：模型选择器分组行内的单段彩色数值（取档位最严重的一段示警，
 *   查询中/失败不渲染）；
 * - variant="card"：设置模型卡片头部的右对齐块 = 相对更新时间 + 数值段 + 刷新小按钮
 *   （cc-switch 卡头 ml-auto inline 同款布局）；多档用量（5h/周/MCP、三档百分比）
 *   逐档全部展示——「已用 92%」带语义标签，用户不用猜百分比是已用还是剩余。
 *
 * backend（"pi" | "dsh"）决定查询/缓存走哪条链路：
 * - pi：配置 ~/.pi/agent/usage-probes.json；
 * - dsh：配置 $DSH_HOME/usage-probes.json + DSH 凭据库；
 * 缓存 key 归一化为 `dsh:<provider>`，与 pi 侧同名 provider（如 deepseek）互不串缓存。
 *
 * 颜色规则与三处详情面板共用 providerUsageDisplay 的 tone：≥90% 红 / ≥70% 橙 /
 * 其余绿；余额不足 10% 橙、≤0 红。无数据一律返回 null——保持「查不到就不显示」。
 */
import { Fragment } from "react";
import { Clock, RefreshCw } from "lucide-react";
import type { ProviderUsageResult, UsageProbeBackend } from "../../../../shared/types/providerUsage";
import {
	useProviderUsageEntry,
	useProviderUsageRefresh,
} from "../../hooks/useProviderUsage";
import {
	usageBadgePrimarySegment,
	usageBadgeSegments,
	USAGE_TONE_TEXT_CLASS,
	relativeTimeParts,
	type UsageBadgeSegment,
} from "../../utils/providerUsageDisplay";
import { t } from "../../i18n";

/** 只有成功且能产出至少一段带标签数值的结果才属于卡片可见的用量状态。 */
function hasUsableUsage(result: ProviderUsageResult | null): boolean {
	return result != null && result.success && usageBadgeSegments(result, t) != null;
}

/** 一段用量的渲染：灰标签 + 彩色粗体数值（段间由调用方加分隔点）。 */
function UsageSegment(props: { segment: UsageBadgeSegment }) {
	const { segment } = props;
	return (
		<span className="inline-flex items-baseline gap-0.5 whitespace-nowrap">
			<span className="text-text-tertiary">
				{segment.labelKey != null ? t(segment.labelKey) : segment.labelText}
			</span>
			<span className={`font-mono font-semibold tabular-nums ${USAGE_TONE_TEXT_CLASS[segment.tone]}`}>
				{segment.text}
			</span>
		</span>
	);
}

/** 数值段：卡片 = 全部档位（·分隔）；选择器行 = 最严重的一段。 */
function UsageValue(props: { provider: string; backend?: UsageProbeBackend; variant: "row" | "card"; className?: string }) {
	const { result } = useProviderUsageEntry(props.provider, props.backend);
	if (!result || !result.success) return null;
	const segments = usageBadgeSegments(result, t);
	if (!segments || segments.length === 0) return null;
	const shown = props.variant === "row"
		? [usageBadgePrimarySegment(result, t)].filter((segment): segment is UsageBadgeSegment => segment != null)
		: segments;
	return (
		<span className={`flex-none whitespace-nowrap font-mono text-caption tabular-nums ${props.className ?? ""}`}>
			{shown.map((segment, index) => (
				<Fragment key={`${segment.labelKey ?? segment.labelText ?? ""}:${index}`}>
					{index > 0 && <span className="px-1 text-text-tertiary">·</span>}
					<UsageSegment segment={segment} />
				</Fragment>
			))}
		</span>
	);
}

export function ProviderUsageInline(props: {
	provider: string;
	/** row = 选择器分组行（极简单值）；card = 模型卡片头部（时间 + 数值 + 刷新）。 */
	variant: "row" | "card";
	backend?: UsageProbeBackend;
	className?: string;
}) {
	const entry = useProviderUsageEntry(props.provider, props.backend);
	const refresh = useProviderUsageRefresh();
	if (!props.provider) return null;
	const hasUsable = hasUsableUsage(entry.result);
	if (!hasUsable) return null;
	const fetchedAt = entry.fetchedAt;

	if (props.variant === "row") {
		return <UsageValue provider={props.provider} backend={props.backend} variant="row" className={props.className} />;
	}

	const time = fetchedAt != null ? relativeTimeParts(fetchedAt) : null;
	const loading = entry.status === "loading";
	return (
		<span
			className={`flex flex-none items-center gap-1.5 whitespace-nowrap ${props.className ?? ""}`}
			data-testid="provider-usage-inline"
			data-provider={props.provider}
		>
			{time && (
				<span className="inline-flex items-center gap-0.5 text-[10px] text-text-tertiary">
					<Clock size={10} aria-hidden="true" />
					{t(time.key, time.params)}
				</span>
			)}
			<UsageValue provider={props.provider} backend={props.backend} variant="card" />
			<button
				type="button"
				data-testid="provider-usage-inline-refresh"
				title={t("config.usage.refresh")}
				aria-label={t("config.usage.refresh")}
				onClick={(event) => {
					event.stopPropagation();
					refresh(props.provider, props.backend);
				}}
				className="flex h-4 w-4 flex-none items-center justify-center rounded text-text-tertiary transition-colors hover:bg-muted/60 hover:text-foreground"
			>
				<RefreshCw size={10} className={loading ? "animate-pideck-spin" : undefined} />
			</button>
		</span>
	);
}


