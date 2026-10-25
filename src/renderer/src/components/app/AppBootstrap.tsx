import React from "react";
import { useGlobalAgentListeners } from "../../hooks/useGlobalAgentListeners";
import { useSoundAlerts } from "../../hooks/useSoundAlerts";
import { useAnnouncementsSync } from "../../hooks/useAnnouncementsSync";
import { useAutomationSync } from "../../hooks/useAutomationSync";
import { useAgentProfileSync } from "../../hooks/useAgentProfileSync";
import type { AppSettings, FocusTargetPayload, Project } from "../../../../shared/types";

interface AppBootstrapProps {
	onProjectsChanged: (projects: Project[]) => void;
	onSettingsApplied: (settings: AppSettings) => void;
	onOpenInBrowser: (url: string) => void;
	onTrustRequest: (req: { requestId: string; cwd: string; projectName: string }) => void;
	onFocusTarget: (target: FocusTargetPayload) => void;
}

/** Bootstrap — sets up global IPC listeners, renders nothing. */
export const AppBootstrap = React.memo(function AppBootstrap(props: AppBootstrapProps) {
	useGlobalAgentListeners({
		onProjectsChanged: props.onProjectsChanged,
		onSettingsApplied: props.onSettingsApplied,
		onOpenInBrowser: props.onOpenInBrowser,
		onTrustRequest: props.onTrustRequest,
		onFocusTarget: props.onFocusTarget,
	});
	// 声音提醒：全局唯一挂载点（与其它全局 listener 同层），卸载即退订
	useSoundAlerts();
	// 公告快照全局同步：初始 list + 订阅推送，同样全局唯一挂载点、卸载即退订
	useAnnouncementsSync();
	// 定时任务快照全局同步：初始 list + 订阅推送，卸载即退订
	useAutomationSync();
	// 智能体快照全局同步（市场卡片与划词默认智能体共用一份）：同一挂载点、卸载即退订
	useAgentProfileSync();

	return null;
});
