import { memo, useEffect, useRef, useState } from "react";
import { AlertTriangle, Brain, Check, ChevronDown, ChevronRight, MessageCircle, X } from "lucide-react";
import type { ChatMessage } from "../../../../shared/types";
import { t, translateI18nDescriptor } from "../../i18n";
import { formatDuration, formatTime, stripAnsi } from "./TimelineFormat";
import { Textarea } from "../ui-shadcn/textarea";
import { TimelineMarker } from "./TimelineMarker";
import { MarkdownStream } from "./MarkdownStream";

// Button 收口状态（P0）：本文件按钮全部保留原生——
// compaction-card-header / thinking-card-trigger 是折叠触发器 + 内容排版容器（内部 span/small/em 结构）；
// ask-question-card-option 是选项卡片；ask-question-card-submit/cancel 是品牌视觉按钮
// （30px 圆角 14px + 2px 边框 + 硬编码品牌绿/危险色，非 token 值，换装会丢失品牌感）。
// 迁移路径见 P2 CSS 收口。

function getDiagnosticTone(message: ChatMessage): "error" | "warning" | "success" | "info" {
	if (message.role === "error") return "error";
	const status = String(message.meta?.status ?? "");
	if (status === "error") return "error";
	if (status === "running") return "warning";
	if (status === "success") return "success";
	return "info";
}

/** 压缩事件卡片：在时间线上标记会话被压缩过，展示摘要和节约的 token 数。
 * 支持展开查看压缩前的归档消息。 */
export const CompactionCard = memo(function CompactionCard(props: {
	message: ChatMessage;
}) {
	const [expanded, setExpanded] = useState(false);
	const summary = props.message.text;
	const tokensBefore = (props.message.meta as any)?.tokensBefore;
	const compactionCount = (props.message.meta as any)?.compactionCount;
	const archivedMessages = (props.message.meta as any)?.archivedMessages as ChatMessage[] | undefined;
	const time = formatTime(props.message.timestamp);
	const hasArchived = Array.isArray(archivedMessages) && archivedMessages.length > 0;

	return (
		<TimelineMarker kind="compaction" tone="active">
		<article
			className={`my-px flex flex-col overflow-hidden rounded-sm border border-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_4%,var(--color-bg-panel))]${expanded ? " compaction-card--expanded" : ""}`}
			data-message-id={props.message.id}
		>
			<button
				type="button"
				className="flex w-full cursor-pointer items-start gap-2 rounded-[inherit] border-none bg-none p-1 px-3 text-left text-inherit select-none hover:bg-[color:color-mix(in_srgb,var(--color-accent)_6%,transparent)] focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
				onClick={() => hasArchived && setExpanded(!expanded)}
				disabled={!hasArchived}
				aria-expanded={expanded}
			>
				<span className="shrink-0 text-body leading-6" aria-hidden="true">
					{hasArchived ? (expanded ? "📂" : "📁") : "🔁"}
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate text-caption leading-[1.4] text-text-secondary">{stripAnsi(summary)}</span>
					<div className="flex flex-wrap items-center gap-1">
						{typeof compactionCount === "number" && compactionCount > 0 && (
							<span className="inline-flex items-center rounded-full border border-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_8%,transparent)] px-1.5 font-mono text-micro text-text-tertiary">
								{t("app.compactionCount", { count: compactionCount })}
							</span>
						)}
						{typeof tokensBefore === "number" && (
							<span className="font-mono text-micro text-text-tertiary">
								{t("app.compactionTokensBefore", { count: Math.round(tokensBefore / 1000) })}
							</span>
						)}
						{hasArchived && (
							<span className="font-mono text-micro opacity-80 text-text-tertiary">
								{expanded ? t("app.compactionCollapse") : t("app.compactionExpand")}
							</span>
						)}
					</div>
					<time className="text-micro opacity-70 text-text-tertiary">{time}</time>
				</div>
			</button>
			{expanded && hasArchived && (
				<div className="border-t border-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]">
					<div />
					<ArchivedMessageList messages={archivedMessages} />
				</div>
			)}
		</article>
		</TimelineMarker>
	);
});

/** 归档消息列表：压缩卡片展开时，以简略格式渲染压缩前的消息历史。 */
function ArchivedMessageList({ messages }: { messages: ChatMessage[] }) {
	return (
		<div className="flex max-h-[360px] flex-col overflow-y-auto p-1 px-2">
			{messages.map((msg) => (
				<ArchivedMessage key={msg.id} message={msg} />
			))}
		</div>
	);
}

