import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ComposerBottomBar,
  ImagePreviewModal,
  PromptSuggestions,
} from "./ComposerParts";
import {
  RichInput,
} from "../app/RichInput";
import { SessionReferenceModal } from "../app/SessionReferenceModal";
import { t } from "../../i18n";
import { useSessionComposerController } from "../../hooks/useSessionComposerController";
import {
  ComposerAttachmentBar,
  ComposerSendControls,
  SessionDeliveryNotice,
} from "./ComposerPanels";
import { ComposerPickerHost } from "./ComposerPickerHost";
import { ComposerRuntimeIntegrations } from "./ComposerRuntimeIntegrations";
import { desktopApi } from "../../desktopApi";
import { COMPOSER_DEFAULT_HEIGHT } from "../../rendererUtils";
import type { GitBranchInfo } from "../../../../shared/types";
import type { EnqueuePromptSnapshot } from "../../hooks/useSessionSend";

export type ComposerAreaProps = {
  sessionId: string;
  gitInfo?: GitBranchInfo;
  queuePanel?: ReactNode;
  onOpenFile?: (path: string) => void;
  /** 受控高度（px）。传入时由外层面板（react-resizable-panels）持有尺寸，
   *  本地 state 仅作非受控回退（#115 U5 布局换装）。 */
  height?: number;
  onHeightChange?: (height: number) => void;
  /** 输入区上方可变内容（附件栏 / 扩展 widget / 队列 / 投递通知）当前占用的额外高度（px）。
   *  内容出现时上报给外层，由外层命令式增高 composer 面板，避免固定高度挤压输入区。 */
  onContentHeightChange?: (extraHeight: number) => void;
  enqueue?: (sessionId: string, snapshot: EnqueuePromptSnapshot) => boolean;
  ensureSessionId?: (sessionId: string) => Promise<string>;
};

const CONTENT_GAP_PX = 8;

type ComposerMeasuredExtrasProps = {
  widgets: ReactNode;
  queuePanel?: ReactNode;
  deliveryNotice: ReactNode;
  attachmentBar: ReactNode;
  onHeightChange: (extraHeight: number) => void;
};

/**
 * 必须作为 ComposerRuntimeIntegrations render-prop 子树中的独立组件存在：
 * widget 的关闭/更新只会重渲染这棵子树，不会重渲染外层 ComposerArea。
 * 测量 effect 放在这里，才能在 widget 变化的同一帧回缩面板，而不是等用户输入。
 */
function ComposerMeasuredExtras(props: ComposerMeasuredExtrasProps) {
  const widgetsRef = useRef<HTMLDivElement | null>(null);
  const attachmentBarRef = useRef<HTMLDivElement | null>(null);
  const lastContentExtraRef = useRef(0);
  const mountedRef = useRef(false);
  const onHeightChangeRef = useRef(props.onHeightChange);
  onHeightChangeRef.current = props.onHeightChange;

  const measureExtra = () => {
    const widgetsH = widgetsRef.current?.offsetHeight ?? 0;
    const imageBarH = attachmentBarRef.current?.offsetHeight ?? 0;
    // gap 实测：Tailwind gap-2 是 rem，随根字号变化；用 rowGap 拿到真实 px。
    let gapPx = CONTENT_GAP_PX;
    const footerEl = widgetsRef.current?.parentElement;
    if (footerEl && typeof window !== "undefined") {
      const rowGap = parseFloat(window.getComputedStyle(footerEl).rowGap || "");
      if (!Number.isNaN(rowGap) && rowGap > 0) gapPx = rowGap;
    }
    return Math.ceil(
      widgetsH + imageBarH + (imageBarH > 0 ? gapPx : 0),
    );
  };

  const reportExtra = () => {
    const extra = measureExtra();
    if (extra === lastContentExtraRef.current) return;
    lastContentExtraRef.current = extra;
    onHeightChangeRef.current(extra);
  };

  // props.widgets 变化会重渲染本组件；在 paint 前同步 resize，输入区不会闪高一帧。
  useLayoutEffect(() => {
    if (!mountedRef.current) return;
    reportExtra();
  });

  const hasAttachmentBar = props.attachmentBar != null;
  useEffect(() => {
    let rafId = 0;
    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        mountedRef.current = true;
        reportExtra();
      });
    };
    const observer = new ResizeObserver(schedule);
    if (widgetsRef.current) observer.observe(widgetsRef.current);
    if (attachmentBarRef.current) observer.observe(attachmentBarRef.current);
    // 首测延迟到下一帧：此时 ResizablePanel 已注册到 group。
    schedule();
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [hasAttachmentBar]);

  return (
    <>
      <div
        ref={widgetsRef}
        className="flex shrink-0 min-h-0 min-w-0 flex-col gap-2"
      >
        {props.widgets}
        {props.queuePanel}
        {props.deliveryNotice}
      </div>
      {hasAttachmentBar ? (
        <div ref={attachmentBarRef} className="shrink-0">
          {props.attachmentBar}
        </div>
      ) : null}
    </>
  );
}

