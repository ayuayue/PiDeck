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
import { ArrowDown, Brain, ChevronDown, ChevronRight, ChevronUp, Wrench } from "lucide-react";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { splitAskOption, formatAskTitle, serializeBatchAnswers } from "../utils/askUi";
import { WebAssistantText } from "./WebAssistantText";
import type { WebPendingUiRequest } from "./webTypes";
import type { AgentUiResponse } from "../../../shared/types";
import { MarkdownStream } from "@/components/session/MarkdownStream";
import { SingleLinePreview } from "@/components/session/SingleLinePreview";
import { TimelineMarker } from "../components/session/TimelineMarker";
import { LogoMark } from "../components/app/LogoMark";

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
				<div className="text-chat text-text-primary whitespace-pre-wrap break-words">{text}</div>
			</div>
		</article>
	);
});

/** 思考折叠卡片（复用桌面 ThinkingBlock 视觉：Brain + 耗时/标题 + 同行预览）。
 * 默认永远单行；流式时预览尾部跟随，不自动撑开正文（对齐 dsh-web ReasoningRow）。 */
export const WebThinkingBlock = memo(function WebThinkingBlock(props: {
	text: string;
	/** 思考是否仍在流式：折叠预览尾部跟随，不驱动自动展开 */
	running?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	if (!props.text.trim()) return null;
	return (
		<TimelineMarker kind="thinking" tone={props.running ? "active" : "neutral"} contentClassName="pb-1">
			<section className="w-full min-w-0 overflow-hidden rounded-md border-0">
				<button
					type="button"
					className="relative flex min-h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1 py-1 text-left text-control leading-5 text-text-secondary transition-[background-color,transform] duration-150 motion-reduce:transition-none hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)] active:scale-[0.99] focus-visible:-outline-offset-2 focus-visible:outline-2 [&_svg]:shrink-0"
					onClick={() => setExpanded((value) => !value)}
					aria-expanded={expanded}
					title={expanded ? t("thinking.collapse") : t("thinking.expand")}
				>
					{props.running && <span aria-hidden className="pointer-events-none absolute inset-y-0 left-[-300px] w-[300px] animate-thinking-sweep motion-reduce:animate-none bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--color-bg-app)_55%,transparent),transparent)]" />}
					<Brain size={16} className="thinking-row-icon" />
					<span className="shrink-0 font-mono text-caption tabular-nums text-text-secondary">{t("thinking.title")}</span>
					{expanded ? <ChevronDown size={14} className="shrink-0 text-text-tertiary" aria-hidden="true" /> : <ChevronRight size={14} className="shrink-0 text-text-tertiary" aria-hidden="true" />}
					{!expanded && <SingleLinePreview text={props.text} running={props.running} showSweep={false} className="min-w-0 flex-[1_1_auto] font-mono text-caption text-text-secondary" />}
				</button>
				{expanded && (
					<div className="relative ml-5 mt-1 mb-2 rounded-b-sm border-l-2 border-border-subtle bg-transparent pl-3 animate-in fade-in slide-in-from-top-1 duration-150">
						<div className="markdown-body px-0 pt-1 pb-1 text-text-tertiary">
							<MarkdownStream
								text={props.text}
								isStreaming={props.running}
								onOpenExternal={(url: string) => {
									// Web 端无系统浏览器通道，直接新窗口打开
									window.open(url, "_blank", "noopener");
								}}
							/>
						</div>
						<div className="flex pb-1.5">
							<button
								type="button"
								className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro text-text-tertiary transition-colors duration-150 hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_45%,transparent)] hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
								onClick={() => setExpanded(false)}
							>
								<ChevronUp size={12} aria-hidden="true" />
								{t("thinking.collapse")}
							</button>
						</div>
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
	const toolName = part.toolName || (typeof part.type === "string" && part.type.startsWith("tool-") ? part.type.slice("tool-".length) : "tool");
	const state = part.state ?? "input-streaming";
	const running = state === "input-streaming" || state === "input-available";
	const error = state === "output-error" || state === "error" || Boolean(part.errorText);
	return (
		<TimelineMarker kind="tool" tone={error ? "error" : running ? "active" : "success"}>
			<section className={cn("tool-card w-full min-w-0 overflow-hidden", running && "tone-running", error && "tone-error")} data-status={error ? "error" : running ? "running" : "done"} data-tool-name={toolName}>
				<div className="relative flex min-h-7 items-center rounded-md px-1 py-1">
					<span className="tool-card-trigger flex min-w-0 items-center gap-2 text-control leading-5 text-text-secondary">
						<span className="tool-card-icon">
							<Wrench size={14} aria-hidden="true" />
						</span>
						<span className="tool-card-name truncate font-medium text-text-primary">{toolName}</span>
						<span className={cn("tool-card-status shrink-0", running && "text-warning", error && "text-danger")}>
							{running ? (
								<span className="inline-flex items-center gap-1.5">
									<span className="tool-card-spinner animate-pideck-spin" aria-hidden="true" />
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
export const WebAssistantMessage = memo(function WebAssistantMessage(props: { message: UIMessage; isStreaming: boolean }) {
	const { message, isStreaming } = props;
	return (
		<div className="w-full min-w-0">
			{message.parts.map((part, index) => {
				if (part.type === "reasoning") {
					return <WebThinkingBlock key={index} text={part.text} running={isStreaming} />;
				}
				if (part.type === "dynamic-tool" || (typeof part.type === "string" && part.type.startsWith("tool-"))) {
					// v7：静态工具 part.type 为 `tool-${toolName}`（tool-input-start 无 dynamic 标志），
					// 动态工具为 "dynamic-tool"；toolName/toolCallId/state 都直接挂在 part 上
					return <WebToolCard key={index} part={part as unknown as WebToolPart} />;
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

function WebAskCard(props: { request: WebPendingUiRequest; busy: boolean; onRespond: (response: AgentUiResponse) => void }) {
	const batchQuestions = props.request.batchQuestions;
	const isBatch = Boolean(batchQuestions && batchQuestions.length > 0);

	// 状态：用于批量问答
	const [batchTab, setBatchTab] = useState(0);
	const [batchAnswers, setBatchAnswers] = useState<Record<string, string | boolean | string[]>>({});
	const [batchInput, setBatchInput] = useState("");

	// 单问题/普通输入框
	const [draft, setDraft] = useState(props.request.prefill ?? "");
	const method = props.request.method;
	const options = (props.request.options ?? []).filter((option) => !option.startsWith("✎"));

	// 如果是批量问题或者 multi_select 信封
	if (isBatch && batchQuestions && batchQuestions.length > 0) {
		const currentQ = batchQuestions[batchTab] || batchQuestions[0];
		const total = batchQuestions.length;
		const isLast = batchTab === total - 1;
		const currentAns = batchAnswers[currentQ.id];

		const handleAnswerOne = (val: string | boolean | string[]) => {
			const updated = { ...batchAnswers, [currentQ.id]: val };
			setBatchAnswers(updated);
			if (!isLast) {
				setBatchTab(batchTab + 1);
				setBatchInput("");
			} else {
				// 提交全部答案
				const serialized = serializeBatchAnswers(batchQuestions, updated);
				props.onRespond({ value: serialized });
			}
		};

		const handleToggleMulti = (val: string) => {
			const arr = Array.isArray(currentAns) ? [...currentAns] : [];
			const idx = arr.indexOf(val);
			if (idx >= 0) arr.splice(idx, 1);
			else arr.push(val);
			setBatchAnswers({ ...batchAnswers, [currentQ.id]: arr });
		};

		return (
			<section className="mt-3 rounded-lg border border-border bg-card p-3 shadow-sm">
				<div className="mb-2 flex items-center justify-between text-caption font-medium text-foreground">
					<span>
						{t("ask.toolName")} ({batchTab + 1}/{total})
					</span>
					{total > 1 ? (
						<div className="flex gap-1">
							{batchQuestions.map((q, idx) => (
								<button
									key={q.id}
									type="button"
									className={cn("h-5 w-5 rounded text-xs", idx === batchTab ? "bg-primary text-primary-foreground font-semibold" : batchAnswers[q.id] !== undefined ? "bg-muted text-foreground" : "bg-muted/40 text-muted-foreground")}
									onClick={() => {
										setBatchTab(idx);
										setBatchInput("");
									}}
								>
									{idx + 1}
								</button>
							))}
						</div>
					) : null}
				</div>

				<p className="mb-3 whitespace-pre-wrap break-words text-sm font-medium text-foreground [overflow-wrap:anywhere]">{currentQ.question}</p>

				{/* 选项渲染 */}
				{currentQ.type === "select" && currentQ.options && currentQ.options.length > 0 ? (
					<div className="flex flex-col gap-2">
						{currentQ.options.map((opt) => {
							const label = typeof opt === "string" ? opt : opt.label;
							const desc = typeof opt === "string" ? undefined : opt.description;
							const val = typeof opt === "string" ? opt : (opt.value ?? opt.label);
							return (
								<Button key={label} type="button" variant={currentAns === val ? "default" : "secondary"} size="sm" className="h-auto min-h-9 w-full flex-col items-start justify-center whitespace-normal break-words py-2 text-left" disabled={props.busy} onClick={() => handleAnswerOne(val)}>
									<span className="whitespace-pre-wrap break-words">{label}</span>
									{desc ? <span className="text-xs font-normal leading-relaxed text-muted-foreground">{desc}</span> : null}
								</Button>
							);
						})}
						{/* select 自定义输入恒定显示（与桌面端批量卡同语义）：ask_question 统一走批量
						    信封后手机端若缺这个框，用户就只能从预设选项里答。allowOther !== false 判断
						    保留给 plan-mode 等非 ask 来源。 */}
						{currentQ.allowOther !== false ? (
							<>
								<textarea className="min-h-16 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" placeholder={currentQ.placeholder || t("ask.customPlaceholder")} value={batchInput} disabled={props.busy} onChange={(event) => setBatchInput(event.target.value)} />
								<Button type="button" size="sm" disabled={props.busy || !batchInput.trim()} onClick={() => handleAnswerOne(batchInput.trim())}>
									{isLast ? t("ask.submit") : t("ask.batchNext")}
								</Button>
							</>
						) : null}
					</div>
				) : currentQ.type === "multi_select" && currentQ.options && currentQ.options.length > 0 ? (
					<div className="flex flex-col gap-2">
						{currentQ.options.map((opt) => {
							const label = typeof opt === "string" ? opt : opt.label;
							const desc = typeof opt === "string" ? undefined : opt.description;
							const val = typeof opt === "string" ? opt : (opt.value ?? opt.label);
							const selected = Array.isArray(currentAns) && currentAns.includes(val);
							return (
								<Button key={label} type="button" variant={selected ? "default" : "secondary"} size="sm" className="h-auto min-h-9 w-full flex-col items-start justify-center whitespace-normal break-words py-2 text-left" disabled={props.busy} onClick={() => handleToggleMulti(val)}>
									<span className="whitespace-pre-wrap break-words">
										{selected ? "✓ " : "○ "}
										{label}
									</span>
									{desc ? <span className="text-xs font-normal leading-relaxed text-muted-foreground">{desc}</span> : null}
								</Button>
							);
						})}
						<Button type="button" size="sm" className="mt-2" disabled={props.busy || !Array.isArray(currentAns) || currentAns.length === 0} onClick={() => handleAnswerOne(currentAns ?? [])}>
							{isLast ? t("ask.submit") : t("ask.batchNext")}
						</Button>
					</div>
				) : currentQ.type === "confirm" ? (
					<div className="flex gap-2">
						<Button type="button" size="sm" disabled={props.busy} onClick={() => handleAnswerOne(true)}>
							{t("common.true")}
						</Button>
						<Button type="button" variant="secondary" size="sm" disabled={props.busy} onClick={() => handleAnswerOne(false)}>
							{t("common.false")}
						</Button>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						<textarea className="min-h-16 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" placeholder={currentQ.placeholder || t("ask.inputPlaceholder")} value={batchInput} disabled={props.busy} onChange={(event) => setBatchInput(event.target.value)} />
						<Button type="button" size="sm" disabled={props.busy || !batchInput.trim()} onClick={() => handleAnswerOne(batchInput.trim())}>
							{isLast ? t("ask.submit") : t("ask.batchNext")}
						</Button>
					</div>
				)}

				<Button type="button" variant="ghost" size="sm" className="mt-2" disabled={props.busy} onClick={() => props.onRespond({ cancelled: true })}>
					{t("common.cancel")}
				</Button>
			</section>
		);
	}

	const displayTitle = formatAskTitle(props.request.title || t("ask.defaultTitle"));

	return (
		<section className="mt-3 rounded-lg border border-border bg-card p-3 shadow-sm">
			<div className="mb-2 text-caption font-medium text-foreground">{t("ask.toolName")}</div>
			<p className="mb-3 whitespace-pre-wrap break-words text-sm text-foreground [overflow-wrap:anywhere]">{displayTitle}</p>
			{method === "select" && options.length > 0 ? (
				<div className="flex flex-col gap-2">
					{options.map((option) => {
						const parsed = splitAskOption(option);
						return (
							<Button key={option} type="button" variant="secondary" size="sm" className="h-auto min-h-9 w-full flex-col items-start justify-center whitespace-normal break-words py-2 text-left" disabled={props.busy} onClick={() => props.onRespond({ value: option })}>
								<span className="whitespace-pre-wrap break-words">{parsed.label}</span>
								{parsed.description ? <span className="text-xs font-normal leading-relaxed text-muted-foreground">{parsed.description}</span> : null}
							</Button>
						);
					})}
				</div>
			) : method === "confirm" ? (
				<div className="flex gap-2">
					<Button type="button" size="sm" disabled={props.busy} onClick={() => props.onRespond({ confirmed: true })}>
						{t("common.true")}
					</Button>
					<Button type="button" variant="secondary" size="sm" disabled={props.busy} onClick={() => props.onRespond({ confirmed: false })}>
						{t("common.false")}
					</Button>
				</div>
			) : (
				<div className="flex flex-col gap-2">
					<textarea className="min-h-16 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" placeholder={props.request.placeholder || t("ask.inputPlaceholder")} value={draft} disabled={props.busy} onChange={(event) => setDraft(event.target.value)} />
					<Button type="button" size="sm" disabled={props.busy || !draft.trim()} onClick={() => props.onRespond({ value: draft.trim() })}>
						{t("ask.submit")}
					</Button>
				</div>
			)}
			<Button type="button" variant="ghost" size="sm" className="mt-2" disabled={props.busy} onClick={() => props.onRespond({ cancelled: true })}>
				{t("common.cancel")}
			</Button>
		</section>
	);
}

export function WebTimeline(props: {
	messages: UIMessage[];
	hasActiveSession: boolean;
	hasMoreHistory: boolean;
	moreCount: number;
	loadingMore: boolean;
	streaming: boolean;
	error: string | null;
	pendingUiRequest?: WebPendingUiRequest;
	uiResponding?: boolean;
	onRespondUi?: (response: AgentUiResponse) => void;
	onLoadMore: () => void;
}) {
	const { messages, hasActiveSession, hasMoreHistory, moreCount, loadingMore, streaming, error, onLoadMore } = props;
	const timelineRef = useRef<HTMLDivElement | null>(null);
	const stickToBottomRef = useRef(true);
	const [showScrollToBottom, setShowScrollToBottom] = useState(false);

	const updateScrollState = () => {
		const el = timelineRef.current;
		if (!el) return;
		const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
		const nearBottom = distance < 160;
		stickToBottomRef.current = nearBottom;
		setShowScrollToBottom(!nearBottom && messages.length > 0);
	};

	const scrollToBottom = () => {
		const el = timelineRef.current;
		if (!el) return;
		stickToBottomRef.current = true;
		setShowScrollToBottom(false);
		el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
	};

	// 新消息或流式增量到达时，仅在用户原本接近底部时跟随，避免打断用户阅读历史。
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			const el = timelineRef.current;
			if (el && stickToBottomRef.current) el.scrollTo({ top: el.scrollHeight });
			updateScrollState();
		});
		return () => cancelAnimationFrame(frame);
		// messages 变化既覆盖新消息，也覆盖同一条 assistant 消息的流式增量。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [messages, streaming]);

	return (
		<section className="message-timeline relative h-full min-h-0 flex-1 overflow-y-auto" ref={timelineRef} onScroll={updateScrollState}>
			<div className="message-list flex flex-col gap-4 p-4">
				{!hasActiveSession && messages.length === 0 ? (
					<div className="empty-state">
						<div className="empty-logo">
							<LogoMark size={66} />
						</div>
						<p className="empty-hint">{t("web.emptySelection")}</p>
					</div>
				) : messages.length === 0 ? (
					<div className="empty-state">
						<div className="empty-logo">
							<LogoMark size={66} />
						</div>
						<p className="empty-hint">{t("web.noMessages")}</p>
					</div>
				) : (
					<>
						{messages.map((message) => (
							<div key={message.id}>{message.role === "user" ? <WebUserBubble message={message} /> : <WebAssistantMessage message={message} isStreaming={streaming && message === messages[messages.length - 1]} />}</div>
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
				{error ? <div className="diagnostic-card tone-error p-3 text-control text-danger">{error}</div> : null}

				{props.pendingUiRequest && props.onRespondUi ? <WebAskCard request={props.pendingUiRequest} busy={Boolean(props.uiResponding)} onRespond={props.onRespondUi} /> : null}
			</div>

			{showScrollToBottom && (
				<Button variant="secondary" size="icon" className="absolute right-4 bottom-4 z-10 size-9 rounded-full border border-border bg-background/95 shadow-md" onClick={scrollToBottom} aria-label={t("web.scrollToBottom")} title={t("web.scrollToBottom")}>
					<ArrowDown className="size-4" aria-hidden="true" />
				</Button>
			)}

			{/* 分页加载更多 */}
			{hasMoreHistory && (
				<div className="flex justify-center py-3">
					<Button variant="outline" size="sm" disabled={loadingMore} onClick={onLoadMore} className="h-8 px-4 text-caption">
						{loadingMore ? t("timeline.loadingMore") : t("timeline.loadMoreHistory", { count: moreCount })}
					</Button>
				</div>
			)}
		</section>
	);
}
