import { useCallback, useMemo, useState } from "react";
import { t } from "../../../i18n";
import { Tabs } from "../../ui-shadcn/tabs";
import type { RightSidebarStackState } from "../../workspace/RightSidebarStack";
import { useRightSidebarStack } from "../../workspace/RightSidebarStack";
import { ComposerWidgetLayoutProvider, useComposerWidgetLayoutValue, type ComposerWidgetCollapsedByKey } from "../ComposerWidgetLayout";
import { useSessionSubagentList } from "../SessionSubagentsStrip";
import { todoWidgetsToItems, useSessionTodoSources } from "../SessionTodoStrip";
import { SessionStatusContent } from "./SessionStatusContent";
import { StatusEmpty, StatusTabBar } from "./StatusTabs";
import { SESSION_STATUS_TAB_STORAGE_KEY, parseSessionStatusTab, todoProgressBadge, type SessionStatusTab } from "./sessionStatusPanelModel";

/**
 * 右侧边栏下半区：当前聚焦会话的待办 / 子代理（分组标签页）。
 *
 * - 抽屉关闭：不渲染、不拉数据；
 * - 下半区收起：只留 32px tab 栏，但仍拉取待办/子代理计数，信息不至于完全不可见；
 * - 展开且有会话：面板「占用」该会话。
 *
 * 输入框上方的同类折叠条是否显示只看设置 sessionStatusPlacement（见 App 写入的
 * sessionStatusInSidebarAtom），与本面板此刻展开还是收起无关。
 *
 * 当前 tab、展开/收起偏好都跨会话、跨重启记忆；数据变化不自动切 tab，避免跳动。
 */

function loadTab(): SessionStatusTab {
	try {
		return parseSessionStatusTab(localStorage.getItem(SESSION_STATUS_TAB_STORAGE_KEY));
	} catch {
		return parseSessionStatusTab(null);
	}
}

function saveTab(tab: SessionStatusTab): void {
	try {
		localStorage.setItem(SESSION_STATUS_TAB_STORAGE_KEY, tab);
	} catch {
		// 隐私模式或配额失败：只影响下次启动时的默认 tab。
	}
}

export function SessionStatusPanel({ sessionId }: { sessionId: string | undefined }) {
	const stack = useRightSidebarStack();
	const [tab, setTab] = useState<SessionStatusTab>(loadTab);
	// 行级展开状态（子代理详情）自持一份，与输入框上方折叠条互不串扰
	const [collapsedByKey, setCollapsedByKey] = useState<ComposerWidgetCollapsedByKey>({});
	const layoutValue = useComposerWidgetLayoutValue(collapsedByKey, setCollapsedByKey);
	const visible = stack.open && !stack.collapsed;

	const selectTab = useCallback((value: string) => {
		const next = parseSessionStatusTab(value);
		setTab(next);
		saveTab(next);
	}, []);
	const { collapsed, expand } = stack;
	// 点已选中的 tab 不会触发 onValueChange，所以展开放在 onClick
	const handleTriggerClick = useCallback(() => {
		if (collapsed) expand();
	}, [collapsed, expand]);

	if (!stack.open) return null;

	return (
		// 背景与 .detail-drawer 同为 --color-bg-panel：壁纸模式下两者同为单层半透明，上下同档
		<section aria-label={t("sessionStatus.title")} className="@container/status h-full min-h-0 bg-bg-panel">
			<ComposerWidgetLayoutProvider value={layoutValue}>
				<Tabs value={tab} onValueChange={selectTab} className="h-full min-h-0 gap-0">
					{visible && sessionId ? (
						<SessionStatusContent key={sessionId} sessionId={sessionId} stack={stack} onTriggerClick={handleTriggerClick} />
					) : sessionId ? (
						<CollapsedStatusBar sessionId={sessionId} stack={stack} onTriggerClick={handleTriggerClick} />
					) : (
						<>
							<StatusTabBar collapsed={stack.collapsed} autoCollapsed={stack.autoCollapsed} onToggleCollapsed={stack.toggleCollapsed} onTriggerClick={handleTriggerClick} />
							{!stack.collapsed && <StatusEmpty>{t("sessionStatus.noSession")}</StatusEmpty>}
						</>
					)}
				</Tabs>
			</ComposerWidgetLayoutProvider>
		</section>
	);
}

/** 收起态：只渲染 tab 栏，但仍带待办进度与子代理计数，收起后不用再回输入框上方找信息。 */
function CollapsedStatusBar(props: { sessionId: string; stack: RightSidebarStackState; onTriggerClick: () => void }) {
	const todoSources = useSessionTodoSources(props.sessionId);
	const todoItems = useMemo(() => todoWidgetsToItems(todoSources), [todoSources]);
	const subagents = useSessionSubagentList(props.sessionId);
	return (
		<StatusTabBar
			badges={{ todo: todoProgressBadge(todoItems), subagentsTotal: subagents.total, subagentsRunning: subagents.running }}
			collapsed={props.stack.collapsed}
			autoCollapsed={props.stack.autoCollapsed}
			onToggleCollapsed={props.stack.toggleCollapsed}
			onTriggerClick={props.onTriggerClick}
		/>
	);
}
