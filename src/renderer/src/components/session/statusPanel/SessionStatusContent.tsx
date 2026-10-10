import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { projectByIdAtomFamily, sessionLatestAgentRunAtomFamily, sessionRecordByIdAtomFamily, sessionRuntimeBySessionIdAtomFamily } from "../../../atoms";
import { useSessionFileChanges } from "../../../hooks/useSessionFileChanges";
import { TabsContent } from "../../ui-shadcn/tabs";
import type { RightSidebarStackState } from "../../workspace/RightSidebarStack";
import { useSessionPaneServices } from "../SessionPaneServices";
import { useSessionSubagentList } from "../SessionSubagentsStrip";
import { todoWidgetsToItems, useSessionTodoSources } from "../SessionTodoStrip";
import { StatusFilesTab, StatusSubagentsTab, StatusTabBar, StatusTodoTab } from "./StatusTabs";
import { todoProgressBadge } from "./sessionStatusPanelModel";

/**
 * 面板展开且有会话时的主体。数据 hook 只在这里运行：收起或抽屉关闭时不拉取，
 * 此时输入框上方的折叠条已恢复显示，避免两处重复拉取（DSH 子代理 3s 轮询等）。
 */
export function SessionStatusContent(props: { sessionId: string; stack: RightSidebarStackState; onTriggerClick: () => void }) {
	const { sessionId, stack } = props;
	const services = useSessionPaneServices();
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
	const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
	const projectId = runtime?.projectId ?? record?.projectId ?? "";
	const project = useAtomValue(projectByIdAtomFamily(projectId));
	// 与 SessionRuntimeInjector 的 paneFileContext 同口径：runtime cwd 是会话真正执行工具的
	// 目录，未启动时回退项目根；项目外路径的安全等级按本会话判定。
	const fileContext = useMemo(
		() => ({
			baseDir: runtime?.cwd ?? project?.path,
			projectId: projectId || undefined,
			projectRoot: project?.path,
			sessionId,
		}),
		[runtime?.cwd, project?.path, projectId, sessionId],
	);
	const { onOpenFile, onDiffFile, activeProjectId, openSidebarSessionById } = services;
	const openFile = useCallback((path: string) => onOpenFile(path, undefined, fileContext), [fileContext, onOpenFile]);
	const openChildSession = useMemo(() => {
		if (!activeProjectId || !openSidebarSessionById) return undefined;
		return (childSessionId: string) => {
			void openSidebarSessionById(activeProjectId, childSessionId);
		};
	}, [activeProjectId, openSidebarSessionById]);

	// 待办展示完整列表：常驻面板不受折叠条 dismiss 影响
	const todoSources = useSessionTodoSources(sessionId);
	const todoItems = useMemo(() => todoWidgetsToItems(todoSources), [todoSources]);
	// 最近一轮 run 由 SessionView 发布：文件修改的实时增量与折叠条同源
	const run = useAtomValue(sessionLatestAgentRunAtomFamily(sessionId));
	const { entries: fileEntries, loading: filesLoading } = useSessionFileChanges(sessionId, run);
	const subagents = useSessionSubagentList(sessionId);

	return (
		<>
			<StatusTabBar badges={{ todo: todoProgressBadge(todoItems), files: fileEntries.length, subagentsTotal: subagents.total, subagentsRunning: subagents.running }} collapsed={stack.collapsed} autoCollapsed={stack.autoCollapsed} onToggleCollapsed={stack.toggleCollapsed} onTriggerClick={props.onTriggerClick} />
			<TabsContent value="todo" className="min-h-0 overflow-y-auto">
				<StatusTodoTab items={todoItems} />
			</TabsContent>
			<TabsContent value="files" className="min-h-0 overflow-y-auto">
				<StatusFilesTab sessionId={sessionId} entries={fileEntries} loading={filesLoading} onOpenFile={openFile} onDiffFile={onDiffFile} />
			</TabsContent>
			<TabsContent value="subagents" className="min-h-0 overflow-y-auto">
				<StatusSubagentsTab sessionId={sessionId} list={subagents} onOpenChildSession={openChildSession} />
			</TabsContent>
		</>
	);
}
