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
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import { toBlob } from "html-to-image";
import { MarkdownStream } from "./MarkdownStream";
import { useAtomValue } from "jotai";
import "katex/dist/katex.min.css";
import {
	summarizeMessage,
	type ToolGroupItem,
	type MessageItem,
	type ThinkingGroupItem,
	type AgentRunItem,
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
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronsUpDown,
	ChevronUp,
	MoveDown,
	MoveUp,
	ChevronsDownUp,
	GitBranch,
	Brain,
	Eye,
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
	SquarePen,
	Send,
	UserPen,
	GitFork,
	LoaderCircle,
} from "lucide-react";
import { getFileIconSeti, getFileIconColor, getFileTypeLabel } from "../../fileIcons";
import { normalizeSessionPathForCompare } from "../../agentListDisplay";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";
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
	PetManifest,
	PiCliUpdateResult,
	PiCommand,
	PiInstallExecResult,
	PiInstallStatus,
	PiUpdateCheckResult,
	Project,
	SessionSummary,
} from "../../../../shared/types";
import { parseRichInputChips, type RichInputChip } from "../app/RichInput";
import removeMarkdown from "remove-markdown";
/** 复用 petdex 标准网格规格，在主设置面板里为宠物选择器渲染单格动画预览 */
import { GRID_COLS, CELL_W, CELL_H, MODE_ROW, MODE_FRAMES } from "../../pet/PetSpriteSheet";

