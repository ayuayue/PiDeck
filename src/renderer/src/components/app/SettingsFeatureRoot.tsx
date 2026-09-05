import { lazy, Suspense, useCallback, useMemo, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { AppInfo, AppSettings } from "../../../../shared/types";
import { settingsFocusAtom, settingsOpenAtom } from "../../atoms";
import { updateStatusAtom } from "../../atoms/update-atoms";
import {
  flushUpdateInstallPreflight,
  updateInstallPreflightTasksAtom,
} from "../../atoms/update-install-preflight";
import { desktopApi as api } from "../../desktopApi";
import type { PiUpdateController } from "../../hooks/usePiUpdate";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";

const SettingsModal = lazy(() =>
  import("./SettingsModal").then((module) => ({ default: module.SettingsModal })),
);

type SettingsFeatureRootProps = {
  settings: AppSettings;
  piUpdate: PiUpdateController;
  webServiceChanging: boolean;
  onRestartWebService: () => void;
  appInfo: AppInfo;
  onChange: (patch: Partial<AppSettings>) => Promise<boolean>;
  /** 当前项目路径：有值时配置管理分区合并项目 `.mcp.json` / `.pi/mcp.json`（只读）。 */
  projectPath?: string;
};

/** Owns Settings overlay visibility and modal-only commands without mirroring AppSettings. */
export function SettingsFeatureRoot(props: SettingsFeatureRootProps) {
  const open = useAtomValue(settingsOpenAtom);
  const setOpen = useSetAtom(settingsOpenAtom);
  const setFocus = useSetAtom(settingsFocusAtom);
  const setUpdateStatus = useSetAtom(updateStatusAtom);
  const updateInstallPreflightTasks = useAtomValue(updateInstallPreflightTasksAtom);
  const updateInstallInFlightRef = useRef(false);

  /**
   * File editors debounce writes during normal typing. Before an updater-triggered process
   * exit, explicitly flush every registered editor and keep the user in the app on failure.
   */
  const installAppUpdate = useCallback(async () => {
    if (updateInstallInFlightRef.current) return;
    updateInstallInFlightRef.current = true;
    try {
      const allSaved = await flushUpdateInstallPreflight(updateInstallPreflightTasks.values());
      if (!allSaved) {
        showNotice(
          t("update.saveBeforeInstallDetail"),
          0,
          "error",
          t("update.saveBeforeInstallTitle"),
        );
        return;
      }
      await api.app.installUpdate();
    } catch (error) {
      showNotice(
        t("update.installFailedDetail", {
          error: error instanceof Error ? error.message : String(error),
        }),
        0,
        "error",
        t("update.installFailedTitle"),
      );
    } finally {
      updateInstallInFlightRef.current = false;
    }
  }, [updateInstallPreflightTasks]);

  // 按字段级 useMemo 稳定弹窗 props：App 根组件重渲染（低频）不会连带
  // 重渲染 SettingsModal（memo）。piUpdate 内部函数均为 useCallback，
  // 原语字段不变则引用不变。
  const modalProps = useMemo(
    () => ({
      settings: props.settings,
      piStatus: props.piUpdate.piStatus,
      piChecking: props.piUpdate.piChecking,
      piProxyChecking: props.piUpdate.piProxyChecking,
      piProxyNotice: props.piUpdate.piProxyNotice,
      piProxyNoticeTone: props.piUpdate.piProxyNoticeTone,
      webServiceChanging: props.webServiceChanging,
      appInfo: props.appInfo,
      customPiPath: props.piUpdate.customPiPath,
      customPathValidating: props.piUpdate.customPathValidating,
      customPathResult: props.piUpdate.customPathResult,
      updateChecking: false,
      piUpdating: props.piUpdate.piUpdating,
      piUpdateChecking: props.piUpdate.piUpdateChecking,
      piUpdateCheck: props.piUpdate.piUpdateCheck,
      piUpdateResult: props.piUpdate.piUpdateResult,
      onCustomPathChange: (path: string) => {
        props.piUpdate.setCustomPiPath(path);
        props.piUpdate.setCustomPathResult(null);
      },
      onValidateCustomPath: props.piUpdate.validateCustomPiPath,
      onClearCustomPath: props.piUpdate.clearCustomPiPath,
      onCheckPi: props.piUpdate.checkPiInstallInline,
      onTestPiProxy: props.piUpdate.testPiProxy,
      onCheckUpdate: () => {
        // 手动检测：直接触发主进程检查（结果经快照推送，设置页状态卡片响应）。
        void api.app.checkUpdate();
        void api.app.getUpdateStatus().then((snapshot) => {
          if (snapshot) setUpdateStatus(snapshot);
        });
      },
      onInstallUpdate: () => void installAppUpdate(),
      onDownloadUpdate: () => void api.app.downloadUpdate(),
      onCheckPiUpdate: props.piUpdate.checkPiCliUpdate,
      onUpdatePi: props.piUpdate.updatePiCli,
      onToggleDevTools: () => {
        void api.app.toggleDevTools().then((opened) => {
          showNotice(opened ? t("app.devToolsOpened") : t("app.devToolsClosed"));
        });
      },
      onRestartApp: () => api.app.restart(),
      onRestartWebService: props.onRestartWebService,
      onClearCheckFlag: async () => {
        await api.settings.update({ piEnvironmentChecked: false });
        showNotice(t("environment.checkFlagCleared"));
      },
      // forceSystem=true：Web 服务页必须离开内置浏览器面板——面板在 Dialog 下层，
      // 设置弹窗打开时会被遮挡；且外部端按桌面浏览器视口设计，系统浏览器体验更完整。
      onOpenWebService: (port: string) => api.app.openExternal(`http://127.0.0.1:${port}`, true),
      onClose: () => {
        // 关闭时清掉未消费的深链，避免下次从侧栏打开仍跳到 Git 分区。
        setFocus(null);
        setOpen(false);
      },
      onChange: props.onChange,
      projectPath: props.projectPath,
    }),
    [
      props.settings,
      props.piUpdate.piStatus,
      props.piUpdate.piChecking,
      props.piUpdate.piProxyChecking,
      props.piUpdate.piProxyNotice,
      props.piUpdate.piProxyNoticeTone,
      props.webServiceChanging,
      props.appInfo,
      props.piUpdate.customPiPath,
      props.piUpdate.customPathValidating,
      props.piUpdate.customPathResult,
      props.piUpdate.piUpdateChecking,
      props.piUpdate.piUpdateCheck,
      props.piUpdate.piUpdateResult,
      props.piUpdate.setCustomPiPath,
      props.piUpdate.setCustomPathResult,
      props.piUpdate.validateCustomPiPath,
      props.piUpdate.clearCustomPiPath,
      props.piUpdate.checkPiInstallInline,
      props.piUpdate.testPiProxy,
      props.piUpdate.checkPiCliUpdate,
      props.piUpdate.updatePiCli,
      props.piUpdate.piUpdating,
      props.onRestartWebService,
      props.onChange,
      props.projectPath,
      installAppUpdate,
      setFocus,
      setOpen,
    ],
  );

  if (!open) return null;

  return (
    <Suspense fallback={null}>
      <SettingsModal {...modalProps} />
    </Suspense>
  );
}
