import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { AppLogEntry, AppLogLevel } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Pagination } from "../../ui-shadcn/pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui-shadcn/table";
import { LogsDateRangePicker } from "./LogsDateRangePicker";

const LEVELS: Array<AppLogLevel | "all"> = ["all", "debug", "info", "warn", "error"];

/** 每页条数：主进程查询上限 200，20 一页保证详情展开/滚动可控 */
const PAGE_SIZE = 20;

function formatTime(time: number) {
	return new Date(time).toLocaleString();
}

function formatDetail(detail: unknown) {
	if (detail == null) return "";
	try {
		return JSON.stringify(detail, null, 2);
	} catch {
		return String(detail);
	}
}

/** 级别徽标配色（复用语义 token，与旧 log-level.* 一致：error 红/warn 黄/info 蓝/debug 灰） */
const LEVEL_CLASS: Record<AppLogLevel, string> = {
	debug: "text-text-tertiary",
	info: "text-info",
	warn: "text-warning",
	error: "text-danger",
};

/** 把本地时间输入（YYYY-MM-DDTHH:mm）转毫秒时间戳；空串返回 undefined */
function toTimestamp(value: string): number | undefined {
	return value ? new Date(value).getTime() : undefined;
}

/**
 * 应用日志查看器（由 Pi 管理界面「日志」tab 迁入设置）。
 * 只负责查看（级别/关键词/起止时间筛选 + table 分页 + 展开详情）；
 * 清除/打开文件夹由「缓存与日志」tab 的应用日志管理行承担。
 * 分页走 logs.listPage：过滤在服务端完成，任意时间范围的旧日志都能翻到
 * （旧 list 的 5000 行截断会导致选较早日期查不到）。
 *
 * @param props.refreshSignal 外部清空日志后递增的刷新信号：清空入口在「缓存与日志」管理行，
 *   查看器自身无从感知（清空只落一条审计行），不重查就会停在已删除的旧行上。
 */
export function LogViewer(props: { refreshSignal?: number }) {
	const [entries, setEntries] = useState<AppLogEntry[]>([]);
	const [total, setTotal] = useState(0);
	const [page, setPage] = useState(0);
	const [loading, setLoading] = useState(false);
	const [level, setLevel] = useState<AppLogLevel | "all">("all");
	const [search, setSearch] = useState("");
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const query = useMemo(
		() => ({
			level,
			search,
			from: toTimestamp(from),
			to: toTimestamp(to),
			page,
			pageSize: PAGE_SIZE,
		}),
		[level, search, from, to, page],
	);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await desktopApi.logs.listPage(query);
			setEntries(result.entries);
			setTotal(result.total);
			// 筛选变化后页码可能越界（如上一页数据全被筛掉），自动回退到最后一页
			if (result.entries.length === 0 && result.page > 0 && result.total > 0) {
				setPage(Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1));
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [query]);

	useEffect(() => {
		const timer = window.setTimeout(() => {
			void refresh();
		}, 150);
		return () => window.clearTimeout(timer);
		// refreshSignal 不是查询条件，而是「外部把日志清空了」的外部信号：只靠 query 变化感知不到清空
	}, [refresh, props.refreshSignal]);

	// 筛选条件变化时回到第一页（页码变化走 Pagination 回调，不在这里重置）
	const resetPage = useCallback(() => setPage(0), []);

	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

	return (
		<div className="logs-tab">
			{/* 工具栏（UI 2.0）：级别 + 搜索 + 起止时间 + 刷新，一行左对齐，窄时自动换行 */}
			<div className="mb-3.5 flex flex-wrap items-center gap-2">
				<Select
					value={level}
					onValueChange={(value) => {
						setLevel(value as AppLogLevel | "all");
						resetPage();
					}}
				>
					<SelectTrigger className="w-28" aria-label={t("logs.levelFilter")}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{LEVELS.map((item) => (
							<SelectItem key={item} value={item}>
								{t(`logs.level.${item}`)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Input
					className="w-64 max-w-full"
					value={search}
					onChange={(event) => {
						setSearch(event.target.value);
						resetPage();
					}}
					placeholder={t("logs.searchPlaceholder")}
				/>
				<LogsDateRangePicker
					from={from}
					to={to}
					onChange={(nextFrom, nextTo) => {
						setFrom(nextFrom);
						setTo(nextTo);
						resetPage();
					}}
				/>
				<Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
					{t("common.refresh")}
				</Button>
				{!loading && total > 0 && <span className="ml-auto text-caption text-muted-foreground tabular-nums">{t("logs.resultsCount", { count: String(total) })}</span>}
			</div>
			{error && <div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{error}</div>}
			{loading ? (
				<div className="flex items-center justify-center gap-2 py-12 text-control text-text-tertiary">
					<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
					{t("common.loading")}
				</div>
			) : entries.length === 0 ? (
				<div className="py-12 text-center text-control text-text-tertiary">{t("logs.empty")}</div>
			) : (
				<>
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<TableHead className="w-44">{t("logs.column.time")}</TableHead>
								<TableHead className="w-16">{t("logs.column.level")}</TableHead>
								<TableHead className="w-36">{t("logs.column.scope")}</TableHead>
								<TableHead>{t("logs.column.message")}</TableHead>
								<TableHead className="w-14">{t("logs.column.detail")}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{entries.map((entry) => {
								const expanded = expandedId === entry.id;
								return (
									<Fragment key={entry.id}>
										<TableRow className="cursor-pointer" onClick={() => setExpandedId(expanded ? null : entry.id)} data-state={expanded ? "selected" : undefined}>
											<TableCell className="text-caption text-text-secondary tabular-nums">{formatTime(entry.time)}</TableCell>
											<TableCell className={`text-caption font-medium uppercase ${LEVEL_CLASS[entry.level]}`}>{entry.level}</TableCell>
											<TableCell className="max-w-36 truncate text-caption text-text-secondary" title={entry.scope}>
												{entry.scope}
											</TableCell>
											<TableCell className="min-w-0 max-w-0 truncate whitespace-nowrap text-control text-text-primary" title={entry.message}>
												{entry.message}
											</TableCell>
											<TableCell className="text-right text-text-tertiary">{entry.detail != null ? "▸" : ""}</TableCell>
										</TableRow>
										{expanded && (
											<TableRow>
												<TableCell colSpan={5} className="whitespace-pre-wrap bg-[var(--color-code-bg)] font-mono text-caption text-[var(--color-code-text)] break-words">
													{formatDetail(entry.detail) || t("logs.noDetail")}
												</TableCell>
											</TableRow>
										)}
									</Fragment>
								);
							})}
						</TableBody>
					</Table>
					<Pagination page={page + 1} totalPages={totalPages} onPageChange={(p) => setPage(p - 1)} />
				</>
			)}
		</div>
	);
}
