import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { SessionSearchMatch } from "../../../../shared/types";
import { t } from "../../i18n";
import { SESSION_FIND_MIN_QUERY_LENGTH, useSessionMessageSearch } from "../../hooks/useSessionMessageSearch";
import { resolveSessionFindAnchor, type SessionFindAnchor } from "./sessionFindAnchor";
import { formatAbsoluteTime, formatRelativeTime } from "../../utils/relativeTime";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";

/** 浮层宽度：够放下「片段 + 角色/时间」，又不遮住会话正文的中间区域。 */
const FIND_PANEL_WIDTH = 420;
/** 命中列表最大高度：再多就滚动，不把整屏盖掉。 */
const FIND_LIST_MAX_HEIGHT = 260;

type SessionFindOverlayProps = {
	sessionId: string;
	/** 锚点元素（会话消息区 = 时间线滚动视口）：浮层贴它的右上角，不参与会话栏的 flex/grid 布局。 */
	anchorRef: RefObject<HTMLElement | null>;
	/** 跳到某条消息（由 ChatSessionPane 传入 sessionTimeline.jumpToMessage）。 */
	onJump: (messageId: string) => void;
	/** 外部请求打开（Ctrl/Cmd+Shift+F）：每次自增即打开并聚焦输入框。 */
	openSignal: number;
};

/**
 * 会话内查找浮层：在当前会话的消息里找关键词，逐条跳到命中位置。
 *
 * 为什么浮层走 portal + 固定定位：会话栏在单栏模式下是 `display: contents`
 * （自己的子节点直接成为 App 网格的子项），在栏内插一个绝对定位元素会多出一个
 * 网格项、挤坏布局。portal 到 body 并以消息区矩形为锚点，布局零影响；
 * 位置随窗口尺寸/消息区尺寸变化重算。锚点必须是消息区（时间线视口）而不是整栏聊天区：
 * 自定义标题栏下聊天区顶到窗口上沿，其右上角就是窗口关闭键（见 sessionFindAnchor）。
 *
 * 浮层本身不含入口：收起态什么都不渲染。入口是会话头部工具条里的放大镜按钮
 * （SessionHeader → requestSessionFindAtom），与快捷键 Ctrl/Cmd+Shift+F 写同一份
 * 「按会话累加的打开请求」；不要再把常驻按钮浮回消息区右上角——那样会压住正文，
 * 在自定义标题栏下还会落到窗口控件行（用户反馈「搜索图标跑到关闭窗口位置」）。
 */
