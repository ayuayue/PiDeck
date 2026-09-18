import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 稳定思考流契约：Live / History 同 id，终态一次落盘，done 不早于 History 可见时卸身份。
 * 对齐 textStreamChannel.test.mjs 风格。
 */

const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const atoms = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");
const agentTypes = readFileSync("src/shared/types/agent.ts", "utf8");
const buildTurn = readFileSync(
  "src/renderer/src/components/session/timeline/buildTurnDisplay.ts",
  "utf8",
);
const turnRow = readFileSync(
  "src/renderer/src/components/session/turn/TurnRow.tsx",
  "utf8",
);
const thinkingStep = readFileSync(
  "src/renderer/src/components/session/turn/ThinkingStep.tsx",
  "utf8",
);
const timeline = readFileSync(
  "src/renderer/src/components/session/SessionMessageTimeline.tsx",
  "utf8",
);
const appUtils = readFileSync(
  "src/renderer/src/components/app/AppUtils.ts",
  "utf8",
);

test("ThinkingUpdate payload carries stable id + lifecycle fields", () => {
  assert.match(agentTypes, /export type ThinkingUpdate = \{/);
  assert.match(agentTypes, /id: string;/);
  // 2026-08 增量协议：text 变可选（全量快照时携带），delta 为增量推送
  assert.match(agentTypes, /text\??: string;/);
  assert.match(agentTypes, /delta\??: string;/);
  assert.match(agentTypes, /startedAt: number;/);
  assert.match(agentTypes, /endedAt: number;/);
  assert.match(agentTypes, /done: boolean;/);
  assert.doesNotMatch(
    agentTypes.slice(agentTypes.indexOf("export type ThinkingUpdate"), agentTypes.indexOf("export type ComposerAgentMode")),
    /^\s*thinking:\s*string;/m,
  );
});

test("main process: emitThinkingNow sends delta for appends, full text for resets/snapshots", () => {
  const idx = agentManager.indexOf("private emitThinkingNow");
  const block = agentManager.slice(idx, idx + 900);
  // 增量协议：正常 append 只发 delta；非 append 或超过快照间隔补全量（自愈）
  assert.match(block, /delta: text\.slice\(lastSent\.length\)/);
  assert.match(block, /lastSentThinkingByAgent/);
  assert.match(block, /pushCount >= 50/);
  assert.match(block, /text\.startsWith\(lastSent\)/);
});

test("main process: emitTextStreamNow sends delta for appends, full text for resets/snapshots", () => {
  const idx = agentManager.indexOf("private emitTextStreamNow");
  const block = agentManager.slice(idx, idx + 1000);
  assert.match(block, /delta: text\.slice\(lastSent\.length\)/);
  assert.match(block, /lastSentTextByAgent/);
  assert.match(block, /pushCount >= 50/);
  assert.match(block, /text\.startsWith\(lastSent\)/);
  // done 后清空 delta 基准
  assert.match(block, /lastSentTextByAgent\.delete\(agentId\)/);
});

test("renderer: streaming atoms merge delta and accept full-text snapshots", () => {
  assert.match(atoms, /typeof payload\.delta === "string"/);
  // text-stream：delta 追加本地累积；text 全量替换
  assert.match(atoms, /\(prev\?\.content \?\? ""\) \+ payload\.delta/);
  // thinking：delta 追加本地累积
  assert.match(atoms, /\(prev\?\.text \?\? ""\) \+ delta/);
});

test("main process: live thinking id equals History msg-thinking-* id", () => {
  assert.match(agentManager, /thinkingSegmentByAgent/);
  assert.match(agentManager, /id: `msg-thinking-\$\{assistantMessageId\}`/);
  assert.match(agentManager, /ensureThinkingSegment\(/);
  assert.match(agentManager, /markThinkingSegmentEnded\(/);
  assert.match(agentManager, /finalizeThinkingIntoMessage\(/);
  assert.match(agentManager, /finishThinkingChannel\(/);
});

test("main process: thinking_delta does not upsert; thinking_end does not write messages", () => {
  const thinkingDeltaIdx = agentManager.indexOf('if (eventType === "thinking_delta")');
  const thinkingEndIdx = agentManager.indexOf('if (eventType === "thinking_end")');
  // biome 归一后 message_end 条件被折成多行，改用格式无关正则定位：
  const messageEndIdx = agentManager.search(
    /eventType === "message_end" \|\|\s*eventType === "done"/,
  );
  assert.ok(thinkingDeltaIdx >= 0 && thinkingEndIdx > thinkingDeltaIdx);
  assert.ok(messageEndIdx > thinkingEndIdx);

  const deltaBlock = agentManager.slice(thinkingDeltaIdx, thinkingEndIdx);
  assert.doesNotMatch(deltaBlock, /this\.upsertAssistantMessage\(/);
  assert.match(deltaBlock, /this\.thinkingEmitter\.push\(/);
  assert.match(deltaBlock, /ensureThinkingSegment/);

  const endBlock = agentManager.slice(thinkingEndIdx, messageEndIdx);
  assert.doesNotMatch(endBlock, /this\.upsertAssistantMessage\(/);
  assert.doesNotMatch(endBlock, /finalizeThinkingIntoMessage/);
  assert.match(endBlock, /markThinkingSegmentEnded/);
});

test("main process: finalize writes message.thinking before done clears live channel", () => {
  assert.match(agentManager, /private finalizeThinkingIntoMessage\(/);
  assert.match(agentManager, /private finishThinkingChannel\(/);
  assert.match(agentManager, /list\[existingIndex\]\.thinking = nextThinking/);
  assert.match(agentManager, /done:\s*true/);

  const finalizeThenFinish = /finalizeThinkingIntoMessage[\s\S]{0,200}?flushMessageEmit[\s\S]{0,80}?finishThinkingChannel/;
  assert.match(agentManager, finalizeThenFinish);

  const finishIdx = agentManager.indexOf("private finishThinkingChannel");
  const finishBlock = agentManager.slice(finishIdx, finishIdx + 800);
  assert.match(finishBlock, /done:\s*true/);
  assert.match(finishBlock, /thinkingSegmentByAgent\.delete/);
});

test("main process: markThinkingSegmentEnded is idempotent after endedAt", () => {
  const idx = agentManager.indexOf("private markThinkingSegmentEnded");
  const block = agentManager.slice(idx, idx + 500);
  assert.match(block, /if \(segment\.endedAt > 0\) return;/);
});

test("main process: upsertAssistantMessage no longer dual-writes thinking mid-stream", () => {
  const upsertIdx = agentManager.indexOf("private upsertAssistantMessage(");
  const nextPrivate = agentManager.indexOf("\tprivate upsertToolMessage(", upsertIdx);
  const upsertBlock = agentManager.slice(upsertIdx, nextPrivate);
  assert.doesNotMatch(upsertBlock, /pendingThinking/);
  assert.doesNotMatch(upsertBlock, /shouldClearThinking/);
  assert.doesNotMatch(upsertBlock, /existing\.thinking\s*=/);
  assert.doesNotMatch(upsertBlock, /commitPendingThinking/);
});

test("renderer: done keeps live identity until History thinking is visible", () => {
  assert.match(atoms, /tryReleaseLiveThinkingAfterHistory/);
  assert.match(atoms, /streamingThinkingEntryByIdAtomFamily/);
  assert.match(atoms, /liveThinkingIdBySessionIdAtomFamily/);
  assert.match(atoms, /disposeStreamingThinkingFamily/);
  assert.match(atoms, /streamingThinkingEntryByIdAtomFamily\.remove/);

  const thinkingIdx = atoms.indexOf('event.sourceChannel === "agents:thinking"');
  const textIdx = atoms.indexOf('event.sourceChannel === "agents:text-stream"');
  assert.ok(thinkingIdx >= 0 && textIdx > thinkingIdx);
  const thinkingBlock = atoms.slice(thinkingIdx, textIdx);
  // done 路径不得直接 delete live id；须标 streaming:false 后尝试 History 接管释放
  assert.match(thinkingBlock, /streaming:\s*false/);
  assert.match(thinkingBlock, /tryReleaseLiveThinkingAfterHistory/);
  assert.doesNotMatch(thinkingBlock, /delete nextMap\[event\.sessionId\]/);
  assert.doesNotMatch(atoms, /thinking:\s*string;/);
});

test("renderer: releasing live thinking also removes atomFamily instance", () => {
  const releaseIdx = atoms.indexOf("function tryReleaseLiveThinkingAfterHistory");
  const clearIdx = atoms.indexOf("function clearSessionLiveThinking");
  assert.ok(releaseIdx >= 0 && clearIdx >= 0);
  const releaseBlock = atoms.slice(releaseIdx, releaseIdx + 1200);
  const clearBlock = atoms.slice(clearIdx, clearIdx + 1200);
  assert.match(releaseBlock, /disposeStreamingThinkingFamily\(liveId\)/);
  assert.match(clearBlock, /disposeStreamingThinkingFamily\(id\)/);
});

test("renderer: message flush also tries live→History release", () => {
  const msgIdx = atoms.indexOf('event.sourceChannel === "agents:message"');
  assert.ok(msgIdx >= 0);
  // 切片窗口：windowStartFilePos（2026-11 数值游标）+ cardCount（2026-12 卡片偏移修正）
  // + 迟到快照守卫（2026-11 编辑/删除回归）解析均位于同一块内，窗口相应放大
  const msgBlock = atoms.slice(msgIdx, msgIdx + 4600);
  assert.match(msgBlock, /tryReleaseLiveThinkingAfterHistory/);
});

test("UI: timeline only subscribes liveThinkingId; ThinkingStep uses per-id family", () => {
  assert.match(timeline, /liveThinkingIdBySessionIdAtomFamily/);
  assert.doesNotMatch(timeline, /streamingThinkingByIdAtom/);
  assert.match(timeline, /liveThinkingId=\{liveThinkingId\}/);
  assert.match(thinkingStep, /streamingThinkingEntryByIdAtomFamily/);
  assert.doesNotMatch(thinkingStep, /useAtomValue\(streamingThinkingByIdAtom\)/);
  assert.match(buildTurn, /liveThinkingId\?:/);
  assert.match(turnRow, /liveThinkingId: props\.liveThinkingId/);
  assert.doesNotMatch(turnRow, /liveThinkingGroup/);
});

test("AppUtils emits one thinking-group per thinking-only message", () => {
  const flushIdx = appUtils.indexOf("function flushThinking()");
  const flushBlock = appUtils.slice(flushIdx, flushIdx + 900);
  assert.match(flushBlock, /for \(const message of currentThinking\)/);
  assert.doesNotMatch(flushBlock, /\.join\("\\n\\n"\)/);
  assert.match(appUtils, /立即成组/);
});
