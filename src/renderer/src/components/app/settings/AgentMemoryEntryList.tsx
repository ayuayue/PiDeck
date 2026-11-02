/**
 * 「记忆」tab 的条目浏览器：把 Markdown 真值逐条列出来，可展开看全文、可删除单条。
 *
 * 只读 + 删除。为什么不做编辑：改写一条记忆的语义（去重键、预算裁剪、墓碑）
 * 全在工具层（`memory_add/replace/remove`），设置页做一份编辑器就等于把那些规则抄第二遍；
 * 想改内容就让 Agent 改，想改措辞就删掉再说一遍。
 *
 * 形态：**表格式列表**（`ui-shadcn/table` + 卡片外壳），与「进程与内存监控」等设置面板同一套视觉：
 * 卡片头部放搜索框与计数，下面是可以滚动的表格，表头吸顶。分组不再靠嵌套小节，而是在表格里
 * 插一条跨列的分组行（作用域 + 落盘文件 + 预算）——既保留「这条记忆在哪个文件里」这个关键信息，
 * 又不会把列表拆成几坨各自的边框。
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Brain, ChevronDown, ChevronRight, RotateCcw, Search, SearchX, Trash2 } from "lucide-react";
import type { AgentMemoryEntry, AgentMemoryEntryList } from "../../../../../shared/types/agentMemory";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui-shadcn/table";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";
import { describeAgentMemoryCode, memoryGroupScopeLabel, memoryTargetLabel } from "./agentMemoryLabels";

/** 条目身份：同一段内容可能同时存在于全局与项目作用域，所以键里必须带作用域。 */
function entryId(entry: AgentMemoryEntry): string {
	return `${entry.scope}|${entry.projectId}|${entry.target}|${entry.key}`;
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
	/** 刚删掉、还来得及撤销的那条：拿着它把内容原样写回并回收墓碑。 */
	const [deleted, setDeleted] = useState<AgentMemoryEntry | null>(null);
	const [restoring, setRestoring] = useState(false);
	const [error, setError] = useState<string | null>(null);

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

	const needle = query.trim().toLowerCase();
	// 过滤在渲染层做：记忆总量有预算封顶（几万字），一次全量拿到前端比每条搜索都往主进程跑一次稳。
	const groups = useMemo(() => {
		if (!data) return [];
		if (!needle) return data.groups;
		return data.groups
			.map((group) => ({
				...group,
				entries: group.entries.filter((entry) => `${entry.content}\n${memoryTargetLabel(entry.target)}\n${memoryGroupScopeLabel(group)}`.toLowerCase().includes(needle)),
			}))
			.filter((group) => group.entries.length > 0);
	}, [data, needle]);
	const shown = groups.reduce((sum, group) => sum + group.entries.length, 0);

	const runDelete = async () => {
		const entry = pending;
		setPending(null);
		if (!entry) return;
		setBusyKey(entryId(entry));
		setError(null);
		try {
			const result = await desktopApi.agentMemory.deleteEntry({ target: entry.target, projectId: entry.projectId, key: entry.key });
			if (!result.ok) setError(describeAgentMemoryCode(result.code));
			else {
				setDeleted(entry);
				await refresh();
				props.onChanged?.();
			}
		} finally {
			setBusyKey(null);
		}
	};

	const runRestore = async () => {
		const entry = deleted;
		setDeleted(null);
		if (!entry) return;
		setRestoring(true);
		setError(null);
		try {
			const result = await desktopApi.agentMemory.restoreEntry({ target: entry.target, projectId: entry.projectId, content: entry.content, category: entry.category || undefined });
			if (!result.ok) setError(describeAgentMemoryCode(result.code));
			else {
				await refresh();
				props.onChanged?.();
			}
		} finally {
			setRestoring(false);
		}
	};

	// 表格四种状态：加载中 / 完全空 / 过滤无匹配 / 有数据。前三种各自占一行跨度撑满表格，避免出现「空表格骨头」。
	const emptyKind = !data ? "loading" : data.total === 0 ? "empty" : shown === 0 ? "nomatch" : null;

	return (
		<div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-panel">
			{/* 卡片头：搜索框 + 计数。与「进程与内存监控」表格同一套像素（border-b + px-3 py-2）。 */}
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
				<span className="ml-auto shrink-0 text-micro tabular-nums text-muted-foreground">{data ? t("settings.agentMemoryEntriesCount", { shown: String(shown), total: String(data.total) }) : t("common.loading")}</span>
			</div>

			{error ? <p className="border-b border-border-subtle px-3 py-2 text-control text-destructive">{error}</p> : null}

			{deleted ? (
				<div className="flex items-center gap-2 border-b border-border-subtle bg-bg-muted px-3 py-2">
					<span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{t("settings.agentMemoryDeletedEntry", { content: deleted.content.split("\n")[0].length > 80 ? `${deleted.content.split("\n")[0].slice(0, 80)}…` : deleted.content.split("\n")[0] })}</span>
					<Button type="button" variant="ghost" size="sm" disabled={restoring} onClick={() => void runRestore()}>
						<RotateCcw size={13} aria-hidden="true" />
						{t("settings.agentMemoryUndoDelete")}
					</Button>
				</div>
			) : null}

			<Table>
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						<TableHead>{t("settings.agentMemoryTableContent")}</TableHead>
						<TableHead className="w-16 text-right">{t("settings.agentMemoryTableChars")}</TableHead>
						<TableHead className="w-12" aria-label={t("settings.agentMemoryTableActions")} />
					</TableRow>
				</TableHeader>
				<TableBody>
					{emptyKind ? (
						<TableRow className="hover:bg-transparent">
							<TableCell colSpan={3} className="whitespace-normal">
								<div className="flex flex-col items-center gap-2 py-8 text-center">
									<span className="flex size-9 items-center justify-center rounded-full bg-bg-muted text-muted-foreground">{emptyKind === "nomatch" ? <SearchX size={16} aria-hidden="true" /> : <Brain size={16} aria-hidden="true" />}</span>
									<p className="max-w-sm text-caption leading-relaxed text-muted-foreground">{emptyKind === "loading" ? t("common.loading") : emptyKind === "empty" ? t("settings.agentMemoryEmpty") : t("settings.agentMemoryNoMatch")}</p>
									{emptyKind === "nomatch" ? (
										<Button type="button" variant="ghost" size="sm" onClick={() => setQuery("")}>
											{t("settings.agentMemorySearchClear")}
										</Button>
									) : null}
								</div>
							</TableCell>
						</TableRow>
					) : null}
					{groups.map((group) => (
						<Fragment key={`${group.scope}|${group.projectId}|${group.target}`}>
							{/* 分组行：作用域 + 落盘文件 + 预算。跨列铺满，读起来是表格的一条分隔带，不是第二个容器。 */}
							<TableRow className="bg-bg-muted hover:bg-bg-muted">
								<TableCell colSpan={3} className="py-1 whitespace-normal">
									<div className="flex items-center gap-2 text-caption text-muted-foreground">
										<span className="shrink-0 rounded-sm bg-background px-1.5 py-0.5 text-foreground">{memoryGroupScopeLabel(group)}</span>
										<span className="shrink-0">{memoryTargetLabel(group.target)}</span>
										<span className="min-w-0 truncate font-mono opacity-70" title={group.file}>
											{group.file}
										</span>
										<span className="ml-auto shrink-0 tabular-nums">
											{group.budget
												? t("settings.agentMemoryGroupBudget", { count: String(group.entries.length), chars: String(group.chars), maxChars: String(group.budget.maxChars), maxEntries: String(group.budget.maxEntries) })
												: t("settings.agentMemoryGroupPlain", { count: String(group.entries.length), chars: String(group.chars) })}
										</span>
									</div>
								</TableCell>
							</TableRow>
							{group.entries.map((entry) => {
								const id = entryId(entry);
								const open = expanded[id] === true;
								return (
									<TableRow key={id} data-state={open ? "selected" : undefined}>
										<TableCell className="max-w-0 whitespace-normal">
											{/* 折叠态单行省略，展开后整段铺开：记忆条目是纯文本，首行通常就是结论。 */}
											<button type="button" className="flex w-full items-start gap-1.5 text-left text-control text-foreground focus-visible:outline-none" aria-expanded={open} onClick={() => setExpanded((current) => ({ ...current, [id]: !open }))}>
												<span className="mt-0.5 shrink-0 text-muted-foreground">{open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}</span>
												<span className={open ? "min-w-0 whitespace-pre-wrap break-words" : "min-w-0 truncate"}>{open ? entry.content : entry.content.split("\n")[0]}</span>
											</button>
										</TableCell>
										<TableCell className="text-right text-caption tabular-nums text-muted-foreground">{entry.chars}</TableCell>
										<TableCell>
											<Button type="button" variant="ghost" size="icon-sm" aria-label={t("settings.agentMemoryDeleteEntry")} disabled={busyKey === id} onClick={() => setPending(entry)} className="text-muted-foreground hover:text-destructive">
												<Trash2 size={13} aria-hidden="true" />
											</Button>
										</TableCell>
									</TableRow>
								);
							})}
						</Fragment>
					))}
				</TableBody>
			</Table>

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
		</div>
	);
}
