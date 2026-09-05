import React from "react";
import { useGlobalAgentListeners } from "../../hooks/useGlobalAgentListeners";
import { useSoundAlerts } from "../../hooks/useSoundAlerts";
import type { AppSettings, Project } from "../../../../shared/types";

interface AppBootstrapProps {
  onProjectsChanged: (projects: Project[]) => void;
  onSettingsApplied: (settings: AppSettings) => void;
  onOpenInBrowser: (url: string) => void;
  onTrustRequest: (req: { requestId: string; cwd: string; projectName: string }) => void;
  onFocusTarget: (target: { sessionId: string }) => void;
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

  return null;
});
