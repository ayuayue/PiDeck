import { Search } from "lucide-react";
import type { RefObject } from "react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";

/**
 * 导入弹窗列表的搜索行（Codex / Claude / 目录导入共用）。
 *
 * 放在工具栏与会话列表之间、滚动容器之外：列表本身很长，搜索框必须始终可见。
 * 命中数单独展示——列表是增量渲染的，屏幕上看到的行数不代表命中数。
 */
export function ImportListSearchRow(props: { value: string; onChange: (value: string) => void; matchedCount: number; totalCount: number; placeholder?: string; label?: string }) {
	const searching = props.value.trim().length > 0;
	return (
		<div className="flex items-center gap-3 border-b border-border-subtle bg-bg-muted px-4 py-2">
			<label className="relative block min-w-0 flex-1">
				<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
				<Input type="search" value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)} placeholder={props.placeholder ?? t("importList.searchPlaceholder")} aria-label={props.label ?? t("importList.searchLabel")} className="h-8 pl-8 text-xs" />
			</label>
			{searching && (
				<span className="shrink-0 text-xs text-text-tertiary" aria-live="polite">
					{t("importList.matched", { matched: props.matchedCount, total: props.totalCount })}
				</span>
			)}
		</div>
	);
}

/** 关键字没有命中任何会话时的空态：给出退出路径（清空搜索），不要只留一片空白。 */
export function ImportListNoMatch(props: { query: string; totalCount: number; onClear: () => void }) {
	return (
		<div className="grid min-h-60 place-content-center gap-2 text-center">
			<strong className="text-text-primary">{t("importList.noMatch", { query: props.query.trim() })}</strong>
			<span className="text-xs text-muted-foreground">{t("importList.noMatchHint", { total: props.totalCount })}</span>
			<Button type="button" variant="outline" size="sm" className="mx-auto h-7 gap-1.5 rounded-lg px-2.5 text-xs shadow-none" onClick={props.onClear}>
				{t("importList.clearSearch")}
			</Button>
		</div>
	);
}

/**
 * 增量渲染的页脚：哨兵进入视口即自动追加下一批，按钮是键盘/无障碍与滚动未触发时的兜底入口。
 * 全部渲染完则不渲染任何东西，避免列表末尾多出一行无信息噪音。
 */
export function ImportListWindowFooter(props: { sentinelRef: RefObject<HTMLDivElement | null>; visibleCount: number; totalCount: number; hasMore: boolean; onLoadMore: () => void }) {
	if (!props.hasMore) return null;
	return (
		<div ref={props.sentinelRef} className="flex items-center justify-center py-2">
			<Button type="button" variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={props.onLoadMore}>
				{t("importList.loadMore", { shown: props.visibleCount, total: props.totalCount })}
			</Button>
		</div>
	);
}
