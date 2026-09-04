import { forwardRef, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import {
  ComposerBottomBar,
  ImagePreviewModal,
  PromptSuggestions,
} from "./ComposerParts";
import {
  TipTapComposer,
} from "./composer";
import { SessionReferenceModal } from "../app/SessionReferenceModal";
import { t } from "../../i18n";
import { useSessionComposerController } from "../../hooks/useSessionComposerController";
import {
  ComposerAttachmentBar,
  ComposerSendControls,
  SessionDeliveryNotice,
} from "./ComposerPanels";
import { ComposerPickerHost } from "./ComposerPickerHost";
import { SecurityControl } from "./SecurityControl";
import { modelPendingByIdAtom } from "../../atoms/composer-atoms";
import { ComposerRuntimeIntegrations } from "./ComposerRuntimeIntegrations";
import { useSessionPaneServices } from "./SessionPaneServices";
import { desktopApi } from "../../desktopApi";
import { COMPOSER_TEXT_MAX_HEIGHT } from "../../rendererUtils";
import { chatContentWidthStyle } from "./chatContentWidth";
import { ComposerStatsLine } from "./ComposerStatsLine";
import {
  ComposerWidgetLayoutProvider,
  type ComposerWidgetCollapsedByKey,
  useComposerWidgetLayoutValue,
} from "./ComposerWidgetLayout";
import type { GitBranchInfo } from "../../../../shared/types";
import type { EnqueuePromptSnapshot } from "../../hooks/useSessionSend";
import { isLiveRuntimeStatus } from "../../utils/sessionCommands";

export type ComposerAreaProps = {
  sessionId: string;
  gitInfo?: GitBranchInfo;
  /** 底栏分支下拉的切换回调（owner 为 App 级 switchBranch，保持 Git 面板同步） */
  onSwitchBranch?: (branch: string) => void;
  /** 输入框上方独立卡（todo / goal）；放在 widgets 槽位。 */
  widgets?: ReactNode;
  /** 排队消息独立卡（与 todo/goal 同列同宽，不贴输入框、不右浮）。 */
  queuePanel?: ReactNode;
  enqueue?: (sessionId: string, snapshot: EnqueuePromptSnapshot) => boolean;
  ensureSessionId?: (sessionId: string) => Promise<string>;
  /** 当前会话中用户发起的轮次，用于 pi 统计栏；DSH 自带 sessionStats 时不重复显示。 */
  turnCount?: number;
  /** 引导页虚拟会话没有 SessionRecord，用它兑底确定文件树/模型目录所属项目。 */
  bootstrapProjectId?: string;
};

/** footer 同时带标准 CSS 与自定义封顶变量；交叉类型避免 `as` 强转。 */
function composerFooterStyle(): CSSProperties & {
  "--composer-text-max-height": string;
} {
  return {
    ...chatContentWidthStyle,
    "--composer-text-max-height": `${COMPOSER_TEXT_MAX_HEIGHT}px`,
  };
}

type ComposerExtrasProps = {
  widgets: ReactNode;
  queuePanel?: ReactNode;
  deliveryNotice: ReactNode;
  attachmentBar: ReactNode;
  composerBox: ReactNode;
  /** 输入卡正下方 StatsLine；与输入卡同一列，不吃剩余高度。 */
  statsLine?: ReactNode;
};

/**
 * 输入栏固有高度：独立卡按内容撑开，列被 max-height 卡住时才内部滚动。
 * 折叠状态放在这里，是为了一次重渲染就让 footer 跟着内容变高/变矮。
 */
function ComposerMeasuredExtras(props: ComposerExtrasProps) {
  const [collapsedByWidgetKey, setCollapsedByWidgetKey] = useState<ComposerWidgetCollapsedByKey>({});
  const widgetLayoutValue = useComposerWidgetLayoutValue(
    collapsedByWidgetKey,
    setCollapsedByWidgetKey,
  );
  const hasAttachmentBar = props.attachmentBar != null;

  return (
    <ComposerWidgetLayoutProvider value={widgetLayoutValue}>
      <>
        <div className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto overscroll-contain pb-px empty:hidden">
          {props.widgets}
          {props.queuePanel}
          {props.deliveryNotice}
        </div>
        {hasAttachmentBar ? (
          <div className="shrink-0">
            {props.attachmentBar}
          </div>
        ) : null}
        <div className="flex w-full min-w-0 shrink-0 flex-col">
          {props.composerBox}
          {props.statsLine}
        </div>
      </>
    </ComposerWidgetLayoutProvider>
  );
}

export const ComposerArea = forwardRef<HTMLElement, ComposerAreaProps>(function ComposerArea(
  props,
  footerRef,
) {
  const composer = useSessionComposerController({
    sessionId: props.sessionId,
    enqueue: props.enqueue,
    ensureSessionId: props.ensureSessionId,
    // 引导页虚拟会话（GUIDE_BOOTSTRAP_SESSION_ID）无 record：用选中项目加载
    // @ 引用文件树；真实会话忽略该字段（record.projectId 优先）。
    bootstrapProjectId: props.bootstrapProjectId,
    // 预览 Tab 里发消息 → 自动晋升常驻（由 App 装配的 SessionPaneServices 提供）
    onPromoteSession: useSessionPaneServices().promoteSessionToPermanent,
    onCreateSession: useSessionPaneServices().runCreateSessionDraft,
  });

  const modelPendingMap = useAtomValue(modelPendingByIdAtom);

  const prewarmStartedForSessionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!props.sessionId || !window.piDesktop) return;
    if (!composer.draft.trim() && composer.attachments.length === 0 && composer.pasteFiles.files.length === 0) return;
    if (prewarmStartedForSessionRef.current === props.sessionId) return;
    prewarmStartedForSessionRef.current = props.sessionId;

    // 输入是比“打开会话”更可靠的发送意图信号；只在首次输入后预热一次，
    // 避免用户仅浏览历史时创建进程，也避免每个按键重复触发 IPC。
    void desktopApi.sessions.activateRuntime(props.sessionId).catch(() => undefined);
  }, [composer.attachments.length, composer.draft, composer.pasteFiles.files.length, props.sessionId]);

  return (
    <ComposerRuntimeIntegrations sessionId={props.sessionId}>
      {({ feishuIndicator }) => (
        <>
          {/* 固有高度：内容撑开 footer；父列 max-height 卡住时独立卡内部滚动，
              输入卡 shrink-0 始终完整可见。 */}
          <footer
            ref={footerRef}
            className="composer flex max-h-full min-h-0 min-w-0 flex-col gap-2 overflow-hidden bg-transparent px-0 pb-2"
            style={composerFooterStyle()}
            data-session-id={props.sessionId}
          >
            <ComposerMeasuredExtras
              widgets={props.widgets ?? null}
              queuePanel={props.queuePanel}
              deliveryNotice={( 
                <SessionDeliveryNotice
                  status={composer.sendState.status}
                  message={composer.sendState.unknownSnapshot?.message}
                  images={composer.sendState.unknownSnapshot?.images}
                  error={composer.sendState.error}
                  onAcknowledge={composer.delivery.acknowledgeUnknown}
                />
              )}
              attachmentBar={
                composer.attachments.length > 0 || composer.pasteFiles.files.length > 0 ? (
                  <ComposerAttachmentBar
                    images={composer.attachments}
                    onPreview={composer.images.preview}
                    onRemove={composer.images.remove}
                    onClear={composer.images.clear}
                    pasteFiles={composer.pasteFiles.files}
                    onRemovePasteFile={composer.pasteFiles.remove}
                    onClearPasteFiles={composer.pasteFiles.clear}
                  />
                ) : null
              }
              statsLine={<ComposerStatsLine state={composer.runtime?.state} turnCount={props.turnCount} />}
              composerBox={
            <div
              // overflow-visible：保留命令面板/建议浮层；面板 minSize 已保证底栏不被裁切
              className={["composer-box relative flex w-full min-w-0 shrink-0 flex-col overflow-visible rounded-[20px] border border-border bg-card text-card-foreground shadow-[var(--shadow-composer-lifted)] transition-[border-color,box-shadow,background-color]",
                composer.bangMode === "bang-bang"
                  ? "shell-silent-mode"
                  : composer.bangMode === "bang"
                    ? "shell-mode"
                    : composer.mode === "plan"
                      ? "plan-mode"
                      : composer.mode === "goal"
                        ? "goal-mode"
                        : "",
              ].filter(Boolean).join(" ")}
            >
              {/* 扩展 widget（Todo/Plan）由统一会话组件卡展示。 */}
              <TipTapComposer
                ref={composer.editor.ref}
                value={composer.draft}
                className={
                  composer.bangMode === "bang-bang"
                    ? "bang-bang"
                    : composer.bangMode === "bang"
                      ? "bang"
                      : ""
                }
                disabled={composer.isStarting}
                validCommandNames={composer.editor.validCommandNames}
                validFilePaths={composer.editor.validFilePaths}
                validSessionRefs={composer.editor.validSessionRefs}
                validQuotes={composer.editor.validQuotes}
                caretRef={composer.editor.caretRef}
                placeholder={
                  composer.isStarting
                    ? t("app.agentStartingPlaceholder")
                    : composer.bangMode === "bang-bang"
                      ? t("app.composerSilentPlaceholder")
                      : composer.bangMode === "bang"
                        ? t("app.composerShellPlaceholder")
                        : composer.mode === "plan"
                          ? t("app.composerPlanPlaceholder")
                          : composer.mode === "goal"
                            ? t("app.composerGoalPlaceholder")
                            : t("app.composerEnterPlaceholder")
                }
                onFocus={composer.editor.onFocus}
                onChange={composer.editor.onChange}
                onCursorChange={composer.editor.onCursorChange}
                onKeyDown={composer.editor.onKeyDown}
                onPaste={composer.editor.onPaste}
                onPasteClipboard={composer.editor.onPasteClipboard}
                onDrop={composer.editor.onDrop}
                onDragOver={composer.editor.onDragOver}
                onBlur={composer.editor.onBlur}
                onChipClick={composer.editor.onChipClick}
              />
              {composer.suggestions.open && !composer.isStarting ? (
                <PromptSuggestions
                  prompt={composer.draft}
                  items={composer.suggestions.items}
                  selectedIndex={composer.suggestions.selectedIndex}
                  anchorStyle={composer.suggestions.anchorStyle}
                  onSelectedIndexChange={composer.suggestions.setSelectedIndex}
                  onClose={composer.suggestions.close}
                  onPick={composer.suggestions.pick}
                />
              ) : null}
              {/* 运行中允许后端尝试切换思考强度；是否能作用于当前回合由具体 Agent 后端决定。 */}
              <ComposerBottomBar
                sessionId={props.sessionId}
                state={composer.runtime?.state}
                runtimeLive={isLiveRuntimeStatus(composer.runtime?.status)}
                disabled={composer.isBusy || composer.isStarting}
                thinkingDisabled={composer.isStarting}
                modelDisabled={composer.isStarting}
                modelPending={modelPendingMap[props.sessionId]}
                composerAgentMode={composer.mode}
                gitInfo={props.gitInfo}
                onSwitchBranch={props.onSwitchBranch}
                record={composer.record}
                defaultModel={composer.dshDefaultModel ?? composer.bootstrapDefaultModel}
                defaultModelConfigured={composer.bootstrapDefaultModelConfigured}
                defaultThinkingLevel={composer.dshDefaultThinkingLevel ?? composer.bootstrapDefaultThinkingLevel}
                backend={composer.backend}
                onChangeBackend={composer.changeBackend}
                feishuIndicator={feishuIndicator}
                securityControl={
                  /* C20：后端安全控制位统一入口（pi 安全等级 / DSH 权限预设） */
                  <SecurityControl sessionId={props.sessionId} backend={composer.backend} disabled={composer.isStarting} />
                }
                onPickModel={() => composer.pickers.open("model")}
                onPickThinking={() => composer.pickers.open("thinking")}
                onPickPromptTemplate={() => composer.pickers.open("template")}
                onPickSkill={() => composer.pickers.open("skill")}
                onCompact={composer.delivery.compact}
                onChangeMode={composer.pickers.setMode}
                imageGenLocked={composer.delivery.imageGenModeLocked}
                onCancelPlan={() => composer.pickers.setMode("normal")}
                onAttachFile={composer.editor.attachFile}
                imageGenOptions={
                  composer.mode === "imagegen"
                    ? {
                        config: composer.delivery.imageGenConfig,
                        providerId: composer.delivery.imageGenProviderId,
                        modelId: composer.delivery.imageGenModelId,
                        size: composer.delivery.imageGenSize,
                        outputFormat: composer.delivery.imageGenOutputFormat,
                        watermark: composer.delivery.imageGenWatermark,
                        onSelectionChange: composer.delivery.setImageGenSelection,
                        onSizeChange: composer.delivery.setImageGenSize,
                        onOutputFormatChange: composer.delivery.setImageGenOutputFormat,
                        onWatermarkChange: composer.delivery.setImageGenWatermark,
                      }
                    : undefined
                }
                sendControls={
                  <ComposerSendControls
                    isAgentBusy={composer.isBusy}
                    isAgentStarting={composer.isStarting}
                    hasContent={composer.hasContent}
                    canSend={composer.delivery.canSend}
                    isGeneratingImage={composer.delivery.generatingImage}
                    onSend={composer.delivery.send}
                    onStop={composer.delivery.abort}
                  />
                }
              />
            </div>
              }
            />
          </footer>
          <ComposerPickerHost
            sessionId={props.sessionId}
            picker={composer.picker}
            templates={composer.templates}
            onClose={composer.pickers.close}
            onInsertTemplate={composer.pickers.insertTemplate}
            onInsertTemplateContent={composer.pickers.insertTemplateContent}
            onInsertSkill={composer.pickers.insertSkillInvocation}
            onInsertSkillContent={composer.pickers.insertSkillContent}
            defaultModel={composer.dshDefaultModel ?? composer.bootstrapDefaultModel}
            defaultModelConfigured={composer.bootstrapDefaultModelConfigured}
            defaultThinkingLevel={composer.dshDefaultThinkingLevel ?? composer.bootstrapDefaultThinkingLevel}
          />
          {composer.previewImage ? (
            <ImagePreviewModal
              image={composer.previewImage}
              onClose={composer.modals.closePreview}
            />
          ) : null}
          {composer.sessionReference ? (
            <SessionReferenceModal
              session={composer.sessionReference}
              initialSelected={composer.sessionReferenceSelection
                ? new Set(composer.sessionReferenceSelection.selectedIndices)
                : undefined}
              onClose={composer.modals.closeSessionReference}
              onConfirm={(result, selectedIndices) => {
                composer.modals.confirmSessionReference(
                  result.sessionName,
                  result.messages,
                  selectedIndices,
                );
              }}
              loadMessages={(sessionId) => desktopApi.sessions.readReferenceMessages(sessionId)}
            />
          ) : null}
        </>
      )}
    </ComposerRuntimeIntegrations>
  );
});
