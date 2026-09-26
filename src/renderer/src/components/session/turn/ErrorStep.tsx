import { memo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, CircleX } from "lucide-react";
import type { ErrorGroupItem } from "../timeline/types";
import { TimelineMarker } from "../TimelineMarker";
import { Badge } from "../../ui-shadcn/badge";
import { t, translateI18nDescriptor } from "../../../i18n";
import { stripAnsi } from "../TimelineFormat";
import { resolveStepDetail, StepTraceDetails } from "./StepTraceDetails";

/**
 * 错误诊断过程行（run 内步骤，原位穿插）。
 *
 * 用户反馈（m00001）：429 等错误卡应与自动重试一样并入工具调用时间线，而不是
 * 渲染成独立大卡片夹在工具与回答之间。行语义与 RetryStep 失败态同构：
 * - 红 AlertTriangle + 红徽章（与失败工具行 danger-soft 同构），一眼识别「请求失败」；
 * - 行文案沿用主进程 i18n 描述符（请求失败。已自动重试 N/M 次 等）；
 * - 整行可点展开（与 ToolCard trigger 同构），点开看未截断的 debugDetails 原文。
 * 注意：仅 run 进行中（agentBusy）且 run 已有内容时才会折叠成行；run 未开始或
 * 空闲态的 error 仍走独立 DiagnosticMessageCard（见 groupToolMessages error 分支）。
 */
export const ErrorStep = memo(function ErrorStep(props: { group: ErrorGroupItem; hidden: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const hasDetail = Boolean(resolveStepDetail(props.group.message));
	const label = stripAnsi(translateI18nDescriptor(props.group.message.meta, props.group.message.text) || props.group.message.text).trim();
	const rowInner = (
		<>
			<span className="tool-card-icon inline-flex shrink-0 items-center justify-center">
				<AlertTriangle size={16} aria-hidden="true" className="text-danger" />
			</span>
			<span className="shrink-0 text-chat-row lowercase text-text-faint">{t("diagnostic.errorTitle")}</span>
			<Badge variant="outline" className="gap-1 border-danger/40 bg-danger-soft px-1 py-0 text-chat-detail text-danger">
				<CircleX size={9} aria-hidden="true" />
				{t("tool.statusError")}
			</Badge>
			{hasDetail && (expanded ? <ChevronDown size={14} className="shrink-0 text-text-faint" aria-hidden="true" /> : <ChevronRight size={14} className="shrink-0 text-text-faint" aria-hidden="true" />)}
			{/* 主进程下发的诊断文案（请求失败 / 已自动重试 N/M 次 …），点开看未截断原文 */}
			<span className="min-w-0 flex-[1_1_auto] truncate font-mono text-chat-detail text-danger" title={label}>
				{label}
			</span>
		</>
	);
	return (
		<div style={{ display: props.hidden ? "none" : undefined }}>
			<TimelineMarker kind="tool" tone="error" contentClassName="pb-1">
				<section className="tool-card w-full min-w-0 tone-error" data-error-step="true" data-message-id={props.group.id}>
					<div className="relative flex min-h-7 items-center rounded-md transition-colors duration-150 hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)]">
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
					{/* 展开的错误详情："429 Too Many Requests …" 完整原文/栈帧 */}
					{expanded && (
						<div className="px-1 pb-1">
							<StepTraceDetails message={props.group.message} />
						</div>
					)}
				</section>
			</TimelineMarker>
		</div>
	);
});
