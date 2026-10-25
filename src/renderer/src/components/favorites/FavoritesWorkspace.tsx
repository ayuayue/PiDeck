import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Copy, GripVertical, ListChecks, Loader2, Search, Star, TextQuote, Trash2, UserRound, X } from "lucide-react";
import { useSetAtom } from "jotai";
import type { FavoriteEntry, FavoriteRole } from "../../../../shared/types";
import { favoriteDetailOpenAtom } from "../../atoms/favorites-atoms";
import { useFavorites } from "../../hooks/useFavorites";
import { useListReorder, type ListReorderItemBinding } from "../../hooks/useListReorder";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { writeClipboard } from "../../utils/clipboard";
import { showNotice } from "../../utils/notice";
import { openInSystemBrowser } from "../../utils/openExternal";
import { formatFullDateTime, formatRelativeTime } from "../../utils/relativeTime";
import { areAllSelected, pruneSelection, setSelectionFor, toggleSelection } from "../../utils/selectionSet";
import { BulkSelectionBar } from "../common/BulkSelectionBar";
import { RemovalList, RemovalRow } from "../removal/RemovalList";
import { Drawer } from "../motion/drawer";
import { MarkdownStream } from "../session/MarkdownStream";
import { stripMarkdown } from "../session/SurfaceParts";
import { Badge } from "../ui-shadcn/badge";
import { Button } from "../ui-shadcn/button";
import { Checkbox } from "../ui-shadcn/checkbox";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Input } from "../ui-shadcn/input";
import { filterFavorites, type FavoriteFilter } from "./favoriteFilters";

/** 筛选 chips：全部 / 回复 / 片段（与智能体分类 chips 同一形态）。 */
const FILTERS: readonly { value: FavoriteFilter; labelKey: "favorites.filterAll" | "favorites.filterMessage" | "favorites.filterSelection" }[] = [
	{ value: "all", labelKey: "favorites.filterAll" },
	{ value: "message", labelKey: "favorites.filterMessage" },
	{ value: "selection", labelKey: "favorites.filterSelection" },
];

function roleLabel(role: FavoriteRole): string {
	if (role === "user") return t("favorites.roleUser");
	if (role === "system") return t("favorites.roleSystem");
	return t("favorites.roleAssistant");
}

/**
 * 「收藏」页面主体：头部（标题 / 条数 / 搜索 / 批量）+ 筛选 chips + 紧凑列表 + 详情抽屉。
 *
 * 列表信息密度优先：卡片是两行（元信息 + 两行摘要）、高度约 72px，一屏能扫到更多条；
 * 完整内容（Markdown 渲染）在右侧抽屉里看——卡片摘要只给剥离 Markdown 的纯文本，
 * 避免列表里出现 ## / 围栏等源码噪声。
 *
 * 详情用抽屉（与公告中心同一套 beui Drawer）而不是常驻侧栏：长正文在 440px 侧栏里
 * 只能一行十几个字，而且会挤掉列表宽度；抽屉给正文 680px，关掉即回到全宽列表。
 *
 * 批量删除：头部「批量」进入选择态 → 卡片点选（拖拽/复制/单删在此时隐藏，避免与
 * 选择语义打架）→ 底部空条上的「删除所选」走确认框。选区按 id 存，删除/刷新后
 * 由 pruneSelection 自动收缩，不会把已消失的条目继续算进「已选 N 项」。
 */
