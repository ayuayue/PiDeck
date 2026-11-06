/**
 * 「记忆」tab 的条目浏览器：把 Markdown 真值逐条列出来，可展开看全文、可删除单条或批量删除。
 *
 * 只读 + 删除。为什么不做编辑：改写一条记忆的语义（去重键、预算裁剪、墓碑）
 * 全在工具层（`memory_add/replace/remove`），设置页做一份编辑器就等于把那些规则抄第二遍；
 * 想改内容就让 Agent 改，想改措辞就删掉再说一遍。
 *
 * 形态：**表格式列表**（`ui-shadcn/table` + 卡片外壳），与「进程与内存监控」等设置面板同一套视觉。
 * 卡片顶部按类型分两个 tab（记忆 / 教训），下面是工具栏（搜索 + 计数 + 批量删除 + 手动刷新）、表格与分页。
 * 批量删除进入后行首出现勾选框：勾选跨页保留，删除走一次 IPC（主进程按文件分组落盘），
 * 删完同样给撤销。
 * 列为内容 / 记录于 / 字数 / 删除；时间来自记忆索引（Markdown 真值不存时间戳），
 * 所以工具栏留了一个刷新按钮：Agent 在会话里刚写下的记忆不会主动推到这里。
 * 所有作用域按记录时间混排成一条列表，行首徽标标明全局 / 项目 / 本机设备——早期在时间线里
 * 插「分组行」时，同一组的条目被别组隔开就会反复出现同样的表头（一屏好几个「全局 通用记忆
 * MEMORY.md」）。落盘文件与预算收进徽标的 title，超预算另给一个短徽标。
 *
 * 为什么分 tab + 分页（2026-11 真机）：四种 target 混在一张表里时，教训条目排在
 * 「全局记忆 → 用户偏好」之后，再往下还有每个项目的记忆组——想看教训只能一路滚到底；
 * 真实记忆目录约 200+ 条，一屏表格滚起来也找不到位置。分 tab 后每个 tab 只装一类，
 * 分页把单页压到 20 条（与日志页一致）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Brain, ChevronDown, ChevronRight, ListChecks, RefreshCw, RotateCcw, Search, SearchX, Trash2 } from "lucide-react";
import type { AgentMemoryEntry, AgentMemoryEntryGroup, AgentMemoryEntryList } from "../../../../../shared/types/agentMemory";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Badge } from "../../ui-shadcn/badge";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui-shadcn/table";
import { Pagination } from "../../ui-shadcn/pagination";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui-shadcn/tabs";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { describeAgentMemoryCode, memoryGroupScopeLabel, memoryTargetLabel } from "./agentMemoryLabels";
import { MEMORY_PAGE_SIZE, buildMemoryPageEntries, memoryEntryId, memoryTotalPages } from "./agentMemoryPaging";
import { formatFullDateTime, formatRelativeTime } from "../../../utils/relativeTime";

/** tab 与 target 的归属：用户偏好也是「记忆」，只有失败教训单独一类。 */
const KIND_TARGETS = {
	memory: ["memory", "user"],
	failure: ["failure"],
} as const;
type EntryKind = keyof typeof KIND_TARGETS;

/** 行首作用域徽标：项目没有可读名字时带短键，避免一长串目录键挤掉内容。 */
function entryScopeBadge(group: AgentMemoryEntryGroup): string {
	if (group.scope === "global") return t("settings.agentMemoryScopeGlobal");
	if (group.scope === "device") return t("settings.agentMemoryScopeDeviceShort");
	if (group.projectName) return group.projectName;
	const shortId = group.projectId.replace(/^device:/, "").slice(0, 8);
	return shortId ? t("settings.agentMemoryScopeProjectId", { id: shortId }) : t("settings.agentMemoryScopeProject");
}

