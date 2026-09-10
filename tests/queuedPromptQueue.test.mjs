import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

import { mergeAgentRuntimeState } from "../src/renderer/src/utils/agentRuntimeState.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { setI18nLocale, t } = loadTsCommonJs("src/renderer/src/i18n.ts");

const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const sessionViewSource = readFileSync(
  "src/renderer/src/components/session/SessionView.tsx",
  "utf8",
);
const sessionRuntimeInjectorSource = readFileSync(
  "src/renderer/src/components/session/SessionRuntimeInjector.tsx",
  "utf8",
);
const bootstrapSource = readFileSync(
  "src/renderer/src/components/app/AppBootstrap.tsx",
  "utf8",
);
const globalListenersSource = readFileSync(
  "src/renderer/src/hooks/useGlobalAgentListeners.ts",
  "utf8",
);
const composerPanelsSource = readFileSync(
  "src/renderer/src/components/session/ComposerPanels.tsx",
  "utf8",
);
const stylesSource = readRendererStyles();
const i18nSource = [
  readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"),
  readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8"),
].join("\n");
const runtimeStateSource = readFileSync(
  "src/renderer/src/utils/agentRuntimeState.ts",
  "utf8",
);
const queueStateSource = readFileSync(
  "src/renderer/src/utils/queuedPromptQueue.ts",
  "utf8",
);
const toolRuntimeStateSource = readFileSync(
  "src/shared/toolRuntimeState.ts",
  "utf8",
);
const agentManagerSource = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const webServiceSource = readFileSync(
  "src/main/web/WebServiceManager.ts",
  "utf8",
);
const sharedTypesSource = [
  readFileSync("src/shared/types.ts", "utf8"),
  readFileSync("src/shared/types/session.ts", "utf8"),
].join("\n");
// Queue ownership now lives in useQueuedPrompt.
const queuedPromptHookSource = readFileSync(
  "src/renderer/src/hooks/useQueuedPrompt.ts",
  "utf8",
);
const composerControllerSource = readFileSync(
  "src/renderer/src/hooks/useSessionComposerController.ts",
  "utf8",
);
const sessionSendSource = readFileSync(
  "src/renderer/src/hooks/useSessionSend.ts",
  "utf8",
);
const sessionRuntimeBridgeSource = readFileSync(
  "src/renderer/src/hooks/useSessionRuntimeBridge.ts",
  "utf8",
);
const sessionRuntimeControllerSource = readFileSync(
  "src/renderer/src/hooks/useSessionRuntimeController.ts",
  "utf8",
);

function componentInvocation(source, componentName) {
  const start = source.indexOf(`<${componentName}`);
  const end = source.indexOf("/>", start);
  assert.notEqual(start, -1, `${componentName} invocation must exist`);
  assert.notEqual(end, -1, `${componentName} invocation must be self-closing`);
  return source.slice(start, end + 2);
}

test("pending prompts render inside the composer before composer-box", () => {
  const composerAreaIndex = sessionViewSource.indexOf("<ComposerArea");
  const queuePanelIndex = sessionRuntimeInjectorSource.indexOf("<QueuedPromptPanel");
  assert.ok(composerAreaIndex >= 0, "ComposerArea should exist");
  assert.ok(
    queuePanelIndex >= 0,
    "QueuedPromptPanel should exist in SessionRuntimeInjector",
  );
  // 与 todo/goal 同列独立卡：外框由共享 ComposerWidgetFrame 提供，不再右浮紧凑面板。
  assert.match(composerPanelsSource, /<ComposerWidgetFrame[\s\S]*?className="queued-track"/);
});

