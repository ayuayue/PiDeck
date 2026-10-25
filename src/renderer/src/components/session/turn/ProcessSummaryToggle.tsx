import { Check, ChevronDown, ChevronRight, CircleAlert, ListTree, MessagesSquare, RotateCw, Sparkles, Wrench } from "lucide-react";
import { memo } from "react";
import { t } from "../../../i18n";
import type { ProcessSummary } from "../timeline/segmentSummary";
import { isEmptySummary } from "../timeline/segmentSummary";

/**
 * 执行过程唯一折叠汇总按钮。
 *
 * 参考 beUI AgentActivity：完成态用轻量的「活动轨迹」摘要，统计由图标 + 数字组成，
 * 不再把整句内容挤在一个普通按钮里；展开后仍保留原有过程节点与挂载预算。
 * 位置：run 开头（先看到「这轮干了什么」摘要，再看到结论；点开从上往下展开顺序自然）。
 */
export const ProcessSummaryToggle = memo(function ProcessSummaryToggle(props: { summary: ProcessSummary; expanded: boolean; onToggle: () => void }) {
	if (isEmptySummary(props.summary)) return null;

	const parts: string[] = [];
	if (props.summary.toolCount > 0) {
		parts.push(t("activity.executionToolCount", { count: props.summary.toolCount }));
	}
	if (props.summary.thinkingCount > 0) {
		parts.push(t("activity.executionThinkingCount", { count: props.summary.thinkingCount }));
	}
	if (props.summary.interimCount > 0) {
		parts.push(t("activity.executionInterimCount", { count: props.summary.interimCount }));
	}
	if (props.summary.retryCount > 0) {
		// 自动重试也计入本轮过程摘要：折叠态一眼可看出「这轮重试过」
		parts.push(t("activity.executionRetryCount", { count: props.summary.retryCount }));
	}
	if (props.summary.errorCount > 0) {
		// 错误诊断也计入本轮过程摘要：折叠态一眼可看出「这轮出过错」
		parts.push(t("activity.executionErrorCount", { count: props.summary.errorCount }));
	}
	const label = parts.length > 0 ? t("activity.executionSummary", { summary: parts.join(" ") }) : "";
	const stats = [
		props.summary.toolCount > 0 ? { icon: Wrench, value: props.summary.toolCount, label: t("activity.executionToolCount", { count: props.summary.toolCount }), tone: "" } : null,
		props.summary.thinkingCount > 0 ? { icon: Sparkles, value: props.summary.thinkingCount, label: t("activity.executionThinkingCount", { count: props.summary.thinkingCount }), tone: "" } : null,
		// 中间回复也是「说话」，用对话气泡而不是树形列表（与折叠头的 ListTree 区分开）。
		props.summary.interimCount > 0 ? { icon: MessagesSquare, value: props.summary.interimCount, label: t("activity.executionInterimCount", { count: props.summary.interimCount }), tone: "" } : null,
		props.summary.retryCount > 0 ? { icon: RotateCw, value: props.summary.retryCount, label: t("activity.executionRetryCount", { count: props.summary.retryCount }), tone: "warning" } : null,
		props.summary.errorCount > 0 ? { icon: CircleAlert, value: props.summary.errorCount, label: t("activity.executionErrorCount", { count: props.summary.errorCount }), tone: "danger" } : null,
	].filter((stat): stat is { icon: typeof Wrench; value: number; label: string; tone: string } => stat !== null);

	return (
		<button type="button" className="execution-summary-toggle group" onClick={props.onToggle} aria-expanded={props.expanded} title={props.expanded ? t("common.collapse") : t("common.expand")}>
			<span className="execution-summary-leading" aria-hidden="true">
				<span className="execution-summary-icon">
					<ListTree size={13} />
				</span>
				<span className="execution-summary-chevron">{props.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
			</span>
			<span className="execution-summary-copy">
				<span className="execution-summary-title">{t("activity.executionTitle")}</span>
				<span className="execution-summary-stats">
					{stats.map(({ icon: Icon, value, label: statLabel, tone }) => (
						<span key={statLabel} className={`execution-summary-stat${tone ? ` is-${tone}` : ""}`} title={statLabel}>
							<Icon size={12} aria-hidden="true" />
							<span className="tabular-nums">{value}</span>
						</span>
					))}
				</span>
			</span>
			<span className="execution-summary-state" aria-hidden="true">
				{props.expanded ? <Check size={12} /> : null}
			</span>
			<span className="sr-only">{label}</span>
		</button>
	);
});
