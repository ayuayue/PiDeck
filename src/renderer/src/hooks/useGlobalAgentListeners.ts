import { useEffect, useRef } from "react";
import { useStore } from "jotai";
import type {
  AppSettings,
  Project,
} from "../../../shared/types";
import { replaceProjectInventoryAtom } from "../atoms";
import { desktopApi } from "../desktopApi";

type GlobalAgentListenerCallbacks = {
  onProjectsChanged?: (projects: Project[]) => void;
  onFocusTarget?: (target: { sessionId: string }) => void;
  onSettingsApplied?: (settings: AppSettings) => void;
  onOpenInBrowser?: (url: string) => void;
  onTrustRequest?: (request: {
    requestId: string;
    cwd: string;
    projectName: string;
  }) => void;
};

export function useGlobalAgentListeners(
  callbacks: GlobalAgentListenerCallbacks = {},
): void {
  const store = useStore();
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    let disposed = false;

    void desktopApi.projects.list().then((projects) => {
      if (disposed) return;
      store.set(replaceProjectInventoryAtom, projects);
      callbacksRef.current.onProjectsChanged?.(projects);
    }).catch(() => undefined);
    const offProjects = desktopApi.projects.onChanged(() => {
      // 主进程部分广播只表示 store 清单变化，未必携带实时 missing 标记。
      // 统一回读 projects:list，避免 DSH 自动导入等事件把已检测出的失效目录覆盖成“正常”。
      void desktopApi.projects.list().then((projects) => {
        if (disposed) return;
        store.set(replaceProjectInventoryAtom, projects);
        callbacksRef.current.onProjectsChanged?.(projects);
      }).catch(() => undefined);
    });
    const offFocusTarget = desktopApi.pet.onFocusTarget((target) => {
      callbacksRef.current.onFocusTarget?.(target);
    });
    const offSettings = desktopApi.settings.onApplyWindow((settings) => {
      callbacksRef.current.onSettingsApplied?.(settings);
    });
    const offOpenInBrowser = desktopApi.app.onOpenInBrowser?.((url) => {
      callbacksRef.current.onOpenInBrowser?.(url);
    });
    const offTrustRequest = desktopApi.projects.onTrustRequest((request) => {
      callbacksRef.current.onTrustRequest?.(request);
    });

    return () => {
      disposed = true;
      offProjects();
      offFocusTarget();
      offSettings();
      offOpenInBrowser?.();
      offTrustRequest();
    };
  }, [store]);
}