export function FavoritesWorkspace() {
	const { entries, removeFavorite, removeFavorites, reorderFavorites } = useFavorites();
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<FavoriteFilter>("all");
	const [detailId, setDetailId] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<FavoriteEntry | null>(null);
	const [selectionMode, setSelectionMode] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(() => new Set<string>());
	const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
	const setDetailOpen = useSetAtom(favoriteDetailOpenAtom);

	const visible = useMemo(() => filterFavorites(entries ?? [], query, filter), [entries, query, filter]);
	// 拖拽排序：keys 用完整列表，落点用可见列表——搜索时隐藏的收藏在完整顺序里保持原槽位。
	const allIds = useMemo(() => (entries ?? []).map((entry) => entry.id), [entries]);
	const visibleIds = useMemo(() => visible.map((entry) => entry.id), [visible]);
	const reorder = useListReorder({ keys: allIds, visibleKeys: visibleIds, orientation: "list", onReorder: (nextOrder) => void reorderFavorites(nextOrder) });
	const detailEntry = useMemo(() => (detailId ? ((entries ?? []).find((entry) => entry.id === detailId) ?? null) : null), [entries, detailId]);
	const hasQuery = query.trim().length > 0;
	const selectedCount = selected.size;

	// 详情跟随数据：被删除（或列表刷新后不存在）就收起，避免抽屉停在死数据上。
	useEffect(() => {
		if (detailId && entries && !entries.some((entry) => entry.id === detailId)) setDetailId(null);
	}, [entries, detailId]);

	// 页面级 Esc（关 Tab）据此让路：抽屉打开时 Esc 只关抽屉。
	useEffect(() => {
		setDetailOpen(detailEntry !== null);
	}, [detailEntry, setDetailOpen]);
	useEffect(() => () => setDetailOpen(false), [setDetailOpen]);

	// 列表刷新（删除 / 其它入口取消收藏）后收缩选区；空列表直接退出批量态。
	useEffect(() => {
		if (!entries) return;
		setSelected((current) =>
			pruneSelection(
				current,
				entries.map((entry) => entry.id),
			),
		);
		if (entries.length === 0) setSelectionMode(false);
	}, [entries]);

	const handleCopy = async (entry: FavoriteEntry) => {
		const ok = await writeClipboard(entry.text);
		showNotice(ok ? t("copy.success") : t("copy.failed"), ok ? 1200 : 2000, ok ? undefined : "error");
	};

	const exitSelection = () => {
		setSelectionMode(false);
		setSelected(new Set<string>());
	};

	const enterSelection = () => {
		setDetailId(null);
		setSelectionMode(true);
	};

	const toggleSelect = (entry: FavoriteEntry) => setSelected((current) => toggleSelection(current, entry.id));

	const toggleSelectAllVisible = () => {
		setSelected((current) => setSelectionFor(current, visibleIds, !areAllSelected(current, visibleIds)));
	};

	const confirmBulkDelete = () => {
		const ids = [...selected];
		setPendingBulkDelete(false);
		exitSelection();
		void removeFavorites(ids);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex shrink-0 flex-col gap-3 border-b border-border/40 px-5 py-3">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
								<Star className="size-4" aria-hidden="true" />
							</span>
							<h1 className="truncate text-base font-semibold text-foreground">{t("favorites.title")}</h1>
							{entries ? (
								<Badge variant="neutral" size="sm">
									{t("favorites.count", { count: entries.length })}
								</Badge>
							) : null}
						</div>
						<p className="mt-1 truncate text-xs text-muted-foreground">{t("favorites.subtitle")}</p>
					</div>
					{entries && entries.length > 0 ? (
						<Button type="button" variant={selectionMode ? "secondary" : "outline"} size="sm" className="h-8 shrink-0 gap-1.5 text-xs" aria-pressed={selectionMode} title={t("common.bulkSelectHint")} onClick={() => (selectionMode ? exitSelection() : enterSelection())}>
							<ListChecks className="size-3.5" aria-hidden="true" />
							{t("common.bulkSelect")}
						</Button>
					) : null}
				</div>
				<div className="relative">
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
					<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("favorites.searchPlaceholder")} aria-label={t("favorites.searchPlaceholder")} size="sm" className="pl-7 text-xs" />
				</div>
			</header>

			{selectionMode ? (
				<BulkSelectionBar count={selectedCount} allSelected={areAllSelected(selected, visibleIds)} onToggleAll={toggleSelectAllVisible} onExit={exitSelection} onRequestDelete={() => setPendingBulkDelete(true)} />
			) : (
				<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/40 px-5 py-2" role="group" aria-label={t("favorites.filterLabel")}>
					{FILTERS.map((item) => (
						<button
							key={item.value}
							type="button"
							aria-pressed={filter === item.value}
							onClick={() => setFilter(item.value)}
							className={cn("inline-flex h-6 items-center rounded-full border px-2.5 text-xs transition-colors", filter === item.value ? "border-primary/40 bg-primary/10 font-medium text-primary" : "border-border/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground")}
						>
							{t(item.labelKey)}
						</button>
					))}
				</div>
			)}

			<div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
				{entries === null ? (
					<div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
						<Loader2 className="size-4 animate-pideck-spin" aria-hidden="true" />
						{t("common.loading")}
					</div>
				) : visible.length === 0 ? (
					<div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
						<Star className="size-8 text-muted-foreground/50" aria-hidden="true" />
						<div className="text-sm font-semibold text-foreground">{hasQuery ? t("favorites.noMatch") : t("favorites.emptyTitle")}</div>
						{!hasQuery && <p className="max-w-[360px] text-xs leading-6 text-muted-foreground">{t("favorites.emptyHint")}</p>}
					</div>
				) : (
					<div className="flex flex-col gap-1.5" {...reorder.containerProps}>
						{/* 删除淡出 + 列表位移收拢：remainingIds 用未过滤的 allIds——搜索/筛选隐藏的
						    收藏不算删除（exit 时长为 0），真实删除（单删/批量删）才淡出并让下方行滑位。
						    与 useListReorder 的拖拽 FLIP 互不干扰：重排不 bump 生成数。 */}
						<RemovalList remainingIds={allIds}>
							{visible.map((entry) => (
								<RemovalRow key={entry.id} itemId={entry.id}>
									<FavoriteCard
										entry={entry}
										active={entry.id === detailId}
										selectionMode={selectionMode}
										checked={selected.has(entry.id)}
										reorder={reorder.itemBinding(entry.id)}
										onOpen={(item) => setDetailId((current) => (current === item.id ? null : item.id))}
										onToggleSelect={toggleSelect}
										onCopy={(item) => void handleCopy(item)}
										onRequestDelete={setPendingDelete}
									/>
								</RemovalRow>
							))}
						</RemovalList>
					</div>
				)}
			</div>

			<FavoriteDetailDrawer entry={detailEntry} onClose={() => setDetailId(null)} onCopy={(item) => void handleCopy(item)} onRequestDelete={setPendingDelete} />

			{pendingDelete && (
				<ConfirmDialog
					title={t("favorites.deleteTitle")}
					message={t("favorites.deleteBody")}
					confirmLabel={t("common.delete")}
					danger
					layer={detailEntry ? "drawer" : "dialog"}
					onCancel={() => setPendingDelete(null)}
					onConfirm={() => {
						const target = pendingDelete;
						setPendingDelete(null);
						void removeFavorite(target.id);
					}}
				/>
			)}

			{pendingBulkDelete && <ConfirmDialog title={t("favorites.batchDeleteTitle")} message={t("favorites.batchDeleteBody", { count: selectedCount })} confirmLabel={t("common.delete")} danger onCancel={() => setPendingBulkDelete(false)} onConfirm={confirmBulkDelete} />}
		</div>
	);
}

