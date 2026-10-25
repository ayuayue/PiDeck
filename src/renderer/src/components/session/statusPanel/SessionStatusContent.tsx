import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { sessionRecordByIdAtomFamily, sessionRuntimeBySessionIdAtomFamily } from "../../../atoms";
import { TabsContent } from "../../ui-shadcn/tabs";
import type { RightSidebarStackState } from "../../workspace/RightSidebarStack";
import { useSessionPaneServices } from "../SessionPaneServices";
import { useSessionSubagentList } from "../SessionSubagentsStrip";
import { todoWidgetsToItems, useSessionTodoSources } from "../SessionTodoStrip";
import { StatusSubagentsTab, StatusTabBar, StatusTodoTab } from "./StatusTabs";
import { todoProgressBadge } from "./sessionStatusPanelModel";

/**
 * 面板展开且有会话时的主体。数据 hook 只在这里运行：收起或抽屉关闭时不拉取，
 * 此时输入框上方的折叠条已恢复显示，避免两处重复拉取（DSH 子代理 3s 轮询等）。
 *
 * 2027-02 移除 files tab：文件修改改由每轮末尾的 chip 行（turn/TurnFileChanges）
 * 在轮次上下文里展示，面板不再拉取任何文件修改数据。
 */
export function SessionStatusContent(props: { sessionId: string; stack: RightSidebarStackState; onTriggerClick: () => void }) {
	const { sessionId, stack } = props;
	const services = useSessionPaneServices();
	// subagents tab 只需项目 id：它拿它去 openSidebarSessionById 打开子会话。
	// runtime cwd / project 路径 / 文件打开上下文原本只服务于已移除的 files tab。
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
	const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
	const projectId = runtime?.projectId ?? record?.projectId ?? "";
	const { activeProjectId, openSidebarSessionById } = services;
	const openChildSession = useMemo(() => {
		if (!activeProjectId || !openSidebarSessionById) return undefined;
		return (childSessionId: string) => {
			void openSidebarSessionById(activeProjectId, childSessionId);
		};
	}, [activeProjectId, openSidebarSessionById]);

	// 待办展示完整列表：常驻面板不受折叠条 dismiss 影响
	const todoSources = useSessionTodoSources(sessionId);
	const todoItems = useMemo(() => todoWidgetsToItems(todoSources), [todoSources]);
	const subagents = useSessionSubagentList(sessionId);

	return (
		<>
			<StatusTabBar badges={{ todo: todoProgressBadge(todoItems), subagentsTotal: subagents.total, subagentsRunning: subagents.running }} collapsed={stack.collapsed} autoCollapsed={stack.autoCollapsed} onToggleCollapsed={stack.toggleCollapsed} onTriggerClick={props.onTriggerClick} />
			<TabsContent value="todo" className="min-h-0 overflow-y-auto">
				<StatusTodoTab items={todoItems} />
			</TabsContent>
			<TabsContent value="subagents" className="min-h-0 overflow-y-auto">
				<StatusSubagentsTab sessionId={sessionId} list={subagents} onOpenChildSession={openChildSession} />
			</TabsContent>
		</>
	);
}
