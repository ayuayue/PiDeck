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

/** 从 UIMessage 提取纯文本（复制/重发用）。 */
export function uiMessageText(message: UIMessage): string {
	return message.parts
		.filter((part) => part.type === "text")
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
}

/** 提取消息中的图片 data URL（用户气泡缩略图 / 重发附件）。 */
export function uiMessageImages(message: UIMessage): string[] {
	const urls: string[] = [];
	for (const part of message.parts) {
		if (part.type !== "file") continue;
		const filePart = part as { mediaType?: string; data?: string; url?: string };
		const src = typeof filePart.data === "string" ? filePart.data : typeof filePart.url === "string" ? filePart.url : "";
		if (src && (!filePart.mediaType || filePart.mediaType.startsWith("image/"))) urls.push(src);
	}
	return urls;
}

type WebToolPart = {
	type: string;
	toolName?: string;
	toolCallId?: string;
	state?: string;
	input?: unknown;
	output?: unknown;
	errorText?: string;
};

/** 回合内一段过程内容：合并后的思考块 / 工具调用 / 中间回复。思考块 running 取块内最后一个 reasoning part 的流式状态（AI SDK state 字段），不再用整轮流式标志。 */
export type TurnSegment = { kind: "thinking"; id: string; texts: string[]; running?: boolean } | { kind: "tool"; id: string; part: WebToolPart } | { kind: "interim"; id: string; text: string };

/** 一轮助手回合：用户消息之后的连续 assistant 消息聚合（对齐桌面 run 语义）。 */
export interface AssistantTurn {
	/** 回合内首条消息 id（容器 key/锚点） */
	id: string;
	/** 回合内全部消息 id（含首条；锚点补偿用） */
	messageIds: string[];
	/** 过程内容（不含常驻正文），按原始顺序 */
	segments: TurnSegment[];
	/** 最后一段非空正文：常驻折叠容器外；流式中即正在生成的文本 */
	finalText: string;
	toolCount: number;
	/** 思考段数（合并后块内 texts 总数，对齐桌面「N 次思考」） */
	thinkingCount: number;
	/** 中间回复段数（不含 final） */
	interimCount: number;
}

export type TimelineEntry = { kind: "user"; id: string; message: UIMessage } | { kind: "turn"; id: string; turn: AssistantTurn };

/** 把扁平 messages 聚合成「用户气泡 / 助手回合」交替序列（桌面 groupAgentRuns 的 Web 版）。
 *
 * - 连续 assistant 消息归为一个回合，跨消息的连续 reasoning part 合并成同一思考块
 *   （修复：一轮里被拆成多个思考卡片）；
 * - 回合内最后一段非空 text 剔出过程组作为常驻正文（对齐桌面「最终回答永不折叠」）；
 * - 纯函数，行为由 tests/webLayout.test.mjs 锁定。 */
export function groupTimelineEntries(messages: UIMessage[]): TimelineEntry[] {
	const entries: TimelineEntry[] = [];
	let messageIds: string[] = [];
	let segments: TurnSegment[] = [];
	let finalText = "";
	let finalId = "";
	let turnId = "";
	const flush = () => {
		if (!turnId) return;
		// 把 final 对应的最后一个 interim 从过程组剔除（只剔除一次，同 id 不会重复）
		const processSegments = finalId ? segments.filter((segment) => !(segment.kind === "interim" && segment.id === finalId)) : segments;
		entries.push({
			kind: "turn",
			id: turnId,
			turn: {
				id: turnId,
				messageIds,
				segments: processSegments,
				finalText,
				toolCount: processSegments.filter((segment) => segment.kind === "tool").length,
				thinkingCount: processSegments.reduce((sum, segment) => sum + (segment.kind === "thinking" ? segment.texts.length : 0), 0),
				interimCount: processSegments.filter((segment) => segment.kind === "interim").length,
			},
		});
		messageIds = [];
		segments = [];
		finalText = "";
		finalId = "";
		turnId = "";
	};
	for (const message of messages) {
		if (message.role !== "assistant") {
			flush();
			entries.push({ kind: "user", id: message.id, message });
			continue;
		}
		if (!turnId) turnId = message.id;
		messageIds.push(message.id);
		for (let index = 0; index < message.parts.length; index += 1) {
			const part = message.parts[index];
			if (part.type === "reasoning") {
				const text = part.text ?? "";
				if (!text.trim()) continue;
				const running = (part as { state?: "streaming" | "done" }).state === "streaming";
				const last = segments.at(-1);
				if (last && last.kind === "thinking") {
					last.texts.push(text);
					// 合并块的流式状态以最后一个 part 为准：新 part 还在流 → 块继续 sweep；新 part 已 done → 块停
					last.running = running;
				} else {
					segments.push({ kind: "thinking", id: `${message.id}:p${index}`, texts: [text], running });
				}
			} else if (part.type === "dynamic-tool" || (typeof part.type === "string" && part.type.startsWith("tool-"))) {
				const toolPart = part as unknown as WebToolPart;
				segments.push({ kind: "tool", id: toolPart.toolCallId ?? `${message.id}:p${index}`, part: toolPart });
			} else if (part.type === "text") {
				const text = part.text ?? "";
				if (!text.trim()) continue;
				const id = `${message.id}:p${index}`;
				segments.push({ kind: "interim", id, text });
				finalText = text;
				finalId = id;
			}
		}
	}
	flush();
	return entries;
}

