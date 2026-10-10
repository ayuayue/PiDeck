import type { ReactNode } from "react";
import { Bot, ChevronDown, ChevronUp, FileEdit, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionFileChange } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { TabsList, TabsTrigger } from "../../ui-shadcn/tabs";
import type { AgentTodoItem } from "../agentTodoParser";
import { FileEntry } from "../SessionFilesStrip";
import { DshSubagentEntryRow, PiSubagentEntryRow, type SessionSubagentList } from "../SessionSubagentsStrip";
import { TodoItemRow, progressLabel } from "../SessionTodoStrip";
import type { DiffFileHandler } from "../ToolCallComponents";
import { fileChangeKind, type FileChangeKind, type SessionStatusTab } from "./sessionStatusPanelModel";

/**
 * 会话状态面板的展示件：tab 栏（32px，与收起高度一致）与三个 tab 的内容。
 * 行组件全部复用输入框上方折叠条的同款实现，只换外层容器。
 */

export type StatusTabBadges = {
	/** 待办「已完成/总数」，空列表为 null */
	todo: string | null;
	files: number;
	subagentsTotal: number;
	subagentsRunning: number;
};

function StatusTrigger(props: { value: SessionStatusTab; icon: ReactNode; label: string; badge: ReactNode; description: string; onClick: () => void }) {
	return (
		<TabsTrigger variant="line" value={props.value} aria-label={props.description} title={props.description} className="h-8 min-w-0 shrink gap-1.5 px-2.5 py-0" onClick={props.onClick}>
			{props.icon}
			{/* 紧凑模式：侧栏窄于 280px 时只留图标与计数 */}
			<span className="hidden truncate @min-[280px]/status:inline">{props.label}</span>
			{props.badge}
		</TabsTrigger>
	);
}

function CountBadge({ children }: { children: ReactNode }) {
	return <span className="shrink-0 tabular-nums text-micro text-text-tertiary">{children}</span>;
}

