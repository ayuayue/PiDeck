import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { PanelRight, Plus, X } from "lucide-react";
import { ChatSessionPane } from "../session/ChatSessionPane";
import { SessionPaneServicesProvider, type SessionPaneServices } from "../session/SessionPaneServices";
import type { SideTaskController } from "../../hooks/useSideTasks";
import { sessionRecordByIdAtomFamily } from "../../atoms";
import { Button } from "../ui-shadcn/button";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";

/** 单个任务芯片：按 id 订阅自己的记录，列表里其他任务改名不会唤醒它。 */
function SideTaskChip(props: { sessionId: string; active: boolean; onSelect: (sessionId: string) => void; onRelease: (sessionId: string) => void }) {
	const record = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
	if (!record) return null;
	return (
		<div className="group relative shrink-0" role="presentation">
			<Button
				type="button"
				variant={props.active ? "secondary" : "ghost"}
				size="sm"
				title={record.title}
				aria-current={props.active ? "true" : undefined}
				data-testid={`side-task-chip-${props.sessionId}`}
				className={cn("max-w-40 gap-1.5 rounded-md pl-2 pr-6 text-xs", props.active && "active")}
				onClick={() => props.onSelect(props.sessionId)}
			>
				<PanelRight size={12} className="shrink-0 opacity-70" aria-hidden="true" />
				<span className="truncate">{record.title || t("sideTask.untitled")}</span>
			</Button>
			{/* 释放（清标记）而非删除：会话本身留在左栏，与抽屉活动栏移除 tab 的 X 语义一致 */}
			<Button
				type="button"
				variant="ghost"
				size="icon"
				title={t("sideTask.release")}
				aria-label={t("sideTask.release")}
				data-testid={`side-task-release-${props.sessionId}`}
				className={cn("absolute top-1/2 right-1 z-10 size-4 -translate-y-1/2 rounded-full p-0 text-muted-foreground transition-opacity hover:bg-bg-hover hover:text-text-primary focus-visible:opacity-100", props.active ? "opacity-100" : "opacity-0 group-hover:opacity-100")}
				onClick={() => props.onRelease(props.sessionId)}
			>
				<X size={10} />
			</Button>
		</div>
	);
}

/**
 * 侧边任务面板：任务条 + 复用主区会话渲染栈（ChatSessionPane）。
 *
 * 渲染逻辑零复制是本面板的前提——时间线、输入框、工具卡片、ask 回弹全部走同一套 pane，
 * 只有两处语义必须为本面板改写：
 * 1. `promoteSessionToPermanent` 置空：侧边任务发第一条消息不得把会话晋升进主区常驻 Tab；
 * 2. `focused=false` + 空 `onFocusPane`：面板不是主区栏位，不能抢 App 级 composer/header layout refs，
 *    也不能在点击面板时把主工作区的当前会话顶掉。
 */
export function SideTaskPanel(props: { controller: SideTaskController; paneServices: SessionPaneServices }) {
	const { ids, activeId, select, create, release } = props.controller;
	// 释放/删除后 activeId 可能指向已不在列表里的会话，回退到最近活跃的一条。
	const currentId = activeId && ids.includes(activeId) ? activeId : (ids[0] ?? null);

	const paneServices = useMemo(() => ({ ...props.paneServices, promoteSessionToPermanent: () => {} }), [props.paneServices]);
	const projectId = props.paneServices.activeProjectId;

	return (
		<div className="drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="side-task-panel">
			<div className="side-task-strip flex shrink-0 items-center gap-1 border-b border-border/40 px-2 py-1.5">
				{/* 限高/横向滚动容器的子项必须 shrink-0，否则标题被压成横条（AGENTS.md CSS 硬性条款 6） */}
				<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-contain">
					{ids.map((sessionId) => (
						<SideTaskChip key={sessionId} sessionId={sessionId} active={sessionId === currentId} onSelect={select} onRelease={release} />
					))}
					{ids.length === 0 ? <span className="truncate px-1 text-xs text-muted-foreground">{t("sideTask.empty")}</span> : null}
				</div>
				<Button type="button" variant="ghost" size="icon" title={t("sideTask.create")} aria-label={t("sideTask.create")} data-testid="side-task-create" disabled={!projectId} className="size-6 shrink-0" onClick={() => void create({ projectId })}>
					<Plus size={14} />
				</Button>
			</div>
			{currentId ? (
				<div className="min-h-0 min-w-0 flex-1 overflow-hidden">
					<SessionPaneServicesProvider value={paneServices}>
						<ChatSessionPane sessionId={currentId} focused={false} onFocusPane={() => {}} splitPane={false} />
					</SessionPaneServicesProvider>
				</div>
			) : (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
					<PanelRight size={24} className="text-muted-foreground" aria-hidden="true" />
					<p className="max-w-60 text-xs text-muted-foreground">{t("sideTask.emptyHint")}</p>
					<Button type="button" variant="secondary" size="sm" data-testid="side-task-create-empty" disabled={!projectId} onClick={() => void create({ projectId })}>
						<Plus size={14} />
						{t("sideTask.create")}
					</Button>
				</div>
			)}
		</div>
	);
}
