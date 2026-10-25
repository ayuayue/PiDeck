import { memo, useState } from "react";
import { ChevronDown, ChevronRight, CircleCheck, CircleX, RefreshCw } from "lucide-react";
import type { RetryGroupItem } from "../timeline/types";
import { TimelineMarker } from "../TimelineMarker";
import { Badge } from "../../ui-shadcn/badge";
import { t, translateI18nDescriptor } from "../../../i18n";
import { stripAnsi } from "../TimelineFormat";
import { useRetryCountdown } from "../../../hooks/useRetryCountdown";
import { resolveStepDetail, StepTraceDetails } from "./StepTraceDetails";
import { Collapsible, CollapsibleContent } from "../../ui-shadcn/collapsible";

/**
 * 自动重试过程行（run 内步骤，原位穿插）。
 *
 * 设计（用户反馈 m00001）：重试提示不再渲染成时间线上的独立「错误诊断」大卡片——
 * 那会与工具调用时间线割裂且顺序错乱；改为与工具/思考同层的过程行：
 * - 运行中：旋转图标 + 琥珀徽章（与工具 running 徽章同构），告诉用户「正在等待重试」；
 * - 最终失败：红图标 + 失败徽章（与失败工具行 danger-soft 同构），留痕可排查；
 * - 成功：中性 + 完成徽章（成功由 toast 即时报告，行保留作为周期终点痕迹）。
 * 行文案沿用主进程 i18n 描述符（正在自动重试 N，X 秒后重试 等）。
 *
 * 展开详情（用户反馈）：整行可点展开（与 ToolCard trigger 同构），查看具体错误原因
 * （debugDetails / errorMessage，见 StepTraceDetails）。无详情时保持单行不可点。
 */
export const RetryStep = memo(function RetryStep(props: { group: RetryGroupItem; hidden: boolean }) {
	const status = String(props.group.message.meta?.status ?? "");
	const retryRunning = status === "running";
	const retryFailed = status === "error";
	const [expanded, setExpanded] = useState(false);
	const hasDetail = Boolean(resolveStepDetail(props.group.message));
	const remainingSeconds = useRetryCountdown(props.group.message, props.hidden);
	// 只覆盖结构化文案参数；次数/错误详情仍取原消息，倒数不触发时间线整体刷新。
	const descriptor =
		remainingSeconds === null
			? props.group.message.meta
			: {
					...props.group.message.meta,
					i18nKey: remainingSeconds > 0 ? "diagnostic.retryScheduledAfterDelay" : "diagnostic.retryScheduled",
					i18nParams: { ...props.group.message.meta?.i18nParams, delaySeconds: remainingSeconds },
				};
	const label = stripAnsi(translateI18nDescriptor(descriptor, props.group.message.text) || props.group.message.text).trim();
	// 状态徽章与 ToolCard 三态同构（outline 琥珀 / danger-soft 红 / success-soft 绿），
	// 扫读语言一致：一眼区分「在等重试 / 重试也救不回来 / 重试成功」。
	const statusBadge = retryRunning ? (
		<Badge variant="outline" className="gap-1 border-warning/40 px-1 py-0 text-chat-detail text-warning">
			{t("tool.statusRunning")}
		</Badge>
	) : retryFailed ? (
		<Badge variant="outline" className="gap-1 border-danger/40 bg-danger-soft px-1 py-0 text-chat-detail text-danger">
			<CircleX size={9} aria-hidden="true" />
			{t("tool.statusError")}
		</Badge>
	) : (
		<Badge variant="outline" className="gap-1 border-success/40 bg-success-soft px-1 py-0 text-chat-detail text-success">
			<CircleCheck size={9} aria-hidden="true" />
			{t("tool.statusDone")}
		</Badge>
	);
	const rowInner = (
		<>
			{/* 图标：运行中旋转（继承旧诊断卡 RefreshCw 语义 + tool-card--running 呼吸色），
			    失败态图标转红（tool-card.tone-error 覆写 status 色，图标由下方 label 色承担） */}
			<span className="tool-card-icon inline-flex shrink-0 items-center justify-center">
				<RefreshCw size={16} aria-hidden="true" className={retryRunning ? "animate-pideck-spin" : retryFailed ? "text-danger" : undefined} />
			</span>
			<span className="shrink-0 text-chat-row lowercase text-text-faint">{t("diagnostic.retryTitle")}</span>
			{statusBadge}
			{hasDetail && (expanded ? <ChevronDown size={14} className="shrink-0 text-text-faint" aria-hidden="true" /> : <ChevronRight size={14} className="shrink-0 text-text-faint" aria-hidden="true" />)}
			{/* 重试详情：主进程下发的完整状态文案（第几次/延时/失败原因概括），点开看未截断原文 */}
			<span className={`min-w-0 flex-[1_1_auto] truncate font-mono text-chat-detail ${retryFailed ? "text-danger" : "text-text-faint"}`} title={label}>
				{label}
			</span>
		</>
	);
	return (
		<div style={{ display: props.hidden ? "none" : undefined }}>
			{/* Marker tone 与工具行同语义：running=active、error=error、成功=success */}
			<TimelineMarker kind="tool" tone={retryRunning ? "active" : retryFailed ? "error" : "success"} contentClassName="pb-1">
				<section className={`tool-card w-full min-w-0 tone-${retryFailed ? "error" : retryRunning ? "running" : "ok"}`} data-status={status} data-retry-step="true" data-message-id={props.group.id}>
					<div className="relative flex min-h-7 items-center rounded-md transition-colors duration-fast hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)]">
						{/* 整行可点展开（与 ToolCard 的 trigger 同构）：原来只有 20px chevron 可点，
						    用户反馈「无法点击」；无详情时保持 div，不渲染空展开。 */}
						{hasDetail ? (
							<button
								type="button"
								className="flex min-h-7 min-w-0 flex-[1_1_auto] cursor-pointer items-center gap-2 border-0 bg-transparent py-1 pr-0.5 pl-1 text-left text-chat-row text-text-faint focus-visible:-outline-offset-2 focus-visible:outline-2"
								onClick={() => setExpanded((value) => !value)}
								aria-expanded={expanded}
							>
								{rowInner}
							</button>
						) : (
							<div className="flex min-h-7 min-w-0 flex-[1_1_auto] cursor-default items-center gap-2 py-1 pr-0.5 pl-1 text-chat-row text-text-faint">{rowInner}</div>
						)}
					</div>
					{/* 展开的错误详情：具体原因原文（如 "429 Too Many Requests …"）。
					    折叠体走共享折叠原语：真高度渐变 + exit 后卸载；display:contents 根不生成盒子，折叠态零空档。
					    不再挂 animate-in/fade-in：twMerge 会把 animate-* 判同组，保留会盖掉高度动画。 */}
					<Collapsible open={expanded} className="contents">
						<CollapsibleContent className="px-1 pb-1">
							<StepTraceDetails message={props.group.message} />
						</CollapsibleContent>
					</Collapsible>
				</section>
			</TimelineMarker>
		</div>
	);
});