export const ComposerArea = forwardRef<HTMLElement, ComposerAreaProps>(function ComposerArea(
  props,
  footerRef,
) {
  const composer = useSessionComposerController({
    sessionId: props.sessionId,
    onOpenFile: props.onOpenFile,
    enqueue: props.enqueue,
    ensureSessionId: props.ensureSessionId,
  });
  const prewarmStartedForSessionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!props.sessionId || !window.piDesktop) return;
    if (!composer.draft.trim() && composer.attachments.length === 0) return;
    if (prewarmStartedForSessionRef.current === props.sessionId) return;
    prewarmStartedForSessionRef.current = props.sessionId;

    // 输入是比“打开会话”更可靠的发送意图信号；只在首次输入后预热一次，
    // 避免用户仅浏览历史时创建进程，也避免每个按键重复触发 IPC。
    void desktopApi.sessions.activateRuntime(props.sessionId).catch(() => undefined);
  }, [composer.attachments.length, composer.draft, props.sessionId]);

  // 受控/非受控双模：SessionView 以面板分隔条控制高度时传 height；
  // 其余场景（测试、嵌入）回退本地默认值，与全局默认高度保持一致。
  const [localHeight, setLocalHeight] = useState(COMPOSER_DEFAULT_HEIGHT);
  const height = props.height ?? localHeight;
  const handleContentHeightChange = (extra: number) => {
    if (props.height != null) {
      props.onContentHeightChange?.(extra);
    } else if (extra > 0) {
      setLocalHeight((current) =>
        Math.max(current, extra + COMPOSER_DEFAULT_HEIGHT),
      );
    }
  };

  return (
    <ComposerRuntimeIntegrations sessionId={props.sessionId}>
      {({ feishuIndicator }) => (
        <>
          {/* overflow-hidden：面板到 minSize 时禁止整块 footer 再出滚动条；
              文本区自身仍可在 RichInput 内滚动，底栏 shrink-0 始终可见 */}
          <footer
            ref={footerRef}
            className="composer flex min-h-0 w-full min-w-0 flex-col gap-2 overflow-hidden bg-background px-3 pb-3"
            style={{ height: props.height != null ? "100%" : height }}
            data-session-id={props.sessionId}
          >
            {/* 扩展 widget（Todo/Plan）已迁至 chat-header 左侧 SessionWidgetChips，
                composer 内不再有 widget，widgets 槽位传 null；
                ComposerMeasuredExtras 负责测量附件/队列/通知高度并驱动 composer 自动增高。 */}
            <ComposerMeasuredExtras
              widgets={null}
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
              attachmentBar={composer.attachments.length > 0 ? (
                <ComposerAttachmentBar
                  images={composer.attachments}
                  onPreview={composer.images.preview}
                  onRemove={composer.images.remove}
                  onClear={composer.images.clear}
                />
              ) : null}
              onHeightChange={handleContentHeightChange}
            />
            <div
              // overflow-visible：保留命令面板/建议浮层；面板 minSize 已保证底栏不被裁切
              className={["composer-box relative flex min-h-0 min-w-0 flex-1 flex-col overflow-visible rounded-xl border border-border bg-card text-card-foreground shadow-sm transition-[border-color,box-shadow,background-color]",
                composer.bangMode === "bang-bang"
                  ? "shell-silent-mode"
                  : composer.bangMode === "bang"
                    ? "shell-mode"
                    : composer.mode === "plan"
                      ? "plan-mode"
                      : "",
              ].filter(Boolean).join(" ")}
            >
              {/* 扩展 widget（Todo/Plan）已迁至 chat-header 左侧 SessionWidgetChips。 */}
              <RichInput
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
                          : t("app.composerEnterPlaceholder")
                }
                onFocus={composer.editor.onFocus}
                onChange={composer.editor.onChange}
                onCursorChange={composer.editor.onCursorChange}
                onKeyDown={composer.editor.onKeyDown}
                onPaste={composer.editor.onPaste}
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
              <ComposerBottomBar
                state={composer.runtime?.state}
                compacting={Boolean(composer.runtime?.state?.isCompacting)}
                disabled={composer.isBusy || composer.isStarting}
                composerAgentMode={composer.mode}
                gitInfo={props.gitInfo}
                record={composer.record}
                feishuIndicator={feishuIndicator}
                onPickModel={() => composer.pickers.open("model")}
                onPickThinking={() => composer.pickers.open("thinking")}
                onPickPromptTemplate={() => composer.pickers.open("template")}
                onCompact={composer.delivery.compact}
                onOpenComposerModePicker={() => composer.pickers.open("mode")}
                onCancelPlan={() => composer.pickers.setMode("normal")}
                onAttachFile={composer.editor.attachFile}
                sendControls={
                  <ComposerSendControls
                    isAgentBusy={composer.isBusy}
                    isAgentStarting={composer.isStarting}
                    keepBusyDraftControls={composer.busyDraftLocked}
                    showBusySendControls={composer.isBusy || composer.busyDraftLocked}
                    hasComposerContent={composer.hasContent}
                    canSend={composer.delivery.canSend}
                    sendBehaviorMenuOpen={composer.delivery.sendBehaviorMenuOpen}
                    onSend={composer.delivery.send}
                    onSendFollowUp={composer.delivery.followUp}
                    onStop={composer.delivery.abort}
                    onToggleBehaviorMenu={composer.delivery.toggleSendBehaviorMenu}
                    onKeepBehaviorMenuOpen={composer.delivery.keepSendBehaviorMenuOpen}
                    onScheduleBehaviorMenuClose={composer.delivery.scheduleSendBehaviorMenuClose}
                  />
                }
              />
            </div>
          </footer>
          <ComposerPickerHost
            sessionId={props.sessionId}
            picker={composer.picker}
            templates={composer.templates}
            onClose={composer.pickers.close}
            onInsertTemplate={composer.pickers.insertTemplate}
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