/** 单条归档消息：根据角色显示对应的图标和内容预览。
 * 只展示纯文本内容，不渲染 Markdown / 代码高亮 / 工具详情，保持归档区视觉干净。 */
function ArchivedMessage({ message }: { message: ChatMessage }) {
	const text = stripAnsi(message.text).trim();
	// 截断过长的消息以减少展开区体积
	const preview = text.length > 300 ? text.slice(0, 300) + "…" : text;
	const roleIcon =
		message.role === "user" ? "👤" :
		message.role === "assistant" ? "🤖" :
		message.role === "tool" ? "🔧" : "💬";

	return (
		<div className={`flex items-start gap-1 rounded-[2px] p-0.5 px-1 text-caption leading-[1.4] hover:bg-[color:color-mix(in_srgb,var(--color-accent)_4%,transparent)]${message.role === "user" ? "" : ""}`}>
			<span className="w-5 shrink-0 text-center text-caption">{roleIcon}</span>
			<span className={`min-w-0 flex-1 truncate${message.role === "user" ? " text-text-primary" : message.role === "tool" ? " font-mono text-micro text-text-tertiary" : " text-text-secondary"}`}>{preview || "(empty)"}</span>
		</div>
	);
}

/** 错误/RPC/系统诊断消息使用独立卡片，避免和普通 AI 正文混在一起难以扫读。 */
export const DiagnosticMessageCard = memo(function DiagnosticMessageCard(props: {
	message: ChatMessage;
}) {
	const tone = getDiagnosticTone(props.message);
	const localizedText = translateI18nDescriptor(props.message.meta, props.message.text);
	const debugDetails = typeof props.message.meta?.debugDetails === "string"
		? props.message.meta.debugDetails.trim()
		: "";
	const body = debugDetails ? `${localizedText}\n\n${debugDetails}` : localizedText;
	const title = props.message.role === "error"
		? t("diagnostic.errorTitle")
		: t("diagnostic.systemTitle");
	return (
		<TimelineMarker kind="diagnostic" tone={tone === "error" ? "error" : tone === "warning" ? "warning" : tone === "success" ? "success" : "neutral"}>
		<article
			className={`diagnostic-card w-full min-w-0 overflow-hidden rounded-md border border-border-subtle bg-[var(--color-chat-muted-bg)] tone-${tone}`}
			data-message-id={props.message.id}
			data-role={props.message.role}
		>
			<div className="flex items-center gap-2 px-2 py-1.5 font-mono text-caption text-text-secondary">
				<AlertTriangle size={14} aria-hidden="true" />
				<span className="font-semibold">{title}</span>
				<time className="ml-auto text-micro tabular-nums text-text-tertiary">{formatTime(props.message.timestamp)}</time>
			</div>
			<pre className="m-0 p-2 font-mono text-caption leading-relaxed break-words whitespace-pre-wrap text-text-secondary">{stripAnsi(body)}</pre>
		</article>
		</TimelineMarker>
	);
});

/**
 * 内联提问卡片：渲染 Extension UI 请求（select/confirm/input/editor）作为 system 消息。
 * 用于实时会话中模型通过 ask_question 扩展向用户发起交互。
 */
