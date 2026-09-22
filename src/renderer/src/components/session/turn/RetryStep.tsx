import { memo } from "react";
import { CircleCheck, CircleX, RefreshCw } from "lucide-react";
import type { RetryGroupItem } from "../timeline/types";
import { TimelineMarker } from "../TimelineMarker";
import { Badge } from "../../ui-shadcn/badge";
import { t, translateI18nDescriptor } from "../../../i18n";
import { stripAnsi } from "../TimelineFormat";

/**
 * 自动重试过程行（run 内步骤，原位穿插）。
 *
 * 设计（用户反馈 m00001）：重试提示不再渲染成时间线上的独立「错误诊断」大卡片——
 * 那会与工具调用时间线割裂且顺序错乱；改为与工具/思考同层的过程行：
 * - 运行中：旋转图标 + 琥珀徽章（与工具 running 徽章同构），告诉用户「正在等待重试」；
 * - 最终失败：红图标 + 失败徽章（与失败工具行 danger-soft 同构），留痕可排查；
 * - 成功：中性 + 完成徽章（成功由 toast 即时报告，行保留作为周期终点痕迹）。
 * 行文案沿用主进程 i18n 描述符（正在自动重试 N，X 秒后重试 等）。
 */
export const RetryStep = memo(function RetryStep(props: { group: RetryGroupItem; hidden: boolean }) {
	const status = String(props.group.message.meta?.status ?? "");
	const retryRunning = status === "running";
	const retryFailed = status === "error";
	const label = stripAnsi(translateI18nDescriptor(props.group.message.meta, props.group.message.text) || props.group.message.text).trim();
	// 状态徽章与 ToolCard 三态同构（outline 琥珀 / danger-soft 红 / secondary 完成），
	// 扫读语言一致：一眼区分「在等重试 / 重试也救不回来 / 重试成功」。
	const statusBadge = retryRunning ? (
		<Badge variant="outline" className="gap-1 border-warning/40 px-1 py-0 text-micro text-warning">
			{t("tool.statusRunning")}
		</Badge>
	) : retryFailed ? (
		<Badge variant="outline" className="gap-1 border-danger/40 bg-danger-soft px-1 py-0 text-micro text-danger">
			<CircleX size={9} aria-hidden="true" />
			{t("tool.statusError")}
		</Badge>
	) : (
		<Badge variant="secondary" className="gap-1 px-1 py-0 text-micro">
			<CircleCheck size={9} aria-hidden="true" />
			{t("tool.statusDone")}
		</Badge>
	);
	return (
		<div style={{ display: props.hidden ? "none" : undefined }}>
			{/* Marker tone 与工具行同语义：running=active、error=error、成功=success */}
			<TimelineMarker kind="tool" tone={retryRunning ? "active" : retryFailed ? "error" : "success"} contentClassName="pb-1">
				<section className={`tool-card w-full min-w-0 tone-${retryFailed ? "error" : retryRunning ? "running" : "ok"}`} data-status={status} data-retry-step="true" data-message-id={props.group.id}>
					<div className="relative flex min-h-7 items-center rounded-md transition-colors duration-150 hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)]">
						<div className="flex min-h-7 min-w-0 flex-[1_1_auto] cursor-default items-center gap-2 py-1 pr-0.5 pl-1 text-control leading-5 text-text-faint">
							{/* 图标：运行中旋转（继承旧诊断卡 RefreshCw 语义 + tool-card--running 呼吸色），
							    失败态图标转红（tool-card.tone-error 覆写 status 色，图标由下方 label 色承担） */}
							<span className="tool-card-icon inline-flex shrink-0 items-center justify-center">
								<RefreshCw size={16} aria-hidden="true" className={retryRunning ? "animate-pideck-spin" : retryFailed ? "text-danger" : undefined} />
							</span>
							<span className="shrink-0 text-control lowercase text-text-faint">{t("diagnostic.retryTitle")}</span>
							{statusBadge}
							{/* 重试详情：主进程下发的完整状态文案（第几次/延时/失败原因概括） */}
							<span className={`min-w-0 flex-[1_1_auto] truncate font-mono text-caption ${retryFailed ? "text-danger" : "text-text-faint"}`} title={label}>
								{label}
							</span>
						</div>
					</div>
				</section>
			</TimelineMarker>
		</div>
	);
});