/** 徽标 title：完整作用域 + 目标 + 落盘文件 + 该文件预算（原先分组行承担的信息）。 */
function entryScopeTitle(group: AgentMemoryEntryGroup): string {
	const budget = group.budget
		? t("settings.agentMemoryGroupBudget", { count: String(group.entries.length), chars: String(group.chars), maxChars: String(group.budget.maxChars), maxEntries: String(group.budget.maxEntries) })
		: t("settings.agentMemoryGroupPlain", { count: String(group.entries.length), chars: String(group.chars) });
	return [memoryGroupScopeLabel(group), `${memoryTargetLabel(group.target)} · ${group.file}`, budget, group.overBudget ? t("settings.agentMemoryGroupOverBudget") : ""].filter(Boolean).join("\n");
}

/**
 * 条目时间格：相对时间（刚刚 / n 分钟 / n 天），title 给精确时刻。
 * 时间来自记忆索引，索引不可用、或这条还没被索引过时留破折号——不编造时间。
 */
function EntryTimeCell({ value }: { value?: string }) {
	const ms = value ? Date.parse(value) : Number.NaN;
	if (Number.isNaN(ms)) {
		return (
			<TableCell className="text-right text-caption text-muted-foreground" title={t("settings.agentMemoryTableUpdatedUnknown")}>
				—
			</TableCell>
		);
	}
	return (
		<TableCell className="text-right text-caption tabular-nums text-muted-foreground" title={formatFullDateTime(ms)}>
			{formatRelativeTime(ms)}
		</TableCell>
	);
}