test("pending prompts share the native content width constraint without hiding composer", () => {
  // queued-track 与 composer 同在会话栏宿主的内容盒内，全宽独立卡（不再右对齐缩宽）
  assert.match(composerPanelsSource, /ComposerWidgetFrame/);
  assert.match(composerPanelsSource, /className="queued-track"/);
  assert.doesNotMatch(composerPanelsSource, /justify-end/);
  assert.doesNotMatch(composerPanelsSource, /w-\[clamp\(13\.5rem,36%,22\.5rem\)\]/);
  assert.match(composerPanelsSource, /queued-row flex h-9 min-h-9 shrink-0/);
  assert.match(composerPanelsSource, /truncate text-\[13px\] leading-5/);
  assert.doesNotMatch(stylesSource, /\.queued-card \{/);
});

test("compact queue panel exposes retract, discard, and delivery actions", () => {
  const queuedPromptPanel = componentInvocation(sessionRuntimeInjectorSource, "QueuedPromptPanel");

  assert.match(queuedPromptPanel, /onRetract=\{services\.queueRetract\}/);
  assert.match(composerPanelsSource, /app\.retractToInput/);
  assert.match(composerPanelsSource, /app\.retractDiscard/);
  assert.match(sessionRuntimeInjectorSource, /onDiscard=\{services\.queueDiscard\}/);
  assert.match(sessionRuntimeInjectorSource, /onChangeBehavior=\{services\.queueChangeBehavior\}/);
  assert.match(composerPanelsSource, /canRetractQueuedPromptToInput\(status\)/);
  assert.match(composerPanelsSource, /canDiscardQueuedPrompt\(status\)/);
  assert.match(composerPanelsSource, /canChangeQueuedPromptBehavior\(status\)/);
  assert.match(composerPanelsSource, /app\.sendSteerTitle/);
  assert.match(composerPanelsSource, /app\.sendFollowUpTitle/);
  assert.match(composerPanelsSource, /app\.sendAskTitle/);
  assert.match(appSource, /const activeQueuedPrompts = currentSessionId/);
  assert.match(appSource, /queueChangeBehavior: queue\.setQueuedPromptBehavior/);
  assert.match(composerPanelsSource, /queued-behavior-\$\{props\.prompt\.behavior\}/);
  assert.match(composerPanelsSource, /max-h-\[180px\]/);
  assert.match(stylesSource, /\.queued-row\.queued-behavior-steer \{/);
  assert.match(stylesSource, /\.queued-row\.queued-behavior-followUp \{/);
  assert.match(queuedPromptHookSource, /QUEUED_PROMPT_LIMIT/);
  assert.match(queuedPromptHookSource, /setQueuedPromptBehavior/);
  assert.match(i18nSource, /"app\.queuedFull"/);
  assert.doesNotMatch(composerPanelsSource, /app\.queuedRetry/);
  assert.doesNotMatch(composerPanelsSource, /app\.queuedAcknowledge/);
  assert.doesNotMatch(appSource, /retryQueuedPrompt/);
  assert.match(queueStateSource, /export const QUEUED_PROMPT_LIMIT = 10/);
  assert.match(queueStateSource, /export const QUEUED_PROMPT_VISIBLE = 3/);
});

test("busy composer keeps send circle; stop only when input is empty", () => {
  const composerAreaSource = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
  const sendControls = componentInvocation(composerAreaSource, "ComposerSendControls");

  assert.match(sendControls, /onSend=\{composer\.delivery\.send\}/);
  assert.match(sendControls, /onStop=\{composer\.delivery\.abort\}/);
  // 忙碌时有无内容决定停止/发送：hasContent 由控制器传入，不再只看 isAgentBusy
  assert.match(sendControls, /hasContent=\{composer\.hasContent\}/);
  assert.doesNotMatch(sendControls, /onSendSteer/);
  assert.doesNotMatch(sendControls, /onSendFollowUp/);
  assert.doesNotMatch(sendControls, /onSendAsk/);
  assert.match(composerPanelsSource, /composer-send-primary/);
  assert.match(composerPanelsSource, /primaryStops \? t\("app\.stop"\) : t\("app\.send"\)/);
  assert.match(composerPanelsSource, /onClick=\{primaryStops \? props\.onStop : props\.onSend\}/);
  assert.match(composerPanelsSource, /resolveComposerSendButtonState\(/);
  assert.match(composerPanelsSource, /hasContent: props\.hasContent/);
  assert.doesNotMatch(composerPanelsSource, /send-behavior-toggle/);
  assert.doesNotMatch(composerPanelsSource, /send-behavior-chevron/);
  assert.doesNotMatch(composerPanelsSource, /<DropdownMenu>/);
  assert.doesNotMatch(composerPanelsSource, /composer-bar-btn stop/);
});

test("composer keeps native typing inside the Session feature root", () => {
  assert.match(composerControllerSource, /const liveDomDraftRef = useRef\(\{ sessionId, value: draft \}\)/);
  assert.match(composerControllerSource, /liveDomDraftRef\.current = \{ sessionId, value \}/);
  assert.match(composerControllerSource, /setDraft\(value\)/);
  assert.match(composerControllerSource, /canApplyRuntimeEditorText/);
  assert.doesNotMatch(appSource, /currentSessionDraftAtom/);
  assert.doesNotMatch(appSource, /setPromptForAgent\(currentSessionId, editorText\.text\)/);
  assert.match(queuedPromptHookSource, /queuedPrompt\.behavior === "direct" \? undefined : queuedPrompt\.behavior/);
  assert.match(queuedPromptHookSource, /const currentDraft = store\.get\(sessionDraftByIdAtom\)\[sessionId\] \?\? ""/);
  assert.doesNotMatch(queuedPromptHookSource, /promptByAgent/);
  assert.match(appSource, /livePromptByAgentRef\.current = migrateAgentRecord/);
  assert.doesNotMatch(composerControllerSource, /sendBehaviorMenuOpen/);
  assert.doesNotMatch(composerPanelsSource, /<DropdownMenuItem/);
});

test("queue drain is serialized and waits for an ordered canonical Session capability event", () => {
  assert.match(appSource, /queueFlushBySessionRef = useRef<Set<string>>/);
  // 队列 flush 中 / 有排队中的消息时不允许重启：判定已收敛到策略函数，
  // 由 sessionRunCapabilities 的 busy 与 hasInFlightQueuedPrompt 表达
  //（见 tests/sessionRunControl.test.mjs 的能力矩阵断言）。
  assert.match(
    sessionRuntimeControllerSource,
    /hasInFlightQueuedPrompt: activeQueuedPrompts\.some\(/,
  );
  assert.match(
    sessionRuntimeControllerSource,
    /sessionRunCapabilities\(\{/,
  );
  assert.match(
    appSource,
    /queueFlushBySessionRef\.current\.has\(sessionId\)/,
  );
  assert.doesNotMatch(
    sessionRuntimeControllerSource,
    /queuedPrompts\[activeAgentId\]/,
  );
  assert.doesNotMatch(globalListenersSource, /sessions\.onRuntimeEvent\(/);
  assert.match(sessionRuntimeBridgeSource, /sessions\.onRuntimeEvent\(/);
  assert.match(sessionRuntimeBridgeSource, /event\.sourceChannel !== "agents:runtime-state"/);
  assert.match(
    appSource,
    /previous\?\.isExecutingTool\s*&&\s*!current\.isExecutingTool[\s\S]*?queue\.flushQueuedSteerPrompts\(sessionId\)/,
  );
  assert.match(runtimeStateSource, /incoming\.toolStateSequence < current\.toolStateSequence/);
  assert.match(agentManagerSource, /updateActiveToolCalls/);
  assert.match(toolRuntimeStateSource, /calls\.delete\(event\.toolCallId\)/);
  assert.match(toolRuntimeStateSource, /completedBatch: event\.type === "end" && current\.size > 0 && calls\.size === 0/);
  assert.match(queuedPromptHookSource, /claimIdleHead\(queuedPromptsRef\.current, sessionId\)/);
  assert.match(queuedPromptHookSource, /claimNextSteerPrompt\(queuedPromptsRef\.current, sessionId\)/);
  assert.match(queuedPromptHookSource, /resolveClaimedPrompt/);
  assert.doesNotMatch(appSource, /queuedPrompt\.status === "sending"\s*\? \{ \.\.\.queuedPrompt, status: "pending"/);
  assert.doesNotMatch(queueStateSource, /migrateQueuedPrompts|replacementById/);
});

test("retract edit restores text, attachments, and composer mode to the owning Session", () => {
  assert.match(queuedPromptHookSource, /livePrompt\.displayText/);
  assert.match(queuedPromptHookSource, /store\.set\(setSessionAttachmentsAtom, \{/);
  assert.match(queuedPromptHookSource, /store\.set\(setSessionComposerModeAtom, \{ sessionId, mode: livePrompt\.agentMode \}\)/);
  assert.doesNotMatch(queuedPromptHookSource, /setComposerAgentModeForAgent/);
  assert.match(queuedPromptHookSource, /pendingComposerCaretRef\.current = restoredPrompt\.length/);
  assert.match(queuedPromptHookSource, /setComposerCursor\(restoredPrompt\.length\)/);
  assert.match(queuedPromptHookSource, /editor\.scrollTop = editor\.scrollHeight/);
  assert.match(queuedPromptHookSource, /livePrompt\.status === "sending"/);
});

test("retract edit uses action-oriented copy", () => {
  setI18nLocale("zh-CN");
  assert.equal(t("app.retractToInput"), "撤回修改");
  setI18nLocale("en-US");
  assert.equal(t("app.retractToInput"), "Retract to edit");
});

test("queued image count uses the standard i18n interpolation syntax", () => {
  setI18nLocale("zh-CN");
  assert.equal(t("app.queuedImageCount", { count: 3 }), "3 图");
  setI18nLocale("en-US");
  assert.equal(t("app.queuedImageCount", { count: 3 }), "3 img");
});

test("runtime state merge rejects stale tool edges without losing non-tool fields", () => {
  const current = {
    modelId: "new-model",
    isExecutingTool: false,
    toolStateSequence: 4,
  };
  const merged = mergeAgentRuntimeState(current, {
    modelName: "Updated name",
    isExecutingTool: true,
    executingToolName: "read",
    toolStateSequence: 3,
  });

  assert.equal(merged.modelName, "Updated name");
  assert.equal(merged.modelId, "new-model");
  assert.equal(merged.isExecutingTool, false);
  assert.equal(merged.executingToolName, undefined);
  assert.equal(merged.toolStateSequence, 4);
});

test("indeterminate prompt timeout never becomes a retryable rejection", () => {
  assert.match(
    sharedTypesSource,
    /delivery: "unknown"/,
  );
  assert.match(
    agentManagerSource,
    /catch \(error\)[\s\S]*?delivery: "unknown"/,
  );
  assert.match(
    agentManagerSource,
    /命令接收结果未知[\s\S]*?delivery: "unknown"/,
  );
  assert.match(queuedPromptHookSource, /status: "unknown"/);
  assert.match(sessionSendSource, /outcome === "unknown"/);
  assert.match(sessionSendSource, /status: "unknown"/);
  assert.match(composerPanelsSource, /SessionDeliveryNotice/);
  const runtimeControllerSource = readFileSync(
    "src/renderer/src/hooks/useSessionRuntimeController.ts",
    "utf8",
  );
  assert.match(runtimeControllerSource, /\.status === "unknown"/);
});

test("prompt acceptance is explicit across the main and renderer boundary", () => {
  assert.match(agentManagerSource, /Promise<SendPromptResult>/);
  assert.match(
    agentManagerSource,
    /accepted: false,[\s\S]{0,160}?error: errorMessage,[\s\S]{0,160}?i18nKey: "diagnostic\./,
  );
  assert.match(webServiceSource, /this\.sendJson\(response, \{ result \}\)/);
  assert.doesNotMatch(webServiceSource, /sendError\(response, 409, result\.error\)/);
  assert.match(agentManagerSource, /if \(cancelled\)[\s\S]*?命令已取消[\s\S]*?return \{ accepted: true \}/);
  assert.match(
    appSource,
    /if \(!result\.accepted\)[\s\S]*?translateI18nDescriptor\(result, result\.error\)[\s\S]*?PromptDeliveryUnknownError\(localizedError\)[\s\S]*?throw new Error\(localizedError\)/,
  );
});
