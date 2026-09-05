import {
	Fragment,
	isValidElement,
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type RefObject,
	type WheelEvent as ReactWheelEvent,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import { messageEntryId } from "../../utils/sessionCommands";
import { toBlob } from "html-to-image";
import { writeClipboardImage } from "../../utils/clipboard";
import { MarkdownStream } from "./MarkdownStream";
import { PreviewRail, type PreviewRailItem } from "../motion/preview-rail";
import { planRailTicks } from "./timeline/outlineRailTicks";
import { areOutlineRailItemsEqual, createOutlineItemIndex, resolveVisibleRailActiveId } from "./timeline/outlineRailActive";
import { useTimelineOutlineActiveId } from "./timeline/useTimelineOutlineActiveId";
import { useAtomValue } from "jotai";
import "katex/dist/katex.min.css";

/**
 * 消息图片按需解码：base64 data URL 的字符串已在消息对象中（无法省字符串），
 * 但解码出的位图是内存大头（一张截图 1~5MB）——视口外不设 src 不解码，
 * 进入视口（含 200px 提前量）才挂载 src；未加载时占位高度避免滚动跳动。
 * decoding="async" 保证解码不阻塞渲染主线程。
 */
function MessageImage(props: {
	src: string;
	alt: string;
	className: string;
	onClick?: () => void;
	/** 未加载时的占位高度类（无固定尺寸的图片防滚动跳动；固定尺寸缩略图无需传） */
	placeholderClass?: string;
}) {
	const ref = useRef<HTMLImageElement>(null);
	const [inView, setInView] = useState(false);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) {
					setInView(true);
					observer.disconnect();
				}
			},
			{ rootMargin: "200px" },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return (
		<img
			ref={ref}
			src={inView ? props.src : undefined}
			alt={props.alt}
			className={`${props.className}${!inView && props.placeholderClass ? ` ${props.placeholderClass}` : ""}`}
			loading="lazy"
			decoding="async"
			onClick={props.onClick}
		/>
	);
}
import {
	summarizeMessage,
	type RenderMessage,
	type ComposerSuggestionResult,
	type ComposerTrigger,
	groupToolMessages,
	buildOutline,
	detectTrigger,
	applySuggestion,
	clearSuggestionTrigger,
	buildSuggestionItems,
	mergeCommands,
	matches,
	displayPath,
	flattenFiles,
} from "../app/AppUtils";
import { Textarea } from "../ui-shadcn/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../ui-shadcn/tooltip";

// Mermaid 库体积数 MB，仅在真正出现 mermaid 代码块时才动态加载，
// 避免随渲染进程常驻、放大内存占用并在流式期间抢占主线程。
import {
	AlertTriangle,
	Check,
	CircleAlert,
	CircleDot,
	ChevronLeft,
	ChevronDown,
	ChevronUp,
	ChevronsUpDown,
	MoveDown,
	MoveUp,
	ChevronsDownUp,
	GitBranch,
	Eye,
	Loader2,
	FileText,
	Folder,
	Globe2,
	MessageCircle,
	Network,
	PawPrint,
	Pin,
	Plus,
	RefreshCw,
	Search,
	Settings2,
	Terminal,
	UploadCloud,
	Wrench,
	X,
	Star,
	FolderOpen,
	Copy,
	Trash,
	Share,
	Undo2,
	SquarePen,
	Send,
	UserPen,
	GitFork,
	LoaderCircle,
} from "lucide-react";
import { getFileIconSeti, getFileIconColor, getFileTypeLabel } from "../../fileIcons";
import { normalizeSessionPathForCompare } from "../../agentListDisplay";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui-shadcn/dropdown-menu";
import type {
	AgentRuntimeState,
	AgentTab,
	AppInfo,
	AppSettings,
	ComposerAgentMode,
	AvailableModel,
	ChatMessage,
	CodexImportReport,
	CodexSessionSummary,
	ClaudeImportReport,
	ClaudeSessionSummary,
	OpenCodeImportReport,
	OpenCodeSessionSummary,
	GitBranchInfo,
	ImageContent,
	PiCliUpdateResult,
	PiCommand,
	PiInstallExecResult,
	PiInstallStatus,
	PiUpdateCheckResult,
	Project,
	SessionSummary,
	VisionBridgeEvent,
	VisionEventsInfo,
} from "../../../../shared/types";
import { parseRichInputChips, unwrapFileChipPath } from "./composer/chips";
import removeMarkdown from "remove-markdown";

import type { WorkspaceDrawerPanel } from "../../hooks/useWorkspacePanels";
import { formatDuration, formatTime, stripAnsi, formatPercent } from "./TimelineFormat";
import { extractVisionBridgeBlocks, matchVisionBridgeEvent } from "../../utils/visionBridgeBlocks";
import { visionImageHashes } from "../../utils/visionImageHash";
import { ToolCard, ToolGroupCard, type DiffFileHandler } from "./ToolCallComponents";
import {
	DiagnosticMessageCard,
	RespondingIndicator,
	ThinkingBlock,
} from "./TimelineEventCards";
import { MultiSelectModal } from "./MessageShareModal";

// ============================================================
// Surface & Workspace domain components
// 从 AppParts.tsx 提取，包含所有会话渲染组件
//
// Button 收口状态（P0 UI 统一）：
// - 已换装 shadcn Button：turn-row-action-btn / user-turn-action-btn / copy-menu-trigger
//   （ghost + size-7 + hover:bg-muted，对齐旧透明小钮；避免 hover:bg-accent 绿底）。
// - 保留原生 button（样式完全由自定义 CSS 驱动，直接换装会被 Tailwind utilities 覆盖默认尺寸
//   导致回归，需先做 CSS→utility 迁移）：code-copy、execution-summary-toggle/collapse、
//   image-preview-close、outline-* 系列、scratch/terminal/files/git/editors/browser-entry、
//   空状态创建按钮。迁移路径见 P2 CSS 收口。
//   （copy-menu-popover 菜单项已于 2026-08 迁移到 shadcn DropdownMenu，保留锚点类仅用于
//   多选导出/截图复制的节点排除。）
// ============================================================

type SessionModifiedFile = {
	path: string;
	toolName: string;
	status: string;
	changedLines?: number;
	/** 工具执行前的文件原始内容，用于历史会话恢复时展示差异对比。 */
	originalContent?: string;
	/** 工具写入/编辑后的新文件内容，优先于从磁盘实时读取（历史会话恢复时磁盘可能已变化或文件已删除）。 */
	content?: string;
};


/**
 * 美元→人民币估算汇率：仅用于费用提示的便捷换算（约合金额），非实时牌价。
 * 如需跟随实时汇率或用户自定义，可升级为设置项（usdToCnyRate）。
 */
export const USD_TO_CNY_RATE = 7.2;

export type SessionDetailRow = { label: string; value: string; emphasis?: boolean };

export type SessionStatusDetail = {
	detailRows: SessionDetailRow[];
	/** 最近一条回复的性能指标（TTFT/总耗时/tps）：与上下文累计量分开展示，避免误读为整段会话均值 */
	replyPerfRows: SessionDetailRow[];
	/** DSH 会话统计（host sessionStats 投影：回合/步骤、墙钟、平均首字、生成速度） */
	sessionStatRows: SessionDetailRow[];
	hasDetail: boolean;
};

/**
 * 由 runtime 状态构建会话状态详情行（SessionStatus tooltip 与圆环面板共用）。
 * 纯函数：label/value 已本地化，调用方只负责布局。
 */