/** 撤销条只给一行提示：取首行并截断到 80 字，整段内容在表格里已经看过了。 */
function firstLinePreview(content: string): string {
	const line = content.split("\n")[0];
	return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

export function AgentMemoryEntryList(props: {
	/** 兄弟面板（导出/导入/清空索引）改过记忆后 +1。 */
	reloadKey?: number;
	/** 本面板删过条目后通知兄弟面板刷新统计。 */
	onChanged?: () => void;
}) {
	const [data, setData] = useState<AgentMemoryEntryList | null>(null);
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [busyKey, setBusyKey] = useState<string | null>(null);
	const [pending, setPending] = useState<AgentMemoryEntry | null>(null);
	/** 刚删掉、还来得及撤销的条目（单条或整批）：拿着它们把内容原样写回并回收墓碑。 */
	const [deleted, setDeleted] = useState<AgentMemoryEntry[] | null>(null);
	const [restoring, setRestoring] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** 批量选择模式：工具栏「批量删除」进入，行首出现勾选框，选中项由工具栏下方的选择栏统一删除。 */
	const [selecting, setSelecting] = useState(false);
	/** 勾选只存条目 id：刷新/删条后已经不在磁盘上的键自动从计数与删除清单里消失。 */
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const [pendingBatch, setPendingBatch] = useState<AgentMemoryEntry[] | null>(null);
	const [deleting, setDeleting] = useState(false);
	/** 记忆 / 教训两个 tab：四种 target 混排时教训总被挤到列表底部。 */
	const [kind, setKind] = useState<EntryKind>("memory");
	const [page, setPage] = useState(1);
	/** 手动刷新中：Agent 在会话里写了记忆后，页面不会自己知道。 */
	const [refreshing, setRefreshing] = useState(false);

	const refresh = useCallback(async () => {
		const result = await desktopApi.agentMemory.list();
		if (result.ok) {
			setData(result.value);
			setError(null);
		} else setError(describeAgentMemoryCode(result.code));
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh, props.reloadKey]);

	const runRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await refresh();
		} finally {
			setRefreshing(false);
		}
	}, [refresh]);

	const needle = query.trim().toLowerCase();
	// 过滤在渲染层做：记忆总量有预算封顶（几万字），一次全量拿到前端比每条搜索都往主进程跑一次稳。
	// 先按 tab 取本类（记忆 = memory + user，教训 = failure），再套搜索词。
	const kindGroups = useMemo(() => {
		if (!data) return [];
		const targets: readonly string[] = KIND_TARGETS[kind];
		return data.groups.filter((group) => targets.includes(group.target));
	}, [data, kind]);
	const groups = useMemo(() => {
		if (!needle) return kindGroups;
		return kindGroups
			.map((group) => ({
				...group,
				entries: group.entries.filter((entry) => `${entry.content}\n${memoryTargetLabel(entry.target)}\n${memoryGroupScopeLabel(group)}\n${entry.source === "auto-learn" ? t("settings.agentMemorySourceAutoLearn") : ""}`.toLowerCase().includes(needle)),
			}))
			.filter((group) => group.entries.length > 0);
	}, [kindGroups, needle]);
	const countOf = useCallback((targets: readonly string[]) => (data ? data.groups.filter((group) => targets.includes(group.target)).reduce((sum, group) => sum + group.entries.length, 0) : 0), [data]);
	const kindTotal = countOf(KIND_TARGETS[kind]);
	const shown = groups.reduce((sum, group) => sum + group.entries.length, 0);
	// 页码状态保留「用户点过的页」，越界（删条目/切 tab/搜索后变短）时由分页函数夹住，不另写重置逻辑。
	const totalPages = memoryTotalPages(shown, MEMORY_PAGE_SIZE);
	const currentPage = Math.min(page, totalPages);
	const pageEntries = useMemo(() => buildMemoryPageEntries(groups, currentPage), [groups, currentPage]);
	const byId = useMemo(() => {
		const map = new Map<string, AgentMemoryEntry>();
		for (const group of data?.groups ?? []) for (const entry of group.entries) map.set(memoryEntryId(entry), entry);
		return map;
	}, [data]);
	// 选中项从全量数据里回填：翻页、搜索、切 tab 都不会丢勾选，也不存在「拿着已消失的键去删」。
	const selectedEntries = useMemo(() => [...selected].flatMap((id) => { const entry = byId.get(id); return entry ? [entry] : []; }), [selected, byId]);
	const pageIds = useMemo(() => pageEntries.map((row) => row.key), [pageEntries]);
	const pagePicked = pageIds.filter((id) => selected.has(id)).length;
	const pageAll = pageIds.length > 0 && pagePicked === pageIds.length;

	const togglePage = () => {
		setSelected((current) => {
			const next = new Set(current);
			for (const id of pageIds) {
				if (pageAll) next.delete(id);
				else next.add(id);
			}
			return next;
		});
	};

	const toggleEntry = (id: string) => {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const runDelete = async () => {
		const entry = pending;
		setPending(null);
		if (!entry) return;
		setBusyKey(memoryEntryId(entry));
		setError(null);
		try {
			const result = await desktopApi.agentMemory.deleteEntry({ target: entry.target, projectId: entry.projectId, key: entry.key });
			if (!result.ok) setError(describeAgentMemoryCode(result.code));
			else {
				setDeleted([entry]);
				await refresh();
				props.onChanged?.();
			}
		} finally {
			setBusyKey(null);
		}
	};

	const runRestore = async () => {
		const entries = deleted;
		setDeleted(null);
		if (!entries || entries.length === 0) return;
		setRestoring(true);
		setError(null);
		try {
			// 逐条写回：每条都是主进程里「addMemory + 回收墓碑」的原子动作，批量撤销只是重复它。
			const failed: AgentMemoryEntry[] = [];
			let firstError: string | null = null;
			for (const entry of entries) {
				const result = await desktopApi.agentMemory.restoreEntry({ target: entry.target, projectId: entry.projectId, content: entry.content, category: entry.category || undefined });
				if (!result.ok) {
					failed.push(entry);
					firstError ??= describeAgentMemoryCode(result.code);
				}
			}
			// 写回失败的留在条上，用户还能再点一次撤销，不用重新去那页找。
			if (failed.length > 0) {
				setDeleted(failed);
				setError(firstError);
			}
			await refresh();
			props.onChanged?.();
		} finally {
			setRestoring(false);
		}
	};

	const runBatchDelete = async () => {
		const entries = pendingBatch;
		const refs = entries?.map((entry) => ({ target: entry.target, projectId: entry.projectId, key: entry.key })) ?? [];
		setPendingBatch(null);
		if (!entries || refs.length === 0) return;
		setDeleting(true);
		setError(null);
		try {
			// 一次 IPC：主进程按文件分组，同一份记忆文件只读写一遍，不会因为勾了 20 条就重写 20 次。
			const result = await desktopApi.agentMemory.deleteEntries(refs);
			if (!result.ok) setError(describeAgentMemoryCode(result.code));
			else {
				setDeleted(entries);
				setSelected(new Set());
				setSelecting(false);
				await refresh();
				props.onChanged?.();
			}
		} finally {
			setDeleting(false);
		}
	};

	// 表格四种状态：加载中 / 完全空 / 过滤无匹配 / 有数据。前三种各自占一行跨度撑满表格，避免出现「空表格骨头」。
	const emptyKind = !data ? "loading" : kindTotal === 0 ? "empty" : shown === 0 ? "nomatch" : null;

	return (
		<div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-panel">
			<Tabs value={kind} onValueChange={(value) => { setKind(value === "failure" ? "failure" : "memory"); /* 换 tab 等于换一批条目：勾选清掉，避免把另一类的条目一起删掉。 */ setSelected(new Set()); }} className="gap-0">
				{/* 类型切换：记忆（memory + user）/ 教训（failure）。四种 target 混排时教训永远排在列表底部。 */}
				<TabsList variant="line" className="px-2" aria-label={t("settings.agentMemoryKindLabel")}>
					<TabsTrigger variant="line" value="memory">
						{t("settings.agentMemoryTabMemory")}
						<span className="text-micro tabular-nums opacity-60">{countOf(KIND_TARGETS.memory)}</span>
					</TabsTrigger>
					<TabsTrigger variant="line" value="failure">
						{t("settings.agentMemoryTabFailure")}
						<span className="text-micro tabular-nums opacity-60">{countOf(KIND_TARGETS.failure)}</span>
					</TabsTrigger>
				</TabsList>
				<TabsContent value={kind} className="mt-0">
					{/* 工具栏：搜索框 + 计数。与「进程与内存监控」表格同一套像素（border-b + px-3 py-2）。 */}
					<div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
						<div className="relative w-full max-w-xs">
							<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
							<Input
								size="sm"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Escape" && query) setQuery("");
								}}
								placeholder={t("settings.agentMemorySearchPlaceholder")}
								aria-label={t("settings.agentMemorySearchPlaceholder")}
								className="pl-8"
							/>
						</div>
						{/* 计数只在搜索时出现：不搜索时 tab 上的角标就是本类总数，再写一遍只是噪音；分页信息由分页条自己给。 */}
						<span className="ml-auto shrink-0 text-micro tabular-nums text-muted-foreground">{!data ? t("common.loading") : needle ? t("settings.agentMemoryEntriesCount", { shown: String(shown), total: String(kindTotal) }) : null}</span>
						{/* 批量删除入口：与刷新同档图标按钮；进入后行首出现勾选框，选中项在下面的选择栏里统一删除。 */}
						<Button type="button" variant={selecting ? "secondary" : "ghost"} size="icon-sm" aria-pressed={selecting} aria-label={t("settings.agentMemoryBatchDelete")} title={t("settings.agentMemoryBatchDelete")} disabled={shown === 0} onClick={() => { setSelecting((value) => !value); setSelected(new Set()); }}>
							<ListChecks size={13} aria-hidden="true" />
						</Button>
						{/* 手动刷新：条目真值在磁盘上，Agent 在会话里刚写下的记忆不会推到这里（只有兄弟面板改动会 +1 reloadKey）。 */}
						<Button type="button" variant="ghost" size="icon-sm" aria-label={t("settings.agentMemoryRefresh")} title={t("settings.agentMemoryRefresh")} disabled={refreshing} onClick={() => void runRefresh()}>
							<RefreshCw size={13} className={refreshing ? "animate-pideck-spin" : undefined} aria-hidden="true" />
						</Button>
					</div>

					{error ? <p className="border-b border-border-subtle px-3 py-2 text-control text-destructive">{error}</p> : null}

					{/* 选择栏：勾选可以跨页（翻页不清空），删除前在这里给出总数与「全选本页」的开关。 */}
					{selecting ? (
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-subtle bg-bg-muted px-3 py-1.5">
							<span className="text-caption tabular-nums text-foreground">{t("settings.agentMemoryBatchSelected", { count: String(selectedEntries.length) })}</span>
							<Button type="button" variant="ghost" size="xs" disabled={pageIds.length === 0} onClick={togglePage}>
								{pageAll ? t("settings.agentMemoryBatchUnselectPage") : t("settings.agentMemoryBatchSelectPage")}
							</Button>
							{selectedEntries.length > 0 ? (
								<Button type="button" variant="ghost" size="xs" onClick={() => setSelected(new Set())}>
									{t("settings.agentMemoryBatchClear")}
								</Button>
							) : null}
							<span className="ml-auto flex items-center gap-2">
								<Button type="button" variant="ghost" size="xs" onClick={() => { setSelecting(false); setSelected(new Set()); }}>
									{t("common.cancel")}
								</Button>
								<Button type="button" variant="destructive" size="xs" disabled={selectedEntries.length === 0 || deleting} onClick={() => setPendingBatch(selectedEntries)}>
									<Trash2 size={12} aria-hidden="true" />
									{t("settings.agentMemoryBatchDeleteAction")}
								</Button>
							</span>
						</div>
					) : null}

					{deleted && deleted.length > 0 ? (
						<div className="flex items-center gap-2 border-b border-border-subtle bg-bg-muted px-3 py-2">
							<span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{deleted.length === 1 ? t("settings.agentMemoryDeletedEntry", { content: firstLinePreview(deleted[0].content) }) : t("settings.agentMemoryDeletedEntries", { count: String(deleted.length) })}</span>
							<Button type="button" variant="ghost" size="sm" disabled={restoring} onClick={() => void runRestore()}>
								<RotateCcw size={13} aria-hidden="true" />
								{t("settings.agentMemoryUndoDelete")}
							</Button>
						</div>
					) : null}

					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								{selecting ? (
									<TableHead className="w-10">
										<Checkbox checked={pageAll ? true : pagePicked > 0 ? "indeterminate" : false} onCheckedChange={togglePage} disabled={pageIds.length === 0} aria-label={t("settings.agentMemoryBatchSelectPage")} />
									</TableHead>
								) : null}
								<TableHead>{t("settings.agentMemoryTableContent")}</TableHead>
								<TableHead className="w-20 text-right" title={t("settings.agentMemoryTableUpdatedHint")}>
									{t("settings.agentMemoryTableUpdated")}
								</TableHead>
								<TableHead className="w-16 text-right">{t("settings.agentMemoryTableChars")}</TableHead>
								<TableHead className="w-12" aria-label={t("settings.agentMemoryTableActions")} />
							</TableRow>
						</TableHeader>
						<TableBody>
							{emptyKind ? (
								<TableRow className="hover:bg-transparent">
									<TableCell colSpan={selecting ? 5 : 4} className="whitespace-normal">
										<div className="flex flex-col items-center gap-2 py-8 text-center">
											<span className="flex size-9 items-center justify-center rounded-full bg-bg-muted text-muted-foreground">{emptyKind === "nomatch" ? <SearchX size={16} aria-hidden="true" /> : <Brain size={16} aria-hidden="true" />}</span>
											<p className="max-w-sm text-caption leading-relaxed text-muted-foreground">{emptyKind === "loading" ? t("common.loading") : emptyKind === "empty" ? t(kind === "failure" ? "settings.agentMemoryEmptyFailure" : "settings.agentMemoryEmpty") : t("settings.agentMemoryNoMatch")}</p>
											{emptyKind === "nomatch" ? (
												<Button type="button" variant="ghost" size="sm" onClick={() => setQuery("")}>
													{t("settings.agentMemorySearchClear")}
												</Button>
											) : null}
										</div>
									</TableCell>
								</TableRow>
							) : null}
							{pageEntries.map((row) => (
								<TableRow key={row.key} data-state={selected.has(row.key) || expanded[row.key] === true ? "selected" : undefined}>
									{/* 勾选框独占一列：点它不会触发行内容那块的展开按钮。 */}
									{selecting ? (
										<TableCell className="w-10">
											<Checkbox checked={selected.has(row.key)} onCheckedChange={() => toggleEntry(row.key)} aria-label={t("settings.agentMemoryBatchSelectRow")} />
										</TableCell>
									) : null}
									<TableCell className="max-w-0 whitespace-normal">
										{/* 折叠态单行省略，展开后整段铺开：记忆条目是纯文本，首行通常就是结论。 */}
										<button type="button" className="flex w-full items-start gap-1.5 text-left text-control text-foreground focus-visible:outline-none" aria-expanded={expanded[row.key] === true} onClick={() => setExpanded((current) => ({ ...current, [row.key]: current[row.key] !== true }))}>
											<span className="mt-0.5 shrink-0 text-muted-foreground">{expanded[row.key] === true ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}</span>
											{/* 作用域徽标替代分组行：整页一条时间线，靠这一格区分全局 / 项目 / 设备；文件与预算进 title。 */}
											<Badge variant="neutral" size="sm" className="mt-px max-w-40" title={entryScopeTitle(row.group)}>
												<span className="min-w-0 truncate">{entryScopeBadge(row.group)}</span>
											</Badge>
											{/* 记忆 tab 混装通用记忆与用户偏好：目标不是默认的 memory 时补一个标签，避免两类内容看起来一样。 */}
											{row.group.target === "user" ? (
												<Badge variant="outline" size="sm" className="mt-px">
													{t("settings.agentMemoryTargetUser")}
												</Badge>
											) : null}
											{row.group.overBudget ? (
												<Badge variant="danger" size="sm" className="mt-px gap-1" title={t("settings.agentMemoryGroupOverBudget")}>
													<AlertTriangle size={10} aria-hidden="true" />
													{t("settings.agentMemoryGroupOverBudgetShort")}
												</Badge>
											) : null}
											{row.entry.source === "auto-learn" ? (
												<Badge variant="secondary" size="sm" className="mt-px">
													{t("settings.agentMemorySourceAutoLearn")}
												</Badge>
											) : null}
											<span className={expanded[row.key] === true ? "min-w-0 whitespace-pre-wrap break-words" : "min-w-0 truncate"}>{expanded[row.key] === true ? row.entry.content : row.entry.content.split("\n")[0]}</span>
										</button>
									</TableCell>
									<EntryTimeCell value={row.entry.updatedAt} />
									<TableCell className="text-right text-caption tabular-nums text-muted-foreground">{row.entry.chars}</TableCell>
									<TableCell>
										<Button type="button" variant="ghost" size="icon-sm" aria-label={t("settings.agentMemoryDeleteEntry")} disabled={busyKey === row.key} onClick={() => setPending(row.entry)} className="text-muted-foreground hover:text-destructive">
											<Trash2 size={13} aria-hidden="true" />
										</Button>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>

					{/* 分页放在卡片底部：条目总量有预算上限，单页 20 条足够，不做内部滚动区（会与表格吸顶表头打架）。 */}
					{totalPages > 1 ? (
						<div className="border-t border-border-subtle px-3">
							<Pagination page={currentPage} totalPages={totalPages} onPageChange={setPage} className="py-2" />
						</div>
					) : null}
				</TabsContent>
			</Tabs>

			{pending ? (
				<ConfirmDialog
					title={t("settings.agentMemoryDeleteEntry")}
					message={t("settings.agentMemoryDeleteEntryConfirm", { content: pending.content.length > 160 ? `${pending.content.slice(0, 160)}…` : pending.content })}
					confirmLabel={t("settings.agentMemoryDeleteEntry")}
					danger
					onConfirm={() => void runDelete()}
					onCancel={() => setPending(null)}
				/>
			) : null}

			{pendingBatch ? (
				<ConfirmDialog
					title={t("settings.agentMemoryBatchDeleteTitle")}
					message={t("settings.agentMemoryBatchConfirm", { count: String(pendingBatch.length) })}
					confirmLabel={t("settings.agentMemoryBatchDeleteAction")}
					danger
					onConfirm={() => void runBatchDelete()}
					onCancel={() => setPendingBatch(null)}
				/>
			) : null}
		</div>
	);
}
