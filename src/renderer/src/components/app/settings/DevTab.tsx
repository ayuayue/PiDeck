import { memo, useEffect, useState } from "react";
import type {
  AppInfo,
  AppSettings,
  PiCliUpdateResult,
  PiInstallStatus,
  PiUpdateCheckResult,
} from "../../../../../shared/types";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { useAtomValue } from "jotai";
import { updateStatusAtom } from "../../../atoms/update-atoms";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui-shadcn/select";
import { SettingsSection } from "./SettingsStorageTab";
import { AppUpdateCard } from "./AppUpdateCard";
import { DirtyMarker, SettingRow, SettingSwitchRow } from "./SettingRows";
import { UpdateSourceSetting } from "./UpdateSourceSetting";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { CatalogSection } from "./CatalogSection";

type DevTabProps = {
  draft: AppSettings;
  updateDraft: (patch: Partial<AppSettings>) => void;
  isDirty: (field: keyof AppSettings) => boolean;
  appInfo: AppInfo;
  piStatus: PiInstallStatus | null;
  piChecking: boolean;
  customPiPath: string;
  customPathValidating: boolean;
  customPathResult: PiInstallStatus | null;
  onCustomPathChange: (path: string) => void;
  onValidateCustomPath: () => void;
  onClearCustomPath: () => void;
  onCheckPi: () => void;
  onClearCheckFlag?: () => void;
  piUpdateChecking: boolean;
  onCheckPiUpdate: () => void;
  piUpdating: boolean;
  onUpdatePi: () => void;
  piUpdateCheck: PiUpdateCheckResult | null;
  piUpdateResult: PiCliUpdateResult | null;
  updateChecking: boolean;
  onCheckUpdate: () => void;
  /** 手动下载（自动下载关闭时显示「立即下载」）。 */
  onDownloadUpdate: () => void;
  /** 重启并安装（下载完成后显示）。 */
  onInstallUpdate: () => void;
  onToggleDevTools: () => void;
  onRestartApp: () => void;
  /** 壳层「取消」递增；本 tab 借此重置 WSL / Web 端口等局部状态 */
  resetKey: number;
};

/** 下拉选项：disabled 可选（SelectItem 透传） */
type SelectOption = { value: string; label: string; disabled?: boolean };

/**
 * 设置弹框「开发设置」tab：环境/版本更新/运行参数/调试/隐私。
 * 独立组件 + memo：WSL 等局部状态自持，只有进入本 tab 才加载；
 * Web 本地服务与外部编辑器已拆为独立 tab（settings/WebTab.tsx、settings/EditorsTab.tsx）。
 */