/** 用户消息右对齐气泡（结构与桌面 UserBubble 一致；P1/P2 增加图片与 hover 操作）。 */
export const WebUserBubble = memo(function WebUserBubble(props: {
	message: UIMessage;
	/** runtime 存活且非流式时才允许编辑/删除/重发（历史静态会话不提供） */
	canManage?: boolean;
	onEdit?: (messageId: string, newText: string) => void;
	onDelete?: (messageId: string) => void;
	onResend?: (messageId: string) => void;
	/** 乐观更新进行中：编辑=等待服务端确认（操作行换成转圈+文案），删除=即将退场 */
	pendingAction?: "edit" | "delete" | null;
	/** 编辑保存成功的确认反馈：气泡闪一拍品牌色环 */
	flash?: boolean;
}) {
	const text = uiMessageText(props.message);
	const images = uiMessageImages(props.message);
	const [editing, setEditing] = useState(false);
	const [editDraft, setEditDraft] = useState("");
	if (!text.trim() && images.length === 0) return null;
	const manage = Boolean(props.canManage && props.onEdit && props.onDelete && props.onResend);
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
				<div className="w-fit min-w-0 max-w-[min(82%,64ch)] rounded-2xl border border-primary/40 bg-muted/60 px-3.5 py-2.5">
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
						<div className={cn("w-fit min-w-0 max-w-[min(82%,64ch)] rounded-2xl border border-border bg-muted/60 px-3.5 py-2.5 text-sm text-foreground [overflow-wrap:anywhere] break-words", props.flash && "web-msg-flash-ring")}>
							<div className="text-chat text-text-primary whitespace-pre-wrap break-words">{text}</div>
						</div>
					) : null}
					{/* hover 操作行：复制恒有；编辑/删除/重发需 runtime 存活；触屏无 hover，常驻显示。
						乐观更新进行中整行换成状态指示，避免重复触发。 */}
					{props.pendingAction ? (
						<div className="mt-1 flex items-center gap-1.5 text-xs text-text-tertiary" role="status">
							<Loader2 className="size-3.5 animate-pideck-spin" aria-hidden="true" />
							{props.pendingAction === "edit" ? t("web.msgSaving") : t("web.msgDeleting")}
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
									<ActionButton label={t("web.msgDelete")} danger onClick={() => props.onDelete?.(props.message.id)}>
										<Trash2 className="size-3.5" aria-hidden="true" />
									</ActionButton>
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
				"inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_60%,transparent)] hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]",
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
				<button type="button" className="relative flex min-h-7 w-full cursor-pointer items-center rounded-md px-1 py-1 text-left" onClick={() => hasBody && setExpanded((value) => !value)} aria-expanded={expanded}>
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
	return (
		<div className="group/assistant flex w-full min-w-0 flex-col gap-2">
			{hasProcess ? (
				<div className="execution-fold" data-open={processOpen}>
					<button
						type="button"
						className="inline-flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-control text-text-secondary transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
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
								className="mt-1 inline-flex items-center gap-1 self-start rounded-md px-1.5 py-0.5 text-micro text-text-tertiary transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_45%,transparent)] hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
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
	/** 乐观更新：进行中编辑/删除的消息（气泡操作行换成状态指示） */
	pendingMessageAction?: { kind: "edit" | "delete"; id: string } | null;
	/** 删除退场动画进行中的消息 id（动画播完才从列表摘除） */
	exitingMessageIds?: ReadonlySet<string>;
	/** 编辑保存成功的确认反馈：气泡闪一拍品牌色环 */
	flashMessageId?: string | null;
	/** P1：消息操作（runtime 存活时可用） */
	canManageMessages?: boolean;
	onEditMessage?: (messageId: string, newText: string) => void;
	onDeleteMessage?: (messageId: string) => void;
	onResendMessage?: (messageId: string) => void;
	/** 文件路径链接点击 → 全屏预览（未提供时链接不可点） */
	onOpenFile?: (path: string, line?: number) => void;
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

	// 回合聚合：连续 assistant 消息合并成「过程组 + 常驻正文」（桌面 TurnRow 语义）。
	const timelineEntries = useMemo(() => groupTimelineEntries(messages), [messages]);
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
								<div key={entry.id} id={`web-msg-${entry.id}`} className={cn("scroll-mt-24", exiting && "web-msg-exiting")}>
									{entry.kind === "user" ? (
										<WebUserBubble
											message={entry.message}
											canManage={props.canManageMessages}
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
