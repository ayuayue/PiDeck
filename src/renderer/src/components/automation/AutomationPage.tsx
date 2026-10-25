import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { automationPageOpenAtom, automationPageProjectIdAtom, closeAutomationPageAtom } from "../../atoms/automation-atoms";
import { deactivateWorkspacePageAtom } from "../../atoms/workspace-page-atoms";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { DEFAULT_AUTOMATION_WORKSPACE_ROUTE, type AutomationWorkspaceRoute } from "../../utils/workspaceSurface";
import { AutomationWorkspace } from "./AutomationWorkspace";

interface AutomationPageProps {
	/** 当前呈现的是不是本页面（失活时保持挂载、只隐藏，切回来状态不丢）。 */
	active: boolean;
	/** 点击查看执行会话时的跳转回调（切到目标项目、打开并常驻会话 Tab）。 */
	onViewSession: (projectId: string, sessionId: string) => void;
}

/**
 * 定时任务页面宿主：会话 Tab 栏里的专属页面 Tab（不是弹窗）。
 *
 * 打开状态由 workspace-page-atoms 驱动；关闭 Tab 才卸载整棵子树，因此
 * 任务列表/编辑器/历史的内部路由在「切到会话再切回」时原样保留。
 */
export function AutomationPage({ active, onViewSession }: AutomationPageProps) {
	const open = useAtomValue(automationPageOpenAtom);
	const projectId = useAtomValue(automationPageProjectIdAtom);
	// 关闭后整棵子树卸载，route 随组件状态一起复位（与旧弹窗关闭语义一致）。
	if (!open) return null;
	// key = 项目范围：项目菜单切到另一个项目时重建内部路由，避免编辑器锁在旧项目的任务上。
	return <AutomationPageSurface key={projectId ?? "all"} active={active} projectId={projectId ?? undefined} onViewSession={onViewSession} />;
}

function AutomationPageSurface(props: AutomationPageProps & { projectId?: string }) {
	const close = useSetAtom(closeAutomationPageAtom);
	const deactivate = useSetAtom(deactivateWorkspacePageAtom);
	const [route, setRoute] = useState<AutomationWorkspaceRoute>(DEFAULT_AUTOMATION_WORKSPACE_ROUTE);

	// Esc 关闭页面 Tab（与「智能体」页面同语义）；只有当前呈现的页面响应，
	// 隐藏但未关闭的页面不得抢走会话区的 Esc。
	useEffect(() => {
		if (!props.active) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			close();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [close, props.active]);

	const handleViewSession = (targetProjectId: string, sessionId: string) => {
		// 前往执行会话 = 让出页面（Tab 保留），由 App 负责切项目/选中会话。
		deactivate();
		props.onViewSession(targetProjectId, sessionId);
	};

	return (
		// inset-0 只覆盖会话列：侧栏、右侧抽屉、底部停靠栏保持可交互（与智能体页/插件页同约定）。
		<div className={cn("absolute inset-0 z-30 flex flex-col bg-background", !props.active && "hidden")} role="region" aria-label={t("automation.title")}>
			<AutomationWorkspace route={route} projectId={props.projectId} onRouteChange={setRoute} onViewSession={handleViewSession} />
		</div>
	);
}