import type { WorkspaceDrawerPanel } from "../../hooks/useWorkspacePanels";
import { formatDuration, formatTime, stripAnsi } from "./TimelineFormat";
import { ToolCard, ToolGroupCard, type DiffFileHandler } from "./ToolCallComponents";
import {
	AskQuestionCard,
	CompactionCard,
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
// - 已换装 shadcn Button：turn-row-action-btn / user-turn-action-btn 9 个（ghost icon-sm，
//   原 tailwind class 保留，tailwind-merge 合并后视觉零变化）；turn-row-edit-btn /
//   message-edit-btn 4 个（outline sm + h-auto 反制默认高度，保留 .*-edit-btn class 作 CSS 兜底）。
// - 保留原生 button（样式完全由自定义 CSS 驱动，直接换装会被 Tailwind utilities 覆盖默认尺寸
//   导致回归，需先做 CSS→utility 迁移）：copy-menu-trigger、copy-menu-popover 菜单项、
//   code-copy、execution-summary-toggle/collapse、image-preview-close、outline-* 系列、
//   scratch/terminal/files/git/editors/browser-entry、空状态创建按钮。迁移路径见 P2 CSS 收口。
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
const USD_TO_CNY_RATE = 7.2;

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
	// 美元→人民币估算汇率（仅用于费用提示的便捷换算，非实时牌价；
	// 如后续需要跟随实时汇率，可升级为设置项 usdToCnyRate）
	const cnyAmount = state.cost != null
		? `¥${(state.cost * USD_TO_CNY_RATE).toFixed(2)}`
		: undefined;

	const detailRows: Array<{ label: string; value: string; emphasis?: boolean }> = [];
	if (state.contextPercent != null || state.contextTokens != null) {
		detailRows.push({
			label: t("ctx.detail.context"),
			value: `${state.contextPercent != null ? `${state.contextPercent.toFixed(1)}%` : "-"} / ${formatCompact(state.contextTokens)} / ${formatCompact(state.contextWindow)}`,
		});
	}
	if (state.inputTokens != null || state.outputTokens != null) {
		detailRows.push({
			label: t("ctx.detail.tokens"),
			value: `↑ ${formatCompact(state.inputTokens)} / ↓ ${formatCompact(state.outputTokens)}`,
		});
	}
	if (state.cacheRead != null || state.cacheWrite != null) {
		detailRows.push({
			label: t("ctx.detail.cacheIO"),
			value: `${t("ctx.detail.cacheRead")} ${formatCompact(state.cacheRead)} / ${t("ctx.detail.cacheWrite")} ${formatCompact(state.cacheWrite)}`,
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
	if (state.cost != null) {
		detailRows.push({ label: t("ctx.detail.cost"), value: `$${state.cost.toFixed(3)}`, emphasis: true });
		detailRows.push({ label: t("ctx.detail.costCny"), value: cnyAmount ?? "-", emphasis: true });
	}
	const hasDetail = detailRows.length > 0;

	const statusInner = (
		<div className="session-status">
			{state.contextPercent != null && (
				<span className="ctx-chip">
					{t("app.ctx")}:{" "}
					{state.contextPercent?.toFixed?.(1) ??
						state.contextPercent}
					% / {formatCompact(state.contextWindow)}
					{state.inputTokens != null && (
						<>{" "}↑ {formatCompact(state.inputTokens)}</>
					)}
					{state.outputTokens != null && (
						<>{" "}↓ {formatCompact(state.outputTokens)}</>
					)}
				</span>
			)}
			{(state.cacheHitPercent != null || state.cacheTotal != null) && (
				<span className="cache-chip">
					{state.cacheHitPercent != null && (
						<>{t("app.cacheHit")}: {state.cacheHitPercent?.toFixed?.(0) ?? state.cacheHitPercent}%</>
					)}
					{state.cacheHitPercent != null && state.cacheTotal != null && " "}
					{state.cacheTotal != null && (
						<>{t("app.cache")}: {formatCompact(state.cacheTotal)}</>
					)}
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
								<span className="min-w-0 text-right font-mono font-semibold tabular-nums text-popover-foreground">{row.value}</span>
							</div>
						))}
					</div>
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

export function LogoMark() {
	return (
		<div
			className="logo-mark relative grid size-8 place-items-center overflow-hidden rounded-md bg-primary text-primary-foreground shadow-sm"
			aria-label={t("app.logoLabel")}
		>
			<svg viewBox="140 140 520 520" width="18" height="18" aria-hidden="true">
				<path
					fill="currentColor"
					fillRule="evenodd"
					d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
				/>
				<path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
			</svg>
		</div>
	);
}


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
				{normalizedStatus === "error" ? <CircleAlert size={8} strokeWidth={2.5} /> : normalizedStatus === "starting" ? <CircleDot size={8} strokeWidth={2.5} /> : normalizedStatus === "running" ? <LoaderCircle size={8} strokeWidth={2.5} className="animate-spin" /> : <Check size={8} strokeWidth={2.5} />}
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
		// 中文会回退系统宋体破坏质感，拉丁词才能保证 PiDeckPlantin 斜体真正生效。
		// pb-[8vh]：几何居中在光学上偏低，内容整体上移后重心落在视觉中心。
		<div
			className="empty-state relative h-full min-h-0 overflow-hidden bg-background px-6 text-left"
			data-empty-state={props.hasProject ? "project" : "no-project"}
		>
			<div className="mx-auto flex h-full w-full max-w-2xl animate-in flex-col justify-center pb-[8vh] duration-500 fade-in">
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
							<span className="text-text-tertiary">{t("app.emptyProjectTitlePunct")}</span>
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
	// 截图复制依赖浏览器 ClipboardItem PNG 支持；失败时由调用方提示/回退，不影响文本复制。
	// 使用 toBlob 而非 toPng+fetch 避免 CSP 拒绝连接 data: URL。
	// 克隆节点 + 内边距 + 临时注入 body 的方式与分享为图片（handleMultiSelectCopy）保持一致，
	// 避免直接截图导致图片紧贴内容边缘、缺少留白。
	const clone = element.cloneNode(true) as HTMLElement;
	clone.style.padding = "24px";
	clone.style.background =
		getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || "#fff";
	// 将 clone 插入到原元素旁边，确保 CSS 样式正确继承（父层选择器、rem 等）
	if (element.parentElement) {
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
	if (!blob) return;
	await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

function CopyMenu(props: {
	text: string;
	markdown: string;
	targetRef: React.RefObject<HTMLElement | null>;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);
	const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const closeTimerRef = useRef<number | null>(null);
	const clearCloseTimer = () => {
		if (closeTimerRef.current !== null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	};
	const scheduleClose = () => {
		// 操作栏由 hover/focus 控制显隐；离开后主动收起菜单，避免下次 hover 时复用旧 open 状态。
		clearCloseTimer();
		closeTimerRef.current = window.setTimeout(() => {
			setOpen(false);
			closeTimerRef.current = null;
		}, 180);
	};
	useEffect(() => clearCloseTimer, []);
	const copy = async (kind: "text" | "markdown" | "image") => {
		try {
			if (kind === "text") await navigator.clipboard.writeText(props.text);
			if (kind === "markdown") await navigator.clipboard.writeText(props.markdown);
			if (kind === "image" && props.targetRef.current) await copyElementAsPng(props.targetRef.current);
			setCopied(kind);
			setOpen(false);
			showNotice(t("copy.success"), 1200);
			window.setTimeout(() => setCopied(null), 1800);
		} catch {
			setCopied(null);
			showNotice(t("copy.failed"), 2000);
		}
	};
	const toggleOpen = () => {
		clearCloseTimer();
		const rect = triggerRef.current?.getBoundingClientRect();
		if (rect) {
			setMenuStyle({
				position: "fixed",
				top: rect.bottom + 4,
				left: Math.min(window.innerWidth - 156, Math.max(8, rect.right - 148)),
			});
		}
		setOpen((value) => !value);
	};
	return (
		<div
			className={`copy-menu ${props.className ?? ""}`}
			onPointerEnter={clearCloseTimer}
			onPointerLeave={scheduleClose}
		>
			<Button
				ref={triggerRef}
				variant="ghost"
				size="icon-sm"
				className="copy-menu-trigger"
				type="button"
				onClick={toggleOpen}
				aria-expanded={open}
				title={t("common.copy")}
			>
				{copied ? <Check size={14} /> : <Copy size={14} />}
			</Button>
			{open && (
				<div className="copy-menu-popover" style={menuStyle}>
					<button type="button" onClick={() => void copy("text")}>{t("copy.asText")}</button>
					<button type="button" onClick={() => void copy("markdown")}>{t("copy.asMarkdown")}</button>
					<button type="button" onClick={() => void copy("image")}>{t("copy.asImage")}</button>
				</div>
			)}
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

/** 按工具名选择语义图标：read→文件、edit→铅笔、bash→终端、grep→搜索等，未匹配回退扳手。 */
function PetChooserPreview(props: {
	pet?: PetManifest;
	mode?: string;
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);
	const rafRef = useRef<number | null>(null);

	useEffect(() => {
		const pet = props.pet;
		const canvas = canvasRef.current;
		if (!pet || !pet.spritesheetUrl || !canvas) {
			const ctx = canvas!.getContext("2d");
			ctx?.clearRect(0, 0, canvas!.width, canvas!.height);
			return;
		}

		// 复用 petdex 标准网格规格（8 列 × 9 行，单格 192×208）
		const mode = props.mode && props.mode !== "__auto" ? props.mode : "idle";
		const row = MODE_ROW[mode] ?? 0;
		const frameCount = MODE_FRAMES[mode] ?? 6;
		const cols = GRID_COLS;
		const cellW = CELL_W;
		const cellH = CELL_H;

		// 解码 spritesheet；成功后用 rAF 按帧定时绘制单格，避免每帧重新解码。
		const img = new Image();
		img.src = pet.spritesheetUrl;
		let disposed = false;
		const start = () => {
			if (disposed) return;
			imgRef.current = img;
			let frame = 0;
			let last = performance.now();
			const FPS = 8;
			let acc = 0;
			const tick = (now: number) => {
				rafRef.current = requestAnimationFrame(tick);
				acc += now - last;
				last = now;
				if (acc < 1000 / FPS) return;
				acc = 0;
				if (frameCount <= 0) return;
				frame = (frame + 1) % frameCount;
				const ctx = canvas.getContext("2d");
				if (!ctx) return;
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				// 仅绘制当前帧对应的单格，按 canvas 尺寸等比缩放，避免拉伸出框。
				ctx.drawImage(img, frame * cellW, row * cellH, cellW, cellH, 0, 0, canvas.width, canvas.height);
			};
			rafRef.current = requestAnimationFrame(tick);
		};
		img.decode().then(start).catch(() => undefined);

		return () => {
			disposed = true;
			if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
			imgRef.current = null;
		};
	}, [props.pet, props.mode]);

	return (
		<div className="pet-chooser-preview">
			<canvas ref={canvasRef} width={CELL_W} height={CELL_H} aria-hidden="true" />
		</div>
	);
}

/** 助手正文：扁平 markdown 渲染，无气泡包裹，全宽排版，支持内嵌图片。
 *  路径链接化用 remark 插件在 mdast 层处理（见底部 remarkLinkifyPaths），不再前置改写原始字符串。 */
export const AssistantText = memo(
	function AssistantText(props: {
		text: string;
		images?: ImageContent[];
		onPreviewImage: (image: ImageContent) => void;
		onOpenExternal: (url: string) => void;
		onOpenFile?: (path: string) => void;
		/** 当前消息是否正在流式追加。为 true 时走轻量渲染路径，跳过 KaTeX 数学解析与
		 *  mermaid 图渲染，避免每个 token 都对不断增长的全量正文调用重型插件导致主线程卡死。 */
		isStreaming?: boolean;
	}) {
		// 清理 ANSI 转义码与 <thinking> 标签，thinking 由调用方通过 ThinkingBlock 渲染
		const cleanText = stripThinkingTags(stripAnsi(props.text));
		// 统一 Streamdown 引擎（迁移后唯一 markdown 管线）：流式由引擎按 block memo、
		// 半截 markdown 由 remend 容错补全，不再需要旧管线的流式/静态双路径切换。
		return (
			<div className="assistant-text markdown-body">
				{props.images && props.images.length > 0 && (
					<div className="message-images">
						{props.images.map((img, index) => (
							<img
								key={index}
								src={`data:${img.mimeType};base64,${img.data}`}
								alt={t("app.imageAlt", { index: index + 1 })}
								className="message-image"
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
	// 自定义比较：文本、流式标记、图片一致时跳过重渲染。回调函数（onPreviewImage/onOpenExternal/
	// onOpenFile）行为稳定（读 ref 或 setState），不参与比较，避免 App 每次渲染新建内联箭头
	// 函数导致 memo 失效——历史消息在流式期间因此不再重复解析 Markdown，从根上消除卡顿。
	(prev, next) =>
		prev.text === next.text &&
		prev.isStreaming === next.isStreaming &&
		prev.images === next.images,
);

/** 一轮回答内的展示段（issue #130）：
 *  process = 连续思考/工具组成的折叠段；text = 回答文本段（常驻平铺）。 */
type TurnSegment =
	| { kind: "process"; id: string; items: (ThinkingGroupItem | ToolGroupItem)[] }
	| { kind: "text"; id: string; message: ChatMessage };

/** 一轮 AI 回答的扁平容器：左侧竖线聚合，内含思考/工具/正文/文件摘要。
 *  替代旧的 AgentRun + ChatBubble 助手分支 + RunActivity 三层结构。 */
export const TurnRow = memo(function TurnRow(props: {
	run: AgentRunItem;
	/** 新消息入场动画：仅发送后尾部新增的消息播放一次 */
	fresh?: boolean;
	onPreviewImage: (image: ImageContent) => void;
	showThinking?: boolean;
	isStreaming?: boolean;
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string) => void;
	onDiffFile?: DiffFileHandler;
	onResendUserMessage?: (message: ChatMessage) => void;
	onDeleteMessage?: (messageId: string) => void;
	onEditMessage?: (messageId: string, newText: string) => void;
	/** Agent 正在处理请求或流式输出中时禁用编辑/删除等操作按钮 */
	agentRunning?: boolean;
	/** 打开多选分享弹框 */
	onEnterMultiSelect?: () => void;
}) {
	const { run } = props;
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const editAreaRef = useRef<HTMLDivElement | null>(null);
	// 激活编辑时自动滚动到编辑区（避免 textarea 超出可视区域）
	useEffect(() => {
		if (editing && editAreaRef.current) {
			editAreaRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}
	}, [editing]);
	const isComplete = run.endedAt > 0;
	const duration = isComplete && run.startedAt > 0 ? run.endedAt - run.startedAt : 0;
	const showDuration = isComplete && duration > 0;

	// 收集本轮所有 assistant 消息（按 run.items 的时序保持原始顺序）
	const assistantMessages = run.items.filter(
		(item): item is MessageItem =>
			item.kind === "message" && item.message.role === "assistant",
	);
	const allImages: ImageContent[] = [];
	for (const item of assistantMessages) {
		if (item.message.images) allImages.push(...item.message.images);
	}
	// 合并后的完整文本仅用于编辑/复制/删除等操作栏，不用于展示
	const mergedText = assistantMessages
		.map((item) => stripThinkingTags(stripAnsi(item.message.text)).trim())
		.filter(Boolean)
		.join("\n\n");

	/** 找出 message 在 run.items 中的位置，分离「执行过程」（最后一条 assistant message 之前的所有条目）。
	 *  执行过程包含 thinking-group、tool-group 以及中间穿插的 assistant 消息，
	 *  默认折叠并以概要形式展示，用户可展开查看细节。最后一条 assistant 消息作为最终回答始终可见。 */
	const lastAssistantIndex = (() => {
		for (let i = run.items.length - 1; i >= 0; i--) {
			if (run.items[i].kind === "message" && (run.items[i] as MessageItem).message.role === "assistant") {
				return i;
			}
		}
		return -1;
	})();
	const finalMessageItem = lastAssistantIndex >= 0 ? (run.items[lastAssistantIndex] as MessageItem) : null;

	// 最终回答文本，用于判断自然完成 vs 手动中断。
	// 提前定义以在 useEffect 中使用（auto-collapse 逻辑需要判断是否有最终文本回答）。
	const finalTxt = finalMessageItem
		? stripThinkingTags(stripAnsi(finalMessageItem.message.text)).trim()
		: "";

	// 执行过程默认展开（agent 处理中），输出完毕后自动折叠。
	// 使用 agentRunning 而非 isStreaming：后者在多步工具调用之间会短暂 flicker 为 false，
	// 导致过早折叠工具输出；agentRunning 在整个 agent 处理生命周期内始终为 true。
	const [executionExpanded, setExecutionExpanded] = useState(
		!isComplete || Boolean(props.agentRunning),
	);
	useEffect(() => {
		if (props.agentRunning) {
			setExecutionExpanded(true);
		} else if (isComplete) {
			setExecutionExpanded(false);
		}
	}, [isComplete, props.agentRunning]);

	const rowRef = useRef<HTMLElement | null>(null);
	// 本轮没有任何可渲染内容时不输出空容器
	const hasContent =
		assistantMessages.length > 0 ||
		run.items.some(item => item.kind === "thinking-group") ||
		run.items.some(item => item.kind === "tool-group") ||
		allImages.length > 0;
	if (!hasContent) return null;

	/** 渲染执行过程折叠区里的一个条目（thinking-group / tool-group）。
	 *  回答文本不再进入折叠区（issue #130），由 text 段常驻平铺渲染。 */
	const renderExecutionItem = (item: ThinkingGroupItem | ToolGroupItem) => {
		if (item.kind === "thinking-group") {
			if (!props.showThinking) return null;
			return (
				<ThinkingBlock
					key={item.id}
					text={item.text}
					startedAt={item.startedAt}
					endedAt={item.endedAt}
					showThinking={props.showThinking}
					onOpenExternal={props.onOpenExternal}
					onOpenFile={props.onOpenFile}
				/>
			);
		}
		return <ToolGroupCard key={item.id} group={item} />;
	};

	const finalThinking = finalMessageItem?.message.thinking?.trim()
		? stripAnsi(finalMessageItem.message.thinking)
		: null;
	const hasFinalThinking = Boolean(finalThinking && props.showThinking);

	/** 把一轮回答按时序拆成「过程段（思考+工具，可折叠）」与「回答文本段（常驻平铺）」。
	 *  issue #130：中间过渡回答是面向用户的正式内容，不再折进执行过程；
	 *  连续的思考/工具合成一个折叠段，回答文本段原位平铺，保留真实调用时序。 */
	const segments = useMemo<TurnSegment[]>(() => {
		const result: TurnSegment[] = [];
		const pushProcessItem = (item: ThinkingGroupItem | ToolGroupItem) => {
			const last = result[result.length - 1];
			if (last?.kind === "process") last.items.push(item);
			else result.push({ kind: "process", id: item.id, items: [item] });
		};
		run.items.forEach((item, index) => {
			// 最终回答单独渲染（支持编辑），不进任何段
			if (index === lastAssistantIndex) return;
			if (item.kind === "thinking-group" || item.kind === "tool-group") {
				pushProcessItem(item);
				return;
			}
			if (item.kind === "message" && item.message.role === "assistant") {
				// 空文本消息不展示（与旧逻辑一致）
				if (!stripThinkingTags(stripAnsi(item.message.text)).trim()) return;
				result.push({ kind: "text", id: item.message.id, message: item.message });
			}
		});
		// 最终回答的思考并入其前的过程段尾部，保持「思考→回答」时序
		if (hasFinalThinking && finalThinking) {
			pushProcessItem({
				kind: "thinking-group",
				id: `final-thinking-${finalMessageItem?.message.id ?? run.id}`,
				messages: finalMessageItem?.message ? [finalMessageItem.message] : [],
				text: finalThinking,
				startedAt: run.startedAt,
				endedAt: finalMessageItem?.message.timestamp ?? run.endedAt,
			});
		}
		return result;
	}, [run.items, lastAssistantIndex, hasFinalThinking, finalThinking, finalMessageItem, run.id, run.startedAt, run.endedAt]);

	/** 单个过程段的概要文本：只统计思考/工具（回答不再计入折叠，issue #130）。 */
	const segmentSummary = (items: (ThinkingGroupItem | ToolGroupItem)[]): string => {
		const tools = items.filter((i) => i.kind === "tool-group").length;
		const thinks = items.filter((i) => i.kind === "thinking-group").length;
		const parts: string[] = [];
		if (tools > 0) parts.push(t("activity.executionToolCount", { count: tools }));
		if (thinks > 0) parts.push(t("activity.executionThinkingCount", { count: thinks }));
		return parts.length > 0
			? t("activity.executionSummary", { summary: parts.join(" ") })
			: "";
	};

	/** 渲染一个段：过程段折叠（概要 + 可展开详情），回答文本段常驻平铺。 */
	const renderSegment = (segment: TurnSegment) => {
		if (segment.kind === "text") {
			return (
				<div key={segment.id} className="timeline-inline-text">
					<AssistantText
						text={stripThinkingTags(stripAnsi(segment.message.text)).trim()}
						images={allImages}
						onPreviewImage={props.onPreviewImage}
						onOpenExternal={props.onOpenExternal}
						onOpenFile={props.onOpenFile}
						isStreaming={props.isStreaming ?? false}
					/>
				</div>
			);
		}
		const summary = segmentSummary(segment.items);
		if (!summary) return null;
		return (
			<div className="execution-summary" key={segment.id}>
				<button
					type="button"
					className="execution-summary-toggle"
					onClick={() => setExecutionExpanded((prev) => !prev)}
					aria-expanded={executionExpanded}
					title={executionExpanded ? t("common.collapse") : t("common.expand")}
				>
					{executionExpanded ? (
						<ChevronDown size={14} aria-hidden="true" />
					) : (
						<ChevronRight size={14} aria-hidden="true" />
					)}
					<span>{summary}</span>
				</button>
				{executionExpanded && (
					<div className="execution-summary-details">
						{segment.items.map(renderExecutionItem)}
						<button
							type="button"
							className="execution-summary-collapse"
							onClick={() => setExecutionExpanded(false)}
							title={t("common.collapse")}
						>
							<ChevronUp size={12} aria-hidden="true" />
							<span>{t("common.collapse")}</span>
						</button>
					</div>
				)}
			</div>
		);
	};

	// 没有助手指令消息的情况：整轮只含工具/思考，用执行过程折叠渲染
	if (lastAssistantIndex === -1) {
		return (
			<article ref={rowRef} className={`turn-row mb-6 w-full min-w-0 max-w-full ${props.fresh ? "turn-row--fresh animate-[message-enter_260ms_cubic-bezier(0.22,1,0.36,1)_both]" : ""} ${props.agentRunning && !isComplete ? "turn-row--running" : isComplete ? "turn-row--complete" : "turn-row--pending"}`} data-message-id={run.id}>
				<div className="flex min-w-0 flex-col gap-3">
					<div className="mb-1 inline-flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
						<span className="shrink-0 font-mono font-semibold text-foreground/80">pi</span>
						<time className="shrink-0 font-mono text-[11px]">{formatTime(run.endedAt)}</time>
						{showDuration && (
							<span className="shrink-0 font-mono text-[11px] text-muted-foreground">{formatDuration(duration)}</span>
						)}
					</div>
					{/* 过程段（思考+工具）折叠展示，回答文本段常驻平铺（issue #130） */}
					{segments.map(renderSegment)}
				</div>
			</article>
		);
	}

	return (
		<article ref={rowRef} className={`turn-row mb-6 w-full min-w-0 max-w-full ${props.agentRunning && !isComplete ? "turn-row--running" : isComplete ? "turn-row--complete" : "turn-row--pending"} ${props.fresh ? "turn-row--fresh" : ""}`} data-message-id={run.id}>
			<div className="flex min-w-0 flex-col gap-3">
				<div className="mb-1 inline-flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
					<span className="shrink-0 font-mono font-semibold text-foreground/80">pi</span>
					<time className="shrink-0 font-mono text-[11px]">{formatTime(run.endedAt)}</time>
					{showDuration && (
						<span className="shrink-0 font-mono text-[11px] text-muted-foreground">{formatDuration(duration)}</span>
					)}
				</div>
				{/* 过程段（思考+工具）折叠展示，回答文本段常驻平铺（issue #130），
				    段按真实调用时序排列，最终回答始终在最后单独渲染。 */}
				{segments.map(renderSegment)}
				{/* 最终回答（始终可见）；最终思考已融入执行过程折叠区 */}
				{finalMessageItem && (
					<Fragment key={finalMessageItem.message.id}>
						{editing ? (
							<div className="flex flex-col gap-2 rounded-md border border-border-subtle bg-[color:color-mix(in_srgb,var(--color-accent)_3%,var(--color-bg-panel))] pl-2" ref={editAreaRef}>
								<div className="flex items-center gap-1 text-xs font-medium text-[var(--color-accent)] before:content-['✎'] before:text-sm">{t("common.edit")}</div>
								<Textarea
									className="min-h-[100px] max-h-[400px] w-full resize-y rounded-sm border border-[var(--color-accent)] bg-bg-panel p-2 font-mono text-sm leading-relaxed text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[0_0_0_2px_var(--focus-ring)]"
									value={editText}
									onChange={(e) => setEditText(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
											e.preventDefault();
											const targetId = assistantMessages.at(-1)?.message.id;
											if (targetId && props.onEditMessage) {
												props.onEditMessage(targetId, editText);
												setEditing(false);
											}
										}
										if (e.key === "Escape") setEditing(false);
									}}
									autoFocus
								/>
								<div className="flex justify-end gap-2">
									<Button variant="outline" size="sm" className="h-auto border-[var(--color-accent)] px-3 py-1 text-xs text-[var(--color-accent)] shadow-none hover:text-[var(--color-accent)]" onClick={() => {
										const targetId = assistantMessages.at(-1)?.message.id;
										if (targetId && props.onEditMessage) {
											props.onEditMessage(targetId, editText);
											setEditing(false);
										}
									}}>{t("common.save")}</Button>
									<Button variant="outline" size="sm" className="h-auto px-3 py-1 text-xs shadow-none" onClick={() => setEditing(false)}>{t("common.cancel")}</Button>
								</div>
							</div>
						) : finalTxt ? (
							<AssistantText
								text={finalTxt}
								images={allImages}
								onPreviewImage={props.onPreviewImage}
								onOpenExternal={props.onOpenExternal}
								onOpenFile={props.onOpenFile}
								isStreaming={props.isStreaming ?? false}
							/>
						) : null}
					</Fragment>
				)}
				{/* 操作栏 */}
				{mergedText && !editing && (
					<div className="flex min-h-6 items-center gap-1 opacity-55 transition-opacity hover:opacity-100 focus-within:opacity-100">
						<CopyMenu text={stripMarkdown(mergedText)} markdown={mergedText} targetRef={rowRef} />
						<Button
							type="button"
							className="turn-row-action-btn inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
							onClick={props.onEnterMultiSelect}
						title={t("app.multiSelectEnter")}
						>
							<Share size={14} />
						</Button>
						{!props.isStreaming && !props.agentRunning && assistantMessages.at(-1)?.message.id && (
							<>
								{props.onEditMessage && (
									<Button
										type="button"
										className="turn-row-action-btn inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
										onClick={() => {
											setEditText(mergedText);
											setEditing(true);
										}}
										title={t("common.edit")}
									>
										<SquarePen size={14} />
									</Button>
								)}
								{props.onDeleteMessage && (
									<Button
										type="button"
										className="turn-row-action-btn inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
										onClick={() => {
											const targetId = assistantMessages.at(-1)?.message.id;
											if (targetId) props.onDeleteMessage?.(targetId);
										}}
										title={t("common.delete")}
									>
										<Trash size={14} />
									</Button>
								)}
							</>
						)}
					</div>
				)}
			</div>
		</article>
	);
});

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
	onPreviewImage: (image: ImageContent) => void;
	onOpenFile?: (path: string) => void;
	onResendUserMessage?: (message: ChatMessage) => void;
	onEditMessage?: (messageId: string, newText: string) => void;
	onDeleteMessage?: (messageId: string) => void;
	/** 从该用户消息 fork 新会话；忙碌时不展示入口 */
	onForkMessage?: (message: ChatMessage) => void;
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
}) {
	const { message } = props;
	// 空闲时始终展示 fork 入口；entryId 解析放到点击时做（meta 缺失时走 getForkMessages 回退）。
	const canFork = Boolean(props.onForkMessage) && !props.agentRunning;
	const rowRef = useRef<HTMLElement | null>(null);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const editAreaRef = useRef<HTMLDivElement | null>(null);
	// 激活编辑时自动滚动到编辑区
	useEffect(() => {
		if (editing && editAreaRef.current) {
			editAreaRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}
	}, [editing]);
	// 提取 pi 展开后的 <skill> 块：渲染为 skill 徽标，并从正文里剥除 XML
	const { skills, text: bodyText } = extractSkillBlocks(stripAnsi(message.text));
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
			props.onEditMessage(message.id, editText);
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
		<article /* user-turn 为 e2e 选择器锚点 */ ref={rowRef} className={`user-turn group/user mb-4 flex w-full min-w-0 max-w-full flex-col items-end ${props.fresh ? "user-turn--fresh animate-[message-enter_260ms_cubic-bezier(0.22,1,0.36,1)_both]" : ""}`} data-message-id={message.id}>
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
						<img
							key={index}
							src={`data:${img.mimeType};base64,${img.data}`}
							alt={t("app.imageAlt", { index: index + 1 })}
							className="size-16 max-h-40 cursor-pointer rounded-md border border-border object-cover transition-colors duration-150 hover:border-border-strong"
							onClick={() => props.onPreviewImage(img)}
						/>
					))}
				</div>
			)}
			{cleanText && !editing && (
				<div className="user-turn-bubble w-fit min-w-0 max-w-[min(82%,64ch)] rounded-[14px] border border-border bg-muted/60 px-3 py-2 text-sm text-foreground [overflow-wrap:anywhere] break-words">
					<div className="text-chat leading-[1.6] text-text-primary whitespace-pre-wrap break-words">
						{renderChipText(cleanText, props.onOpenFile, props.validCommandNames, props.validFilePaths)}
					</div>
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
				<time className="font-mono">{formatTime(message.timestamp)}</time>
			</div>
			<div className="user-turn-actions flex min-h-6 items-center gap-0.5 opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100">
				<CopyMenu text={stripMarkdown(cleanText)} markdown={message.text} targetRef={rowRef} />
				<Button
					className="user-turn-action-btn inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
					onClick={props.onEnterMultiSelect}
					title={t("app.multiSelectEnter")}
						>
							<Share size={14} />
						</Button>
				{!editing && !props.agentRunning && (
					<>
						{canFork && (
							<Button
								type="button"
								className="user-turn-action-btn inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
								disabled={props.forking}
								onClick={() => props.onForkMessage?.(message)}
								title={t("app.forkFromMessageTitle")}
								aria-label={t("app.forkFromMessage")}
							>
								<GitFork size={14} strokeWidth={1.8} aria-hidden="true" />
							</Button>
						)}
						{props.onEditMessage && (
							<Button className="user-turn-action-btn inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={() => {
								setEditText(cleanText);
								setEditing(true);
							}} title={t("common.edit")}>
								<SquarePen size={14} />
							</Button>
						)}
						<Button
							className="user-turn-action-btn inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
							onClick={handleEditAndResend}
							title={t("app.editAndResendTitle")}
						>
							<UserPen size={14} />
						</Button>
						{props.onDeleteMessage && (
							<Button
								className="user-turn-action-btn inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
								onClick={() => props.onDeleteMessage?.(message.id)}
								title={t("common.delete")}
							>
								<Trash size={14} />
							</Button>
						)}
						{((props.isLastUserMessage || props.showResendButton) && props.onResendUserMessage) && (
							<Button
								className="user-turn-action-btn inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
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
				onClick={clickable ? () => onOpenFile(chip.raw.slice(1)) : undefined}
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
	AskQuestionCard,
	CompactionCard,
	DiagnosticMessageCard,
	RespondingIndicator,
	ThinkingBlock,
};
export { MultiSelectModal };

/** 将毫秒数格式化为短可读形式,如 "3.2s" "1m23s" */
type EntryAction = {
	active?: boolean;
	label: string;
	onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
	icon: ReactNode;
};

export function ConversationOutline(props: {
	items: Array<{ id: string; role: string; title: string; time: string }>;
	onJump: (id: string) => void;
	extraAction?: EntryAction;
	terminalAction?: EntryAction;
	filesAction?: EntryAction;
	gitAction?: EntryAction;
	editorsAction?: EntryAction & { anchorRef?: React.RefObject<HTMLButtonElement | null> };
	browserAction?: EntryAction;
}) {
	const [expanded, setExpanded] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [top, setTop] = useState(() => getInitialOutlineTop());
	const dragRef = useRef<{ startY: number; startTop: number } | null>(null);
	const topRef = useRef(top);
	const visibleItems = expanded ? props.items : props.items.slice(-15);
	const hasMore = props.items.length > 15;

	useEffect(() => {
		topRef.current = top;
	}, [top]);

	useEffect(() => {
		if (!dragging) return;
		function onMove(event: PointerEvent) {
			const drag = dragRef.current;
			if (!drag) return;
			setTop(clampOutlineTop(drag.startTop + event.clientY - drag.startY));
		}
		function onUp() {
			setDragging(false);
			dragRef.current = null;
			localStorage.setItem(OUTLINE_TOP_STORAGE_KEY, String(topRef.current));
		}
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}, [dragging]);

	useEffect(() => {
		const onResize = () => setTop((value) => clampOutlineTop(value));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	function startDrag(event: ReactPointerEvent<HTMLElement>) {
		event.preventDefault();
		event.stopPropagation();
		dragRef.current = { startY: event.clientY, startTop: topRef.current };
		setDragging(true);
	}

	return (
		<div
			className={`outline-hover${dragging ? " dragging" : ""}`}
			style={{ "--outline-top": `${top}px` } as React.CSSProperties}
		>
			<div className="outline-zone">
				<button
					className={`outline-trigger${props.items.length > 0 ? "" : " is-disabled"}`}
					disabled={props.items.length === 0}
					title={t("outline.trigger", { count: props.items.length })}
					onPointerDown={props.items.length > 0 ? startDrag : undefined}
				>
					☰
				</button>
				{props.items.length > 0 && (
				<nav className="conversation-outline">
				<div className="outline-title">
					<span
						className="outline-drag-handle"
						title={t("outline.drag")}
						onPointerDown={startDrag}
					>
						⋮⋮
					</span>
					<span>{t("outline.title")}</span>
					<span className="outline-count">{props.items.length}</span>
				</div>
				<div className="outline-list">
					{hasMore && !expanded && (
						<button
							className="outline-expand"
							onClick={() => setExpanded(true)}
						>
							{t("outline.showAll", { count: props.items.length })}
						</button>
					)}
					{visibleItems.map((item) => (
						<button
							key={item.id}
							className={
								item.role === "user" ? "outline-user" : "outline-assistant"
							}
							onClick={() => props.onJump(item.id)}
						>
							<strong>{item.title}</strong>
							<span>{item.time}</span>
						</button>
					))}
				</div>
				</nav>
				)}
			</div>
			{props.extraAction && (
				<button
					type="button"
					className={`scratch-pad-entry${props.extraAction.active ? " active" : ""}`}
					title={props.extraAction.label}
					aria-label={props.extraAction.label}
					onClick={props.extraAction.onClick}
				>
					{props.extraAction.icon}
				</button>
			)}
			{props.terminalAction && (
				<button
					type="button"
					className={`terminal-entry${props.terminalAction.active ? " active" : ""}`}
					title={props.terminalAction.label}
					aria-label={props.terminalAction.label}
					onClick={props.terminalAction.onClick}
				>
					{props.terminalAction.icon}
				</button>
			)}
			{props.filesAction && (
				<button
					type="button"
					className={`files-entry${props.filesAction.active ? " active" : ""}`}
					title={props.filesAction.label}
					aria-label={props.filesAction.label}
					onClick={props.filesAction.onClick}
				>
					{props.filesAction.icon}
				</button>
			)}
			{props.gitAction && (
				<button
					type="button"
					className={`git-entry${props.gitAction.active ? " active" : ""}`}
					title={props.gitAction.label}
					aria-label={props.gitAction.label}
					onClick={props.gitAction.onClick}
				>
					{props.gitAction.icon}
				</button>
			)}
			{props.editorsAction && (
				<button
					type="button"
					className={`editors-entry${props.editorsAction.active ? " active" : ""}`}
					title={props.editorsAction.label}
					aria-label={props.editorsAction.label}
					onClick={props.editorsAction.onClick}
				>
					{props.editorsAction.icon}
				</button>
			)}
			{props.browserAction && (
				<button
					type="button"
					className={`browser-entry${props.browserAction.active ? " active" : ""}`}
					title={props.browserAction.label}
					aria-label={props.browserAction.label}
					onClick={props.browserAction.onClick}
				>
					{props.browserAction.icon}
				</button>
			)}
		</div>
	);
}

const OUTLINE_TOP_STORAGE_KEY = "pi-desktop:outline-top";
function getInitialOutlineTop() {
	if (typeof window === "undefined") return 180;
	const saved = Number(localStorage.getItem(OUTLINE_TOP_STORAGE_KEY));
	if (Number.isFinite(saved) && saved > 0) return clampOutlineTop(saved);
	return clampOutlineTop(Math.round(window.innerHeight * 0.32));
}

function clampOutlineTop(value: number) {
	if (typeof window === "undefined") return value;
	return Math.min(window.innerHeight - 92, Math.max(76, value));
}

export { DrawerContent, SessionFileSummary, SessionHistoryModal } from "./WorkspaceSurface";

export { FileContextMenu, PromptSuggestions } from "./ComposerOverlayComponents";

/** 会话管理弹框：展示项目所有会话，支持多选删除、导出、重命名 */