export function buildSessionStatusDetail(
	state:
		| Pick<
				AgentRuntimeState,
				| "contextPercent" | "contextTokens" | "contextWindow"
				| "inputTokens" | "outputTokens"
				| "cacheRead" | "cacheWrite" | "cacheTotal" | "cacheHitPercent"
				| "ttftMs" | "totalMs" | "tps" | "cost"
				| "dshSessionStats"
		  >
		| undefined,
	averageCacheHit: number | undefined,
	averageCacheHitSampleCount: number,
): SessionStatusDetail {
	const detailRows: SessionDetailRow[] = [];
	const replyPerfRows: SessionDetailRow[] = [];
	const sessionStatRows: SessionDetailRow[] = [];
	if (!state) return { detailRows, replyPerfRows, sessionStatRows, hasDetail: false };
	// 美元→人民币估算汇率（仅用于费用提示的便捷换算，非实时牌价；
	// 如后续需要跟随实时汇率，可升级为设置项 usdToCnyRate）
	const cnyAmount = state.cost != null
		? `¥${(state.cost * USD_TO_CNY_RATE).toFixed(2)}`
		: undefined;

	if (state.contextPercent != null || state.contextTokens != null) {
		detailRows.push({
			label: t("ctx.detail.context"),
			value: `${state.contextPercent != null ? `${formatPercent(state.contextPercent)}%` : "-"} / ${formatCompact(state.contextTokens)} / ${formatCompact(state.contextWindow)}`,
		});
	}
	if (state.inputTokens != null || state.outputTokens != null) {
		// 标签已是「输入/输出」，不再套 ↑/↓：箭头加长字符串，且 `/ ↓` 会在窄面板里被折成两行。
		detailRows.push({
			label: t("ctx.detail.tokens"),
			value: `${formatCompact(state.inputTokens)} / ${formatCompact(state.outputTokens)}`,
		});
	}
	if (state.cacheRead != null || state.cacheWrite != null) {
		detailRows.push({
			label: t("ctx.detail.cacheIO"),
			value: `${t("ctx.detail.cacheRead")} ${formatCompact(state.cacheRead)} / ${t("ctx.detail.cacheWrite")} ${formatCompact(state.cacheWrite)}`,
		});
	}
	if (state.cacheTotal != null) {
		detailRows.push({
			label: t("ctx.detail.cacheTotal"),
			value: formatCompact(state.cacheTotal),
		});
	}
	if (state.cacheHitPercent != null) {
		detailRows.push({
			label: t("ctx.detail.hitLatest"),
			value: `${state.cacheHitPercent.toFixed(1)}%`,
		});
	}
	if (averageCacheHit != null) {
		detailRows.push({
			label: t("ctx.detail.hitAverage"),
			value: `${averageCacheHit.toFixed(1)}% (${averageCacheHitSampleCount} ${t("ctx.detail.snapshots")})`,
		});
	}
	// 这些值来自 AgentManager 的 lastPerfByAgent，只代表最近一条 assistant 回复，
	// 不能和上下文累计量混在同一组，否则用户会误以为是整段会话的平均性能。
	if (state.ttftMs != null) {
		replyPerfRows.push({ label: t("ctx.detail.ttft"), value: formatDuration(state.ttftMs) });
	}
	if (state.totalMs != null) {
		replyPerfRows.push({ label: t("ctx.detail.total"), value: formatDuration(state.totalMs) });
	}
	if (state.tps != null) {
		replyPerfRows.push({ label: t("ctx.detail.tps"), value: `${state.tps.toFixed(0)} tok/s` });
	}
	if (state.cost != null) {
		detailRows.push({ label: t("ctx.detail.cost"), value: `$${state.cost.toFixed(3)}`, emphasis: true });
		detailRows.push({ label: t("ctx.detail.costCny"), value: cnyAmount ?? "-", emphasis: true });
	}
	// DSH 会话统计（host sessionStats 投影，dsh-web StatsLine 同源）：整段日志的
	// 回合/步骤计数与墙钟汇总。与 pi 的「上次回复」性能组语义不同，独立成组展示。
	const sessionStats = state.dshSessionStats;
	if (sessionStats) {
		sessionStatRows.push({
			label: t("ctx.detail.turnsSteps"),
			value: `${sessionStats.turns} / ${sessionStats.steps}`,
		});
		if (sessionStats.llmMs > 0) {
			sessionStatRows.push({ label: t("ctx.detail.llmDuration"), value: formatDuration(sessionStats.llmMs) });
		}
		if (sessionStats.toolMs > 0) {
			sessionStatRows.push({ label: t("ctx.detail.toolDuration"), value: formatDuration(sessionStats.toolMs) });
		}
		if (sessionStats.ttftAvgMs != null) {
			sessionStatRows.push({ label: t("ctx.detail.ttftAverage"), value: formatDuration(sessionStats.ttftAvgMs) });
		}
		if (sessionStats.tokensPerSecond != null) {
			sessionStatRows.push({ label: t("ctx.detail.tps"), value: `${sessionStats.tokensPerSecond.toFixed(0)} tok/s` });
		}
	}
	return {
		detailRows,
		replyPerfRows,
		sessionStatRows,
		hasDetail: detailRows.length > 0 || replyPerfRows.length > 0 || sessionStatRows.length > 0,
	};
}

