import { memo, useState } from "react";
import { AlertTriangle, Brain, ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import type { ChatMessage } from "../../../../shared/types";
import { t, translateI18nDescriptor } from "../../i18n";
import { formatDuration, formatTime, stripAnsi } from "./TimelineFormat";
import { Textarea } from "../ui-shadcn/textarea";
import { StackTrace } from "../ui-shadcn/stack-trace";
import { ApprovalCard } from "../ui-shadcn/approval-card";
import { TimelineMarker } from "./TimelineMarker";
import { LiveDuration } from "./LiveDuration";
import { MarkdownStream } from "./MarkdownStream";
import { ShimmerText } from "./ShimmerText";
import { ReasoningText } from "../agents/loading-states/reasoning-text";
import { Loader } from "../motion/loader";
import { useSmoothStream } from "../../utils/useSmoothStream";
import { SingleLinePreview } from "./SingleLinePreview";
import { deriveRespondingKind, type RespondingKind } from "./timeline/respondingKind";

// Button 收口状态（P0）：本文件按钮全部保留原生——
// thinking-card-trigger 是折叠触发器 + 内容排版容器（内部 span/small/em 结构）。
// 迁移路径见 P2 CSS 收口。
// 迁移路径见 P2 CSS 收口。

function getDiagnosticTone(message: ChatMessage): "error" | "warning" | "success" | "info" {
	if (message.role === "error") return "error";
	const status = String(message.meta?.status ?? "");
	if (status === "error") return "error";
	if (status === "running") return "warning";
	if (status === "success") return "success";
	return "info";
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
	const title = props.message.role === "error"
		? t("diagnostic.errorTitle")
		: t("diagnostic.systemTitle");
	return (
		<TimelineMarker
			kind="diagnostic"
			tone={
				tone === "error"
					? "error"
					: tone === "warning"
						? "warning"
						: tone === "success"
							? "success"
							: "neutral"
			}
			// 系统状态/自动重试/错误提示是独立卡片，不需要轨道归属关系
			hideRail
		>
		<article
			className={`diagnostic-card w-full min-w-0 overflow-hidden rounded-md border border-border-subtle bg-[var(--color-chat-muted-bg)] tone-${tone}`}
			data-message-id={props.message.id}
			data-role={props.message.role}
		>
			<div className="flex items-center gap-2 px-2 py-1.5 text-caption text-text-secondary">
				<AlertTriangle size={14} aria-hidden="true" />
				<span className="font-semibold">{title}</span>
				<time className="ml-auto text-micro tabular-nums text-text-tertiary">{formatTime(props.message.timestamp)}</time>
			</div>
			<div className="p-2">
				<p className="m-0 whitespace-pre-wrap break-words text-caption leading-relaxed text-text-secondary">{stripAnsi(localizedText)}</p>
				{debugDetails ? <StackTrace trace={stripAnsi(debugDetails)} defaultOpen={tone === "error"} /> : null}
			</div>
		</article>
		</TimelineMarker>
	);
});

/** 思考过程折叠卡片：与 ToolCard 同一套「单行 trigger」语言。
 * 折叠：Brain +「思考了 Xs」+ chevron + 单行预览，全部挤在同一行。
 * 展开：同一行标题，下方左竖线正文走打字机（useSmoothStream）。
 * 默认永远收成单行（对齐 dsh-web ReasoningRow）：流式时单行打字机 + 尾部跟随，
 * 不自动撑开正文；只有用户点开才展开。流式结束也不强行改用户的展开态。 */
