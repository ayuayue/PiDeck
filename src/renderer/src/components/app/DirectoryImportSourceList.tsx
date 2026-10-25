import { ChevronRight, FolderOpen } from "lucide-react";
import { useRef } from "react";
import type { DirectorySessionSourceDir } from "../../../../shared/types";
import { useImportSessionFilter } from "../../hooks/useImportSessionFilter";
import { useLazyListWindow } from "../../hooks/useLazyListWindow";
import { t } from "../../i18n";
import { buildImportSearchHaystack, formatImportSearchTime } from "../../utils/importSessionList";
import { formatRelativeTime } from "../../utils/relativeTime";
import { Button } from "../ui-shadcn/button";
import { ImportListNoMatch, ImportListSearchRow, ImportListWindowFooter } from "./ImportListControls";

/** 末两段路径（与 ImportModals.displayPath 同策略），避免弹窗里铺满长路径。 */
function compactPath(path: string) {
	const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts.length <= 2 ? path : `.../${parts.slice(-2).join("/")}`;
}

/** pi 分组目录名（形如 `--D--work-old--`）：次要信息，标出磁盘上到底是哪个目录。 */
function groupFolderName(dir: string) {
	const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts[parts.length - 1] ?? dir;
}

/**
 * 目录卡片的搜索索引：完整工作目录（任意一段路径都能命中）、编码分组目录名、会话数、
 * 最近使用时间（本地 YYYY-MM-DD，可搜 "2026-09"）。
 * 只建一次索引，敲键时仅做子串判定——目录数量可能上百，逐键重新格式化不划算。
 */
function buildSourceHaystack(source: DirectorySessionSourceDir) {
	return buildImportSearchHaystack([source.projectPath, source.dir, source.sessionCount, formatImportSearchTime(source.lastUsedAt)]);
}

export type DirectoryImportSourceListProps = {
	/** 现有会话目录（主进程扫描器给出，只含真的有会话的分组目录） */
	sources: DirectorySessionSourceDir[];
	loading: boolean;
	/** 点选某个分组目录：立即扫描该目录下的会话 */
	onPick: (dir: string) => void;
	/** 列表覆盖不到时的手选目录出口（旧项目目录、sessions 根等） */
	onChooseManually: () => void;
};

/** 一张目录卡片：整卡可点（按钮语义，Enter/空格同样触发），不是勾选行。 */
function DirectoryImportSourceRow(props: { source: DirectorySessionSourceDir; onPick: (dir: string) => void }) {
	const { source } = props;
	return (
		<button type="button" className="group flex w-full items-start gap-3 rounded-lg border border-border-subtle bg-bg-panel px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-accent" onClick={() => props.onPick(source.dir)} title={source.dir}>
			<FolderOpen size={15} className="mt-0.5 shrink-0 text-text-tertiary transition-colors group-hover:text-primary" aria-hidden="true" />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-center gap-2">
					<strong className="truncate text-control font-semibold text-text-primary">{source.projectPath ? compactPath(source.projectPath) : t("directoryImport.originUnknown")}</strong>
					{!source.projectPathExists && <span className="codex-status outdated shrink-0">{t("directoryImport.originMissing")}</span>}
				</span>
				<span className="truncate text-caption tabular-nums text-text-secondary">
					{t("directoryImport.sourceMeta", {
						count: source.sessionCount,
						time: formatRelativeTime(source.lastUsedAt),
					})}
				</span>
				<span className="truncate font-mono text-micro text-text-faint">{groupFolderName(source.dir)}</span>
			</span>
			<ChevronRight size={14} className="mt-0.5 shrink-0 text-text-faint transition-colors group-hover:text-primary" aria-hidden="true" />
		</button>
	);
}

/**
 * 「导入其他目录的会话」首屏：列出 pi 现有会话目录供点选。
 *
 * 为什么要有这一屏：pi 的会话目录名是编码形式（`--D--work-old--`），用户既认不出，
 * 也很容易手选到 `~/.pi` 这类祖先目录 —— 那样扫出来必然是 0 条，看起来像「功能坏了」。
 * 这里把编码名解码回原工作目录、只保留真有会话的目录，点选即必有结果；
 * 需要旧项目目录本身这类场景再走「选择其他目录…」手选。
 *
 * 列表带搜索与增量渲染（首屏 40 行，滚到底再追加）：目录可能上百条。
 * 这里自带滚动容器，让搜索行常驻在列表之上，同时保证哨兵观察的正是真正的滚动区。
 */
export function DirectoryImportSourceList(props: DirectoryImportSourceListProps) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const filter = useImportSessionFilter(props.sources, buildSourceHaystack);
	const listWindow = useLazyListWindow(filter.matched, { scrollRef });

	if (props.loading && props.sources.length === 0) {
		return (
			<div className="history-loading">
				<div className="loader animate-pideck-spin" />
				<span>{t("common.loading")}</span>
			</div>
		);
	}

	// 一条目录都没有：搜索无意义，直接给空态与手选出口。
	if (props.sources.length === 0) {
		return (
			<div className="codex-import-empty">
				<strong>{t("directoryImport.sourceListEmpty")}</strong>
				<span>{t("directoryImport.sourceListEmptyDesc")}</span>
				<Button variant="outline" size="sm" className="mt-2 h-7 gap-1.5 rounded-lg px-2.5 text-xs shadow-none" onClick={props.onChooseManually}>
					<FolderOpen size={14} />
					{t("directoryImport.chooseDirectory")}
				</Button>
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 弹窗在 bodyOverride 场景下去掉了 body 内边距，所以搜索行与列表由本组件自己管（搜索行全宽贴着工具栏）。 */}
			<ImportListSearchRow value={filter.query} onChange={filter.setQuery} matchedCount={filter.matched.length} totalCount={filter.totalCount} placeholder={t("directoryImport.searchPlaceholder")} label={t("directoryImport.searchLabel")} />
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-3">
				{filter.isSearching && filter.matched.length === 0 ? (
					<ImportListNoMatch query={filter.query} totalCount={filter.totalCount} onClear={filter.clearQuery} />
				) : (
					<div className="codex-session-list">
						{listWindow.visible.map((source) => (
							<DirectoryImportSourceRow key={source.dir} source={source} onPick={props.onPick} />
						))}
						<ImportListWindowFooter sentinelRef={listWindow.sentinelRef} visibleCount={listWindow.visibleCount} totalCount={listWindow.totalCount} hasMore={listWindow.hasMore} onLoadMore={listWindow.loadMore} />
					</div>
				)}
			</div>
		</div>
	);
}