export function SessionStatus(props: {
	state?: AgentRuntimeState;
	duration?: number;
	/** 本会话历史缓存命中率快照，用于展示会话平均命中率 */
	cacheHitHistory?: number[];
}) {
	const state = props.state;
	if (!state) return null;
	// 会话平均缓存命中率：主进程基于会话文件全部 assistant 消息 usage 算出的
	// 真实平均优先；渲染层快照历史均值仅作为无文件样本时的降级回退。
	const history = props.cacheHitHistory ?? [];
	const averageCacheHit = state.cacheHitAveragePercent ?? (
		history.length > 0
			? history.reduce((sum, value) => sum + value, 0) / history.length
			: undefined
	);
	const averageCacheHitSampleCount = state.cacheHitSampleCount ?? history.length;
	const { detailRows, replyPerfRows, sessionStatRows, hasDetail } = buildSessionStatusDetail(
		state,
		averageCacheHit,
		averageCacheHitSampleCount,
	);
	// cost-chip 悬浮提示里的人民币估算（与明细行共用同一汇率常量）
	const cnyAmount = state.cost != null
		? `¥${(state.cost * USD_TO_CNY_RATE).toFixed(2)}`
		: undefined;

	const statusInner = (
		<div className="session-status">
			{state.contextPercent != null && (
				<span className="ctx-chip">
					{t("app.ctx")}:{" "}
					{formatPercent(state.contextPercent)}
					% / {formatCompact(state.contextWindow)}
				</span>
			)}
			{(state.cacheHitPercent != null) && (
				<span className="cache-chip">
					{t("app.cacheHit")}: {state.cacheHitPercent?.toFixed?.(0) ?? state.cacheHitPercent}%
				</span>
			)}
			{/* 平均命中率只在悬停明细中展示（ctx.detail.hitAverage），头部不再显示单独 chip */}
			{state.cost != null && (
				<span className="cost-chip" title={t("app.totalCostCny", {
					usd: `$${state.cost.toFixed(3)}`,
					cny: cnyAmount ?? "-",
				})}>
					${state.cost.toFixed(3)}
				</span>
			)}
		</div>
	);

	if (!hasDetail) return statusInner;
	// 用有标题的 popover 承载明细：标题解释这组数字，行内用标签/数值对比降低阅读成本。
	return (
		<Tooltip>
			<TooltipTrigger asChild>{statusInner}</TooltipTrigger>
			<TooltipContent
				side="bottom"
				align="end"
				sideOffset={8}
				arrowClassName="!bg-popover !fill-popover"
				className="ctx-detail-tooltip !w-auto min-w-64 max-w-[min(320px,calc(100vw-24px))] !rounded-md !border !border-border !bg-popover !px-3 !py-2.5 !text-popover-foreground !shadow-lg"
			>
				<div className="grid gap-2.5">
					<div className="flex items-center justify-between gap-4 border-b border-border/70 pb-2">
						<span className="text-caption font-semibold text-popover-foreground">{t("ctx.detail.title")}</span>
						<span className="text-micro text-muted-foreground">{t("app.ctx")}</span>
					</div>
					<div className="grid gap-1">
						{detailRows.map((row) => (
							<div
								key={row.label}
								className={`flex items-baseline justify-between gap-4 px-1 py-0.5 text-caption leading-5${row.emphasis ? " mt-1 border-t border-border/70 pt-1.5" : ""}`}
							>
								<span className="shrink-0 text-muted-foreground">{row.label}</span>
								<span className="min-w-0 whitespace-nowrap text-right font-mono font-semibold tabular-nums text-popover-foreground">{row.value}</span>
							</div>
						))}
					</div>
					{replyPerfRows.length > 0 && (
						<div className="mt-2.5 grid gap-1 border-t border-border/70 pt-2">
							<div className="px-1 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
								{t("ctx.detail.lastReply")}
							</div>
							{replyPerfRows.map((row) => (
								<div key={row.label} className="flex items-baseline justify-between gap-4 px-1 py-0.5 text-caption leading-5">
									<span className="shrink-0 text-muted-foreground">{row.label}</span>
									<span className="min-w-0 whitespace-nowrap text-right font-mono font-semibold tabular-nums text-popover-foreground">{row.value}</span>
								</div>
							))}
						</div>
					)}
					{sessionStatRows.length > 0 && (
						<div className="mt-2.5 grid gap-1 border-t border-border/70 pt-2">
							<div className="px-1 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
								{t("ctx.detail.sessionStats")}
							</div>
							{sessionStatRows.map((row) => (
								<div key={row.label} className="flex items-baseline justify-between gap-4 px-1 py-0.5 text-caption leading-5">
									<span className="shrink-0 text-muted-foreground">{row.label}</span>
									<span className="min-w-0 whitespace-nowrap text-right font-mono font-semibold tabular-nums text-popover-foreground">{row.value}</span>
								</div>
							))}
						</div>
					)}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

function formatCompact(value?: number | null) {
	if (value == null) return "-";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(value);
}

export { LogoMark } from "../app/LogoMark";


export function AgentAvatar(props: { status: string }) {
	const normalizedStatus = props.status === "running" || props.status === "starting" || props.status === "error" ? props.status : "idle";
	return (
		<div className={`conversation-avatar agent-avatar avatar-status-${normalizedStatus}`} data-avatar-status={normalizedStatus}>
			<span className="agent-avatar-mark" aria-hidden="true">
			<svg viewBox="140 140 520 520" width="28" height="28" aria-hidden="true">
				<path
					fill="#fff"
					fillRule="evenodd"
					d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
				/>
				<path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
			</svg>
			</span>
			<span className="avatar-status-indicator" aria-label={normalizedStatus}>
				{normalizedStatus === "error" ? <CircleAlert size={8} strokeWidth={2.5} /> : normalizedStatus === "starting" ? <CircleDot size={8} strokeWidth={2.5} /> : normalizedStatus === "running" ? <LoaderCircle size={8} strokeWidth={2.5} className="animate-pideck-spin" /> : <Check size={8} strokeWidth={2.5} />}
			</span>
		</div>
	);
}

export function EmptyState(props: {
	hasProject: boolean;
	onCreate: () => void;
	/** 可选：自定义操作区（如项目空态的主从按钮），默认提供“启动 Agent”/无项目提示 */
	actions?: ReactNode;
	/** 可选：底部 meta 区（如模型/思考级别/路径），渲染在发丝线分隔的 dl 容器内 */
	footer?: ReactNode;
	/** 可选：章节页眉发丝线右侧的上下文（如当前项目名），帮助用户确认所在工作区 */
	eyebrow?: ReactNode;
}) {
	const description = props.hasProject
		? t("app.emptyHasProject")
		: t("app.emptyNoProject");

	return (
		// Editorial 空态：左对齐章节式排版而非居中对话框，品牌感由衬线斜体的重音词承担。
		// 重音词固定用拉丁词（zh「Session」/ en「session」）：内置艺术字 Plantin 仅有拉丁字形，
		// 居中策略：几何居中（justify-center）后用户反馈标题区仍略偏上——
		// 补 pt-[10vh] 让内容块整体下移，标题重心落到窗口光学中心。
		<div
			className="empty-state relative h-full min-h-0 overflow-hidden bg-transparent px-6 text-left"
			data-empty-state={props.hasProject ? "project" : "no-project"}
		>
			<div className="mx-auto flex h-full w-full max-w-2xl animate-in flex-col justify-center pt-[10vh] duration-500 fade-in">
				{/* 章节页眉：发丝线 + 项目上下文，建立编辑排版的节奏起点 */}
				<div className="flex items-center gap-4 text-[13px] text-text-secondary">
					<span className="h-px flex-1 bg-border-subtle" aria-hidden="true"></span>
					{props.eyebrow}
				</div>
				<h2 className="mt-10 animate-in text-[clamp(2.5rem,5vw,3.25rem)] font-semibold leading-[1.1] tracking-[-0.03em] delay-100 duration-500 fade-in fill-mode-backwards slide-in-from-bottom-2 text-foreground">
					{props.hasProject ? (
						<>
							{t("app.emptyProjectTitleLead")}<br />
							<span className="font-brand font-medium italic">{t("app.emptyProjectTitleAccent")}</span>
							{/* 句号用前景色（黑/白实心）而非灰：作为标题的落点强调，视觉上更扎实 */}
							<span className="text-foreground">{t("app.emptyProjectTitlePunct")}</span>
						</>
					) : (
						t("app.emptyNoProjectTitle")
					)}
				</h2>
				<p className="mt-6 max-w-md animate-in text-[15px] leading-7 delay-100 duration-500 fade-in fill-mode-backwards text-text-secondary">{description}</p>
				{/* actions 是左对齐的主从按钮区，跟随阅读动线而不是居中悬浮 */}
				<div className="mt-10 animate-in delay-200 duration-500 fade-in fill-mode-backwards slide-in-from-bottom-2">{
					props.actions ?? (
						props.hasProject ? (
							<Button size="lg" className="h-12 rounded-xl bg-foreground px-7 text-background shadow-sm hover:bg-foreground/85" onClick={props.onCreate}>{t("app.createAgent")}</Button>
						) : (
							<p className="text-sm text-muted-foreground">{t("app.emptyNoProject")}</p>
						)
					)
				}</div>
				{props.footer && (
					<div className="mt-14 animate-in border-t border-border-subtle pt-5 delay-300 duration-500 fade-in fill-mode-backwards">{props.footer}</div>
				)}
			</div>
		</div>
	);
}

async function copyElementAsPng(element: HTMLElement) {
	// 截图后走 writeClipboardImage（Electron nativeImage），不依赖 ClipboardItem。
	// 使用 toBlob 而非 toPng+fetch 避免 CSP 拒绝连接 data: URL。
	// 克隆节点 + 内边距 + 临时注入 body 的方式与分享为图片（handleMultiSelectCopy）保持一致，
	// 避免直接截图导致图片紧贴内容边缘、缺少留白。
	const clone = element.cloneNode(true) as HTMLElement;
	clone.style.padding = "24px";
	clone.style.background =
		getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || "#fff";
	// 将 clone 插入到原元素旁边，确保 CSS 样式正确继承（父层选择器、CSS 变量、rem 等）
	if (element.parentElement) {
		// 克隆节点不能参与原布局，否则插入时会短暂撑开时间线导致闪动。
		// 复用多选分享的隐藏方式（.multi-select-image-export：absolute + left/top 归零 + z-index:-1）：
		// absolute 脱离文档流、不撑开布局；不能用 left:-100000px 把节点推出视口——
		// html-to-image 会把 clone 的 computed style 复制进 SVG foreignObject，负偏移会让
		// 内容整体渲染到 viewBox 之外，导致截图空白（「复制为图片空白」的根因）。
		clone.classList.add("multi-select-image-export");
		clone.style.width = `${element.getBoundingClientRect().width}px`;
		element.parentElement.insertBefore(clone, element.nextSibling);
	}
	let blob: Blob | null = null;
	try {
		blob = await toBlob(clone, {
			cacheBust: true,
			pixelRatio: Math.min(2, window.devicePixelRatio || 1),
			backgroundColor:
				getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || undefined,
			filter: (node) =>
				!(node instanceof HTMLElement) ||
				(!node.classList.contains("turn-row-actions") &&
					!node.classList.contains("user-turn-actions") &&
					!node.classList.contains("copy-menu-popover")),
		});
	} finally {
		clone.remove();
	}
	// html-to-image 在 oklch / canvas / 失焦时可能返回 null 且不抛错；
	// 这里必须失败给调用方，否则 CopyMenu 会 toast「已复制」但剪贴板是空的。
	if (!blob) throw new Error("Unable to capture message as PNG");
	const written = await writeClipboardImage(blob);
	if (!written) throw new Error("Unable to write PNG to clipboard");
}

export function CopyMenu(props: {
	text: string;
	markdown: string;
	targetRef: React.RefObject<HTMLElement | null>;
	className?: string;
}) {
	const [copied, setCopied] = useState<string | null>(null);
	const copy = async (kind: "text" | "markdown" | "image") => {
		try {
			if (kind === "text") await navigator.clipboard.writeText(props.text);
			if (kind === "markdown") await navigator.clipboard.writeText(props.markdown);
			if (kind === "image") {
				if (!props.targetRef.current) throw new Error("Copy target is missing");
				await copyElementAsPng(props.targetRef.current);
			}
			setCopied(kind);
			showNotice(kind === "image" ? t("copy.asImageCopied") : t("copy.success"), 1200);
			window.setTimeout(() => setCopied(null), 1800);
		} catch (error) {
			setCopied(null);
			showNotice(t("copy.failed"), 2000, "error");
			// 下拉菜单失焦后 ClipboardItem 失败原先无 log；图片路径现在统一记 renderer 日志便于排查。
			if (kind === "image") {
				void window.piDesktop?.app
					.rendererLog("warn", "clipboard", "copy as image failed", error)
					.catch(() => undefined);
			}
		}
	};
	return (
		<div className={`copy-menu ${props.className ?? ""}`}>
			{/* 拆分按钮：主按钮点击直接复制纯文本（默认动作，不再弹菜单）；
			   右侧小箭头展开完整菜单（复制为 Markdown / 图片）。弹层走 shadcn
			   DropdownMenu：Radix 定位 + animate-in/out + dropdown-stagger 错峰动画。 */}
			<div className="flex items-center overflow-hidden rounded-sm border border-transparent hover:border-border">
				<Button
					variant="ghost"
					size="icon-sm"
					className="copy-menu-trigger size-7 rounded-none text-muted-foreground hover:bg-muted hover:text-foreground"
					type="button"
					onClick={() => void copy("text")}
					title={t("common.copy")}
				>
					{copied ? <Check size={14} /> : <Copy size={14} />}
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							className="size-6 rounded-none border-l border-border/60 px-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
							type="button"
							aria-label={t("copy.moreOptions")}
							title={t("copy.moreOptions")}
						>
							<ChevronDown size={12} />
						</Button>
					</DropdownMenuTrigger>
					{/* 保留 copy-menu-popover 锚点类：多选导出/截图复制仍靠它排除菜单节点 */}
					<DropdownMenuContent align="end" className="copy-menu-popover min-w-[132px]">
						<DropdownMenuItem onSelect={() => void copy("text")}>{t("copy.asText")}</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => void copy("markdown")}>{t("copy.asMarkdown")}</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => void copy("image")}>{t("copy.asImage")}</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}

// ============================================================
// 会话时间线渲染组件（借鉴 opencode 扁平 timeline 风格重写）
// 设计要点：
// - 助手内容去掉气泡，改为左对齐扁平排版，用左侧竖线聚合一轮对话
// - 工具调用做成独立可折叠卡片，trigger 行 + 展开内容，内联在 timeline 里
// - 用户消息保留右对齐气泡，但收窄并去掉头像，操作栏 hover 显隐
// - 思考过程做成轻量折叠卡片，不再占用大块气泡空间
// ============================================================

/** 助手正文：扁平 markdown 渲染，无气泡包裹，全宽排版，支持内嵌图片。
 *  路径链接化用 remark 插件在 mdast 层处理（见底部 remarkLinkifyPaths），不再前置改写原始字符串。 */
export const AssistantText = memo(
	function AssistantText(props: {
		text: string;
		images?: ImageContent[];
		onPreviewImage: (image: ImageContent) => void;
		onOpenExternal: (url: string) => void;
		onOpenFile?: (path: string, line?: number) => void;
		/** 当前消息是否正在流式追加。为 true 时走轻量渲染路径，跳过 KaTeX 数学解析与
		 *  mermaid 图渲染，避免每个 token 都对不断增长的全量正文调用重型插件导致主线程卡死。 */
		isStreaming?: boolean;
		/** live→settled 交接时播放一次淡入 */
		settle?: boolean;
	}) {
		// 清理 ANSI 转义码与 <thinking> 标签，thinking 由调用方通过 ThinkingBlock 渲染
		const cleanText = stripThinkingTags(stripAnsi(props.text));
		// 统一 Streamdown 引擎（迁移后唯一 markdown 管线）：流式由引擎按 block memo、
		// 半截 markdown 由 remend 容错补全，不再需要旧管线的流式/静态双路径切换。
		return (
			<div
				className="assistant-text markdown-body"
				data-settle={props.settle ? "1" : undefined}
			>
				{props.images && props.images.length > 0 && (
					<div className="message-images">
						{props.images.map((img, index) => (
							<MessageImage
								key={index}
								src={`data:${img.mimeType};base64,${img.data}`}
								alt={t("app.imageAlt", { index: index + 1 })}
								className="message-image"
								placeholderClass="min-h-24"
								onClick={() => props.onPreviewImage(img)}
							/>
						))}
					</div>
				)}
				<MarkdownStream
					text={cleanText}
					isStreaming={Boolean(props.isStreaming)}
					onOpenExternal={props.onOpenExternal}
					onOpenFile={props.onOpenFile}
				/>
			</div>
		);
	},
	// 自定义比较：正文文件回调绑定栏级 cwd/project，作用域变化时必须刷新；其余稳定回调仍忽略，
	// 避免 App 常规渲染让历史消息反复解析 Markdown。
	(prev, next) =>
		prev.text === next.text &&
		prev.isStreaming === next.isStreaming &&
		prev.settle === next.settle &&
		prev.images === next.images &&
		prev.onOpenFile === next.onOpenFile,
);

/** 视觉桥「请求详情」展开面板：展示最近一次 input 转换的模型/耗时/token/提示词与每张图结果。
 * 事件数据来自扩展写的 pi-deck-vision-events.jsonl（经 IPC 拉取），与消息文本里的图片 #N 序号同源。 */
function VisionBridgeDetail(props: { events: VisionEventsInfo | null; loading: boolean }) {
	if (props.loading) {
		return <p className="mt-2 text-[11px] text-muted-foreground">…</p>;
	}
	const batch = props.events?.events.filter((e) => e.kind === "input").at(-1);
	if (!batch) {
		return <p className="mt-2 text-[11px] text-muted-foreground">{t("app.visionNoEvents")}</p>;
	}
	return (
		<div className="mt-2 max-h-56 overflow-y-auto border-t border-border/60 pt-2 text-[11px] leading-relaxed text-muted-foreground">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="font-mono text-foreground/80">{batch.model}</span>
				<span>{formatDuration(batch.totalDurationMs)}</span>
				<span>{t("app.imageAlt", { index: batch.items.length })}</span>
			</div>
			<ul className="mt-1 space-y-0.5">
				{batch.items.map((it) => (
					<li key={it.index} className={cn(it.ok ? "" : "text-danger", "break-words")}>
						{t("app.visionRequestItem", {
							index: it.index,
							duration: it.cached ? "" : `${formatDuration(it.durationMs)} · `,
							tokens:
								typeof it.outputTokens === "number"
									? `${t("app.visionOutputTokens", { count: it.outputTokens })} · `
									: "",
							status: it.cached
								? t("app.visionCacheHit")
								: it.ok
									? ""
									: t("app.visionRequestFailed", { error: it.error ?? "" }),
						})}
					</li>
				))}
			</ul>
			{/* 提示词完整显示：长模板换行展示，不再单行省略（用户反馈展开后内容看不全） */}
			<p className="mt-1 break-words whitespace-pre-wrap" title={batch.prompt}>
				{t("app.visionRequestPrompt")}：{batch.prompt}
			</p>
		</div>
	);
}

/**
 * 从用户消息文本中提取 pi 展开后的 <skill name="..." location="...">...</skill> 块。
 * pi 在发送 /skill:name 时会把 skill 内容展开成该 XML 块注入用户消息，
 * 这里在展示层把它们识别出来，渲染成 skill 徽标，并把原始 XML 从正文里剥除。
 * 返回 { skills, text }：skills 为 skill 名列表，text 为移除 skill 块后的正文。
 */
function extractSkillBlocks(text: string): { skills: string[]; text: string } {
	const skills: string[] = [];
	// 非贪婪匹配 skill 块；name/location 属性顺序与引号样式兼容 pi 实际输出
	const re = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/gi;
	const cleaned = text.replace(re, (_m, name: string) => {
		if (name) skills.push(name);
		return "";
	});
	return { skills, text: cleaned.trim() };
}

/** 用户消息：右对齐气泡 + 附件 + hover 显隐操作栏（复制/编辑/删除/重发/修改输入框）。
 * 编辑分两种：原地编辑（修改 JSONL + 重载会话）和修改输入框（放回 composer 不自动发送）。 */
export const UserBubble = memo(function UserBubble(props: {
	message: ChatMessage;
	/** 新消息入场动画：发送后乐观上屏的用户消息播放一次 */
	fresh?: boolean;
	/** 上滚窗口扩展时顶部新增的用户消息：播放「从顶部淡入」过渡 */
	topFresh?: boolean;
	onPreviewImage: (image: ImageContent) => void;
	onOpenFile?: (path: string) => void;
	onResendUserMessage?: (message: ChatMessage) => void;
	onEditMessage?: (messageId: string, newText: string, entryId?: string) => void;
	onDeleteMessage?: (messageId: string, entryId?: string) => void;
	/** 从该用户消息 fork 新会话；忙碌时不展示入口 */
	onForkMessage?: (message: ChatMessage) => void;
	/** 回退工作区文件到该消息时刻前最近的检查点；仅 pi 后端注入（rewind 能力） */
	onRewindToMessage?: (message: ChatMessage) => void;
	/** 是否为最后一条用户消息，用于控制重发按钮的显隐 */
	isLastUserMessage?: boolean;
	/** 仅当该消息后出现 error/abort 时显示重发（取代无条件 isLastUserMessage） */
	showResendButton?: boolean;
	validCommandNames?: Set<string>;
	validFilePaths?: Set<string>;
	/** Agent 正在处理请求或流式输出中时禁用编辑/删除等操作按钮 */
	agentRunning?: boolean;
	/** fork 进行中：仅当前消息禁用按钮，避免连点重复 fork */
	forking?: boolean;
	/** 打开多选分享弹框 */
	onEnterMultiSelect?: () => void;
	/**
	 * 本会话发图时视觉桥是否会真正跑。
	 * false = 模型已支持看图 / DSH 不跑 pi 扩展；null = 模型目录尚未解析。
	 * 未传时保持旧行为（只看视觉桥开关），避免单测/Web 嵌入漏传。
	 */
	visionBridgeExpected?: boolean | null;
}) {
	const { message } = props;
	// fork 入口始终展示（hover 可见）；忙碌/进行中仅禁用而非隐藏，避免用户误以为入口「时有时无」。
	// entryId 解析放到点击时做（meta 缺失时走 getForkMessages 回退）。
	const canFork = Boolean(props.onForkMessage);
	const rowRef = useRef<HTMLElement | null>(null);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const editAreaRef = useRef<HTMLDivElement | null>(null);
	// 长消息折叠（2026-08）：超过 8 行（line-clamp-8）折叠为预览，避免超长发送全量铺开；
	// 溢出检测用 ResizeObserver 对比 scrollHeight/clientHeight，折叠态下才测量（展开态保持按钮可见）。
	const [messageExpanded, setMessageExpanded] = useState(false);
	const [messageOverflowing, setMessageOverflowing] = useState(false);
	const userTextRef = useRef<HTMLDivElement | null>(null);
	// 视觉桥「请求详情」展开态：事件数据懒加载（用户点击才拉取，避免每条消息都读事件文件）
	const [visionDetailOpen, setVisionDetailOpen] = useState(false);
	const [visionEvents, setVisionEvents] = useState<VisionEventsInfo | null>(null);
	const [visionLoading, setVisionLoading] = useState(false);
	const loadVisionEvents = useCallback(async () => {
		if (visionEvents || visionLoading) return;
		setVisionLoading(true);
		try {
			setVisionEvents(await window.piDesktop.config.visionGetEvents());
		} catch {
			// 读取失败保持空态（卡片仍显示，详情区显示暂无记录）
			setVisionEvents({ exists: false, size: 0, events: [], truncated: false });
		} finally {
			setVisionLoading(false);
		}
	}, [visionEvents, visionLoading]);
	// 实时消息的视觉桥卡片：pi 只把转换结果写会话文件、不推送给实时消息流，
	// 因此对带图片的乐观消息轮询事件文件，按图片哈希匹配本次转换批次。
	const [imageHashes, setImageHashes] = useState<string[] | null>(null);
	const [visionMatch, setVisionMatch] = useState<VisionBridgeEvent | null>(null);
	const [visionPolling, setVisionPolling] = useState(false);
	const [visionBridgeEnabled, setVisionBridgeEnabled] = useState<boolean | null>(null);
	// 图片哈希与扩展侧 imageHash（sha256 前 24 位）同源
	useEffect(() => {
		const images = message.images ?? [];
		if (images.length === 0) return;
		let cancelled = false;
		void visionImageHashes(images.map((image) => image.data)).then((hashes) => {
			if (!cancelled) setImageHashes(hashes);
		});
		return () => {
			cancelled = true;
		};
	}, [message.images]);
	// 激活编辑时自动滚动到编辑区
	useEffect(() => {
		if (editing && editAreaRef.current) {
			editAreaRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}
	}, [editing]);
	// 长消息折叠溢出检测：折叠态 clamp 生效后 scrollHeight > clientHeight 即溢出；
	// 窗口缩放/内容变化（chips 换行）都会经 ResizeObserver 重新测量。
	useLayoutEffect(() => {
		const el = userTextRef.current;
		if (!el) return;
		const check = () => {
			if (messageExpanded) return; // 展开态无需测量，保持按钮可见
			setMessageOverflowing(el.scrollHeight > el.clientHeight + 1);
		};
		check();
		const observer = new ResizeObserver(check);
		observer.observe(el);
		return () => observer.disconnect();
	}, [messageExpanded]);
	// 视觉桥块：pi-deck-vision 扩展把用户消息里的图片换成描述文本时，会在消息里
	// 留下「[图片 #N（视觉桥已查看...）]」/失败标记。先剥出块，渲染成可视化卡片，
	// 用户才能直观看到「走了视觉桥」以及转换结果/失败原因，而不是一段方括号文本。
	const vision = extractVisionBridgeBlocks(stripAnsi(message.text));
	const visionBlocks = vision.blocks;
	// 先读取开关再轮询事件文件：视觉桥关闭、DSH、或当前模型已勾选图片能力时，
	// 不能把普通图片消息误显示为“转换中”。配置/模型目录都是异步的，
	// null 表示尚未确认，期间保持静默而不是乐观显示动画。
	useEffect(() => {
		const images = message.images ?? [];
		if (
			props.visionBridgeExpected === false ||
			images.length === 0 ||
			visionBlocks.length > 0 ||
			!imageHashes ||
			imageHashes.length === 0
		) {
			setVisionBridgeEnabled(false);
			setVisionPolling(false);
			return;
		}
		if (props.visionBridgeExpected === null) {
			setVisionBridgeEnabled(null);
			setVisionPolling(false);
			return;
		}
		let cancelled = false;
		void window.piDesktop.config.visionGetConfig().then(({ config }) => {
			if (!cancelled) setVisionBridgeEnabled(config?.enabled === true);
		}).catch(() => {
			if (!cancelled) setVisionBridgeEnabled(false);
		});
		return () => {
			cancelled = true;
		};
	}, [imageHashes, message.images, visionBlocks.length, props.visionBridgeExpected]);

	// 发送后短窗口内轮询事件文件（0/700/1800/3200ms），命中即渲染实时卡片，超时静默放弃。
	// 依赖 visionBlocks.length：历史消息文本里已有标记块时走文本卡片，不再轮询。
	useEffect(() => {
		const images = message.images ?? [];
		if (visionBridgeEnabled !== true || images.length === 0 || visionBlocks.length > 0 || !imageHashes || imageHashes.length === 0) {
			setVisionPolling(false);
			return;
		}
		let cancelled = false;
		let timer: number | undefined;
		const delays = [0, 700, 1800, 3200];
		let attempt = 0;
		const poll = async () => {
			if (cancelled) return;
			setVisionPolling(true);
			try {
				const info = await window.piDesktop.config.visionGetEvents();
				if (cancelled) return;
				const matched = matchVisionBridgeEvent(info.events, imageHashes, message.timestamp);
				if (matched) {
					setVisionMatch(matched);
					setVisionPolling(false);
					return;
				}
			} catch {
				// 拉取失败静默，等下一轮重试
			}
			attempt++;
			if (attempt < delays.length) timer = window.setTimeout(poll, delays[attempt]);
			else setVisionPolling(false);
		};
		void poll();
		return () => {
			cancelled = true;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [imageHashes, message.images, message.timestamp, visionBlocks.length, visionBridgeEnabled]);
	// 提取 pi 展开后的 <skill> 块：渲染为 skill 徽标，并从正文里剥除 XML
	const { skills, text: bodyText } = extractSkillBlocks(vision.text);
	const cleanText = bodyText;
	// 投递策略标签：steer(下次调用前插入) / followUp(停止后排队)
	const deliveryBehavior = message.meta?.streamingBehavior as
		| "steer"
		| "followUp"
		| undefined;
	const deliveryLabel =
		deliveryBehavior === "steer"
			? t("app.messageDeliverySteer")
			: deliveryBehavior === "followUp"
				? t("app.messageDeliveryFollowUp")
				: null;
	/** 原地编辑不影响输入框；先提交给确认弹窗。 */
	const handleSaveEdit = () => {
		if (props.onEditMessage && editText.trim()) {
			props.onEditMessage(message.id, editText, messageEntryId(message));
			setEditing(false);
		}
	};
	/** 编辑后重发：放回 composer 输入框，由用户自行修改后发送。 */
	const handleEditAndResend = () => {
		document.querySelector<HTMLElement>(".composer-box .rich-input, .composer-box textarea")?.focus();
		window.dispatchEvent(
			new CustomEvent("user-message-edit", { detail: { text: message.text } }),
		);
	};
	return (
		<article /* user-turn 为 e2e 选择器锚点 */ ref={rowRef} className={`user-turn group/user mb-4 flex w-full min-w-0 max-w-full flex-col items-end ${props.fresh ? "user-turn--fresh animate-[message-enter_260ms_cubic-bezier(0.22,1,0.36,1)_both]" : ""}${props.topFresh ? " user-turn--top-fresh animate-[top-enter_280ms_cubic-bezier(0.22,1,0.36,1)_both]" : ""}`} data-message-id={message.id}>
			{skills.length > 0 && (
				<div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
					{skills.map((name) => (
						<span key={name} className="user-turn-skill-badge inline-flex items-center gap-0.5 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground" title={`/${name}`}>
							<span className="font-mono text-[11px] font-medium text-muted-foreground">/</span>
							{name}
						</span>
					))}
				</div>
			)}
			{message.images && message.images.length > 0 && (
				<div className="mb-2 flex max-w-[min(82%,64ch)] flex-wrap justify-end gap-2">
					{message.images.map((img, index) => (
						<MessageImage
							key={index}
							src={`data:${img.mimeType};base64,${img.data}`}
							alt={t("app.imageAlt", { index: index + 1 })}
							className="size-16 max-h-40 cursor-pointer rounded-md border border-border object-cover transition-colors duration-150 hover:border-border-strong"
							onClick={() => props.onPreviewImage(img)}
						/>
					))}
				</div>
			)}
			{visionBlocks.length > 0 && (
				<div className="mb-2 flex w-full max-w-[min(82%,64ch)] flex-col items-end gap-1.5">
					{visionBlocks.map((block, bi) =>
						block.kind === "success" ? (
							// 成功：徽章行（图标 + 视觉桥已查看 + 图片序号）+ 描述正文
							<div
								key={bi}
								className="vision-bridge-card w-full min-w-0 rounded-lg border border-border bg-background/70 p-2.5"
								title={t("app.visionBridgeSeenDesc")}
							>
								<div className="flex items-center justify-between gap-2">
									<div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
										<Eye size={12} className="shrink-0 text-[var(--color-accent)]" />
										<span>{t("app.visionBridgeSeen")}</span>
										<span className="text-muted-foreground/60">·</span>
										<span>{t("app.visionBridgeImageLabel", { index: block.index })}</span>
									</div>
									<button
										type="button"
										className="inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
										onClick={() => {
											setVisionDetailOpen((open) => !open);
											if (!visionDetailOpen) void loadVisionEvents();
										}}
									>
										{visionDetailOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
										{t("app.visionDetail")}
									</button>
								</div>
								{block.description && (
									<p className="mt-1.5 text-[13px] leading-[1.6] break-words whitespace-pre-wrap text-text-primary">
										{block.description}
									</p>
								)}
								{visionDetailOpen && (
									<VisionBridgeDetail events={visionEvents} loading={visionLoading} />
								)}
							</div>
						) : (
							// 失败：红色卡片，原因直出，用户不用去设置页翻日志
							<div
								key={bi}
								className="w-full min-w-0 rounded-lg border border-danger/40 bg-danger-soft/40 p-2.5"
								title={t("app.visionBridgeFailedDesc")}
							>
								<div className="flex items-center gap-1.5 text-[11px] font-medium text-danger">
									<AlertTriangle size={12} className="shrink-0" />
									<span>{t("app.visionBridgeFailed")}</span>
									<span className="text-danger/60">·</span>
									<span>{t("app.visionBridgeImageLabel", { index: block.index })}</span>
								</div>
								{block.reason && (
									<p className="mt-1.5 text-[13px] leading-[1.6] break-words text-danger/90">
										{block.reason}
									</p>
								)}
							</div>
						),
					)}
				</div>
			)}
			{/* 实时消息：文本里没有标记块（转换结果只写会话文件），用事件文件匹配渲染卡片 */}
			{visionBlocks.length === 0 && visionPolling && !visionMatch && (
				<div className="mb-2 flex w-full max-w-[min(82%,64ch)] flex-col items-end">
					<div className="flex items-center gap-1.5 rounded-lg border border-border bg-background/70 px-2.5 py-1.5 text-[11px] text-muted-foreground">
						<Loader2 size={11} className="animate-pideck-spin" />
						<span>{t("app.visionConverting")}</span>
					</div>
				</div>
			)}
			{visionBlocks.length === 0 && visionMatch && (
				<div className="mb-2 flex w-full max-w-[min(82%,64ch)] flex-col items-end gap-1.5">
					{visionMatch.items.map((item) =>
						item.ok ? (
							// 成功：徽章行（图标 + 视觉桥已查看 + 图片序号）+ 描述正文（与历史标记卡片同款）
							<div
								key={item.index}
								className="vision-bridge-card w-full min-w-0 rounded-lg border border-border bg-background/70 p-2.5"
								title={t("app.visionBridgeSeenDesc")}
							>
								<div className="flex items-center justify-between gap-2">
									<div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
										<Eye size={12} className="shrink-0 text-[var(--color-accent)]" />
										<span>{t("app.visionBridgeSeen")}</span>
										<span className="text-muted-foreground/60">·</span>
										<span>{t("app.visionBridgeImageLabel", { index: item.index })}</span>
									</div>
									<button
										type="button"
										className="inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
										onClick={() => {
											setVisionDetailOpen((open) => !open);
											if (!visionDetailOpen) void loadVisionEvents();
										}}
									>
										{visionDetailOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
										{t("app.visionDetail")}
									</button>
								</div>
								{item.description && (
									<p className="mt-1.5 text-[13px] leading-[1.6] break-words whitespace-pre-wrap text-text-primary">
										{item.description}
									</p>
								)}
								{visionDetailOpen && (
									<VisionBridgeDetail events={visionEvents} loading={visionLoading} />
								)}
							</div>
						) : (
							// 失败：红色卡片，原因直出（与历史标记卡片同款）
							<div
								key={item.index}
								className="w-full min-w-0 rounded-lg border border-danger/40 bg-danger-soft/40 p-2.5"
								title={t("app.visionBridgeFailedDesc")}
							>
								<div className="flex items-center gap-1.5 text-[11px] font-medium text-danger">
									<AlertTriangle size={12} className="shrink-0" />
									<span>{t("app.visionBridgeFailed")}</span>
									<span className="text-danger/60">·</span>
									<span>{t("app.visionBridgeImageLabel", { index: item.index })}</span>
								</div>
								{item.error && (
									<p className="mt-1.5 text-[13px] leading-[1.6] break-words text-danger/90">
										{item.error}
									</p>
								)}
							</div>
						),
					)}
				</div>
			)}
			{cleanText && !editing && (
				<div className="user-turn-bubble w-fit min-w-0 max-w-[min(82%,64ch)] rounded-[14px] border border-border bg-muted/60 px-3 py-2 text-sm text-foreground [overflow-wrap:anywhere] break-words">
					<div
						ref={userTextRef}
						className={`text-chat text-text-primary whitespace-pre-wrap break-words ${messageExpanded ? "" : "line-clamp-8"}`}
					>
						{renderChipText(cleanText, props.onOpenFile, props.validCommandNames, props.validFilePaths)}
					</div>
					{messageOverflowing && (
						<div className="relative mt-1 flex justify-end">
							{/* 折叠态底部渐变提示还有内容；展开态不需要 */}
							{!messageExpanded && (
								<div className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-t from-muted/70 to-transparent" aria-hidden="true" />
							)}
							<button
								type="button"
								className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-micro text-text-tertiary transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
								onClick={() => setMessageExpanded((v) => !v)}
								aria-expanded={messageExpanded}
							>
								{messageExpanded ? <ChevronUp size={11} aria-hidden="true" /> : <ChevronDown size={11} aria-hidden="true" />}
								{messageExpanded ? t("app.messageCollapse") : t("app.messageExpand")}
							</button>
						</div>
					)}
				</div>
			)}
			{editing && (
				<div className="flex w-full min-w-0 flex-col gap-2 rounded-md border border-border-subtle bg-[color:color-mix(in_srgb,var(--color-accent)_3%,var(--color-bg-panel))] pl-2" ref={editAreaRef}>
					<div className="flex items-center gap-1 text-xs font-medium text-[var(--color-accent)] before:content-['✎'] before:text-sm">{t("common.edit")}</div>
					<Textarea
						className="min-h-[100px] max-h-[400px] w-full resize-y rounded-sm border border-[var(--color-accent)] bg-bg-panel p-2 font-mono text-sm leading-relaxed text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[0_0_0_2px_var(--focus-ring)]"
						value={editText}
						onChange={(e) => setEditText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
								e.preventDefault();
								handleSaveEdit();
							}
							if (e.key === "Escape") setEditing(false);
						}}
						autoFocus
					/>
					<div className="flex justify-end gap-2">
						<Button variant="outline" size="sm" className="h-auto border-[var(--color-accent)] px-3 py-1 text-xs text-[var(--color-accent)] shadow-none hover:text-[var(--color-accent)]" onClick={handleSaveEdit}>
							{t("common.save")}
						</Button>
						<Button variant="outline" size="sm" className="h-auto px-3 py-1 text-xs shadow-none" onClick={() => setEditing(false)}>
							{t("common.cancel")}
						</Button>
					</div>
				</div>
			)}
			<div className="mt-1 inline-flex items-center gap-2 text-[11px] tabular-nums text-text-tertiary">
				{deliveryLabel && (
					<span
						className={`inline-flex h-[18px] items-center rounded-full border border-[color-mix(in_srgb,var(--color-accent)_24%,var(--color-border-subtle))] bg-[var(--color-accent-soft)] px-[7px] font-mono text-[11px] font-semibold leading-none text-[var(--color-accent)]${
							deliveryBehavior === "followUp" ? " border-[color-mix(in_srgb,var(--color-info)_20%,var(--color-border-subtle))] bg-[color:color-mix(in_srgb,var(--color-info)_10%,var(--color-bg-panel))] text-[var(--color-info)]" : ""
						}`}
						title={
							deliveryBehavior === "followUp"
								? t("app.messageDeliveryFollowUpTitle")
								: t("app.messageDeliverySteerTitle")
						}
					>
						{deliveryLabel}
					</span>
				)}
				<time>{formatTime(message.timestamp)}</time>
			</div>
			<div className="user-turn-actions flex min-h-6 items-center gap-0.5 opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100">
				<CopyMenu text={stripMarkdown(cleanText)} markdown={message.text} targetRef={rowRef} />
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="user-turn-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
					onClick={props.onEnterMultiSelect}
					title={t("app.multiSelectEnter")}
				>
					<Share size={14} />
				</Button>
				{/* fork 忙碌时也不隐藏、仅禁用：入口稳定可见，避免用户误以为「时有时无」 */}
				{!editing && canFork && (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="user-turn-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
						disabled={props.agentRunning || props.forking}
						onClick={() => props.onForkMessage?.(message)}
						title={props.agentRunning ? t("app.forkBusyTitle") : t("app.forkFromMessageTitle")}
						aria-label={t("app.forkFromMessage")}
					>
						<GitFork size={14} strokeWidth={1.8} aria-hidden="true" />
					</Button>
				)}
				{/* 回退到此消息：把工作区文件恢复到该消息时刻前最近的检查点（见 injector 的最近点解析） */}
				{!editing && props.onRewindToMessage && (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="user-turn-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
						disabled={props.agentRunning}
						onClick={() => props.onRewindToMessage?.(message)}
						title={props.agentRunning ? t("app.forkBusyTitle") : t("rewind.restoreTitle")}
						aria-label={t("rewind.restore")}
					>
						<Undo2 size={14} strokeWidth={1.8} aria-hidden="true" />
					</Button>
				)}
				{!editing && !props.agentRunning && (
					<>
						{props.onEditMessage && (
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="user-turn-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
								onClick={() => {
									setEditText(cleanText);
									setEditing(true);
								}}
								title={t("common.edit")}
							>
								<SquarePen size={14} />
							</Button>
						)}
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="user-turn-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
							onClick={handleEditAndResend}
							title={t("app.editAndResendTitle")}
						>
							<UserPen size={14} />
						</Button>
						{props.onDeleteMessage && (
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="user-turn-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
								onClick={() => props.onDeleteMessage?.(message.id, messageEntryId(message))}
								title={t("common.delete")}
							>
								<Trash size={14} />
							</Button>
						)}
						{((props.isLastUserMessage || props.showResendButton) && props.onResendUserMessage) && (
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="user-turn-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
								onClick={() => props.onResendUserMessage?.(message)}
								title={t("app.resendTitle")}
							>
								<Send size={14} />
							</Button>
						)}
					</>
				)}
			</div>
		</article>
	);
});

export function ImagePreviewModal(props: {
	image: ImageContent;
	onClose: () => void;
}) {
	return (
		<div className="image-preview-modal" onClick={props.onClose}>
			<button
				className="image-preview-close"
				onClick={props.onClose}
				aria-label={t("app.imagePreviewClose")}
			>
				<X size={20} strokeWidth={2.4} />
			</button>
			<img
				src={`data:${props.image.mimeType};base64,${props.image.data}`}
				alt={t("app.imagePreviewAlt")}
				onClick={(event) => event.stopPropagation()}
			/>
		</div>
	);
}

// ANSI 转义码正则:匹配 \x1b[...m 等终端颜色/样式序列
function stripThinkingTags(text: string): string {
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

/** 将 Markdown 语法转换为纯文本，保留可读的文字内容 */
export function stripMarkdown(text: string): string {
	return removeMarkdown(text, {
		// 保留列表项文本，移除列表标记符号
		stripListLeaders: true,
		// 使用 Unicode 字符替换列表标记
		listUnicodeChar: "",
		// 启用 GFM 表格/任务列表等处理
		gfm: true,
		// 图片保留 alt 文本
		useImgAltText: true,
	});
}

/** 将消息文本中的 @path / /command 渲染为行内 chip（聊天区展示用，与输入框 chip 视觉一致）。
 * 可通过 onOpenFile 回调使 chip 可点击跳转。 */
function renderChipText(text: string, onOpenFile?: (path: string) => void, validCommandNames?: Set<string>, validFilePaths?: Set<string>): ReactNode[] {
	const chips = parseRichInputChips(text, validCommandNames, validFilePaths);
	if (chips.length === 0) return [text];
	const nodes: ReactNode[] = [];
	let cursor = 0;
	for (const chip of chips) {
		if (chip.start > cursor) {
			nodes.push(text.slice(cursor, chip.start));
		}
		const clickable = onOpenFile && chip.kind === "file";
		nodes.push(
			<span
				key={`chip-${chip.start}`}
				className={`input-chip input-chip--${chip.kind}${clickable ? " clickable" : ""}`}
				data-type={chip.kind}
				data-raw={chip.raw}
				title={chip.raw}
				onClick={clickable ? () => onOpenFile(unwrapFileChipPath(chip.raw)) : undefined}
			>
				<span className="input-chip__icon">
					{chip.kind === "file" ? "@" : "/"}
				</span>
				<span className="input-chip__label">{chip.label}</span>
			</span>,
		);
		cursor = chip.end;
	}
	if (cursor < text.length) {
		nodes.push(text.slice(cursor));
	}
	return nodes;
}

export { ToolCard, ToolGroupCard };
export {
	DiagnosticMessageCard,
	RespondingIndicator,
	ThinkingBlock,
};
export { MultiSelectModal };

/**
 * 会话定位轴（beUI PreviewRail）：右缘一列 1px 刻度对应全部已加载的用户消息
 * （不再封顶 15 条——长会话此前「最上面的刻度不是第一条消息、很多消息没有刻度」），
 * hover 出预览卡、点击跳转。工具开关已上收会话 Tab 栏（SessionToolAction），
 * 此处不再承载其他入口；容器沿用 .outline-hover 的贴右缘偏移规则（有测试守护）。
 *
 * 高度自适应：容器被 .outline-hover 的 top/bottom 双向夹持出可用高度，刻度间距
 * 按条数收缩；间距压到下限仍放不下时均匀抽稀，但首尾刻度强制保留（planRailTicks）。
 */
type ConversationOutlineProps = {
	className?: string;
	timelineRef?: RefObject<HTMLElement | null>;
	onTimelineWheel?: (deltaY: number) => void;
	items: Array<{ id: string; role: string; title: string; time: string }>;
	onJump: (id: string) => void;
};

function areConversationOutlinePropsEqual(
	previous: ConversationOutlineProps,
	next: ConversationOutlineProps,
): boolean {
	return previous.className === next.className &&
		previous.timelineRef === next.timelineRef &&
		previous.onTimelineWheel === next.onTimelineWheel &&
		previous.onJump === next.onJump &&
		areOutlineRailItemsEqual(previous.items, next.items);
}

function ConversationOutlineView(props: ConversationOutlineProps) {
	// The visible timeline checkpoint owns rail feedback; clicking a tick updates it immediately.
	const [railActiveId, setRailActiveId] = useTimelineOutlineActiveId(props.timelineRef, props.items);
	const containerRef = useRef<HTMLDivElement>(null);
	const [availableHeight, setAvailableHeight] = useState(0);
	// 容器高度由 top/bottom 夹持（不随内容变化），ResizeObserver 重测不会形成反馈环；
	// 窗口缩放、--outline-top 变化都会反映为容器尺寸变化，统一在这里重算刻度规划。
	useLayoutEffect(() => {
		const element = containerRef.current;
		if (!element) return;
		const update = () => setAvailableHeight(element.clientHeight);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const plan = useMemo(
		() => planRailTicks(props.items, availableHeight),
		[props.items, availableHeight],
	);
	const railItems = useMemo<PreviewRailItem[]>(
		() =>
			plan.items.map((item) => ({
				id: item.id,
				label: item.title,
				ariaLabel: item.title,
				description: item.time,
			})),
		[plan.items],
	);
	const outlineItemIndex = useMemo(() => createOutlineItemIndex(props.items), [props.items]);
	const visibleRailActiveId = useMemo(
		() => resolveVisibleRailActiveId(railActiveId, outlineItemIndex, plan.items),
		[railActiveId, outlineItemIndex, plan.items],
	);

	const handleTimelineWheel = useCallback(
		(event: ReactWheelEvent<HTMLDivElement>) => {
			if (!props.onTimelineWheel || event.deltaY === 0) return;
			event.preventDefault();
			props.onTimelineWheel(event.deltaY);
		},
		[props.onTimelineWheel],
	);

	return (
		<div
			ref={containerRef}
			onWheel={handleTimelineWheel}
			className={cn("outline-hover pointer-events-none", props.className)}
		>
			{railItems.length > 0 && (
				<PreviewRail
					orientation="vertical"
					items={railItems}
					label={t("outline.title")}
					itemSize={plan.itemSize}
					previewSide="before"
					activeId={visibleRailActiveId}
					highlightActive={visibleRailActiveId !== undefined}
					onItemSelect={(item) => {
						setRailActiveId(item.id);
						props.onJump(item.id);
					}}
					/* 宽度对齐原触发按钮（30px），min-h-0 抵消组件自带的演示高度 */
					className="pointer-events-auto min-h-0 w-[30px]"
					railClassName="w-full content-center [&_[data-slot=preview-rail-item]]:w-full [&_[data-slot=preview-rail-item]]:justify-center [&_[data-slot=preview-rail-tick]]:h-px [&_[data-slot=preview-rail-tick]]:w-4 [&_[data-slot=preview-rail-tick]]:origin-center"
					previewContainerClassName="inset-y-0 right-7 left-auto w-64"
					previewClassName="[&_[data-slot=preview-rail-card]]:h-20 [&_[data-slot=preview-rail-card]]:overflow-hidden [&_[data-slot=preview-rail-card]]:p-3 [&_[data-slot=preview-rail-title]]:line-clamp-1 [&_[data-slot=preview-rail-title]]:text-xs [&_[data-slot=preview-rail-title]]:leading-4 [&_[data-slot=preview-rail-description]]:line-clamp-1 [&_[data-slot=preview-rail-description]]:text-xs [&_[data-slot=preview-rail-description]]:leading-4"
				/>
			)}
		</div>
	);
}

export const ConversationOutline = memo(
	ConversationOutlineView,
	areConversationOutlinePropsEqual,
);

export { DrawerContent, SessionFileSummary, SessionHistoryModal } from "./WorkspaceSurface";

export { FileContextMenu, PromptSuggestions } from "./ComposerOverlayComponents";

/** 会话管理弹框：展示项目所有会话，支持多选删除、导出、重命名 */
