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
 * - 行尾 chevron 可点开查看 debugDetails 里的具体错误（"429 Too Many Requests …"）。
 * 注意：仅 run 进行中（agentBusy）且 run 已有内容时才会折叠成行；run 未开始或
 * 空闲态的 error 仍走独立 DiagnosticMessageCard（见 groupToolMessages error 分支）。
 */
export const ErrorStep = memo(function ErrorStep(props: { group: ErrorGroupItem; hidden: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const hasDetail = Boolean(resolveStepDetail(props.group.message));
	const label = stripAnsi(translateI18nDescriptor(props.group.message.meta, props.group.message.text) || props.group.message.text).trim();
	return (
		<div style={{ display: props.hidden ? "none" : undefined }}>
			<TimelineMarker kind="tool" tone="error" contentClassName="pb-1">
				<section className="tool-card w-full min-w-0 tone-error" data-error-step="true" data-message-id={props.group.id}>
					<div className="relative flex min-h-7 items-center rounded-md transition-colors duration-150 hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)]">
						<div className="flex min-h-7 min-w-0 flex-[1_1_auto] cursor-default items-center gap-2 py-1 pr-0.5 pl-1 text-chat-row text-text-faint">
							<span className="tool-card-icon inline-flex shrink-0 items-center justify-center">
								<AlertTriangle size={16} aria-hidden="true" className="text-danger" />
							</span>
							<span className="shrink-0 text-chat-row lowercase text-text-faint">{t("diagnostic.errorTitle")}</span>
							<Badge variant="outline" className="gap-1 border-danger/40 bg-danger-soft px-1 py-0 text-chat-detail text-danger">
								<CircleX size={9} aria-hidden="true" />
								{t("tool.statusError")}
							</Badge>
							{/* 主进程下发的诊断文案（请求失败 / 已自动重试 N/M 次 …） */}
							<span className="min-w-0 flex-[1_1_auto] truncate font-mono text-chat-detail text-danger" title={label}>
								{label}
							</span>
							{/* 展开按钮：仅当有具体错误详情（429 原文等）可看时出现 */}
							{hasDetail && (
								<button
									type="button"
									className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-text-faint transition-colors hover:bg-bg-hover hover:text-text-secondary"
									onClick={() => setExpanded((value) => !value)}
									aria-expanded={expanded}
									title={expanded ? t("common.collapse") : t("common.expand")}
								>
									{expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
								</button>
							)}
						</div>
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