export const AskQuestionCard = memo(function AskQuestionCard(props: {
	message: ChatMessage;
	onRespond?: (response: { value?: string | boolean; cancelled?: boolean; confirmed?: boolean }) => void;
}) {
	const meta = props.message.meta as Record<string, unknown> | undefined;
	const uiRequest = meta?.uiRequest as Record<string, unknown> | undefined;
	const status = String(meta?.status ?? "pending");
	const response = meta?.response as Record<string, unknown> | undefined;
	const answered = status === "answered" && response && !response.cancelled;
	const cancelled = status === "cancelled" || status === "error";

	const [inputValue, setInputValue] = useState("");
	const [cancelling, setCancelling] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// 编辑器输入 ref
	const editorRef = useRef<HTMLTextAreaElement>(null);

	// 当 prefill 变化时同步到 inputValue
	useEffect(() => {
		if (uiRequest?.prefill) setInputValue(String(uiRequest.prefill));
	}, [uiRequest?.prefill]);

	const handleSelect = (value: string) => {
		props.onRespond?.({ value });
	};

	const handleConfirm = (value: boolean) => {
		props.onRespond?.({ confirmed: value });
	};

	const handleInputSubmit = () => {
		if (inputValue.trim()) {
			props.onRespond?.({ value: inputValue });
		}
	};

	const handleCancel = () => {
		setCancelling(true);
		props.onRespond?.({ cancelled: true });
	};

	// 已回答/取消的卡片：信息已在 ToolCard 的 _askCard 中展示，此处不再重复渲染
	if (answered || cancelled) {
		return null;
	}

	// pending 卡片：显示交互界面
	const cancellingLabel = t("ask.cancelling");
	const method = String(uiRequest?.method ?? "input");
	const title = String(uiRequest?.title ?? "");
	const placeholder = String(uiRequest?.placeholder ?? "");
	const options = uiRequest?.options as string[] | undefined;

	return (
		<TimelineMarker kind="ask" tone="active">
		<article className="ask-question-card pending" data-message-id={props.message.id}>
			<div className="ask-question-card-header">
				<MessageCircle size={14} />
				<span className="ask-question-card-title">{title || t("ask.defaultTitle")}</span>
				<span className="ask-question-card-status">{cancelling ? t("ask.cancelling") : t("ask.waiting")}</span>
			</div>
			<div className="ask-question-card-body">
				{method === "select" && options && options.length > 0 && (
					<div className="ask-question-card-options">
						{/* 过滤掉 Pi 自带的 "✎ 自行输入..." 选项，用下方内联输入框替代 */}
						{options.filter((opt) => !opt.startsWith("✎")).map((opt, i) => (
							<button
								key={i}
								className="ask-question-card-option"
								onClick={() => handleSelect(opt)}
								disabled={cancelling}
							>
								{opt}
							</button>
						))}
					</div>
				)}
				{method === "confirm" && (
					<div className="ask-question-card-options ask-question-card-options-confirm">
						<button
							className="ask-question-card-option ask-question-card-option-yes"
							onClick={() => handleConfirm(true)}
							disabled={cancelling}
						>
							{t("common.true")}
						</button>
						<button
							className="ask-question-card-option ask-question-card-option-no"
							onClick={() => handleConfirm(false)}
							disabled={cancelling}
						>
							{t("common.false")}
						</button>
					</div>
				)}
				{method === "input" && (
					<div className="ask-question-card-input-row">
						<Textarea
							ref={inputRef}
							className="ask-question-card-input"
							placeholder={placeholder || t("ask.inputPlaceholder")}
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									handleInputSubmit();
								}
							}}
							disabled={cancelling}
						/>
						<button
							className="ask-question-card-submit"
							onClick={handleInputSubmit}
							disabled={!inputValue.trim() || cancelling}
							title={t("ask.submit")}
						>
							<Check size={14} />
						</button>
						<button
							className="ask-question-card-cancel"
							onClick={handleCancel}
							disabled={cancelling}
							title={t("common.cancel")}
							aria-label={t("common.cancel")}
						>
							<X size={14} />
						</button>
					</div>
				)}
				{method === "editor" && (
					<div className="ask-question-card-editor-area">
						<Textarea
							ref={editorRef}
							className="ask-question-card-editor"
							placeholder={placeholder || t("ask.editorPlaceholder")}
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							disabled={cancelling}
						/>
						<div className="ask-question-card-editor-actions">
							<button
								className="ask-question-card-submit"
								onClick={handleInputSubmit}
								disabled={!inputValue.trim() || cancelling}
							>
								{t("ask.submit")}
							</button>
							<button
								className="ask-question-card-cancel"
								onClick={handleCancel}
								disabled={cancelling}
								title={t("common.cancel")}
								aria-label={t("common.cancel")}
							>
								<X size={14} />
							</button>
						</div>
					</div>
				)}
			</div>
		</article>
		</TimelineMarker>
	);
});

/** 思考过程折叠卡片：默认展开，展开后以 Markdown 结构渲染推理文本（标题/列表/代码块），
 * 超长时折叠态提供 220 字符截断预览。 */
