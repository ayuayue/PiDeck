import { useState } from "react";
import type { AgentTab, Project, SessionSummary } from "../../../shared/types";
import { displayProjectDirectoryName } from "../rendererUtils";
import { t } from "../i18n";

export interface UseRenameApi {
  renameAgent: (id: string, name: string) => Promise<AgentTab>;
  renameSession: (id: string, name: string) => Promise<unknown>;
  /** 重命名项目显示名（主进程只改 label 不动磁盘目录）；返回更新后的项目列表。 */
  renameProject: (id: string, name: string) => Promise<Project[]>;
  /** 重命名成功后把主进程返回的项目列表写回全局状态（可选；缺省依赖 projects:changed 广播）。 */
  applyRenamedProjects?: (projects: Project[]) => void;
  showToast: (message: string, duration?: number) => void;
  refreshProjectSessions: (projectId: string, force?: boolean) => Promise<unknown>;
  /** Optional: close agent context menu before opening rename dialog. */
  closeAgentMenu?: () => void;
}

export type RenameModalKind = "agent" | "session" | "project";

export type RenameModalProps = {
  kind: RenameModalKind;
  value: string;
  saving: boolean;
  onValueChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function useRename(api: UseRenameApi) {
  const [agentRenameTarget, setAgentRenameTarget] = useState<AgentTab | null>(null);
  const [sessionRenameTarget, setSessionRenameTarget] = useState<{
    projectId: string;
    session: SessionSummary;
  } | null>(null);
  const [projectRenameTarget, setProjectRenameTarget] = useState<Project | null>(null);
  const [agentRenameValue, setAgentRenameValue] = useState("");
  const [agentRenaming, setAgentRenaming] = useState(false);

  function openAgentRename(agent: AgentTab) {
    api.closeAgentMenu?.();
    setAgentRenameTarget(agent);
    setSessionRenameTarget(null);
    setProjectRenameTarget(null);
    setAgentRenameValue(agent.title);
  }

  function openSessionRename(projectId: string, session: SessionSummary) {
    setAgentRenameTarget(null);
    setSessionRenameTarget({ projectId, session });
    setProjectRenameTarget(null);
    setAgentRenameValue(session.name || t("common.untitled"));
  }

  /** 打开项目重命名对话框：预填当前展示名（含自定义别名），确认后只改显示 label。 */
  function openProjectRename(project: Project) {
    api.closeAgentMenu?.();
    setAgentRenameTarget(null);
    setSessionRenameTarget(null);
    setProjectRenameTarget(project);
    setAgentRenameValue(displayProjectDirectoryName(project));
  }

  async function submitAgentRename() {
    if (!agentRenameTarget) return;
    const name = agentRenameValue.replace(/\s+/g, " ").trim();
    if (!name) {
      api.showToast(t("app.sessionNameRequired"), 2200);
      return;
    }
    setAgentRenaming(true);
    try {
      const tab = await api.renameAgent(agentRenameTarget.id, name);
      setAgentRenameTarget(null);
      setSessionRenameTarget(null);
      setProjectRenameTarget(null);
      setAgentRenameValue("");
      api.showToast(t("app.sessionRenamed"), 2200);
      await api.refreshProjectSessions(tab.projectId);
    } catch (error) {
      api.showToast(
        t("app.sessionRenameFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
    } finally {
      setAgentRenaming(false);
    }
  }

  async function submitSessionRename() {
    if (!sessionRenameTarget) return;
    const name = agentRenameValue.replace(/\s+/g, " ").trim();
    if (!name) {
      api.showToast(t("app.sessionNameRequired"), 2200);
      return;
    }
    setAgentRenaming(true);
    try {
      await api.renameSession(sessionRenameTarget.session.id, name);
      await api.refreshProjectSessions(sessionRenameTarget.projectId);
      setSessionRenameTarget(null);
      setAgentRenameValue("");
      api.showToast(t("app.sessionRenamed"), 2200);
    } catch (error) {
      api.showToast(
        t("app.sessionRenameFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
    } finally {
      setAgentRenaming(false);
    }
  }

  async function submitProjectRename() {
    if (!projectRenameTarget) return;
    const name = agentRenameValue.replace(/\s+/g, " ").trim();
    if (!name) {
      api.showToast(t("app.projectNameRequired"), 2200);
      return;
    }
    setAgentRenaming(true);
    try {
      const projects = await api.renameProject(projectRenameTarget.id, name);
      api.applyRenamedProjects?.(projects);
      setProjectRenameTarget(null);
      setAgentRenameValue("");
      api.showToast(t("app.projectRenamed"), 2200);
    } catch (error) {
      api.showToast(
        t("app.projectRenameFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
    } finally {
      setAgentRenaming(false);
    }
  }

  const renameModalsProps: { rename?: RenameModalProps } = {
    rename: (agentRenameTarget || sessionRenameTarget || projectRenameTarget) ? {
      kind: agentRenameTarget ? "agent" : sessionRenameTarget ? "session" : "project",
      value: agentRenameValue,
      saving: agentRenaming,
      onValueChange: setAgentRenameValue,
      onClose: () => {
        setAgentRenameTarget(null);
        setSessionRenameTarget(null);
        setProjectRenameTarget(null);
      },
      onSubmit: () => {
        if (agentRenameTarget) void submitAgentRename();
        else if (sessionRenameTarget) void submitSessionRename();
        else void submitProjectRename();
      },
    } : undefined,
  };

  return {
    agentRenameTarget,
    sessionRenameTarget,
    projectRenameTarget,
    agentRenameValue,
    agentRenaming,
    openAgentRename,
    openSessionRename,
    openProjectRename,
    submitAgentRename,
    submitSessionRename,
    submitProjectRename,
    renameModalsProps,
  };
}
