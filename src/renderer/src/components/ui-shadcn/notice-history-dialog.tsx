import { Bell, Check, Copy, Eye, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { t } from "../../i18n";
import { replayNoticeEntry } from "../../utils/notice";
import { writeClipboard } from "../../utils/clipboard";
import { clearNoticeHistory, filterNoticeHistory, getNoticeHistorySnapshot, subscribeNoticeHistory, type NoticeHistoryEntry, type NoticeHistoryKind } from "../../utils/noticeHistory";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog";
import { Input } from "./input";
import { Pagination } from "./pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";
import { KIND_ICON, openNoticeDetails } from "./notice-toast";

/**
 * toast 通知历史弹窗：回看所有弹过的 toast，表格形态 + 级别筛选 + 关键词搜索 + 分页，
 * 每行可复制全文、重新弹出、查看未截断详情。
 * 数据源是 utils/noticeHistory 的进程级环形缓冲（showNotice 单点写入），
 * 因此不依赖任何 atom / props 链，整个应用只挂载一份（App 装配层），
 * 设置页与「通知详情」弹窗两个入口都通过 openNoticeHistoryDialog() 打开它。
 */

let historyDialogOpener: ((open: boolean) => void) | null = null;

/** 打开通知历史弹窗（App 未挂载完成时静默忽略）。 */
export function openNoticeHistoryDialog() {
	historyDialogOpener?.(true);
}

/** 每页条数：与日志查看器同档，缓冲上限 200 条时最多 10 页。 */
const PAGE_SIZE = 20;

/** 级别筛选选项：all + 全部档位（顺序与 KIND_ICON 一致，普通档排最后）。 */
const KIND_FILTERS: Array<NoticeHistoryKind | "all"> = ["all", "info", "warning", "error", "question", "neutral"];
/** Select 回传的是 string，用查表收窄回枚举（禁止 as 强转）。 */
const KIND_BY_VALUE: Record<string, NoticeHistoryKind | "all"> = Object.fromEntries(KIND_FILTERS.map((item): [string, NoticeHistoryKind | "all"] => [item, item]));

/** 历史条目的完整复制文本：与 toast 卡片一致「标题 + 换行 + 正文」（无描述时仅标题）。 */
function entryCopyText(entry: NoticeHistoryEntry): string {
	return entry.description ? `${entry.title}\n${entry.description}` : entry.title;
}

function formatEntryTime(timestamp: number): string {
	const date = new Date(timestamp);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 时长列：常驻档位与秒数分开表达，避免在表格里出现 Infinity。 */
function formatEntryDuration(entry: NoticeHistoryEntry): string {
	if (entry.duration === Number.POSITIVE_INFINITY) return t("notice.historySticky");
	return t("settings.toastDurationSeconds", { seconds: String(Math.round(entry.duration / 100) / 10) });
}

function HistoryRow({ entry }: { entry: NoticeHistoryEntry }) {
	const { Icon, className: iconColor } = KIND_ICON[entry.kind];
	const [copied, setCopied] = useState(false);
	const handleCopy = useCallback(async () => {
		const ok = await writeClipboard(entryCopyText(entry));
		if (!ok) return;
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1600);
	}, [entry]);
	return (
		<TableRow>
			<TableCell className="text-caption text-text-secondary tabular-nums">{formatEntryTime(entry.timestamp)}</TableCell>
			<TableCell>
				<span className={`inline-flex items-center gap-1.5 text-caption ${iconColor}`}>
					<Icon className="h-3.5 w-3.5 shrink-0" />
					{t(`notice.historyKind.${entry.kind}`)}
				</span>
			</TableCell>
			<TableCell className="max-w-0 truncate text-control text-text-primary" title={entry.title}>
				{entry.title}
			</TableCell>
			<TableCell className="max-w-0 truncate text-caption text-text-secondary" title={entry.description}>
				{entry.description ?? "—"}
			</TableCell>
			<TableCell className="text-caption text-text-tertiary tabular-nums">{formatEntryDuration(entry)}</TableCell>
			<TableCell>
				<div className="flex items-center justify-end gap-0.5">
					<button
						type="button"
						onClick={() => void handleCopy()}
						aria-label={copied ? t("copy.success") : t("common.copy")}
						title={copied ? t("copy.success") : t("common.copy")}
						className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
					>
						{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
					</button>
					{/* 详情走全局「通知详情」弹窗（同一宿主），长文本不挤占表格列宽 */}
					<button
						type="button"
						onClick={() => openNoticeDetails({ title: entry.title, description: entry.description, kind: entry.kind })}
						aria-label={t("notice.viewDetails")}
						title={t("notice.viewDetails")}
						className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
					>
						<Eye className="h-3.5 w-3.5" />
					</button>
					<button type="button" onClick={() => replayNoticeEntry(entry)} aria-label={t("notice.historyReplay")} title={t("notice.historyReplay")} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary">
						<RotateCcw className="h-3.5 w-3.5" />
					</button>
				</div>
			</TableCell>
		</TableRow>
	);
}

export function NoticeHistoryDialog() {
	const [open, setOpen] = useState(false);
	// 注册式打开入口：弹窗本体常驻 App 树，入口方只调函数不持状态
	useEffect(() => {
		historyDialogOpener = setOpen;
		return () => {
			historyDialogOpener = null;
		};
	}, []);
	const entries = useSyncExternalStore(subscribeNoticeHistory, getNoticeHistorySnapshot);
	const [search, setSearch] = useState("");
	const [kind, setKind] = useState<NoticeHistoryKind | "all">("all");
	const [page, setPage] = useState(1);

	const filtered = useMemo(() => filterNoticeHistory(entries, { search, kind }), [entries, search, kind]);
	const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
	// 筛选变窄或清空记录后当前页可能越界，渲染时夹住（不改 state，避免 effect 里 setState）
	const currentPage = Math.min(page, totalPages);
	const rows = useMemo(() => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE), [filtered, currentPage]);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="sm:max-w-[min(880px,calc(100vw-48px))]" data-notice-history-dialog>
				<DialogHeader>
					<DialogTitle>{t("notice.historyTitle")}</DialogTitle>
					<DialogDescription>{t("notice.historyDesc")}</DialogDescription>
				</DialogHeader>

				{/* 工具栏：级别筛选 + 关键词搜索 + 命中数 + 清空（与日志查看器同一布局习惯） */}
				<div className="flex flex-wrap items-center gap-2">
					<Select
						value={kind}
						onValueChange={(value) => {
							const next = KIND_BY_VALUE[value];
							if (!next) return;
							setKind(next);
							setPage(1);
						}}
					>
						<SelectTrigger className="w-32" aria-label={t("notice.historyKindFilter")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{KIND_FILTERS.map((item) => (
								<SelectItem key={item} value={item}>
									{item === "all" ? t("notice.historyKindAll") : t(`notice.historyKind.${item}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Input
						className="w-64 max-w-full"
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setPage(1);
						}}
						placeholder={t("notice.historySearchPlaceholder")}
					/>
					{filtered.length > 0 ? <span className="ml-auto text-caption text-text-tertiary tabular-nums">{t("notice.historyResults", { count: String(filtered.length) })}</span> : null}
					{entries.length > 0 ? (
						<Button type="button" variant="outline" size="sm" onClick={clearNoticeHistory}>
							<Trash2 className="h-3.5 w-3.5" />
							{t("notice.historyClear")}
						</Button>
					) : null}
				</div>

				{entries.length === 0 ? (
					<div className="flex flex-col items-center gap-2 py-10 text-text-tertiary">
						<Bell className="h-6 w-6" />
						<p className="text-xs">{t("notice.historyEmpty")}</p>
					</div>
				) : filtered.length === 0 ? (
					<div className="py-10 text-center text-control text-text-tertiary">{t("notice.historyNoMatch")}</div>
				) : (
					<>
						{/* 表格限高滚动：横向溢出由 Table 自带的 overflow-x-auto 容器负责 */}
						<div className="max-h-[46vh] overflow-y-auto pr-1 select-text">
							<Table>
								<TableHeader>
									<TableRow className="hover:bg-transparent">
										<TableHead className="w-40">{t("notice.historyColumn.time")}</TableHead>
										<TableHead className="w-24">{t("notice.historyColumn.kind")}</TableHead>
										<TableHead>{t("notice.historyColumn.title")}</TableHead>
										<TableHead>{t("notice.historyColumn.detail")}</TableHead>
										<TableHead className="w-16">{t("notice.historyColumn.duration")}</TableHead>
										<TableHead className="w-24 text-right">{t("notice.historyColumn.actions")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rows.map((entry) => (
										<HistoryRow key={entry.id} entry={entry} />
									))}
								</TableBody>
							</Table>
						</div>
						<Pagination page={currentPage} totalPages={totalPages} onPageChange={setPage} className="pt-0" />
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