/**
 * 紧凑收藏行：单行元信息 + 两行摘要（约 72px）。
 * 摘要对「整条消息」先 stripMarkdown（列表里不该出现 ## / 围栏源码），详情里再按 Markdown 渲染。
 * 批量模式下整行变成「选择目标」：点哪儿都是切换选中，拖拽手柄与悬停操作行收起。
 */
function FavoriteCard(props: {
	entry: FavoriteEntry;
	active: boolean;
	selectionMode: boolean;
	checked: boolean;
	reorder: ListReorderItemBinding;
	onOpen: (entry: FavoriteEntry) => void;
	onToggleSelect: (entry: FavoriteEntry) => void;
	onCopy: (entry: FavoriteEntry) => void;
	onRequestDelete: (entry: FavoriteEntry) => void;
}) {
	const entry = props.entry;
	const isSelection = entry.kind === "selection";
	const KindIcon = isSelection ? TextQuote : entry.role === "user" ? UserRound : Bot;
	const preview = useMemo(() => (isSelection ? entry.text : stripMarkdown(entry.text)), [entry.text, isSelection]);
	const activate = () => (props.selectionMode ? props.onToggleSelect(entry) : props.onOpen(entry));
	return (
		<article
			ref={props.reorder.register}
			role="button"
			tabIndex={0}
			aria-label={props.selectionMode ? t("common.toggleSelection") : t("favorites.openDetail")}
			aria-pressed={props.selectionMode ? props.checked : props.active}
			onClick={activate}
			onKeyDown={(event) => {
				// 卡片内还有手柄/复制/删除按钮：它们的 Enter/Space 表示自己的动作，不再冒泡成「打开详情」。
				if (event.target !== event.currentTarget) return;
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				activate();
			}}
			className={cn(
				"group relative flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors",
				props.selectionMode && props.checked ? "border-primary/50 bg-primary/10" : props.active ? "border-primary/40 bg-primary/5" : "border-border/50 hover:border-border hover:bg-muted/30",
				// 拖拽中的卡片半透明：插入位置由指示线表达，不在拖拽影像里重复。
				props.reorder.dragging && "opacity-40",
			)}
		>
			{/* 插入指示线：单列列表画在卡片上/下沿（与网格的竖线同一套落点语义）。 */}
			{!props.selectionMode && props.reorder.dropPosition && <span className={cn("pointer-events-none absolute -right-1 -left-1 h-0.5 rounded-full bg-primary", props.reorder.dropPosition === "before" ? "-top-1" : "-bottom-1")} aria-hidden="true" />}
			{/* 手柄悬停时替换掉左侧类型图标（同位置同尺寸）：不额外占列宽，列表密度不变。 */}
			{!props.selectionMode && (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="absolute top-2 left-2.5 size-6 cursor-grab rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 active:cursor-grabbing"
					title={t("common.dragReorder")}
					aria-label={t("common.dragReorder")}
					{...props.reorder.gripProps}
					onClick={(event) => event.stopPropagation()}
				>
					<GripVertical className="size-3.5" aria-hidden="true" />
				</Button>
			)}
			{props.selectionMode ? (
				<span className="mt-0.5 flex size-6 shrink-0 items-center justify-center">
					<Checkbox checked={props.checked} aria-label={t("common.toggleSelection")} onClick={(event) => event.stopPropagation()} onCheckedChange={() => props.onToggleSelect(entry)} />
				</span>
			) : (
				<span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
					<KindIcon className="size-3.5" aria-hidden="true" />
				</span>
			)}
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-1.5 text-micro text-muted-foreground">
					<span className="shrink-0">{isSelection ? t("favorites.kindSelection") : t("favorites.kindMessage")}</span>
					{entry.role && <span className="shrink-0">· {roleLabel(entry.role)}</span>}
					<span className="min-w-0 truncate" title={entry.sessionTitle ?? undefined}>
						· {entry.sessionTitle ?? t("favorites.sourceUnknown")}
					</span>
					{entry.partial && <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5">{t("favorites.partial")}</span>}
					{entry.truncated && <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5">{t("favorites.truncated")}</span>}
					{/* 收藏时间：精确日期时间常显（用户要「记录时间」），hover 给相对时间便于扫视 */}
					<time className="ml-auto shrink-0 tabular-nums" dateTime={new Date(entry.createdAt).toISOString()} title={formatRelativeTime(entry.createdAt)}>
						{formatFullDateTime(entry.createdAt)}
					</time>
				</div>
				<div className="mt-1 line-clamp-2 text-xs leading-5 break-words text-foreground/90">{preview}</div>
			</div>
			{!props.selectionMode && (
				<div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="size-6 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
						title={t("favorites.copy")}
						aria-label={t("favorites.copy")}
						onClick={(event) => {
							event.stopPropagation();
							props.onCopy(entry);
						}}
					>
						<Copy size={13} />
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="size-6 rounded-sm text-muted-foreground hover:bg-muted hover:text-[var(--color-danger)]"
						title={t("favorites.delete")}
						aria-label={t("favorites.delete")}
						onClick={(event) => {
							event.stopPropagation();
							props.onRequestDelete(entry);
						}}
					>
						<Trash2 size={13} />
					</Button>
				</div>
			)}
		</article>
	);
}

/**
 * 详情抽屉：Markdown 渲染的完整正文 + 元信息（来源会话 / 收藏时间 / 模型 / 状态标记）+ 复制/删除。
 *
 * 用 beui Drawer（与公告详情同一套）而不是 Radix Dialog：收藏正文是长文档，右侧滑出
 * 不会像居中弹窗那样把正文挤成窄条；portal 到 body 是为了不受页面 overlay（z-30）裁剪。
 * 组件常挂载、靠 open 驱动，关闭时才有滑出动画；正文为空时内部整块卸载。
 */
function FavoriteDetailDrawer(props: { entry: FavoriteEntry | null; onClose: () => void; onCopy: (entry: FavoriteEntry) => void; onRequestDelete: (entry: FavoriteEntry) => void }) {
	const entry = props.entry;
	const isSelection = entry?.kind === "selection";
	return createPortal(
		<Drawer
			open={entry !== null}
			onOpenChange={(next) => {
				if (!next) props.onClose();
			}}
			side="right"
			ariaLabel={t("favorites.detailTitle")}
			// 与 shadcn 弹窗共用一套层级 token（--z-drawer 980 高于 --z-dialog 950）
			backdropClassName="z-[var(--z-drawer)]"
			className="z-[var(--z-drawer)] w-[min(680px,92vw)]"
			rootAttributes={{ "data-favorite-detail-drawer": "" }}
		>
			{entry && (
				<>
					<div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-4 py-3">
						<span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
							<Star className="size-3.5" aria-hidden="true" />
						</span>
						<span className="min-w-0 truncate text-sm font-semibold text-foreground">{t("favorites.detailTitle")}</span>
						<Button type="button" variant="ghost" size="icon-sm" className="ml-auto size-7 rounded-sm text-muted-foreground" title={t("common.close")} aria-label={t("common.close")} onClick={props.onClose}>
							<X size={14} />
						</Button>
					</div>
					<div className="flex shrink-0 flex-col gap-1.5 border-b border-border/40 px-4 py-3 text-micro text-muted-foreground">
						<div className="flex items-center gap-2">
							<span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 px-1.5 py-0.5">
								<TextQuote className="size-3" aria-hidden="true" />
								{isSelection ? t("favorites.kindSelection") : t("favorites.kindMessage")}
							</span>
							{entry.role && <span className="shrink-0">{roleLabel(entry.role)}</span>}
							{entry.partial && <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5">{t("favorites.partial")}</span>}
							{entry.truncated && <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5">{t("favorites.truncated")}</span>}
						</div>
						<DetailMetaRow label={t("favorites.detailSession")} value={entry.sessionTitle ?? t("favorites.sourceUnknown")} />
						<DetailMetaRow label={t("favorites.detailTime")} value={`${formatFullDateTime(entry.createdAt)}（${formatRelativeTime(entry.createdAt)}）`} title={new Date(entry.createdAt).toLocaleString()} />
						{entry.model && <DetailMetaRow label={t("favorites.detailModel")} value={entry.model} />}
					</div>
					{/* 整条消息按 Markdown 渲染（与时间线同一引擎/插件）；划选片段是纯文本，保持原样换行。 */}
					<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
						{/* markdown-body 是排版容器（与时间线 AnswerOutput 同款）：标题/列表/代码块/表格的间距都靠它。 */}
						{isSelection ? (
							<div className="text-xs leading-6 break-words whitespace-pre-wrap text-foreground">{entry.text}</div>
						) : (
							<div className="markdown-body text-chat text-text-primary">
								<MarkdownStream text={entry.text} isStreaming={false} onOpenExternal={(url) => void openInSystemBrowser(url)} />
							</div>
						)}
					</div>
					<div className="flex shrink-0 items-center gap-1.5 border-t border-border/40 px-4 py-2.5">
						<Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => props.onCopy(entry)}>
							<Copy size={14} />
							{t("favorites.copy")}
						</Button>
						<Button type="button" variant="ghost" size="sm" className="ml-auto h-7 gap-1.5 text-xs text-muted-foreground hover:text-[var(--color-danger)]" onClick={() => props.onRequestDelete(entry)}>
							<Trash2 size={14} />
							{t("favorites.delete")}
						</Button>
					</div>
				</>
			)}
		</Drawer>,
		document.body,
	);
}

function DetailMetaRow(props: { label: string; value: string; title?: string }) {
	return (
		<div className="flex items-start gap-2">
			<span className="w-14 shrink-0 text-muted-foreground">{props.label}</span>
			<span className="min-w-0 break-words text-foreground/90" title={props.title}>
				{props.value}
			</span>
		</div>
	);
}
