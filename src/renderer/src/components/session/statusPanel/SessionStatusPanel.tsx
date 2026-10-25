import { useSetAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { rightSidebarStatusSessionIdAtom } from "../../../atoms";
import { t } from "../../../i18n";
import { Tabs } from "../../ui-shadcn/tabs";
import { useRightSidebarStack } from "../../workspace/RightSidebarStack";
import { ComposerWidgetLayoutProvider, useComposerWidgetLayoutValue, type ComposerWidgetCollapsedByKey } from "../ComposerWidgetLayout";
import { SessionStatusContent } from "./SessionStatusContent";
import { StatusEmpty, StatusTabBar } from "./StatusTabs";
import { SESSION_STATUS_TAB_STORAGE_KEY, parseSessionStatusTab, type SessionStatusTab } from "./sessionStatusPanelModel";

/**
 * 右侧边栏下半区：当前聚焦会话的待办 / 修改文件 / 子代理（分组标签页）。
 *
 * - 抽屉关闭：不渲染、不拉数据；
 * - 下半区收起：只留 tab 栏，点任一 tab 展开并切过去；
 * - 展开且有会话：面板「占用」该会话，其输入框上方的同类折叠条隐藏（见 SessionView）。
 *
 * 当前 tab 跨会话、跨重启记忆；数据变化不自动切 tab，避免跳动。
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
	// 行级展开状态（文件 diff、子代理详情）自持一份，与输入框上方折叠条互不串扰
	const [collapsedByKey, setCollapsedByKey] = useState<ComposerWidgetCollapsedByKey>({});
	const layoutValue = useComposerWidgetLayoutValue(collapsedByKey, setCollapsedByKey);
	const setStatusSessionId = useSetAtom(rightSidebarStatusSessionIdAtom);
	const visible = stack.open && !stack.collapsed;

	// 可见地展示某会话时占用它；清理时只释放自己写入的值，避免与新会话的发布竞态。
	useEffect(() => {
		if (!visible || !sessionId) return;
		setStatusSessionId(sessionId);
		return () => setStatusSessionId((current) => (current === sessionId ? null : current));
	}, [visible, sessionId, setStatusSessionId]);

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
