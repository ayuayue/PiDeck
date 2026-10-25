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
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, ArrowDown, Brain, Check, ChevronDown, ChevronRight, ChevronUp, Copy, ListTree, MessagesSquare, Pencil, RefreshCw, Share2, Trash2, Wrench, X } from "lucide-react";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { shareWebText } from "./webShare";
import { cn } from "@/lib/utils";
import { splitAskOption, formatAskTitle, serializeBatchAnswers } from "../utils/askUi";
import { WebAssistantText } from "./WebAssistantText";
import type { WebPendingUiRequest } from "./webTypes";
import type { AgentUiResponse } from "../../../shared/types";
import { MarkdownStream } from "@/components/session/MarkdownStream";
import { SingleLinePreview } from "@/components/session/SingleLinePreview";
import { TimelineMarker } from "../components/session/TimelineMarker";
import { LogoMark } from "../components/app/LogoMark";
import { copyTextToClipboard } from "./webClipboard";

/** 工具参数/结果格式化：字符串原样，对象 pretty JSON，超长截断。 */
function prettyToolValue(value: unknown, maxChars = 4000): string {
	if (value == null) return "";
	let text = typeof value === "string" ? value : "";
	if (!text) {
		try {
			text = JSON.stringify(value, null, 2);
		} catch {
			text = String(value);
		}
	}
	return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (${text.length} chars)` : text;
}

// 纯函数已抽到 webMessageParts（叶子模块，vm 沙箱单测可用）；re-export 保持既有导入路径不破，
// 本模块内部也直接使用（WebUserBubble 渲染）
import { uiMessageText, uiMessageImages } from "./webMessageParts";
export { uiMessageText, uiMessageImages } from "./webMessageParts";

// 分组纯函数已抽到 webTimelineGrouping（叶子模块，vm 沙箱单测可用）；re-export 保持既有导入路径不破
import { groupTimelineEntries, sliceEntriesToBoundary, turnPrefixBoundary, validTurnPrefix, type TurnPrefixCache } from "./webTimelineGrouping";
import type { AssistantTurn, TimelineEntry, TurnSegment, WebToolPart } from "./webTimelineGrouping";
export { groupTimelineEntries } from "./webTimelineGrouping";
export { validTurnPrefix, turnPrefixBoundary, sliceEntriesToBoundary } from "./webTimelineGrouping";
export type { AssistantTurn, TimelineEntry, TurnSegment, WebToolPart } from "./webTimelineGrouping";

/** 用户消息右对齐气泡（结构与桌面 UserBubble 一致；P1/P2 增加图片与 hover 操作）。 */
export const WebUserBubble = memo(function WebUserBubble(props: {
	message: UIMessage;
	/** 编辑/重发可用（pi 会话 fork 化后冷会话也可用；DSH 需 runtime 存活） */
	canManage?: boolean;
	/** 删除可用（delete-message 是 runtime 命令，必须 runtime 存活） */
	canDelete?: boolean;
	onEdit?: (messageId: string, newText: string) => void;
	onDelete?: (messageId: string) => void;
	onResend?: (messageId: string) => void;
	/** 乐观更新进行中：编辑=等待服务端确认，删除=即将退场，重发=fork 化迁移中 */
	pendingAction?: "edit" | "delete" | "resend" | null;
	/** 编辑保存成功的确认反馈：气泡闪一拍品牌色环 */
	flash?: boolean;
}) {
	const text = uiMessageText(props.message);
	const images = uiMessageImages(props.message);
	const [editing, setEditing] = useState(false);
	const [editDraft, setEditDraft] = useState("");
	if (!text.trim() && images.length === 0) return null;
	const manage = Boolean(props.canManage && props.onEdit && props.onResend);
	const canDelete = Boolean(props.canDelete && props.onDelete);
	return (
		<article className="user-turn group/user mb-4 flex w-full min-w-0 max-w-full flex-col items-end">
			{images.length > 0 ? (
				<div className="mb-1.5 flex w-fit max-w-full flex-wrap justify-end gap-1.5">
					{images.map((src, index) => (
						// eslint-disable-next-line @next/next/no-img-element
						<img key={index} src={src} alt={t("web.messageImage")} className="h-24 w-24 rounded-lg border border-border object-cover" loading="lazy" />
					))}
				</div>
			) : null}
			{editing ? (
				<div className="w-fit min-w-0 max-w-[min(82%,64ch)] rounded-lg border border-primary/40 bg-muted/60 px-3.5 py-2.5">
					<textarea
						className="min-h-16 w-full resize-y rounded-md bg-transparent text-sm text-text-primary outline-none"
						value={editDraft}
						autoFocus
						onChange={(event) => setEditDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") setEditing(false);
							if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
								event.preventDefault();
								if (editDraft.trim()) {
									props.onEdit?.(props.message.id, editDraft.trim());
									setEditing(false);
								}
							}
						}}
					/>
					<div className="mt-1.5 flex justify-end gap-1.5">
						<Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => setEditing(false)}>
							<X className="size-3.5" aria-hidden="true" />
						</Button>
						<Button
							type="button"
							size="sm"
							className="h-7 px-2"
							disabled={!editDraft.trim()}
							onClick={() => {
								if (editDraft.trim()) {
									props.onEdit?.(props.message.id, editDraft.trim());
									setEditing(false);
								}
							}}
						>
							<Check className="size-3.5" aria-hidden="true" />
						</Button>
					</div>
				</div>
			) : (
				<>
					{text.trim() ? (
						<div className={cn("w-fit min-w-0 max-w-[min(82%,64ch)] rounded-lg border border-border bg-muted/60 px-3.5 py-2.5 text-sm text-foreground [overflow-wrap:anywhere] break-words", props.flash && "web-msg-flash-ring")}>
							<div className="text-chat text-text-primary whitespace-pre-wrap break-words">{text}</div>
						</div>
					) : null}
					{/* hover 操作行：复制恒有；编辑/删除/重发需 runtime 存活；触屏无 hover，常驻显示。
						乐观更新进行中整行换成状态指示，避免重复触发。 */}
					{props.pendingAction ? (
						<div className="mt-1 flex items-center gap-1.5 text-xs text-text-tertiary" role="status">
							<Loader2 className="size-3.5 animate-pideck-spin" aria-hidden="true" />
							{props.pendingAction === "edit" ? t("web.msgSaving") : props.pendingAction === "resend" ? t("web.msgResending") : t("web.msgDeleting")}
						</div>
					) : (
						<div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100">
							<ActionButton label={t("web.msgCopy")} onClick={() => void copyTextToClipboard(text)}>
								<Copy className="size-3.5" aria-hidden="true" />
							</ActionButton>
							{manage ? (
								<>
									<ActionButton
										label={t("web.msgEdit")}
										onClick={() => {
											setEditDraft(text);
											setEditing(true);
										}}
									>
										<Pencil className="size-3.5" aria-hidden="true" />
									</ActionButton>
									<ActionButton label={t("web.msgResend")} onClick={() => props.onResend?.(props.message.id)}>
										<RefreshCw className="size-3.5" aria-hidden="true" />
									</ActionButton>
									{canDelete ? (
										<ActionButton label={t("web.msgDelete")} danger onClick={() => props.onDelete?.(props.message.id)}>
											<Trash2 className="size-3.5" aria-hidden="true" />
										</ActionButton>
									) : null}
								</>
							) : null}
						</div>
					)}
				</>
			)}
		</article>
	);
});

/** hover 工具按钮（消息操作行用）。 */
function ActionButton(props: { label: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
	return (
		<button
			type="button"
			className={cn(
				// 触屏（pointer:coarse）放大到 36px：24px 图标钮在手机上误触率高（移动走查 #1）
				"inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_60%,transparent)] hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] pointer-coarse:size-9",
				props.danger && "hover:text-danger",
			)}
			title={props.label}
			aria-label={props.label}
			onClick={props.onClick}
		>
			{props.children}
		</button>
	);
}

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
					className="relative flex min-h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1 py-1 text-left text-control leading-5 text-text-secondary transition-[background-color,transform] duration-150 motion-reduce:transition-none hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)] active:scale-[0.99] focus-visible:-outline-offset-2 focus-visible:outline-2 [&_svg]:shrink-0 pointer-coarse:min-h-9"
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
								className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro text-text-tertiary transition-colors duration-150 pointer-coarse:py-2 hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_45%,transparent)] hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
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

/** 工具卡片（复用桌面 tool-card 视觉：图标 + 工具名 + 状态）。 */
export const WebToolCard = memo(function WebToolCard(props: { part: WebToolPart }) {
	const { part } = props;
	// 静态工具 part 不携带 toolName，名称嵌在 type 里（`tool-${name}`）；动态工具带 toolName
	const toolName = part.toolName || (typeof part.type === "string" && part.type.startsWith("tool-") ? part.type.slice("tool-".length) : "tool");
	const state = part.state ?? "input-streaming";
	const running = state === "input-streaming" || state === "input-available";
	const error = state === "output-error" || state === "error" || Boolean(part.errorText);
	const [expanded, setExpanded] = useState(false);
	const inputText = prettyToolValue(part.input);
	const outputText = prettyToolValue(part.output);
	const errorText = typeof part.errorText === "string" ? prettyToolValue(part.errorText) : "";
	// 运行中（输出未到）也可先展开看已流式到的输入
	const hasBody = Boolean(inputText || outputText || errorText);
	return (
		<TimelineMarker kind="tool" tone={error ? "error" : running ? "active" : "success"} contentClassName="pb-1">
			<section className={cn("tool-card w-full min-w-0 overflow-hidden", running && "tone-running", error && "tone-error")} data-status={error ? "error" : running ? "running" : "done"} data-tool-name={toolName}>
				<button type="button" className="relative flex min-h-7 w-full cursor-pointer items-center rounded-md px-1 py-1 text-left pointer-coarse:min-h-9" onClick={() => hasBody && setExpanded((value) => !value)} aria-expanded={expanded}>
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
						{hasBody ? expanded ? <ChevronDown size={14} className="ml-auto shrink-0 text-text-tertiary" aria-hidden="true" /> : <ChevronRight size={14} className="ml-auto shrink-0 text-text-tertiary" aria-hidden="true" /> : null}
					</span>
				</button>
				{expanded ? (
					<div className="mx-1 mb-1 space-y-1.5 rounded-md border border-border-subtle bg-[color:color-mix(in_srgb,var(--color-bg-app)_60%,transparent)] p-2">
						{errorText ? <ToolValueBlock label={t("web.toolError")} text={errorText} tone="error" /> : null}
						{inputText ? <ToolValueBlock label={t("web.toolInput")} text={inputText} /> : null}
						{outputText ? <ToolValueBlock label={t("web.toolOutput")} text={outputText} /> : null}
					</div>
				) : null}
			</section>
		</TimelineMarker>
	);
});

/** 工具输入/输出展示块（等宽 + 限高滚动）。 */
function ToolValueBlock(props: { label: string; text: string; tone?: "error" }) {
	return (
		<div className="min-w-0">
			<div className={cn("mb-0.5 font-mono text-micro uppercase tracking-wide text-text-tertiary", props.tone === "error" && "text-danger")}>{props.label}</div>
			<pre className={cn("max-h-56 overflow-auto rounded border border-border-subtle bg-black/[0.03] p-1.5 font-mono text-micro leading-relaxed whitespace-pre-wrap break-all text-text-secondary", props.tone === "error" && "text-danger")}>{props.text}</pre>
		</div>
	);
}

/** 助手回合：连续 assistant 消息聚合成一轮（对齐桌面 TurnRow 语义）。
 *
 * - 过程内容（合并后的思考块/工具卡/中间回复）收进「执行过程」折叠容器，
 *   摘要条对齐桌面 ProcessSummaryToggle（ListTree + 计数）；
 * - 最后一段非空正文常驻容器外，流式中即正在生成的文本（不被折叠卸载）；
 * - 操作行（复制/分享）只挂回合尾，中间回复不再各自携带；
 * - 流式中过程组自动展开（实时看过程），结束回落折叠（历史紧凑），手动开合优先。
 */
export const WebAssistantTurn = memo(function WebAssistantTurn(props: { turn: AssistantTurn; isStreaming: boolean; onOpenFile?: (path: string, line?: number) => void }) {
	const { turn } = props;
	const [manualOpen, setManualOpen] = useState<boolean | null>(null);
	const processOpen = manualOpen ?? props.isStreaming;
	const hasProcess = turn.segments.length > 0;
	// 流式中的末段正文挂折叠容器外常显（打字机，桌面 liveInterimId 同款）：它仍在 segments
	// 里参与计数，但容器内不再重复渲染；收尾后重分组提升为 finalText，此处自然消失。
	const liveTextSegment = props.isStreaming && turn.liveTextId ? turn.segments.find((segment) => segment.kind === "interim" && segment.id === turn.liveTextId) : undefined;
	const liveTextString = liveTextSegment && liveTextSegment.kind === "interim" ? liveTextSegment.text : undefined;
	return (
		<div className="group/assistant flex w-full min-w-0 flex-col gap-2">
			{hasProcess ? (
				<div className="execution-fold" data-open={processOpen}>
					<button
						type="button"
						className="inline-flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-control text-text-secondary transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] pointer-coarse:h-9"
						onClick={() => setManualOpen(!processOpen)}
						aria-expanded={processOpen}
						title={processOpen ? t("common.collapse") : t("common.expand")}
					>
						{processOpen ? <ChevronDown size={13} className="shrink-0 text-text-tertiary" aria-hidden="true" /> : <ChevronRight size={13} className="shrink-0 text-text-tertiary" aria-hidden="true" />}
						<ListTree size={13} className="shrink-0 text-text-tertiary" aria-hidden="true" />
						<span className="shrink-0 font-medium">{t("activity.executionTitle")}</span>
						<span className="inline-flex min-w-0 items-center gap-2 text-text-tertiary">
							{turn.toolCount > 0 ? (
								<span className="inline-flex items-center gap-0.5" title={t("activity.executionToolCount", { count: turn.toolCount })}>
									<Wrench size={12} aria-hidden="true" />
									<span className="tabular-nums">{turn.toolCount}</span>
								</span>
							) : null}
							{turn.thinkingCount > 0 ? (
								<span className="inline-flex items-center gap-0.5" title={t("activity.executionThinkingCount", { count: turn.thinkingCount })}>
									<Brain size={12} aria-hidden="true" />
									<span className="tabular-nums">{turn.thinkingCount}</span>
								</span>
							) : null}
							{turn.interimCount > 0 ? (
								<span className="inline-flex items-center gap-0.5" title={t("activity.executionInterimCount", { count: turn.interimCount })}>
									<MessagesSquare size={12} aria-hidden="true" />
									<span className="tabular-nums">{turn.interimCount}</span>
								</span>
							) : null}
						</span>
					</button>
					{processOpen ? (
						<div className="execution-fold-details mt-0.5 flex flex-col">
							{turn.segments.map((segment) => {
								if (props.isStreaming && segment.id === turn.liveTextId) return null; // 已挂容器外，容器内不双显
								if (segment.kind === "thinking") {
									// 按段流式状态驱动 sweep：只有真正还在流的思考块转圈，已完成的块即使本轮仍在流式也不闪
									return <WebThinkingBlock key={segment.id} text={segment.texts.join("\n\n")} running={segment.running ?? false} />;
								}
								if (segment.kind === "tool") {
									return <WebToolCard key={segment.id} part={segment.part} />;
								}
								return (
									<div key={segment.id} className="timeline-inline-text">
										<WebAssistantText text={segment.text} onOpenFile={props.onOpenFile} />
									</div>
								);
							})}
							<button
								type="button"
								className="mt-1 inline-flex items-center gap-1 self-start rounded-md px-1.5 py-0.5 text-micro text-text-tertiary transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_45%,transparent)] hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] pointer-coarse:py-2"
								onClick={() => setManualOpen(false)}
							>
								<ChevronUp size={12} aria-hidden="true" />
								{t("common.collapse")}
							</button>
						</div>
					) : null}
				</div>
			) : null}
			{turn.finalText ? (
				<div className="timeline-inline-text">
					<WebAssistantText text={turn.finalText} isStreaming={props.isStreaming} onOpenFile={props.onOpenFile} />
				</div>
			) : liveTextString !== undefined ? (
				// 流式打字机：回合未结束不提升 final，末段正文常驻容器外（见 groupTimelineEntries 注释）
				<div className="timeline-inline-text">
					<WebAssistantText text={liveTextString} isStreaming onOpenFile={props.onOpenFile} />
				</div>
			) : null}
			{!props.isStreaming && turn.finalText ? (
				<div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/assistant:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100">
					<ActionButton label={t("web.msgCopy")} onClick={() => void copyTextToClipboard(turn.finalText)}>
						<Copy className="size-3.5" aria-hidden="true" />
					</ActionButton>
					<ActionButton label={t("web.shareReply")} onClick={() => void shareWebText(t("web.shareReply"), turn.finalText)}>
						<Share2 className="size-3.5" aria-hidden="true" />
					</ActionButton>
				</div>
			) : null}
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
									className={cn("h-5 w-5 rounded text-xs pointer-coarse:size-8", idx === batchTab ? "bg-primary text-primary-foreground font-semibold" : batchAnswers[q.id] !== undefined ? "bg-muted text-foreground" : "bg-muted/40 text-muted-foreground")}
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
	/** 乐观更新：进行中编辑/删除/重发 fork 化的消息（气泡操作行换成状态指示） */
	pendingMessageAction?: { kind: "edit" | "delete" | "resend"; id: string } | null;
	/** 删除退场动画进行中的消息 id（动画播完才从列表摘除） */
	exitingMessageIds?: ReadonlySet<string>;
	/** 编辑保存成功的确认反馈：气泡闪一拍品牌色环 */
	flashMessageId?: string | null;
	/** P1：编辑/重发（pi 会话 fork 化后冷会话也可用；DSH 需 runtime 存活） */
	canManageMessages?: boolean;
	/** P1：删除（delete-message 是 runtime 命令，必须 runtime 存活） */
	canDeleteMessage?: boolean;
	onEditMessage?: (messageId: string, newText: string) => void;
	onDeleteMessage?: (messageId: string) => void;
	onResendMessage?: (messageId: string) => void;
	/** 文件路径链接点击 → 全屏预览（未提供时链接不可点） */
	onOpenFile?: (path: string, line?: number) => void;
	onScrollTopChange?: (scrollTop: number, delta: number) => void;
	onNearBottomChange?: (nearBottom: boolean) => void;
}) {
	const { messages, hasActiveSession, hasMoreHistory, moreCount, loadingMore, streaming, error, onLoadMore } = props;
	const timelineRef = useRef<HTMLDivElement | null>(null);
	const lastScrollTopRef = useRef<number | null>(null);
	const stickToBottomRef = useRef(true);
	const [showScrollToBottom, setShowScrollToBottom] = useState(false);
	const showScrollToBottomRef = useRef(false);
	const nearBottomRef = useRef(true);
	// 自动贴底/回到底部这类「程序化滚动」不参与顶栏收起的方向判定：
	// 否则流式增量会把顶栏一路收起，而用户根本没滑过屏
	const programmaticScrollRef = useRef(false);
	// 平滑滚到底期间持续抑制：一次 scrollTo 会连发多帧滚动事件，只跳第一帧仍会把顶栏收起
	const suppressUntilNearBottomRef = useRef(false);
	const lastScrollHeightRef = useRef<number | null>(null);

	const updateScrollState = () => {
		const el = timelineRef.current;
		if (!el) return;
		const previousScrollTop = lastScrollTopRef.current;
		lastScrollTopRef.current = el.scrollTop;
		// 跟底模式下向下位移一定是自动跟随（用户已经在底部，无法再往下滚）：
		// 滚动事件可能晚于下一次 scrollTo 到达，单次标记挡不住，所以按方向再兜一层
		const wasFollowing = stickToBottomRef.current;
		const delta = previousScrollTop === null ? 0 : el.scrollTop - previousScrollTop;
		// 内容高度变化引起的位移（加载更多前插、过程组折叠、流式增长）不是用户滚动：
		// 浏览器锚定会让 scrollTop 随 scrollHeight 同步跳动，位移与高度变化量近似相等
		const scrollHeight = el.scrollHeight;
		const heightDelta = lastScrollHeightRef.current === null ? 0 : scrollHeight - lastScrollHeightRef.current;
		lastScrollHeightRef.current = scrollHeight;
		const contentDriven = heightDelta !== 0 && Math.abs(delta - heightDelta) <= 2;
		const programmatic = programmaticScrollRef.current || suppressUntilNearBottomRef.current || (wasFollowing && delta > 0) || contentDriven;
		programmaticScrollRef.current = false;
		if (!programmatic && previousScrollTop !== null && Math.abs(delta) <= el.clientHeight) {
			props.onScrollTopChange?.(el.scrollTop, delta);
		}
		const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
		const nearBottom = distance < 160;
		stickToBottomRef.current = nearBottom;
		if (nearBottom) suppressUntilNearBottomRef.current = false;
		if (nearBottom !== nearBottomRef.current) {
			nearBottomRef.current = nearBottom;
			props.onNearBottomChange?.(nearBottom);
		}
		const nextShowScrollToBottom = !nearBottom && messages.length > 0;
		if (nextShowScrollToBottom !== showScrollToBottomRef.current) {
			showScrollToBottomRef.current = nextShowScrollToBottom;
			setShowScrollToBottom(nextShowScrollToBottom);
		}
	};

	const scrollToBottom = () => {
		const el = timelineRef.current;
		if (!el) return;
		stickToBottomRef.current = true;
		showScrollToBottomRef.current = false;
		setShowScrollToBottom(false);
		programmaticScrollRef.current = true;
		suppressUntilNearBottomRef.current = true;
		el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
	};

	// 新消息或流式增量到达时，仅在用户原本接近底部时跟随，避免打断用户阅读历史。
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			const el = timelineRef.current;
			if (el && stickToBottomRef.current) {
				programmaticScrollRef.current = true;
				el.scrollTo({ top: el.scrollHeight });
			}
			updateScrollState();
		});
		return () => cancelAnimationFrame(frame);
		// messages 变化既覆盖新消息，也覆盖同一条 assistant 消息的流式增量。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [messages, streaming]);

	// 回合聚合：连续 assistant 消息合并成「过程组 + 常驻正文」（桌面 TurnRow 语义）。
	// 流式中的末尾回合不提升 final（对齐桌面 isRunTail 门控，见 groupTimelineEntries 注释）。
	// streaming 仅指「正在收流」，与 useChat 的 status 无关，由调用方在收流期间置真。
	//
	// 前缀缓存（2027-02 性能治理）：useChat 流式期每个 delta 重建整个 messages 数组，
	// 全量重分组会铸造全新 turn 对象、memo(WebAssistantTurn) 对所有历史回合失效。
	// 已完成回合按消息引用判据复用分组结果，每帧只对当前（流式尾）回合重分组。
	const turnPrefixCacheRef = useRef<TurnPrefixCache | null>(null);
	const timelineEntries = useMemo<TimelineEntry[]>(() => {
		const cached = turnPrefixCacheRef.current ? validTurnPrefix(turnPrefixCacheRef.current, messages) : null;
		const consumed = cached ? cached.consumed : 0;
		const prefixEntries = cached ? cached.entries : [];
		const suffixEntries = groupTimelineEntries(messages.slice(consumed), { isStreaming: props.streaming });
		const entries = consumed === 0 ? suffixEntries : [...prefixEntries, ...suffixEntries];
		// 回写缓存：覆盖到可缓存边界（流式中=当前回合起点，非流式=全量）。
		// 裁剪出的前缀条目引用与 entries 共享——历史回合对象跨帧稳定，memo 才有效。
		const boundary = turnPrefixBoundary(messages, props.streaming);
		const prefix = boundary > consumed ? sliceEntriesToBoundary(entries, boundary) : null;
		if (prefix && prefix.length > 0) {
			turnPrefixCacheRef.current = { messages: messages.slice(0, boundary), entries: prefix, consumed: boundary };
		} else if (!props.streaming) {
			// 非流式但边界不可裁（异常形态）：直接缓存全量结果
			turnPrefixCacheRef.current = { messages: [...messages], entries, consumed: messages.length };
		}
		return entries;
	}, [messages, props.streaming]);
	const lastEntryId = timelineEntries.length > 0 ? timelineEntries[timelineEntries.length - 1].id : "";

	return (
		<section className="message-timeline relative h-full min-h-0 flex-1 overflow-y-auto" ref={timelineRef} onScroll={updateScrollState}>
			<div className="message-list flex flex-col gap-4 p-4 pb-2 sm:px-6">
				{/* 分页加载更多：历史向上前插，入口必须在消息流顶部——往上滚到顶才碰得到；
					放底部语义反了（底部是最新消息）。前插后靠浏览器原生 scroll anchoring 稳住视口。 */}
				{hasMoreHistory && (
					<div className="flex justify-center py-1">
						<Button variant="outline" size="sm" disabled={loadingMore} onClick={onLoadMore} className="h-8 px-4 text-caption">
							{loadingMore ? <Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" /> : null}
							{loadingMore ? t("timeline.loadingMore") : t("timeline.loadMoreHistory", { count: moreCount })}
						</Button>
					</div>
				)}
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
						{timelineEntries.map((entry) => {
							const exiting = entry.kind === "user" ? Boolean(props.exitingMessageIds?.has(entry.id)) : entry.turn.messageIds.some((messageId) => Boolean(props.exitingMessageIds?.has(messageId)));
							return (
								<div key={entry.id} id={`web-msg-${entry.id}`} className={cn("scroll-mt-24 [[data-header-hidden=on]_&]:scroll-mt-0", exiting && "web-msg-exiting")}>
									{entry.kind === "user" ? (
										<WebUserBubble
											message={entry.message}
											canManage={props.canManageMessages}
											canDelete={props.canDeleteMessage ?? props.canManageMessages}
											onEdit={props.onEditMessage}
											onDelete={props.onDeleteMessage}
											onResend={props.onResendMessage}
											pendingAction={props.pendingMessageAction?.id === entry.message.id ? props.pendingMessageAction.kind : null}
											flash={props.flashMessageId === entry.message.id}
										/>
									) : (
										<>
											{/* 回合聚合后锚点补偿：回合内非首条消息保留 web-msg-{id} 定位（跳转/分支定位用） */}
											{entry.turn.messageIds
												.filter((messageId) => messageId !== entry.id)
												.map((messageId) => (
													<span key={messageId} id={`web-msg-${messageId}`} className="sr-only" />
												))}
											<WebAssistantTurn turn={entry.turn} isStreaming={streaming && entry.id === lastEntryId} onOpenFile={props.onOpenFile} />
										</>
									)}
								</div>
							);
						})}
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
		</section>
	);
}