export const DevTab = memo(function DevTab(props: DevTabProps) {
  const { draft, updateDraft, isDirty } = props;
  const piPath = props.customPiPath || props.piStatus?.command || "";
  // 后台检查发现可提示的 PiDeck 新版本（未跳过）时高亮设置页更新分区。
  const updateStatus = useAtomValue(updateStatusAtom);
  const piCliStatus = updateStatus?.piCli ?? null;
  // 手动检查的结果比定时后台快照更新，统一决定提示内容和更新按钮是否可用。
  const piUpdateStatus = props.piUpdateCheck ?? piCliStatus;
  const piUpdateAvailable = Boolean(piUpdateStatus?.hasUpdate);
  const piUpdateNotice =
    piUpdateAvailable && piUpdateStatus?.latestVersion
      ? piUpdateStatus
      : null;

  // ── WSL 相关状态（仅 Windows + WSL 开启时拉取）──
  const [wslUserInput, setWslUserInput] = useState(draft.wslUser);
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  const [wslDistrosLoading, setWslDistrosLoading] = useState(false);
  const [wslDistrosAttempted, setWslDistrosAttempted] = useState(false);
  const [wslValidating, setWslValidating] = useState(false);
  const [wslValidation, setWslValidation] = useState<{
    ok: boolean;
    whoami: string;
    piVersion: string;
    error: string;
  } | null>(null);
  // WSL 发行版列表懒加载（仅 Windows + WSL 开启时拉取，无论成败只拉一次）
  useEffect(() => {
    const isWin = props.appInfo.platform === "win32";
    if (isWin && draft.wslEnabled && !wslDistrosAttempted && !wslDistrosLoading && window.piDesktop.wsl) {
      setWslDistrosLoading(true);
      window.piDesktop.wsl
        .listDistros()
        .then((list) => { setWslDistros(list); setWslDistrosAttempted(true); })
        .catch(() => { setWslDistros([]); setWslDistrosAttempted(true); })
        .finally(() => setWslDistrosLoading(false));
    }
  }, [draft.wslEnabled, wslDistrosAttempted, wslDistrosLoading, props.appInfo.platform]);

  const distroOptions: SelectOption[] = wslDistros.length > 0
    ? wslDistros.map((d) => ({ value: d, label: d }))
    : [{ value: draft.wslDistro, label: draft.wslDistro }];

  const handleValidateWslUser = async () => {
    if (!window.piDesktop.wsl) {
      setWslValidation({ ok: false, whoami: "", piVersion: "", error: t("settings.wsl.apiUnavailable") });
      return;
    }
    setWslValidating(true);
    setWslValidation(null);
    try {
      const result = await window.piDesktop.wsl.validateConnection(draft.wslDistro, wslUserInput);
      setWslValidation(result);
      if (result.ok) {
        // 验证通过后，将用户输入写入 draft
        updateDraft({ wslUser: wslUserInput });
      }
    } catch (err) {
      console.error("[Settings] WSL validation failed", err);
      setWslValidation({ ok: false, whoami: "", piVersion: "", error: t("settings.wsl.validationFailed") });
    } finally {
      setWslValidating(false);
    }
  };

  // 壳层「取消」：重置本 tab 局部编辑态（WSL 输入）
  useEffect(() => {
    setWslValidation(null);
    setWslUserInput(draft.wslUser);
  }, [props.resetKey]); // eslint-disable-line react-hooks/exhaustive-deps


  const piSourceOptions: SelectOption[] = [
    { value: "windows", label: t("settings.piSource.windows") },
    { value: "wsl", label: t("settings.piSource.wsl") },
  ];

  return (
    <>
      {/* 环境 */}
      {/* 开发设置 tab 不自动检测 pi：检测结果缓存在 settings.piInstall（打开时直接显示），
          只有用户手动点「检测环境」才重新 spawn 探测（曾因自动检测在打开设置时触发双弹窗）。 */}
      <SettingsSection title={t("settings.environment")}>
        {/* Pi CLI 状态：安装检测 + 路径信息 + 重新检测 */}
        <div className="setting-pi-status">
          <div className="setting-pi-status-indicator">
            <span
              className={"pi-status-dot " + (props.piStatus?.installed ? "online" : "offline")}
            />
            <div className="setting-pi-status-text">
              <strong>Pi CLI</strong>
              <span>
                {props.piStatus
                  ? props.piStatus.installed
                    ? t("settings.foundPi", {
                        version: props.piStatus.version ?? "pi",
                      })
                    : t("settings.piMissing")
                  : t("settings.piCliAvailable")}
              </span>
              {piPath && (
                <span className="setting-path">
                  {piPath}
                </span>
              )}
              {props.piStatus && !props.piStatus.installed && props.piStatus.error && (
                <span className="setting-status error">
                  {props.piStatus.error}
                </span>
              )}
            </div>
          </div>
          <div className="setting-inline-actions">
            <Button variant="secondary" onClick={props.onCheckPi} disabled={props.piChecking}>
              {props.piChecking
                ? t("settings.detecting")
                : t("settings.detectEnvironment")}
            </Button>
            {props.onClearCheckFlag && (
              <Button variant="secondary"
                onClick={props.onClearCheckFlag}
              >
                {t("environment.clearCheckFlag")}
              </Button>
            )}
            <Button variant="secondary"
              onClick={props.onCheckPiUpdate}
              loading={props.piUpdateChecking}
            >
              {t("settings.checkPiUpdate")}
            </Button>
            <Button variant="secondary"
              onClick={props.onUpdatePi}
              loading={props.piUpdating}
              disabled={!piUpdateAvailable}
            >
              {t("settings.updatePi")}
            </Button>
          </div>
        </div>
        {/* 后台检查发现的 Pi CLI 更新必须靠近操作按钮，避免提示与入口分属不同分区。 */}
        {piUpdateNotice && (
          <div className="mb-2 rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-3 py-2 text-caption text-text-primary">
            {t("settings.piUpdateAvailableDetail", {
              current: piUpdateNotice.currentVersion ?? t("common.unknown"),
              latest: piUpdateNotice.latestVersion,
            })}
          </div>
        )}
        {props.piUpdateResult && (
          <pre className="setting-update-output">
            {props.piUpdateResult.command}
            {"\n"}
            {props.piUpdateResult.output}
          </pre>
        )}

        <div className="my-3 border-0 border-t border-border-subtle" />

        {/* Pi 来源：Windows 原生 / WSL（仅 Windows 可见） */}
        {props.appInfo.platform === "win32" && (
          <div className="setting-pi-source-block">
            <div className="setting-pi-source-row">
              <span>{t("settings.piSource.label")}</span>
              <div className="grid gap-1.5">
                <Select value={draft.wslEnabled ? "wsl" : "windows"} onValueChange={(value) => {
                  updateDraft({ wslEnabled: value === "wsl" });
                  setWslValidation(null);
                }}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {piSourceOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {draft.wslEnabled && (
              <div className="setting-pi-wsl-config">
                <div className="setting-wsl-fields">
                  {wslDistros.length > 0 ? (
                    <div className="grid min-w-[160px] flex-1 gap-1.5">
                      <span className="text-control font-medium text-foreground">{t("settings.wsl.distro")}</span>
                      <Select value={draft.wslDistro} onValueChange={(value) => {
                        updateDraft({ wslDistro: value });
                        setWslValidation(null);
                      }}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {distroOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : (
                    <div className="grid min-w-[160px] flex-1 gap-1.5">
                      <span className="text-control font-medium text-foreground">{t("settings.wsl.distro")}</span>
                      <Input type="text" value={draft.wslDistro} placeholder={"Ubuntu"} onChange={(event) => {
                        updateDraft({ wslDistro: event.target.value });
                        setWslValidation(null);
                      }} />
                    </div>
                  )}
                  {wslDistrosLoading && (
                    <small className="setting-status info">{t("settings.wsl.detectingDistros")}</small>
                  )}
                  <div className="setting-wsl-user-row">
                    <div className="grid min-w-[160px] flex-1 gap-1.5">
                      <span className="text-control font-medium text-foreground">{t("settings.wsl.user")}</span>
                      <Input type="text" value={wslUserInput} placeholder={"root"} onChange={(event) => {
                        setWslUserInput(event.target.value);
                        setWslValidation(null);
                      }} />
                    </div>
                    <Button variant="secondary"
                      size="sm"
                      disabled={!wslUserInput.trim() || wslValidating}
                      loading={wslValidating}
                      onClick={handleValidateWslUser}
                    >
                      {t("settings.wsl.validateUser")}
                    </Button>
                  </div>
                </div>
                {wslValidation && (
                  <div className={`setting-wsl-validation ${wslValidation.ok ? "success" : "error"}`}>
                    {wslValidation.ok ? (
                      <>
                        <small className="setting-status success">
                          {t("settings.wsl.validationOk", {
                            user: wslValidation.whoami,
                            distro: draft.wslDistro,
                          })}
                        </small>
                        {wslValidation.piVersion ? (
                          <small className="setting-status success">
                            {t("settings.wsl.piDetected", { version: wslValidation.piVersion })}
                          </small>
                        ) : (
                          <small className="setting-status warning">
                            {wslValidation.error || t("settings.wsl.piNotInstalled")}
                          </small>
                        )}
                      </>
                    ) : (
                      <small className="setting-status error">{wslValidation.error}</small>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="my-3 border-0 border-t border-border-subtle" />

        {/* 自定义 Pi 路径 */}
        <div className="setting-pi-path-panel">
          <SettingRow
            title={<span>{t("settings.customPiPath")}</span>}
            description={t("settings.customPiPathHint")}
            stacked
          >
            <Input type="text" value={props.customPiPath} placeholder={
              piPath ||
              "D:\\mise-data\\installs\\node\\24 13 0\\pi.cmd"
            } disabled={props.customPathValidating} onChange={(event) => props.onCustomPathChange(event.target.value)} />
          </SettingRow>
          <div className="setting-pi-path-actions">
            <Button variant="secondary"
              onClick={props.onValidateCustomPath}
              disabled={!props.customPiPath.trim() || props.customPathValidating}
            >
              {props.customPathValidating
                ? t("settings.validating")
                : t("settings.validatePiPath")}
            </Button>
            <Button variant="secondary"
              onClick={props.onClearCustomPath}
              disabled={!props.customPiPath || props.customPathValidating}
            >
              {t("settings.clearCustomPiPath")}
            </Button>
          </div>
          {props.customPathResult && (
            <small className={`setting-status ${props.customPathResult.installed ? "success" : "error"}`}>
              {props.customPathResult.installed
                ? t("settings.validatePassed", {
                    value:
                      props.customPathResult.command ??
                      props.customPathResult.version ??
                      "pi",
                  })
                : t("settings.validateFailed", {
                    error:
                      props.customPathResult.error ??
                      t("environment.unableToRun"),
                  })}
            </small>
          )}
        </div>
      </SettingsSection>

      {/* 版本与更新（electron-updater 快照驱动：检测/下载/安装状态一览，语义对齐 Netcatty 设置卡片） */}
      <SettingsSection title={t("settings.sectionUpdates")}>
        <AppUpdateCard
          appVersion={props.appInfo.version}
          platform={props.appInfo.platform}
          releasesUrl={props.appInfo.releasesUrl}
          checking={props.updateChecking}
          onCheckUpdate={props.onCheckUpdate}
          onDownloadUpdate={props.onDownloadUpdate}
          onInstallUpdate={props.onInstallUpdate}
        />
        {props.appInfo.platform === "darwin" ? (
          <p className="px-0.5 text-caption text-muted-foreground">
            {t("settings.macManualUpdateDesc")}
          </p>
        ) : (
          <SettingSwitchRow
            title={t("settings.autoDownloadUpdates")}
            description={t("settings.autoDownloadUpdatesDesc")}
            checked={draft.autoDownloadUpdates !== false}
            onChange={(checked) => updateDraft({ autoDownloadUpdates: checked })}
          />
        )}
        <UpdateSourceSetting draft={draft} updateDraft={updateDraft} />
      </SettingsSection>

      {/* 模型目录：内置随版本发布，可从 GitHub 拉取最新覆盖 */}
      <CatalogSection />

      {/* 运行 */}
      <SettingsSection title={t("settings.sectionRuntime")}>
        <SettingRow
          title={
            <>
              <span>{t("settings.rpcTimeout")}</span>
              <DirtyMarker dirty={isDirty("rpcTimeout")} label={t("settings.rpcTimeout")} />
            </>
          }
          description={t("settings.rpcTimeoutDesc")}
          stacked
        >
          <Input
            type="number"
            className="max-w-80"
            value={String(Math.round(draft.rpcTimeout / 1000))}
            onChange={(e) => {
              const seconds = Math.max(600, parseInt(e.target.value) || 600);
              updateDraft({ rpcTimeout: seconds * 1000 });
            }}
          />
        </SettingRow>
        <SettingRow
          title={
            <>
              <span>{t("settings.maxEditorFileSize")}</span>
              <DirtyMarker dirty={isDirty("maxEditorFileSizeMB")} label={t("settings.maxEditorFileSize")} />
            </>
          }
          description={t("settings.maxEditorFileSizeDesc")}
          stacked
        >
          <Input
            type="number"
            className="max-w-80"
            value={String(draft.maxEditorFileSizeMB)}
            onChange={(e) => {
              const mb = Math.max(1, parseInt(e.target.value) || 5);
              updateDraft({ maxEditorFileSizeMB: mb });
            }}
          />
        </SettingRow>
        <SettingSwitchRow
          title={t("settings.electronSandbox")}
          description={t("settings.electronSandboxDesc")}
          checked={draft.electronChromiumSandbox}
          onChange={(checked) =>
            updateDraft({ electronChromiumSandbox: checked })
          }
        />
        <div className="px-0.5 pb-1 pt-3">
          <span className="text-caption font-semibold tracking-[0.06em] text-muted-foreground">{t("settings.piRpcStartup")}</span>
          <p className="mt-0.5 text-caption text-muted-foreground">{t("settings.piRpcStartupDesc")}</p>
        </div>
        <SettingSwitchRow
          title={t("settings.piRpcOffline")}
          description={t("settings.piRpcOfflineDesc")}
          checked={draft.piRpcOffline}
          onChange={(checked) => updateDraft({ piRpcOffline: checked })}
        />
        <SettingSwitchRow
          title={t("settings.piRpcNoExtensions")}
          description={t("settings.piRpcNoExtensionsDesc")}
          checked={draft.piRpcNoExtensions}
          onChange={(checked) => updateDraft({ piRpcNoExtensions: checked })}
        />
        <SettingSwitchRow
          title={t("settings.piRpcNoSkills")}
          description={t("settings.piRpcNoSkillsDesc")}
          checked={draft.piRpcNoSkills}
          onChange={(checked) => updateDraft({ piRpcNoSkills: checked })}
        />
      </SettingsSection>

      {/* 调试 */}
      <SettingsSection title={t("settings.debug")}>
        <SettingRow
          title={<span>{t("settings.restartApp")}</span>}
          description={t("settings.restartAppDesc")}
        >
          <Button variant="secondary" onClick={props.onRestartApp}>
            {t("settings.restartAppButton")}
          </Button>
        </SettingRow>
        <SettingRow
          title={<span>{t("settings.devTools")}</span>}
          description={t("settings.devToolsDesc")}
        >
          <Button variant="secondary" onClick={props.onToggleDevTools}>
            {t("settings.toggle")}
          </Button>
        </SettingRow>
        <SettingRow
          title={<span>{t("settings.openDataDir")}</span>}
          description={
            props.appInfo.userDataDir ? (
              // 路径放左列描述位，truncate + tooltip：长路径不换行挤行，hover 可看完整路径
              <code
                className="block truncate font-mono text-caption text-muted-foreground"
                title={props.appInfo.userDataDir}
              >
                {props.appInfo.userDataDir}
              </code>
            ) : undefined
          }
        >
          <Button variant="secondary" onClick={() => void desktopApi.app.openDataDir()}>
            {t("settings.openDataDirButton")}
          </Button>
        </SettingRow>
        <DiagnosticsPanel
          enabled={draft.developerDiagnostics}
          onChange={(checked) => updateDraft({ developerDiagnostics: checked })}
        />
      </SettingsSection>

      {/* 隐私 */}
      <SettingsSection title={t("settings.privacy")}>
        <SettingSwitchRow
          title={t("settings.telemetry")}
          description={t("settings.telemetryDesc")}
          checked={draft.telemetryEnabled}
          onChange={(checked) =>
            updateDraft({ telemetryEnabled: checked })
          }
        />
      </SettingsSection>
    </>
  );
});