export const ThinkingBlock = memo(
	function ThinkingBlock(props: {
		text: string;
		startedAt?: number;
		endedAt?: number;
		showThinking?: boolean;
		/** 仅作初始值；未传则收起。流式过程不再用这个开关自动展开。 */
		defaultExpanded?: boolean;
		/** 流式进行中：MarkdownStream / 单行预览都以 isStreaming 实时渲染 */
		isStreaming?: boolean;
		onOpenExternal: (url: string) => void;
		onOpenFile?: (path: string) => void;
	}) {
	const [expanded, setExpanded] = useState(props.defaultExpanded ?? false);
	// 折叠行的打字机：流式中始终推进（预览吃 displayedContent + 尾部跟随 = 跑马灯）。
	// 展开正文由 MarkdownStream 自己打字，这里不能 disabled 跟 expanded 绑——
	// 用户中途收起时还要接得上单行预览。非流式关掉 rAF，避免历史卡片空转。
	const { displayedContent } = useSmoothStream({
		content: props.text,
		isStreaming: Boolean(props.isStreaming),
		disabled: !props.isStreaming,
	});

	if (!props.showThinking || !props.text.trim()) return null;
	// 思考耗时：结束固定（endedAt - startedAt）；流式中（isStreaming）由 LiveDuration 实时增长
	const hasEnded =
		props.endedAt && props.startedAt && props.endedAt >= props.startedAt;
	const durationText =
		hasEnded && props.endedAt != null && props.startedAt != null
			? formatDuration(props.endedAt - props.startedAt)
			: null;
	return (
		<TimelineMarker
			kind="thinking"
			tone={props.endedAt ? "neutral" : "active"}
			// 与工具行一样压扁底距：思考不再是「标题行 + 虚线框」双行块
			contentClassName="pb-1"
		>
		<section className="w-full min-w-0 overflow-hidden rounded-md border-0">
		{/* 整行可点，结构对齐 ToolCard trigger：图标 + 耗时 + chevron + 折叠预览。 */}
			<button
				type="button"
				className="group relative flex min-h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-control leading-5 transition-[background-color,transform] duration-150 motion-reduce:transition-none hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)] active:scale-[0.99] focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				title={expanded ? t("thinking.collapse") : t("thinking.expand")}
			>
				{/* 流式思考中整行扫光（dsh-web reasoning-row-sweep 同款）。
				    预览嵌在同一行里，不再给 SingleLinePreview 第二道光带，避免叠扫。 */}
				{props.isStreaming && (
					<span
						aria-hidden
						className="pointer-events-none absolute inset-y-0 left-[-300px] w-[300px] animate-thinking-sweep motion-reduce:animate-none bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--color-bg-app)_55%,transparent),transparent)]"
					/>
				)}
				<Brain size={16} className="thinking-row-icon shrink-0" aria-hidden="true" />
				{(hasEnded || props.isStreaming) && props.startedAt && (
					<small className="shrink-0 text-caption tabular-nums text-text-faint">
						{hasEnded ? (
							t("thinking.duration", { duration: durationText })
						) : (
							// 流式中：思考未结束，用同一「思考了 Xs」文案 + LiveDuration 实时跳动，
							// 思考结束只是数字冻结，不会出现前缀/文案整体蹦出。
							<>
								{t("thinking.durationPrefix")}
								<LiveDuration startedAt={props.startedAt} isStreaming />
							</>
						)}
					</small>
				)}
				{/* chevron 语言对齐工具行：折叠 ChevronRight，展开 ChevronDown */}
				{expanded ? (
					<ChevronDown size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
				) : (
					<ChevronRight size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
				)}
				{/* 折叠才挂预览：与工具 displayLabel 一样 truncate 在同一行；
				    展开后正文在下方，行内预览会抢宽度、和打字机重复。 */}
				{!expanded && (
					<SingleLinePreview
						text={displayedContent}
						running={props.isStreaming}
						showSweep={false}
						className="min-w-0 flex-[1_1_auto] font-mono text-caption text-text-faint"
					/>
				)}
			</button>
			{expanded && (
				<div className="relative ml-5 mt-1 mb-2 rounded-b-sm border-l-2 border-border-subtle bg-transparent pl-3 animate-in fade-in duration-100 motion-reduce:animate-none">
					<div className="markdown-body px-0 pt-1 pb-1 text-text-tertiary">
						<MarkdownStream
							text={props.text}
							isStreaming={props.isStreaming}
							onOpenExternal={props.onOpenExternal}
							onOpenFile={props.onOpenFile}
						/>
					</div>
					{/* 收起入口：长思考展开后滚到底即可收起（不用滚回顶部思考栏）。 */}
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
	},
	// 外部链接回调通常稳定；文件回调会随分屏栏的 cwd/project 变化，必须参与比较，
	// 否则展开后的 Markdown 会继续使用旧栏的文件授权上下文。
	(prev, next) =>
		prev.text === next.text &&
		prev.startedAt === next.startedAt &&
		prev.endedAt === next.endedAt &&
		prev.showThinking === next.showThinking &&
		prev.isStreaming === next.isStreaming &&
		prev.onOpenExternal === next.onOpenExternal &&
		prev.onOpenFile === next.onOpenFile,
);

/**
 * 流式响应指示器（三点脉动动画 + 状态文案），在 agent 运行/流式期间显示。
 *
 * 状态优先级：
 *  1. 上下文压缩中 → “正在压缩”（压缩发生在上一轮结束后）
 *  2. Agent 启动中 → “正在启动 Agent”（琥珀色）
 *  3. 工具执行中 → “正在工具调用”（琥珀色）
 *  4. 有思考文本 / 流式回答中 → “正在回应”
 *  5. 过渡等待 → 单条静态文案
 *
 * 启动状态单独展示，避免用户发消息后 Agent 尚未完成预热时看起来像“没有响应”。
 * 视觉实现：beUI ReasoningText（swap 整句淡入淡出 + ascii-line 终端指示器），
 * 每种状态一组 i18n 短语轮播；状态切换用 key 重建，从第一条短语重新开始。
 */

/** 每种状态对应的轮播短语组（i18n；waiting 单条即不轮播）。 */
const RESPONDING_PHRASES: Record<RespondingKind, string[]> = {
	compacting: [t("agent.loading.compacting")],
	starting: [
		t("agent.loading.starting1"),
		t("agent.loading.starting2"),
		t("agent.loading.starting3"),
	],
	executing: [
		t("agent.loading.executing1"),
		t("agent.loading.executing2"),
		t("agent.loading.executing3"),
	],
	responding: [
		t("agent.loading.responding1"),
		t("agent.loading.responding2"),
		t("agent.loading.responding3"),
	],
	waiting: [t("agent.loading.waiting")],
};

export function RespondingIndicator(props: {
	isCompacting?: boolean;
	isStarting?: boolean;
	isExecutingTool?: boolean;
	liveTextStreaming?: boolean;
	liveThinkingStreaming?: boolean;
}) {
	// 判定抽到 deriveRespondingKind：pi / DSH 共用，状态条跟「此刻有没有字/工具」对齐。
	const kind = deriveRespondingKind({
		isCompacting: props.isCompacting,
		isStarting: props.isStarting,
		isExecutingTool: props.isExecutingTool,
		liveTextStreaming: props.liveTextStreaming,
		liveThinkingStreaming: props.liveThinkingStreaming,
	});

	return (
		<div className="responding-indicator" data-kind={kind}>
			{/* key=kind：状态切换时从该组短语第一条重新轮播，避免旧组下标错位；
			   指示器用 Loader dots（三点跳动，bg-current 跟随状态色），
			   不用官方默认的 ascii 终端字符；文字放大到 text-base */}
			<ReasoningText
				key={kind}
				phrases={RESPONDING_PHRASES[kind]}
				variant="swap"
				interval={1800}
				indicator={
					<Loader
						variant="dot-matrix"
						size={18}
						speed={1.1}
						label={t("agent.loading.aria")}
					/>
				}
				// 字号用官方默认（text-sm）：实测语义 token 缩放的观感不如官方字阶，保持官方原样
				/>
		</div>
	);
}

/** 宠物选择预览：给定宠物清单项，用 <canvas> 解码其 spritesheet 并循环播放
 *  对应 mode 行（默认 idle）的网格帧，让用户在选择宠物时即时看到动画效果，
 *  不必切换真实宠物窗。失败时降级为空占位，不阻塞设置面板。 */
