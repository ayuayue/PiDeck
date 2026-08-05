/**
 * WebTimeline — Web 端消息时间线（与桌面 SessionMessageTimeline 同风格）。
 *
 * 数据源为 useChat 的 messages（流式实时）+ 历史分页注入：
 * - 用户消息 → 右对齐气泡（复用桌面 user-turn 布局类）
 * - 助手消息 → 扁平 Markdown（WebAssistantText）
 * - reasoning part → 可折叠思考卡片（复用桌面 ThinkingBlock 视觉）
 * - tool-invocation part → 工具卡片（复用桌面 tool-card 视觉）
 * - 流式期间底部显示响应指示器；出错显示诊断卡
 */
import { Fragment, memo, useEffect, useRef, useState } from "react";
import { Brain, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { WebAssistantText } from "./WebAssistantText";
import { MarkdownStream } from "@/components/session/MarkdownStream";
import { TimelineMarker } from "../components/session/TimelineMarker";

/** 用户消息右对齐气泡（结构与桌面 UserBubble 一致，去掉操作栏/附件能力）。 */
export const WebUserBubble = memo(function WebUserBubble(props: { message: UIMessage }) {
	const text = props.message.parts
		.filter((part) => part.type === "text")
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
	if (!text.trim()) return null;
	return (
		<article className="user-turn group/user mb-4 flex w-full min-w-0 max-w-full flex-col items-end">
			<div className="w-fit min-w-0 max-w-[min(82%,64ch)] rounded-[14px] border border-border bg-muted/60 px-3 py-2 text-sm text-foreground [overflow-wrap:anywhere] break-words">
				<div className="text-chat leading-[1.6] text-text-primary whitespace-pre-wrap break-words">
					{text}
				</div>
			</div>
		</article>
	);
});

/** 思考折叠卡片（复用桌面 ThinkingBlock 视觉：Brain 图标 + 可折叠正文）。 */
export const WebThinkingBlock = memo(function WebThinkingBlock(props: { text: string }) {
	const [expanded, setExpanded] = useState(true);
	if (!props.text.trim()) return null;
	return (
		<TimelineMarker kind="thinking" tone="neutral">
		<section className="w-full min-w-0 overflow-hidden rounded-md border-0">
			<button
				className="flex min-h-8 w-full cursor-pointer items-center gap-2 border-0 bg-transparent p-1.5 pl-2.5 text-left text-control leading-5 text-text-secondary transition-colors duration-150 hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,var(--color-bg))] focus-visible:-outline-offset-2 focus-visible:outline-2 [&_svg]:shrink-0 [&_svg]:text-[var(--color-info)]"
				onClick={() => setExpanded((value) => !value)}
				aria-expanded={expanded}
			>
				<Brain size={15} />
				<span className="shrink-0 text-body font-[650] text-text-primary">{t("thinking.title")}</span>
				{expanded ? (
					<ChevronDown size={15} className="shrink-0 text-text-tertiary" aria-hidden="true" />
				) : (
					<ChevronRight size={15} className="shrink-0 text-text-tertiary" aria-hidden="true" />
				)}
				{!expanded && (
					<span className="min-w-0 flex-[1_1_auto] truncate font-mono text-caption text-text-tertiary">
						{props.text.slice(0, 80)}{props.text.length > 80 ? "..." : ""}
					</span>
				)}
			</button>
			{expanded && (
				<div className="markdown-body border-t border-border-subtle px-3 pt-2 pb-3 text-text-tertiary">
					<MarkdownStream
						text={props.text}
						onOpenExternal={(url: string) => {
							// Web 端无系统浏览器通道，直接新窗口打开
							window.open(url, "_blank", "noopener");
						}}
					/>
				</div>
			)}
		</section>
		</TimelineMarker>
	);
});

type WebToolPart = {
	type: string;
	toolName?: string;
	toolCallId?: string;
	state?: string;
	output?: unknown;
	errorText?: string;
};

/** 工具卡片（复用桌面 tool-card 视觉：图标 + 工具名 + 状态）。 */
export const WebToolCard = memo(function WebToolCard(props: { part: WebToolPart }) {
	const { part } = props;
	// 静态工具 part 不携带 toolName，名称嵌在 type 里（`tool-${name}`）；动态工具带 toolName
	const toolName =
		part.toolName ||
		(typeof part.type === "string" && part.type.startsWith("tool-")
			? part.type.slice("tool-".length)
			: "tool");
	const state = part.state ?? "input-streaming";
	const running = state === "input-streaming" || state === "input-available";
	const error = state === "output-error" || state === "error" || Boolean(part.errorText);
	return (
		<TimelineMarker kind="tool" tone={error ? "error" : running ? "active" : "success"}>
		<section
			className={cn(
				"tool-card w-full min-w-0 overflow-hidden rounded-md border border-border-subtle bg-bg-panel transition-[border-color,background-color] duration-150",
				running && "tone-running",
				error && "tone-error",
			)}
			data-status={error ? "error" : running ? "running" : "done"}
			data-tool-name={toolName}
		>
			<div className="flex min-h-8 items-center p-1.5 pl-2.5">
				<span className="tool-card-trigger flex min-w-0 items-center gap-2 text-control leading-5 text-text-secondary">
					<span className="tool-card-icon">
						<Wrench size={14} aria-hidden="true" />
					</span>
					<span className="tool-card-name truncate font-medium text-text-primary">{toolName}</span>
					<span className={cn("tool-card-status shrink-0", running && "text-warning", error && "text-danger")}>
						{running ? (
							<span className="inline-flex items-center gap-1.5">
								<span className="tool-card-spinner" aria-hidden="true" />
								{t("tool.statusRunning")}
							</span>
						) : error ? (
							<span className="inline-flex items-center gap-1.5">{t("tool.statusError")}</span>
						) : null}
					</span>
				</span>
			</div>
		</section>
		</TimelineMarker>
	);
});

/** 助手消息：思考 + 工具 + 正文 的扁平容器（不套气泡，左对齐全宽）。 */
export const WebAssistantMessage = memo(function WebAssistantMessage(props: {
	message: UIMessage;
	isStreaming: boolean;
}) {
	const { message, isStreaming } = props;
	return (
		<div className="w-full min-w-0">
			{message.parts.map((part, index) => {
				if (part.type === "reasoning") {
					return <WebThinkingBlock key={index} text={part.text} />;
				}
				if (part.type === "dynamic-tool" || (typeof part.type === "string" && part.type.startsWith("tool-"))) {
					// v7：静态工具 part.type 为 `tool-${toolName}`（tool-input-start 无 dynamic 标志），
					// 动态工具为 "dynamic-tool"；toolName/toolCallId/state 都直接挂在 part 上
					return (
						<WebToolCard
							key={index}
							part={
								part as unknown as WebToolPart
							}
						/>
					);
				}
				if (part.type === "text") {
					return (
						<Fragment key={index}>
							{part.text ? (
								<div className="timeline-inline-text">
									<WebAssistantText text={part.text} isStreaming={isStreaming} />
								</div>
							) : null}
						</Fragment>
					);
				}
				return null;
			})}
		</div>
	);
});

export function WebTimeline(props: {
	messages: UIMessage[];
	hasActiveSession: boolean;
	hasMoreHistory: boolean;
	moreCount: number;
	loadingMore: boolean;
	streaming: boolean;
	error: string | null;
	onLoadMore: () => void;
}) {
	const {
		messages,
		hasActiveSession,
		hasMoreHistory,
		moreCount,
		loadingMore,
		streaming,
		error,
		onLoadMore,
	} = props;
	const timelineRef = useRef<HTMLDivElement | null>(null);

	// 流式期间/新消息到达时自动滚到底（仅当用户已在底部附近时）
	const maybeScrollToBottom = () => {
		const el = timelineRef.current;
		if (!el) return;
		const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (distance < 160) {
			el.scrollTo({ top: el.scrollHeight });
		}
	};

	// 新消息（流式增量/历史恢复）追加后检查一次是否需要跟随滚动；
	// 用 effect 而非渲染期副作用，避免 StrictMode 双渲染重复触发
	const messageCount = messages.length;
	useEffect(() => {
		if (messageCount === 0) return;
		const frame = requestAnimationFrame(maybeScrollToBottom);
		return () => cancelAnimationFrame(frame);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [messageCount]);

	return (
		<section
			className="message-timeline h-full min-h-0 flex-1 overflow-y-auto"
			ref={timelineRef}
			onScroll={maybeScrollToBottom}
		>
			<div className="message-list flex flex-col gap-4 p-4">
				{!hasActiveSession && messages.length === 0 ? (
					<div className="empty-state">
						<div className="empty-logo">
							<svg viewBox="140 140 520 520" width="66" height="66" aria-hidden="true">
								<path fill="#fff" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
								<path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
							</svg>
						</div>
						<p className="empty-hint">{t("web.emptySelection")}</p>
					</div>
				) : messages.length === 0 ? (
					<div className="empty-state">
						<div className="empty-logo">
							<svg viewBox="140 140 520 520" width="66" height="66" aria-hidden="true">
								<path fill="#fff" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
								<path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
							</svg>
						</div>
						<p className="empty-hint">{t("web.noMessages")}</p>
					</div>
				) : (
					<>
						{messages.map((message) => (
							<div key={message.id}>
								{message.role === "user" ? (
									<WebUserBubble message={message} />
								) : (
									<WebAssistantMessage
										message={message}
										isStreaming={
											streaming && message === messages[messages.length - 1]
										}
									/>
								)}
							</div>
						))}
					</>
				)}

				{/* 流式响应指示器 */}
				{streaming && (
					<div className="responding-indicator" data-kind="waiting">
						<span className="responding-indicator-dots flex gap-1" aria-hidden="true">
							<span className="size-1.5 rounded-full" />
							<span className="size-1.5 rounded-full" />
							<span className="size-1.5 rounded-full" />
						</span>
						<span className="responding-indicator-label">{t("app.statusRunning")}</span>
					</div>
				)}

				{/* 错误诊断卡 */}
				{error ? (
					<div className="diagnostic-card tone-error p-3 text-control text-danger">
						{error}
					</div>
				) : null}
			</div>

			{/* 分页加载更多 */}
			{hasMoreHistory && (
				<div className="flex justify-center py-3">
					<Button
						variant="outline"
						size="sm"
						disabled={loadingMore}
						onClick={onLoadMore}
						className="h-8 px-4 text-caption"
					>
						{loadingMore ? t("timeline.loadingMore") : t("timeline.loadMoreHistory", { count: moreCount })}
					</Button>
				</div>
			)}
		</section>
	);
}
