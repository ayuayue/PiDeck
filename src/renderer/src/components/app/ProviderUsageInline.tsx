/**
 * Provider 用量徽章（学 cc-switch UsageFooter inline / TierBadge）。
 *
 * 两种形态：
 * - variant="row"：模型选择器分组行内的单段彩色数值（取档位最严重的一段示警）；
 *   无数据时不渲染——选择器行空间紧张，开关与明细留在卡片与展开区。
 * - variant="card"：配置页卡片头部的徽章（模型页/认证页/DSH 模型页共用）。
 *   **只在「已启用」时渲染**（未启用不占位：开关在右侧「用量查询」弹窗里，
 *   徽章只负责展示数据；状态表未回来时也不渲染，避免闪一下再消失）：
 *     · 已启用·查询中 → 「查询中…」+ 转圈
 *     · 已启用·有数据 → 相对更新时间 + 各档数值段 + 刷新
 *     · 已启用·失败 → 「查询失败」（hover 看原因）+ 刷新
 *
 * backend（"pi" | "dsh"）决定查询/缓存走哪条链路：
 * - pi：配置 ~/.pi/agent/usage-probes.json；
 * - dsh：配置 $DSH_HOME/.pideck/usage-probes.json + DSH 凭据库；
 * 缓存 key 归一化为 `dsh:<provider>`，与 pi 侧同名 provider（如 deepseek）互不串缓存。
 *
 * 颜色规则与三处详情面板共用 providerUsageDisplay 的 tone：≥90% 红 / ≥70% 橙 /
 * 其余绿；余额不足 10% 橙、≤0 红。
 */
import { Fragment } from "react";
import { Clock, RefreshCw } from "lucide-react";
import type { UsageProbeBackend } from "../../../../shared/types/providerUsage";
import {
	useProviderUsageEntry,
	useProviderUsageRefresh,
	useProviderUsageState,
} from "../../hooks/useProviderUsage";
import {
	usageBadgePrimarySegment,
	usageBadgeSegments,
	USAGE_TONE_TEXT_CLASS,
	relativeTimeParts,
	type UsageBadgeSegment,
} from "../../utils/providerUsageDisplay";
import { t } from "../../i18n";

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
function UsageSegments(props: { segments: UsageBadgeSegment[]; className?: string }) {
	return (
		<span className={`flex-none whitespace-nowrap font-mono text-caption tabular-nums ${props.className ?? ""}`}>
			{props.segments.map((segment, index) => (
				<Fragment key={`${segment.labelKey ?? segment.labelText ?? ""}:${index}`}>
					{index > 0 && <span className="px-1 text-text-tertiary">·</span>}
					<UsageSegment segment={segment} />
				</Fragment>
			))}
		</span>
	);
}

/** 刷新按钮：查询中显示转圈；点击不冒泡（卡片整行点击是展开/收起）。 */
function UsageRefreshButton(props: { provider: string; backend: UsageProbeBackend; loading: boolean }) {
	const refresh = useProviderUsageRefresh();
	return (
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
			<RefreshCw size={10} className={props.loading ? "animate-pideck-spin" : undefined} />
		</button>
	);
}

export function ProviderUsageInline(props: {
	provider: string;
	/** row = 选择器分组行（无数据不渲染）；card = 卡片头部常驻徽章（只读四态）。 */
	variant: "row" | "card";
	backend?: UsageProbeBackend;
	className?: string;
}) {
	const backend = props.backend ?? "pi";
	const entry = useProviderUsageEntry(props.provider, backend);
	const state = useProviderUsageState(props.provider, backend);
	if (!props.provider) return null;

	if (props.variant === "row") {
		if (!entry.result?.success) return null;
		const primary = usageBadgePrimarySegment(entry.result, t);
		if (!primary) return null;
		return <UsageSegments segments={[primary]} className={props.className} />;
	}

	// card：只在「已启用」时渲染。未启用/状态未回来都不占位——开关在右侧「用量查询」弹窗里，
	// 徽章只展示数据，不留「未启用」这类噪音文案。
	if (!state?.enabled) return null;

	const loading = entry.status === "loading";
	const result = entry.result;
	const segments = result?.success ? usageBadgeSegments(result, t) : null;
	const failed = !loading && result != null && !result.success;
	const time = entry.fetchedAt != null ? relativeTimeParts(entry.fetchedAt) : null;

	return (
		<span
			className={`flex flex-none items-center gap-1.5 whitespace-nowrap ${props.className ?? ""}`}
			data-testid="provider-usage-inline"
			data-provider={props.provider}
			data-enabled="true"
		>
			{time && segments && segments.length > 0 && (
				<span className="inline-flex items-center gap-0.5 text-[10px] text-text-tertiary">
					<Clock size={10} aria-hidden="true" />
					{t(time.key, time.params)}
				</span>
			)}
			{segments && segments.length > 0 ? (
				<UsageSegments segments={segments} />
			) : (
				<span
					className="text-caption text-text-tertiary"
					// 失败时把主进程给的原因挂在 title 上：卡片空间有限，hover 才能看到细节。
					title={failed ? (result?.error ?? undefined) : undefined}
				>
					{failed ? t("config.usage.badgeFailed") : t("config.usage.badgeLoading")}
				</span>
			)}
			<UsageRefreshButton provider={props.provider} backend={backend} loading={loading} />
		</span>
	);
}
