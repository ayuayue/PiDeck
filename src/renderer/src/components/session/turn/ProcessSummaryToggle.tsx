import { ChevronDown, ChevronRight, ListTree } from "lucide-react";
import { memo } from "react";
import { t } from "../../../i18n";
import type { ProcessSummary } from "../timeline/segmentSummary";
import { isEmptySummary } from "../timeline/segmentSummary";

/**
 * 执行过程唯一折叠汇总按钮。
 *
 * 折叠态只显示纯数字（工具数/思考数/中间回复数），不显示内容预览（与用户确认）。
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
	const label = parts.length > 0 ? t("activity.executionSummary", { summary: parts.join(" ") }) : "";

	return (
		<button type="button" className="execution-summary-toggle" onClick={props.onToggle} aria-expanded={props.expanded} title={props.expanded ? t("common.collapse") : t("common.expand")}>
			{props.expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
			<ListTree size={13} aria-hidden="true" className="text-text-tertiary" />
			<span>{label}</span>
		</button>
	);
});