export const ThinkingBlock = memo(
	function ThinkingBlock(props: {
		text: string;
		startedAt?: number;
		endedAt?: number;
		showThinking?: boolean;
		onOpenExternal: (url: string) => void;
		onOpenFile?: (path: string) => void;
	}) {
	// 默认展开，方便用户看到推理过程；可手动折叠
	const [expanded, setExpanded] = useState(true);
	if (!props.showThinking || !props.text.trim()) return null;
	const previewLen = 220;
	const needsTruncate = props.text.length > previewLen;
	const previewText =
		expanded || !needsTruncate
			? props.text
			: `${props.text.slice(0, previewLen)}...`;
	// 计算思考耗时（毫秒），有 endAt 且有 startAt 时才显示
	const durationMs =
		props.endedAt && props.startedAt && props.endedAt >= props.startedAt
			? props.endedAt - props.startedAt
			: null;
	const durationText = durationMs != null ? formatDuration(durationMs) : null;
	return (
		<TimelineMarker kind="thinking" tone={props.endedAt ? "neutral" : "active"}>
		<section className="w-full min-w-0 overflow-hidden rounded-md border-0">
			<button
				className="flex min-h-8 w-full cursor-pointer items-center gap-2 border-0 bg-transparent p-1.5 pl-2.5 text-left text-control leading-5 text-text-secondary transition-colors duration-150 hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,var(--color-bg))] focus-visible:-outline-offset-2 focus-visible:outline-2 [&_svg]:shrink-0 [&_svg]:text-[var(--color-info)]"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
			>
				<Brain size={15} />
				<span className="shrink-0 text-body font-[650] text-text-primary">{t("thinking.title")}</span>
				{expanded ? (
					<ChevronDown size={15} className="shrink-0 text-text-tertiary" aria-hidden="true" />
				) : (
					<ChevronRight size={15} className="shrink-0 text-text-tertiary" aria-hidden="true" />
				)}
				{!expanded && props.text && (
					<span className="min-w-0 flex-[1_1_auto] truncate font-mono text-caption text-text-tertiary" title={props.text}>
						{props.text.slice(0, 80)}{props.text.length > 80 ? "..." : ""}
					</span>
				)}
				{durationText && <small className="shrink-0 font-mono text-micro tabular-nums text-text-tertiary">{durationText}</small>}
			</button>
			{expanded && (
				<div className="markdown-body border-t border-border-subtle px-3 pt-2 pb-3 text-text-tertiary">
					<MarkdownStream
						text={previewText}
						onOpenExternal={props.onOpenExternal}
						onOpenFile={props.onOpenFile}
					/>
				</div>
			)}
		</section>
		</TimelineMarker>
	);
	},
	// 回调函数（onOpenExternal/onOpenFile）行为稳定（读 ref），不参与比较
	(prev, next) =>
		prev.text === next.text &&
		prev.startedAt === next.startedAt &&
		prev.endedAt === next.endedAt &&
		prev.showThinking === next.showThinking,
);



/**
 * 流式响应指示器（三点脉动动画 + 状态文案），在 agent 运行/流式期间显示。
 *
 * 状态优先级：
 *  1. Agent 启动中 → "正在启动 Agent"（琥珀色）
 *  2. 工具执行中 → "正在工具调用"（琥珀色）
 *  3. 有思考文本 / 流式回答中 → "正在回应"
 *  4. 过渡等待 → 只显示三点动画，无标签
 *
 * 启动状态单独展示，避免用户发消息后 Agent 尚未完成预热时看起来像“没有响应”。
 */
export function RespondingIndicator(props: {
	thinking?: string;
	showThinking?: boolean;
	isStarting?: boolean;
	isExecutingTool?: boolean;
	isStreaming?: boolean;
}) {
	const { isStarting, isExecutingTool, isStreaming, thinking, showThinking } = props;

	let kind: "starting" | "executing" | "responding" | "waiting";
	let label: string;

	if (isStarting) {
		kind = "starting";
		label = t("app.agentStarting");
	} else if (isExecutingTool) {
		kind = "executing";
		label = t("thinking.executing");
	} else if ((showThinking && thinking && thinking.length > 0) || isStreaming) {
		// 有思考文本或流式回答中统一显示“正在回应”
		kind = "responding";
		label = t("thinking.responding");
	} else {
		// 过渡等待：只显示三点动画
		kind = "waiting";
		label = "...";
	}

	return (
		<div className="responding-indicator" data-kind={kind}>
			<span className="responding-indicator-dots" aria-hidden="true">
				<span />
				<span />
				<span />
			</span>
			{/* 标签始终渲染，waiting 态通过 CSS visibility:hidden 隐藏，保持容器宽度稳定 */}
			<span className="responding-indicator-label">{label}</span>
		</div>
	);
}

/** 宠物选择预览：给定宠物清单项，用 <canvas> 解码其 spritesheet 并循环播放
 *  对应 mode 行（默认 idle）的网格帧，让用户在选择宠物时即时看到动画效果，
 *  不必切换真实宠物窗。失败时降级为空占位，不阻塞设置面板。 */