export function StatusTabBar(props: { badges?: StatusTabBadges; collapsed: boolean; autoCollapsed: boolean; onToggleCollapsed: () => void; onTriggerClick: () => void }) {
	const { badges } = props;
	const todoLabel = t("sessionStatus.tab.todo");
	const filesLabel = t("sessionStatus.tab.files");
	const subagentsLabel = t("sessionStatus.tab.subagents");
	const running = badges?.subagentsRunning ?? 0;
	const subagentsTotal = badges?.subagentsTotal ?? 0;
	const toggleLabel = props.autoCollapsed ? t("sessionStatus.expandBlocked") : props.collapsed ? t("sessionStatus.expand") : t("sessionStatus.collapse");
	return (
		<div className="flex h-8 shrink-0 items-center border-b border-border-subtle">
			<TabsList variant="line" className="h-8 min-w-0 flex-1 overflow-hidden border-b-0">
				<StatusTrigger value="todo" icon={<ListChecks className="size-3.5" aria-hidden="true" />} label={todoLabel} description={[todoLabel, badges?.todo].filter(Boolean).join(" · ")} badge={badges?.todo ? <CountBadge>{badges.todo}</CountBadge> : null} onClick={props.onTriggerClick} />
				<StatusTrigger
					value="files"
					icon={<FileEdit className="size-3.5" aria-hidden="true" />}
					label={filesLabel}
					description={badges && badges.files > 0 ? `${filesLabel} · ${t("sessionFiles.count", { count: badges.files })}` : filesLabel}
					badge={badges && badges.files > 0 ? <CountBadge>{badges.files}</CountBadge> : null}
					onClick={props.onTriggerClick}
				/>
				<StatusTrigger
					value="subagents"
					icon={<Bot className="size-3.5" aria-hidden="true" />}
					label={subagentsLabel}
					description={running > 0 ? `${subagentsLabel} · ${t("sessionStatus.subagentsRunning", { count: running })}` : subagentsLabel}
					badge={
						running > 0 ? (
							// 运行中计数 + 状态灯：与折叠条头部同一语义
							<span className="inline-flex shrink-0 items-center gap-1 rounded bg-warning/15 px-1 py-0.5 text-micro leading-none font-medium text-warning">
								<span className="size-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />
								{running}
							</span>
						) : subagentsTotal > 0 ? (
							<CountBadge>{subagentsTotal}</CountBadge>
						) : null
					}
					onClick={props.onTriggerClick}
				/>
			</TabsList>
			{/* 自动收起期间不能展开：用 aria-disabled 而非 disabled，保留悬停提示说明原因 */}
			<Button variant="ghost" size="icon-xs" className="mr-1 size-6 shrink-0 rounded text-text-tertiary aria-disabled:opacity-50" aria-label={toggleLabel} title={toggleLabel} aria-expanded={!props.collapsed} aria-disabled={props.autoCollapsed || undefined} onClick={props.onToggleCollapsed}>
				{props.collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
			</Button>
		</div>
	);
}

export function StatusEmpty({ children }: { children: ReactNode }) {
	return <p className="px-3 py-4 text-center text-control leading-5 text-text-tertiary">{children}</p>;
}

export function StatusTodoTab({ items }: { items: AgentTodoItem[] }) {
	if (items.length === 0) return <StatusEmpty>{t("sessionTodo.empty")}</StatusEmpty>;
	return (
		<div className="flex flex-col gap-2 px-3 py-2">
			<p className="truncate text-micro leading-4 text-text-tertiary">{progressLabel(items)}</p>
			<ul className="flex flex-col gap-2">
				{items.map((item) => (
					<TodoItemRow key={item.id} item={item} />
				))}
			</ul>
		</div>
	);
}

const FILE_KIND_BADGE_CLASS: Record<FileChangeKind, string> = {
	write: "bg-success/15 text-success",
	edit: "bg-info/15 text-info",
};

function FileKindBadge({ kind }: { kind: FileChangeKind }) {
	const label = kind === "write" ? t("sessionStatus.fileKind.write") : t("sessionStatus.fileKind.edit");
	const hint = kind === "write" ? t("sessionStatus.fileKindHint.write") : t("sessionStatus.fileKindHint.edit");
	return (
		// h-9 与 FileEntry 顶部文件行对齐，展开 diff 后徽标仍钉在首行
		<span className="flex h-9 shrink-0 items-center">
			<span className={cn("rounded px-1 py-0.5 text-micro font-medium leading-none", FILE_KIND_BADGE_CLASS[kind])} title={hint}>
				{label}
			</span>
		</span>
	);
}

export function StatusFilesTab(props: { sessionId: string; entries: SessionFileChange[]; loading: boolean; onOpenFile?: (path: string) => void; onDiffFile?: DiffFileHandler }) {
	if (props.entries.length === 0) return <StatusEmpty>{props.loading ? t("sessionFiles.loading") : t("sessionFiles.empty")}</StatusEmpty>;
	return (
		<ul className="flex flex-col gap-1 px-2 py-2">
			{props.entries.map((entry) => (
				<li key={entry.path} className="flex min-w-0 shrink-0 items-start gap-1.5">
					<FileKindBadge kind={fileChangeKind(entry)} />
					<FileEntry sessionId={props.sessionId} entry={entry} onOpenFile={props.onOpenFile} onDiffFile={props.onDiffFile} />
				</li>
			))}
		</ul>
	);
}

export function StatusSubagentsTab(props: { sessionId: string; list: SessionSubagentList; onOpenChildSession?: (sessionId: string) => void }) {
	const { list } = props;
	if (list.total === 0) return <StatusEmpty>{list.loading ? t("sessionSubagents.loading") : t("sessionSubagents.empty")}</StatusEmpty>;
	return (
		<div className="flex flex-col gap-1 px-2 py-2">
			<ul className="flex flex-col gap-1">
				{list.isDsh ? list.dshEntries.map((entry) => <DshSubagentEntryRow key={entry.id} agentId={list.agentId ?? ""} entry={entry} />) : list.piEntries.map((entry) => <PiSubagentEntryRow key={entry.id} entry={entry} sessionId={props.sessionId} onOpenChildSession={props.onOpenChildSession} />)}
			</ul>
			{list.hasAcpEntries && <p className="px-2 text-micro leading-4 text-text-tertiary">{t("sessionSubagents.acpDelegateHint")}</p>}
		</div>
	);
}
