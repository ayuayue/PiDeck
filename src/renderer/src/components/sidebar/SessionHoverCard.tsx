import { useEffect, useRef, useState, type ReactNode, type PointerEvent } from "react";
import { Calendar, Folder, Laptop, MessageSquare } from "lucide-react";
import type { SessionRecord, SessionSummary } from "../../../../shared/types";
import { looksLikePiSessionFileStem } from "../../../../shared/sessionIdentity";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { formatFullDateTime } from "../../utils/relativeTime";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui-shadcn/hover-card";
import { SessionBackendMark, SessionSourceBadge } from "../session/SessionSourceBadge";

export interface SessionHoverCardProps {
	children: ReactNode;
	/** 会话摘要或记录数据（含 preview、updatedAt、source、backend 等） */
	session?: SessionSummary | SessionRecord;
	/** 可选显式标题（例如从 AgentTab 或父级格式化后的名称） */
	title?: string;
	/** 所属项目/工作区名称（对应截图中的「所属空间」） */
	projectName?: string;
	/** 当前运行态状态（idle / running / error 等） */
	status?: string | null;
	/** 是否禁用浮层（例如右键菜单打开、正在拖拽或处于草稿编辑期） */
	disabled?: boolean;
	/** 移入延迟展示时间（毫秒），默认 1500ms（1.5 秒）以消除误划竞态 */
	openDelay?: number;
	/** 移出关闭延迟时间（毫秒），默认 200ms 允许鼠标平滑移入卡片复制文字 */
	closeDelay?: number;
}

/** 点击后额外压制时长：覆盖列表重排换位/行重挂载后 Radix 的延迟 open 定时器。 */
const HOVER_SUPPRESS_EXTRA_MS = 250;
/**
 * 模块级「最近一次会话行主键按下」时间戳，跨实例/重挂载共享：点击会话后列表按
 * updatedAt 重排，行可能在静止光标下换位或重挂载，新实例自身的 suppressUntilRef
 * 已归零；没有这个共享时间戳就会出现「点完 1.5s 后弹出另一行的预览卡」。
 */
let lastRowPointerDownAt = 0;

/**
 * 侧栏会话悬浮预览卡片（SessionHoverCard）
 *
 * 核心交互与业务规则：
 * 1. 延迟触发：默认设置 openDelay=1500ms（1.5 秒）。鼠标快速划过侧栏列表时不会频繁触发浮层挂载
 *    与竞态渲染，只有光标在某一行停留超过 1.5 秒后才弹出卡片。
 * 2. 位置朝向：默认朝右侧弹出（side="right"），利用右侧主视口充裕空间展示，不遮挡侧栏下方的其他会话。
 * 3. 丰富信息：展示会话标题与首轮提问/摘要预览文本、本地任务/来源后端标记、所属项目空间、精准更新时间。
 *    当轻量扫描未载入正文 preview 时，自动回退展示已推断出的会话标题，避免有标题却显示「暂无内容摘要」。
 * 4. 状态互斥：支持 disabled 属性，在右键上下文菜单激活或拖拽时禁止浮层激活。
 * 5. 关闭安全网：会话列表按 updatedAt 持续重排，触发行可能在卡片打开期间被重挂载/移除，
 *    此时 pointerleave 不会派发给已卸载的节点，Radix 收不到关闭事件 → 卡片残留。
 *    open 期间全局捕获 pointermove，指针离开「触发行 + 卡片」超过 closeDelay 即强制关闭；
 *    同时不阻止外部 pointerdown（否则点击别处也无法关掉，卡片一直占屏）。
 */
