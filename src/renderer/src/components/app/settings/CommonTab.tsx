import { memo } from "react";
import { useAtomValue } from "jotai";
import type { AppSettings } from "../../../../../shared/types";
import { dshUiVisibilityFor } from "../../../../../shared/types/dshRuntime";
import { dshRuntimeStatusAtom } from "../../../atoms";
import { t } from "../../../i18n";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui-shadcn/select";
import { Input } from "../../ui-shadcn/input";
import { SettingsSection } from "./SettingsStorageTab";
import { DirtyMarker, SettingBox, SettingRow, SettingSwitchRow } from "./SettingRows";
import { VoiceTranscriptionSettingsSection } from "./VoiceTranscriptionSettingsSection";

type CommonTabProps = {
  draft: AppSettings;
  updateDraft: (patch: Partial<AppSettings>) => void;
  isDirty: (field: keyof AppSettings) => boolean;
};

/** 下拉选项：disabled 可选（SelectItem 透传） */
type SelectOption = { value: string; label: string; disabled?: boolean };

/**
 * 设置弹框「常用设置」tab：语言/会话/通知/窗口（Git 分区已拆为独立 tab）。
 * 独立组件 + memo：切换 tab 或壳层无关状态变化时不重渲染本 tab。
 */
export const CommonTab = memo(function CommonTab(props: CommonTabProps) {
  const { draft, updateDraft, isDirty } = props;
  // DSH runtime 安装态：runtime 不可用时 dsh 选项禁选，
  // 否则用户能选到一个「保存成功但新建会话必失败」的后端。
  const dshRuntimeStatus = useAtomValue(dshRuntimeStatusAtom);
  const dshAvailable = dshUiVisibilityFor(dshRuntimeStatus.state).canCreateDshSession;
  const languageOptions: SelectOption[] = [
    { value: "system", label: t("settings.languageSystem") },
    { value: "zh-CN", label: t("settings.languageZh") },
    { value: "en-US", label: t("settings.languageEn") },
    { value: "pseudo", label: t("settings.languagePseudo") },
  ];
  const sendShortcutOptions: SelectOption[] = [
    { value: "enter-send", label: t("settings.sendShortcut.enter") },
    { value: "ctrl-enter-send", label: t("settings.sendShortcut.ctrl") },
    { value: "shift-enter-send", label: t("settings.sendShortcut.shift") },
  ];
  const linkOpenModeOptions: SelectOption[] = [
    { value: "external", label: t("settings.linkOpenMode.external") },
    { value: "internal", label: t("settings.linkOpenMode.internal") },
  ];
  const workspaceContentOpenModeOptions: SelectOption[] = [
    { value: "split", label: t("settings.workspaceContentOpenMode.split") },
    { value: "maximize", label: t("settings.workspaceContentOpenMode.maximize") },
  ];
  const busySendDeliveryOptions: SelectOption[] = [
    { value: "steer", label: t("settings.busySendDeliverySteer") },
    { value: "followUp", label: t("settings.busySendDeliveryFollowUp") },
  ];
  const startupWindowModeOptions: SelectOption[] = [
    { value: "last", label: t("settings.startupWindow.last") },
    { value: "maximized", label: t("settings.startupWindow.maximized") },
    { value: "normal-large", label: t("settings.startupWindow.large") },
    { value: "normal-medium", label: t("settings.startupWindow.medium") },
    { value: "normal-compact", label: t("settings.startupWindow.compact") },
    { value: "fullscreen", label: t("settings.startupWindow.fullscreen") },
  ];

  return (
    <>
      {/* 语言（单行分区：行标题即一级标题，内容行入淡色框） */}
      <SettingBox>
        <SettingRow
          level={1}
          title={
            <>
              <span>{t("settings.language")}</span>
              <DirtyMarker dirty={isDirty("language")} label={t("settings.language")} />
            </>
          }
          alignEnd={false}
        >
          <Select value={draft.language} onValueChange={(value) =>
              updateDraft({ language: value as AppSettings["language"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {languageOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingBox>

      <VoiceTranscriptionSettingsSection />

      {/* 会话 */}
      <SettingsSection title={t("settings.sectionSession")}>
        <SettingRow
          title={
            <>
              <span>{t("settings.sessionTabOpenMode")}</span>
              <DirtyMarker dirty={isDirty("sessionTabOpenMode")} label={t("settings.sessionTabOpenMode")} />
            </>
          }
          alignEnd={false}
        >
          <Select value={draft.sessionTabOpenMode} onValueChange={(value) =>
              updateDraft({ sessionTabOpenMode: value as AppSettings["sessionTabOpenMode"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="preview">{t("settings.sessionTabOpenModePreview")}</SelectItem>
              <SelectItem value="permanent">{t("settings.sessionTabOpenModePermanent")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingSwitchRow
          title={t("settings.autoSessionTitle")}
          description={t("settings.autoSessionTitleDesc")}
          checked={draft.autoSessionTitle ?? true}
          dirty={isDirty("autoSessionTitle")}
          onChange={(checked) => updateDraft({ autoSessionTitle: checked })}
        />
        <SettingRow
          title={
            <>
              <span>{t("settings.inputShortcut")}</span>
              <DirtyMarker dirty={isDirty("sendShortcut")} label={t("settings.inputShortcut")} />
            </>
          }
          alignEnd={false}
        >
          <Select value={draft.sendShortcut} onValueChange={(value) =>
              updateDraft({ sendShortcut: value as AppSettings["sendShortcut"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {sendShortcutOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={
            <>
              <span>{t("settings.defaultAgentBackend")}</span>
              <DirtyMarker dirty={isDirty("defaultAgentBackend")} label={t("settings.defaultAgentBackend")} />
            </>
          }
          description={t("settings.defaultAgentBackendDesc")}
          alignEnd={false}
        >
          <Select
            value={draft.defaultAgentBackend}
            onValueChange={(value) =>
              updateDraft({ defaultAgentBackend: value as AppSettings["defaultAgentBackend"] })
            }
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="pi">{t("settings.defaultAgentBackendPi")}</SelectItem>
              <SelectItem value="dsh" disabled={!dshAvailable}>
                {dshAvailable
                  ? t("settings.defaultAgentBackendDsh")
                  : t("settings.defaultAgentBackendDshUnavailable")}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        {/* DSH runtime 管理已迁至 DSH 配置 → 概览页（DshRuntimeSection 区块：
            未装→安装引导，已装→版本/目录/卸载/导入），这里不再重复放状态行。 */}
        {/* 忙碌时投递行为：Agent 回复期间发送消息的默认语义（pi/dsh 统一）。 */}
        <SettingRow
          title={
            <>
              <span>{t("settings.busySendDelivery")}</span>
              <DirtyMarker dirty={isDirty("busySendDelivery")} label={t("settings.busySendDelivery")} />
            </>
          }
          description={t("settings.busySendDeliveryDesc")}
          alignEnd={false}
        >
          <Select
            value={draft.busySendDelivery}
            onValueChange={(value) =>
              updateDraft({ busySendDelivery: value as AppSettings["busySendDelivery"] })
            }
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {busySendDeliveryOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={
            <>
              <span>{t("settings.linkOpenMode")}</span>
              <DirtyMarker dirty={isDirty("linkOpenMode")} label={t("settings.linkOpenMode")} />
            </>
          }
          alignEnd={false}
        >
          <Select value={draft.linkOpenMode} onValueChange={(value) =>
              updateDraft({ linkOpenMode: value as AppSettings["linkOpenMode"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {linkOpenModeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={
            <>
              <span>{t("settings.workspaceContentOpenMode")}</span>
              <DirtyMarker dirty={isDirty("workspaceContentOpenMode")} label={t("settings.workspaceContentOpenMode")} />
            </>
          }
          description={t("settings.workspaceContentOpenModeDesc")}
          alignEnd={false}
        >
          <Select
            value={draft.workspaceContentOpenMode ?? "split"}
            onValueChange={(value) =>
              updateDraft({
                workspaceContentOpenMode: value as AppSettings["workspaceContentOpenMode"],
              })
            }
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {workspaceContentOpenModeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {/* 流式对话设置：中间过程与本轮修改文件的默认展示行为。 */}
        <SettingSwitchRow
          title={t("settings.expandInterimDuringStream")}
          description={t("settings.expandInterimDuringStreamDesc")}
          checked={draft.expandInterimDuringStream}
          onChange={(checked) => updateDraft({ expandInterimDuringStream: checked })}
        />
        <SettingSwitchRow
          title={t("settings.collapsePrevRunsOnNewTurn")}
          description={t("settings.collapsePrevRunsOnNewTurnDesc")}
          checked={draft.collapsePrevRunsOnNewTurn}
          onChange={(checked) => updateDraft({ collapsePrevRunsOnNewTurn: checked })}
        />
      </SettingsSection>

      {/* 闲置 Agent 内存优化：自动释放长时间闲置的 agent 进程，降低多会话内存占用 */}
      <SettingsSection
        title={t("settings.idleAgentSection")}
        description={t("settings.idleAgentSectionDesc")}
      >
        <SettingSwitchRow
          title={t("settings.idleAgentAutoRelease")}
          description={t("settings.idleAgentAutoReleaseDesc")}
          checked={draft.idleAgentAutoRelease ?? true}
          dirty={isDirty("idleAgentAutoRelease")}
          onChange={(checked) => updateDraft({ idleAgentAutoRelease: checked })}
        />
        <SettingRow
          title={
            <span className="inline-flex items-center gap-1.5">
              <DirtyMarker dirty={isDirty("idleAgentKeepCount")} label={t("settings.idleAgentKeepCount")} />
              {t("settings.idleAgentKeepCount")}
            </span>
          }
          description={t("settings.idleAgentKeepCountDesc")}
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={20}
              step={1}
              className="w-24"
              value={String(draft.idleAgentKeepCount ?? 5)}
              onChange={(event) => {
                const n = parseInt(event.target.value, 10);
                updateDraft({ idleAgentKeepCount: Number.isFinite(n) ? n : 5 });
              }}
              aria-label={t("settings.idleAgentKeepCount")}
            />
            <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
              {t("settings.idleAgentCountUnit")}
            </span>
          </div>
        </SettingRow>
        <SettingRow
          title={
            <span className="inline-flex items-center gap-1.5">
              <DirtyMarker dirty={isDirty("idleAgentTimeoutMin")} label={t("settings.idleAgentTimeoutMin")} />
              {t("settings.idleAgentTimeoutMin")}
            </span>
          }
          description={t("settings.idleAgentTimeoutMinDesc")}
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={1440}
              step={5}
              className="w-24"
              value={String(draft.idleAgentTimeoutMin ?? 60)}
              onChange={(event) => {
                const n = parseInt(event.target.value, 10);
                updateDraft({ idleAgentTimeoutMin: Number.isFinite(n) ? n : 60 });
              }}
              aria-label={t("settings.idleAgentTimeoutMin")}
            />
            <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
              {t("settings.idleAgentTimeoutUnit")}
            </span>
          </div>
        </SettingRow>
      </SettingsSection>

      {/* 通知 */}
      <SettingsSection title={t("settings.notificationSection")}>
        <SettingSwitchRow
          title={t("settings.enableNotifications")}
          checked={draft.enableNotifications}
          onChange={(checked) =>
            updateDraft({ enableNotifications: checked })
          }
        />
        <SettingSwitchRow
          title={t("settings.askNotification")}
          description={t("settings.askNotificationDesc")}
          checked={draft.askNotificationEnabled}
          onChange={(checked) =>
            updateDraft({ askNotificationEnabled: checked })
          }
        />
        <SettingSwitchRow
          title={t("settings.agentCountReminder")}
          description={t("settings.agentCountReminderDesc")}
          checked={draft.agentCountReminderEnabled}
          onChange={(checked) =>
            updateDraft({ agentCountReminderEnabled: checked })
          }
        />
      </SettingsSection>

      {/* 窗口 */}
      <SettingsSection title={t("settings.sectionWindow")}>
        <SettingRow
          title={
            <>
              <span>{t("settings.startupWindowMode")}</span>
              <DirtyMarker
                dirty={isDirty("startupWindowMode")}
                label={t("settings.startupWindowMode")}
              />
            </>
          }
          description={t("settings.startupWindowModeDesc")}
          alignEnd={false}
        >
          <Select value={draft.startupWindowMode} onValueChange={(value) =>
              updateDraft({
                startupWindowMode: value as AppSettings["startupWindowMode"],
              })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {startupWindowModeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingSwitchRow
          title={t("settings.closeToTray")}
          checked={draft.closeToTray}
          onChange={(checked) =>
            updateDraft({ closeToTray: checked })
          }
        />
        <SettingSwitchRow
          title={t("settings.singleInstance")}
          description={t("settings.singleInstanceDesc")}
          checked={draft.singleInstance}
          onChange={(checked) =>
            updateDraft({ singleInstance: checked })
          }
        />
      </SettingsSection>
    </>
  );
});
