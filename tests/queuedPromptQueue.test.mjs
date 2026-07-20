import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { setI18nLocale, t } from "../src/renderer/src/i18n.ts";
import { mergeAgentRuntimeState } from "../src/renderer/src/utils/agentRuntimeState.ts";

const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const stylesSource = readFileSync("src/renderer/src/styles.css", "utf8");
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
const sharedTypesSource = readFileSync("src/shared/types.ts", "utf8");

test("pending prompts render inside the composer before composer-box", () => {
  const footerIndex = appSource.indexOf('<footer ref={composerRef} className="composer">');
  const queueIndex = appSource.indexOf('className="queued-track"');
  const composerBoxIndex = appSource.indexOf("ref={composerBoxRef}");

  assert.ok(footerIndex >= 0, "composer footer should exist");
  assert.ok(queueIndex > footerIndex, "pending prompts should stay inside the composer footer");
  assert.ok(queueIndex < composerBoxIndex, "pending prompts should render immediately above composer-box");
});

test("pending prompts share the native content width constraint without hiding composer", () => {
  assert.match(
    stylesSource,
    /\.chat-pane\[style\*="--content-max-width"\][\s\S]*?\.queued-track,[\s\S]*?width: min\(100%, var\(--content-max-width\)\)/,
  );
  // Outer track is a full-width anchor; the compact panel sits on the right with proportional width.
  assert.match(stylesSource, /\.queued-track \{[\s\S]*?justify-content: flex-end;/);
  assert.match(stylesSource, /\.queued-panel \{[\s\S]*?width: clamp\(/);
  assert.match(stylesSource, /\.queued-row \{[\s\S]*?min-height: 32px;/);
  assert.match(stylesSource, /\.queued-text \{[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/);
  assert.doesNotMatch(stylesSource, /\.queued-card \{/);
});

test("compact queue panel exposes retract-to-input and discard only", () => {
  assert.match(appSource, /app\.retractToInput/);
  assert.match(appSource, /app\.retractDiscard/);
  assert.match(appSource, /discardQueuedPrompt/);
  assert.match(appSource, /canRetractQueuedPromptToInput/);
  assert.match(appSource, /canDiscardQueuedPrompt/);
  assert.match(appSource, /const visibleQueuedPrompts = activeQueuedPrompts/);
  assert.match(appSource, /queued-behavior-\$\{queuedPrompt\.behavior\}/);
  assert.match(stylesSource, /\.queued-list \{[\s\S]*?max-height: 102px;[\s\S]*?overflow-y: auto;/);
  assert.match(stylesSource, /\.queued-row\.queued-behavior-steer \{/);
  assert.match(stylesSource, /\.queued-row\.queued-behavior-followUp \{/);
  assert.match(appSource, /QUEUED_PROMPT_LIMIT/);
  assert.match(appSource, /app\.queuedFull/);
  assert.doesNotMatch(appSource, /app\.queuedRetry/);
  assert.doesNotMatch(appSource, /app\.queuedAcknowledge/);
  assert.doesNotMatch(appSource, /retryQueuedPrompt/);
  assert.match(queueStateSource, /export const QUEUED_PROMPT_LIMIT = 10/);
  assert.match(queueStateSource, /export const QUEUED_PROMPT_VISIBLE = 3/);
});

test("busy composer keeps stop and queued-send controls separate", () => {
  assert.match(appSource, /className="btn-circle stop"/);
  assert.match(appSource, /className="send-behavior-toggle"/);
  assert.match(appSource, /className="send-behavior-primary"/);
  assert.match(appSource, /className="send-behavior-chevron"/);
  assert.match(appSource, /const \[busyDraftByAgent, setBusyDraftByAgent\] = useState<Record<string, boolean>>/);
  assert.match(appSource, /const showBusySendControls = isAgentBusy \|\| keepBusyDraftControls/);
  assert.match(appSource, /\{showBusySendControls && hasComposerContent && \(/);
  assert.match(appSource, /\) : !keepBusyDraftControls \? \(/);
  assert.match(appSource, /if \(!isAgentBusy \|\| current\[activeAgentId\]\) return current;/);
  assert.match(stylesSource, /\.send-behavior-menu-wrap \{[\s\S]*?gap: 8px;/);
  assert.match(stylesSource, /\.composer-footer \.send-behavior-toggle \{[\s\S]*?height: 36px;[\s\S]*?background: var\(--color-accent\);[\s\S]*?border-radius: var\(--radius-pill\)/);
  assert.match(stylesSource, /\.send-behavior-chevron \{[\s\S]*?border-left:/);
  assert.match(appSource, /className="send-behavior-primary"[\s\S]*?onClick=\{sendPrompt\}/);
  assert.match(appSource, /className="send-behavior-chevron"[\s\S]*?onMouseEnter=\{keepSendBehaviorMenuOpen\}[\s\S]*?setSendBehaviorMenuOpen/);
  assert.match(appSource, /className="send-behavior-option steer"/);
  assert.match(appSource, /className="send-behavior-option follow-up"/);
  assert.match(appSource, /setTimeout\(\(\) => \{[\s\S]*?setSendBehaviorMenuOpen\(false\)[\s\S]*?\}, 160\)/);
  assert.doesNotMatch(appSource, /<span>\{t\("app\.sendSteerDesc"\)\}<\/span>/);
  assert.match(stylesSource, /\.send-behavior-menu \{[\s\S]*?width: 156px;[\s\S]*?padding: 4px;/);
  assert.match(stylesSource, /\.send-behavior-option-dot \{[\s\S]*?width: 7px;[\s\S]*?height: 7px;/);
});

test("App keeps native typing responsive with a live draft ref and transition", () => {
  assert.match(appSource, /const livePromptByAgentRef = useRef<Record<string, string>>\(\{\}\)/);
  assert.match(appSource, /const \[, startPromptTransition\] = useTransition\(\)/);
  assert.match(appSource, /function setPromptFromNativeInput\(agentId: string, value: string\)/);
  assert.match(appSource, /startPromptTransition\(\(\) => \{\s*setPromptByAgent/s);
  assert.match(appSource, /const livePrompt = targetAgentId[\s\S]*?livePromptByAgentRef\.current\[targetAgentId\] \?\? prompt/);
  assert.match(appSource, /if \(suggestionsOpen\) setComposerCursor\(cursor\)/);
  assert.match(appSource, /queuedPrompt\.behavior === "direct" \? undefined : queuedPrompt\.behavior/);
  assert.match(appSource, /const currentDraft =[\s\S]*?livePromptByAgentRef\.current\[agentId\] \?\? promptByAgent\[agentId\]/);
  assert.match(appSource, /setPromptForAgent\(request\.agentId, text\)/);
  assert.match(appSource, /livePromptByAgentRef\.current = migrateAgentRecord/);
  assert.match(appSource, /sendBehaviorMenuOpen && showBusySendControls && hasComposerContent/);
  assert.match(appSource, /clearTimeout\(sendBehaviorMenuCloseTimerRef\.current\)/);
  assert.match(appSource, /className="send-behavior-option steer" type="button"/);
  assert.match(appSource, /className="send-behavior-option follow-up" type="button"/);
});

test("queue drain is serialized and waits for an ordered raw tool-end event", () => {
  assert.match(appSource, /queueFlushByAgentRef = useRef<Set<string>>/);
  assert.match(
    appSource,
    /previous\?\.isExecutingTool\s*&&\s*!nextState\.isExecutingTool[\s\S]*?flushQueuedSteerPrompts\(payload\.agentId\)/,
  );
  assert.match(runtimeStateSource, /incoming\.toolStateSequence < current\.toolStateSequence/);
  assert.match(agentManagerSource, /updateActiveToolCalls/);
  assert.match(toolRuntimeStateSource, /calls\.delete\(event\.toolCallId\)/);
  assert.match(toolRuntimeStateSource, /completedBatch: event\.type === "end" && current\.size > 0 && calls\.size === 0/);
  assert.match(appSource, /claimIdleHead\(queuedPromptsRef\.current, agentId\)/);
  assert.match(appSource, /claimNextSteerPrompt\(queuedPromptsRef\.current, agentId\)/);
  assert.match(appSource, /resolveClaimedPrompt/);
  assert.doesNotMatch(appSource, /queuedPrompt\.status === "sending"\s*\? \{ \.\.\.queuedPrompt, status: "pending"/);
  assert.match(queueStateSource, /prompt\.status !== "sending" && prompt\.status !== "unknown"/);
});

test("retract edit restores text, attachments, and composer mode to the owning agent", () => {
  assert.match(appSource, /livePrompt\.displayText/);
  assert.match(appSource, /setAttachedImagesForAgent\(agentId, \(current\) => \[/);
  assert.match(appSource, /setComposerAgentModeForAgent\(agentId, livePrompt\.agentMode\)/);
  assert.match(appSource, /pendingComposerCaretRef\.current = restoredPrompt\.length/);
  assert.match(appSource, /setComposerCursor\(restoredPrompt\.length\)/);
  assert.match(appSource, /editor\.scrollTop = editor\.scrollHeight/);
  assert.match(appSource, /livePrompt\.status === "sending"/);
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
  assert.match(queueStateSource, /outcome\.type === "accepted"/);
  assert.match(queueStateSource, /\{ type: "failed" \| "unknown"; error: string \}/);
  assert.match(appSource, /discardQueuedPrompt/);
  assert.match(appSource, /appendUnknownQueuedPrompt\(targetAgentId, queuedPromptSnapshot\)/);
  assert.match(appSource, /status: "unknown"/);
  assert.match(appSource, /accepted === "unknown"/);
});

test("prompt acceptance is explicit across the main and renderer boundary", () => {
  assert.match(agentManagerSource, /Promise<SendPromptResult>/);
  assert.match(agentManagerSource, /return \{ accepted: false, error: errorMessage \}/);
  assert.match(webServiceSource, /this\.sendJson\(response, \{ result \}\)/);
  assert.doesNotMatch(webServiceSource, /sendError\(response, 409, result\.error\)/);
  assert.match(agentManagerSource, /if \(cancelled\)[\s\S]*?命令已取消[\s\S]*?return \{ accepted: true \}/);
  assert.match(appSource, /if \(!result\.accepted\)[\s\S]*?PromptDeliveryUnknownError[\s\S]*?throw new Error\(result\.error\)/);
});
