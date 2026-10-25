import { memo, useState } from "react";
import { Bell, ChevronDown, ChevronRight } from "lucide-react";
import type { ChatMessage } from "../../../../shared/types";
import { t, type TranslationKey } from "../../i18n";
import { formatTime, stripAnsi } from "./TimelineFormat";
import { TimelineMarker } from "./TimelineMarker";
import { SingleLinePreview } from "./SingleLinePreview";
import { isNotifiableCustomType, parseNotifySummary, type NotifySummaryStatus } from "./notifySummary";
import { Collapsible, CollapsibleContent } from "../ui-shadcn/collapsible";

/**
 * 状态 → 标题 i18n key。写成静态表而不是模板拼接：
 * TranslationKey 类型能护住 key 拼错，rendererProductCopyI18n 的静态扫描也能看到全部 key。
 */
const STATUS_TITLE_KEYS: Record<NotifySummaryStatus, TranslationKey> = {
	completed: "notify.subagent.completed",
	failed: "notify.subagent.failed",
	paused: "notify.subagent.paused",
	stopped: "notify.subagent.stopped",
	unknown: "notify.customTitle",
};

/**
 * NotifyMessageCard — 扩展通知（custom 消息）的时间线卡片。
 *
 * 只服务「面向用户的通知」白名单（见 notifySummary 的 NOTIFY_CUSTOM_TYPES）；
 * 白名单外的 customType 由调用方渲染为 null（内部上下文注入不占位）。
 *
 * 展示契约：默认收成一行（对齐 ThinkingBlock 的「单行 trigger」语言），
 * 展开看完整正文。之所以要显示而不是静默丢弃：这些通知在 pi 侧是**回合边界**
 * （后台子代理完成会唤醒父会话），用户需要知道「为什么又冒出一段回答」。
 * 折叠是本地 state：卡片挂在 key=message.id 的时间线节点上，展开态在会话内保持。
 */
export const NotifyMessageCard = memo(function NotifyMessageCard(props: { message: ChatMessage }) {
	const [expanded, setExpanded] = useState(false);
	const summary = parseNotifySummary(props.message.text ?? "");
	const tone = notifyTone(summary.status);
	const customType = String(props.message.meta?.customType ?? "");
	const title = t(STATUS_TITLE_KEYS[summary.status]);
	const agentsText = summary.agents.join(", ");

	return (
		<TimelineMarker kind="diagnostic" tone={tone}>
			<article className="mb-4 w-full min-w-0 overflow-hidden rounded-md border border-border-subtle bg-[var(--color-chat-muted-bg)]" data-message-id={props.message.id} data-role={props.message.role} data-custom-type={customType || undefined} data-notify-status={summary.status}>
				{/* 整行可点：图标 + 标题 + 子代理名 + 折叠预览 + 时间 + chevron */}
				<button
					type="button"
					className="flex min-h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-caption transition-colors duration-fast hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)] focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
					onClick={() => setExpanded((value) => !value)}
					aria-expanded={expanded}
					title={expanded ? t("notify.collapse") : t("notify.expand")}
				>
					<Bell size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
					<span className="shrink-0 font-semibold text-text-secondary">{title}</span>
					{agentsText ? <span className="shrink-0 max-w-[16rem] truncate text-text-tertiary">{agentsText}</span> : null}
					{/* 折叠行只在没有解析出子代理名时预览原文，避免与标题/名称重复 */}
					{!expanded && !agentsText && summary.headline ? <SingleLinePreview text={summary.headline} showSweep={false} className="min-w-0 flex-[1_1_auto] text-text-faint" /> : null}
					<time className="ml-auto shrink-0 text-micro tabular-nums text-text-tertiary">{formatTime(props.message.timestamp)}</time>
					{expanded ? <ChevronDown size={14} className="shrink-0 text-text-faint" aria-hidden="true" /> : <ChevronRight size={14} className="shrink-0 text-text-faint" aria-hidden="true" />}
				</button>
				{/* 折叠体走共享折叠原语：真高度渐变 + exit 后卸载；display:contents 根不生成盒子，折叠态零空档。 */}
				<Collapsible open={expanded} className="contents">
					<CollapsibleContent className="border-t border-border-subtle px-2 py-1.5">
						{/* 原文整体展示：解析只是「摘要」，不能被当成唯一事实来源 */}
						<p className="m-0 whitespace-pre-wrap break-words text-caption leading-relaxed text-text-secondary">{stripAnsi(props.message.text ?? "")}</p>
					</CollapsibleContent>
				</Collapsible>
			</article>
		</TimelineMarker>
	);
});

/** 状态 → 卡片色调（复用诊断卡的 tone 语言：完成绿、失败红、暂停/停止黄）。 */
function notifyTone(status: NotifySummaryStatus): "neutral" | "success" | "warning" | "error" {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "paused":
		case "stopped":
			return "warning";
		default:
			return "neutral";
	}
}

/**
 * 通知卡渲染判定：白名单外的 custom 消息一律不渲染。
 * 供时间线 system 分支调用，与卡片本体放在同一模块，避免白名单散落两处。
 */
export function shouldRenderNotifyCard(message: ChatMessage): boolean {
	return isNotifiableCustomType(message.meta?.customType);
}