export function SessionHoverCard({
	children,
	session,
	title,
	projectName,
	status,
	disabled = false,
	openDelay = 1500,
	closeDelay = 200,
}: SessionHoverCardProps) {
	const [open, setOpen] = useState(false);
	const suppressUntilRef = useRef(0);
	// 关闭安全网引用：trigger 经 asChild 合并到行按钮（Radix Trigger 类型声明为
	// HTMLAnchorElement，实际 ref 收到的是 asChild 的行 DOM，contains() 按 Node 判定即可）
	const triggerRef = useRef<HTMLAnchorElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const closeTimerRef = useRef<number | null>(null);
	const suppressWindowMs = openDelay + closeDelay + HOVER_SUPPRESS_EXTRA_MS;

	/**
	 * 关闭安全网：触发行在卡片打开期间被列表重排重挂载时，光标下的 pointerleave
	 * 不会派发给已卸载的节点，Radix 永远收不到关闭事件 → 卡片一直残留占屏。
	 * open 期间全局捕获 pointermove：指针不在触发行也不在卡片内，按 closeDelay
	 * 宽限后强制关闭。宽限期复刻 Radix 语义，允许鼠标从行平滑移入卡片复制文字。
	 */
	useEffect(() => {
		if (!open) return;
		const clearCloseTimer = () => {
			if (closeTimerRef.current != null) {
				window.clearTimeout(closeTimerRef.current);
				closeTimerRef.current = null;
			}
		};
		const isInside = (target: EventTarget | null): boolean => {
			if (!(target instanceof Node)) return false;
			return Boolean(triggerRef.current?.contains(target) || contentRef.current?.contains(target));
		};
		const onGlobalPointerMove = (event: globalThis.PointerEvent) => {
			if (isInside(event.target)) {
				clearCloseTimer();
				return;
			}
			if (closeTimerRef.current == null) {
				closeTimerRef.current = window.setTimeout(() => {
					closeTimerRef.current = null;
					setOpen(false);
				}, closeDelay);
			}
		};
		window.addEventListener("pointermove", onGlobalPointerMove, true);
		return () => {
			window.removeEventListener("pointermove", onGlobalPointerMove, true);
			clearCloseTimer();
		};
	}, [open, closeDelay]);

	// 实例自身的时间戳（覆盖本实例刚被点过）与模块级时间戳（覆盖重挂载后的新实例）
	// 取较大者判断；点击后的窗口期内任何 hover 打开一律吞掉。
	const isSuppressed = () =>
		Date.now() < Math.max(suppressUntilRef.current, lastRowPointerDownAt + suppressWindowMs);

	const cancelPendingOpen = () => {
		// 点击会话是导航，不是悬停预览：立刻关掉已开卡片，并在 openDelay 窗口内吞掉 Radix 延迟 open。
		// 超时后允许重新悬停打开，避免 suppress 标志一直卡住下一次正常预览。
		suppressUntilRef.current = Date.now() + suppressWindowMs;
		lastRowPointerDownAt = suppressUntilRef.current;
		setOpen(false);
	};

	const handleOpenChange = (next: boolean) => {
		if (next && isSuppressed()) {
			setOpen(false);
			return;
		}
		setOpen(next);
	};

	const handleTriggerPointerDown = (event: PointerEvent<HTMLElement>) => {
		// 只拦主键点击选中；右键菜单仍走悬停卡片的 disabled 路径。
		if (event.button === 0) cancelPendingOpen();
	};

	// 没有会话数据且未传标题，或显式禁用时，直接渲染子元素，不挂载 HoverCard 行为
	if ((!session && !title) || disabled) {
		return <>{children}</>;
	}

	// 提取并清洗标题：排除时间戳文件名、纯 Untitled 等占位符
	const rawTitle = (
		title ||
		(session && "title" in session && typeof session.title === "string" ? session.title : undefined) ||
		(session && "name" in session && typeof session.name === "string" ? session.name : undefined)
	)?.trim();
	const isPlaceholderTitle = !rawTitle || looksLikePiSessionFileStem(rawTitle) || /^untitled(?: session)?$/i.test(rawTitle);
	const validTitle = isPlaceholderTitle ? undefined : rawTitle;

	// 提取并清洗正文预览：排除空会话等占位标记
	const rawPreview = session?.preview?.trim();
	const isPlaceholderPreview = !rawPreview ||
		rawPreview === "空会话" ||
		rawPreview === "Empty session" ||
		rawPreview === t("sidebar.hoverCard.emptyPreview");
	const validPreview = isPlaceholderPreview ? undefined : rawPreview;

	// 判断标题与预览内容是否实质相同（相同或互相包含前缀，避免卡片内重复展示相同文本）
	const isSameContent = Boolean(
		validTitle &&
		validPreview &&
		(validTitle === validPreview ||
			validPreview.startsWith(validTitle) ||
			validTitle.startsWith(validPreview))
	);

	const formattedTime = session?.updatedAt ? formatFullDateTime(session.updatedAt) : "";

	return (
		<HoverCard open={open} onOpenChange={handleOpenChange} openDelay={openDelay} closeDelay={closeDelay}>
			<HoverCardTrigger asChild ref={triggerRef} onPointerDown={handleTriggerPointerDown}>
				{children}
			</HoverCardTrigger>
			<HoverCardContent
				ref={contentRef}
				side="right"
				align="start"
				sideOffset={10}
				className="w-84 max-w-[calc(100vw-320px)] p-3.5 shadow-xl select-text"
			>
				{/* 1. 会话正文预览区：有明确标题和独立摘要时分层展示，否则展示主体内容；两者皆空才显示占位 */}
				<div className="max-h-48 overflow-y-auto select-text">
					{validTitle && validPreview && !isSameContent ? (
						<div className="flex flex-col gap-1.5">
							<div className="text-xs font-semibold leading-snug text-foreground break-words">
								{validTitle}
							</div>
							<div className="text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
								{validPreview}
							</div>
						</div>
					) : validTitle || validPreview ? (
						<div className="text-xs leading-relaxed text-foreground whitespace-pre-wrap break-words font-medium">
							{isSameContent
								? (validPreview!.length >= validTitle!.length ? validPreview : validTitle)
								: (validTitle ?? validPreview)}
						</div>
					) : (
						<div className="text-xs leading-relaxed text-muted-foreground/70 italic">
							{t("sidebar.hoverCard.emptyPreview")}
						</div>
					)}
				</div>

				{/* 2. 会话属性与标签区 */}
				<div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-2.5 text-micro text-muted-foreground">
					{/* 本地任务 / 来源标识 */}
					<span className="inline-flex items-center gap-1 rounded bg-muted/80 px-1.5 py-0.5 text-foreground/80">
						<Laptop size={11} className="shrink-0 text-muted-foreground" aria-hidden="true" />
						<span>{t("sidebar.hoverCard.localTask")}</span>
					</span>

					{/* 消息数量（若大于 0） */}
					{typeof session?.messageCount === "number" && session.messageCount > 0 && (
						<span className="inline-flex items-center gap-1 rounded bg-muted/80 px-1.5 py-0.5 text-foreground/80">
							<MessageSquare size={11} className="shrink-0 text-muted-foreground" aria-hidden="true" />
							<span>{t("sidebar.hoverCard.messageCount", { count: session.messageCount })}</span>
						</span>
					)}

					{/* 后端标识（dsh / imagegen） */}
					{session?.backend && session.backend !== "pi" && (
						<SessionBackendMark backend={session.backend} />
					)}

					{/* 外部导入来源（codex / claude / workbuddy 等） */}
					{session?.source && session.source !== "pi" && (
						<SessionSourceBadge source={session.source} />
					)}

					{/* 运行状态（若有） */}
					{status && (
						<span
							className={cn(
								"rounded px-1.5 py-0.5 font-medium",
								status === "running" && "bg-warning/15 text-warning",
								status === "error" && "bg-danger/15 text-danger",
								status === "idle" && "bg-info/15 text-info",
							)}
						>
							{status === "running"
								? t("app.statusRunning")
								: status === "error"
									? t("app.statusError")
									: t("app.statusIdle")}
						</span>
					)}
				</div>

				{/* 3. 所属空间与项目 */}
				{projectName && (
					<div className="mt-1.5 flex items-center gap-1.5 text-micro text-muted-foreground">
						<Folder size={11} className="shrink-0 text-muted-foreground/80" aria-hidden="true" />
						<span className="truncate">
							{t("sidebar.hoverCard.workspace", { name: projectName })}
						</span>
					</div>
				)}

				{/* 4. 精确更新时间 */}
				{formattedTime && (
					<div className="mt-1 flex items-center gap-1.5 text-micro text-muted-foreground/80 tabular-nums">
						<Calendar size={11} className="shrink-0 text-muted-foreground/70" aria-hidden="true" />
						<span>{t("sidebar.hoverCard.updatedAt", { time: formattedTime })}</span>
					</div>
				)}
			</HoverCardContent>
		</HoverCard>
	);
}
