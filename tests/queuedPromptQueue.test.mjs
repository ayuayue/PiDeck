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
  assert.match(stylesSource, /\.queued-track \{[\s\S]*?align-items: flex-end;/);
  assert.match(stylesSource, /\.queued-track \{[\s\S]*?max-height: var\(--queued-track-max-height, min\(32vh, 240px\)\);[\s\S]*?overflow-y: auto;/);
  assert.match(stylesSource, /\.queued-card \{[\s\S]*?width: fit-content;[\s\S]*?max-width: min\(82%, 64ch\);/);
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
  assert.match(appSource, /livePrompt\.status === "sending"/);
});

test("queued image count uses the standard i18n interpolation syntax", () => {
  setI18nLocale("zh-CN");
  assert.equal(t("app.queuedImageCount", { count: 3 }), "3 张图片");
  setI18nLocale("en-US");
  assert.equal(t("app.queuedImageCount", { count: 3 }), "3 image(s)");
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
  assert.match(appSource, /acknowledgeUnknownQueuedPrompt/);
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
