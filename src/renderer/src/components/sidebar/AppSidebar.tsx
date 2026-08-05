import React, { useRef } from "react";
import { useSetAtom } from "jotai";
import { PanelLeft } from "lucide-react";
import { SidebarContent, type SidebarActions } from "./SidebarContent";
import type { WorktreeEntry } from "../../../../shared/types";
import { useSidebarController } from "../../hooks/useSidebarController";
import { BrandLockup } from "../app/AppParts";
import { settingsOpenAtom } from "../../atoms";
import { desktopApi } from "../../desktopApi";
import { Button } from "../ui-shadcn/button";
import { t } from "../../i18n";

interface AppSidebarProps {
  actions: SidebarActions;
  currentProjectId: string | undefined;
  currentSessionId: string | undefined;
  worktreesByProject: Record<string, WorktreeEntry[]>;
  branchByProject: Record<string, string | null>;
  creatingWorktree: boolean;
  isLanWeb: boolean;
  onOpenConfig: () => void;
  onOpenFeedback: () => void;
  onOpenHomepage: () => void;
  /** 左侧栏折叠态与开关（main 布局：按钮在品牌文字右侧） */
  listCollapsed: boolean;
  toggleListCollapsed: () => void;
  /** settings.json 中已保存的展开项目 id，权威来源 */
  settingsExpandedProjectIds?: readonly string[];
  /** 首次 settings.get 已完成，controller 可安全处理旧 key 迁移。 */
  settingsLoaded: boolean;
  /** 展开集合完成权威 hydration 后，允许 App 按它懒加载会话。 */
  onExpandedProjectsReady: () => void;
}

export function AppSidebar(props: AppSidebarProps) {
  const setSettingsOpen = useSetAtom(settingsOpenAtom);  // 快速连续点击展开/折叠会触发多次 IPC；按顺序写入可避免旧请求最后完成后覆盖新集合。
  const expandedProjectsSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const controller = useSidebarController({
    getRpcLogging: props.actions.rpc.getLogging,
    settingsExpandedProjectIds: props.settingsExpandedProjectIds,
    settingsLoaded: props.settingsLoaded,
    onExpandedProjectsReady: props.onExpandedProjectsReady,
    persistExpandedProjectIds: (projectIds) => {
      expandedProjectsSaveQueueRef.current = expandedProjectsSaveQueueRef.current
        .catch(() => undefined)
        .then(() => desktopApi.settings.update({ sidebarExpandedProjectIds: projectIds }))
        .catch(() => undefined);
    },
  });

  return (
    <>
    <SidebarContent
      controller={controller}
      actions={props.actions}
      currentProjectId={props.currentProjectId}
      currentSessionId={props.currentSessionId}
      worktreesByProject={props.worktreesByProject}
      branchByProject={props.branchByProject}
      creatingWorktree={props.creatingWorktree}
      isLanWeb={props.isLanWeb}
      chrome={<>
        {/* 品牌区（main 布局）：折叠按钮在品牌文字右侧 */}
        <div className="list-toolbar flex h-12 shrink-0 items-center gap-1 px-1">
          <div className="app-badge flex min-w-0 flex-1 items-center">
            <BrandLockup />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="icon-button list-toggle-native"
            aria-label={props.listCollapsed ? t("app.expandList") : t("app.collapseList")}
            title={props.listCollapsed ? t("app.expandList") : t("app.collapseList")}
            onClick={props.toggleListCollapsed}
          >
            <PanelLeft size={14} strokeWidth={2} aria-hidden="true" />
          </Button>
        </div>
      </>}
      onOpenSettings={() => setSettingsOpen(true)}
      onOpenConfig={props.onOpenConfig}
      onOpenFeedback={props.onOpenFeedback}
      onOpenHomepage={props.onOpenHomepage}
    />
    {/* 侧栏折叠后的浮动恢复入口（品牌区随折叠隐藏，按钮不能跟着消失） */}
    {props.listCollapsed && (
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className="list-toggle-native floating !size-7"
        aria-label={t("app.expandList")}
        title={t("app.expandList")}
        onClick={props.toggleListCollapsed}
      >
        <PanelLeft size={14} strokeWidth={2} aria-hidden="true" />
      </Button>
    )}
    </>
  );
}