export function SessionFindOverlay(props: SessionFindOverlayProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	// 初值给「视口右上角」而不是 null：挂在 mount 上的测量完成前若被快捷键打开，
	// 也始终有一个屏幕内的落点（锚点量不到时同样回退到这里）。
	const [anchorBox, setAnchorBox] = useState<SessionFindAnchor>(() => resolveSessionFindAnchor(null, { width: typeof window === "undefined" ? 0 : window.innerWidth, height: typeof window === "undefined" ? 0 : window.innerHeight }));
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);

	const { result, isSearching, unavailable } = useSessionMessageSearch(props.sessionId, query, open);
	const matches = useMemo<SessionSearchMatch[]>(() => result?.sessions[0]?.matches ?? [], [result]);
	const hitCount = result?.sessions[0]?.hitCount ?? matches.length;
	const trimmedQuery = query.trim();
	const hasQuery = trimmedQuery.length >= SESSION_FIND_MIN_QUERY_LENGTH;

	const measureAnchor = useCallback(() => {
		const rect = props.anchorRef.current?.getBoundingClientRect();
		setAnchorBox(resolveSessionFindAnchor(rect, { width: window.innerWidth, height: window.innerHeight }));
	}, [props.anchorRef]);

	useLayoutEffect(() => {
		measureAnchor();
		window.addEventListener("resize", measureAnchor);
		const anchor = props.anchorRef.current;
		const observer = typeof ResizeObserver === "undefined" || !anchor ? null : new ResizeObserver(() => measureAnchor());
		if (observer && anchor) observer.observe(anchor);
		return () => {
			window.removeEventListener("resize", measureAnchor);
			observer?.disconnect();
		};
	}, [measureAnchor, open, props.anchorRef]);

	// 外部快捷键：openSignal 是「每按一次就自增」的计数器，只响应**变化**，不响应挂载时已有的值。
	// 否则重挂载（切会话换 pane、findSupported 从 false 变 true）会把上一次按键重放成自动弹出。
	const lastOpenSignalRef = useRef(props.openSignal);
	useEffect(() => {
		if (props.openSignal === lastOpenSignalRef.current) return;
		lastOpenSignalRef.current = props.openSignal;
		setOpen(true);
	}, [props.openSignal]);

	useEffect(() => {
		if (!open) return;
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [open, props.openSignal]);

	// 新结果/新关键词后回到第一条命中
	useEffect(() => {
		setActiveIndex(0);
	}, [trimmedQuery, result]);

	const jumpTo = useCallback(
		(index: number) => {
			const target = matches[index];
			if (!target) return;
			setActiveIndex(index);
			props.onJump(target.messageId);
		},
		[matches, props.onJump],
	);

	const step = useCallback(
		(delta: number) => {
			if (matches.length === 0) return;
			const next = (activeIndex + delta + matches.length) % matches.length;
			jumpTo(next);
		},
		[activeIndex, jumpTo, matches.length],
	);

	const close = useCallback(() => {
		setOpen(false);
		setQuery("");
	}, []);

	// 活动行滚动进视野（长结果列表里键盘导航必须能看见当前项）
	useEffect(() => {
		const container = listRef.current;
		if (!container) return;
		const row = container.querySelector<HTMLElement>(`[data-find-index="${activeIndex}"]`);
		row?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	const positionStyle = { top: anchorBox.top, right: anchorBox.right, width: FIND_PANEL_WIDTH };

	// 收起态不渲染任何东西：入口只有快捷键（Ctrl/Cmd+Shift+F），见文件头注释。
	if (!open) return null;

	return createPortal(
		<div
			className="fixed z-40 flex max-w-[calc(100vw-24px)] shrink-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-popover shadow-md"
			style={positionStyle}
			role="dialog"
			aria-label={t("sessionFind.open")}
			onKeyDown={(event) => {
				// 焦点可能落在上一条/下一条/关闭按钮上：Esc 在容器层兜住，随处可关
				if (event.key !== "Escape") return;
				event.preventDefault();
				close();
			}}
		>
			<div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/40 px-2">
				<Search size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
				<Input
					ref={inputRef}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={t("sessionFind.placeholder")}
					className="h-7 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							close();
							return;
						}
						if (event.key === "Enter") {
							event.preventDefault();
							step(event.shiftKey ? -1 : 1);
						}
					}}
				/>
				<span className="shrink-0 text-xs tabular-nums text-muted-foreground">{hasQuery ? t("sessionFind.count", { index: matches.length === 0 ? 0 : activeIndex + 1, total: Math.max(hitCount, matches.length) }) : ""}</span>
				<Button variant="ghost" size="icon" className="shrink-0" style={{ width: 24, height: 24 }} title={t("sessionFind.prev")} aria-label={t("sessionFind.prev")} disabled={matches.length === 0} onClick={() => step(-1)}>
					<ChevronUp size={14} aria-hidden="true" />
				</Button>
				<Button variant="ghost" size="icon" className="shrink-0" style={{ width: 24, height: 24 }} title={t("sessionFind.next")} aria-label={t("sessionFind.next")} disabled={matches.length === 0} onClick={() => step(1)}>
					<ChevronDown size={14} aria-hidden="true" />
				</Button>
				<Button variant="ghost" size="icon" className="shrink-0" style={{ width: 24, height: 24 }} title={t("sessionFind.close")} aria-label={t("sessionFind.close")} onClick={close}>
					<X size={14} aria-hidden="true" />
				</Button>
			</div>
			{hasQuery && (
				<div ref={listRef} className="flex min-h-0 shrink-0 flex-col overflow-y-auto" style={{ maxHeight: FIND_LIST_MAX_HEIGHT }}>
					{matches.length === 0 ? (
						<p className="shrink-0 px-3 py-2 text-xs text-muted-foreground">{isSearching ? t("sessionFind.searching") : unavailable ? t("sessionFind.unavailable") : t("sessionFind.noResults")}</p>
					) : (
						matches.map((match, index) => (
							// key 不能只用 messageId：同一条消息的多个文本块各算一次命中，会撞 key
							<button key={`${match.messageId}-${index}`} type="button" data-find-index={index} className={`flex shrink-0 flex-col gap-0.5 border-b border-border/20 px-3 py-1.5 text-left text-xs hover:bg-accent/40${index === activeIndex ? " bg-accent/60" : ""}`} onClick={() => jumpTo(index)}>
								<span className="flex items-center gap-1.5 text-micro text-muted-foreground">
									<span className="shrink-0">{match.role === "user" ? t("sessionFind.roleUser") : t("sessionFind.roleAssistant")}</span>
									{/* 时间是用户定位「哪一轮」的线索；条目 id 是内部标识，露出来只是噪音 */}
									<span className="shrink-0 tabular-nums" title={formatAbsoluteTime(match.timestampMs)}>
										{formatRelativeTime(match.timestampMs)}
									</span>
								</span>
								<span className="line-clamp-2 break-words">{match.snippet}</span>
							</button>
						))
					)}
				</div>
			)}
			{unavailable && hasQuery && matches.length > 0 && <p className="shrink-0 border-t border-border/40 px-3 py-1 text-micro text-muted-foreground">{t("sessionFind.unavailable")}</p>}
		</div>,
		document.body,
	);
}
