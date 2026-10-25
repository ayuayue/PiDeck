import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Live 正文通道契约：History / Live / Controls 三层。
 * - text_delta 不增长 messages；message_start 建空骨架
 * - agents:text-stream → streamingTextByIdAtom；不 bump runtime
 * - UI 经 AnswerOutput(live) 消费，不再使用 StreamingAnswerBubble
 */

test("main process: textEmitter tracks and pushes streaming text", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	// 节流常量已随消息 emit 域迁入 MessageEmitBatcher（AgentManager 拆分 Wave 2）；
	// 双通道状态机已随 Live 流域迁入 LiveStreamChannel（Wave 3）
	const batcher = readFileSync("src/main/pi/messageEmitBatcher.ts", "utf8");
	const liveStream = readFileSync("src/main/pi/liveStreamChannel.ts", "utf8");

	assert.match(liveStream, /readonly textEmitter = new LatestByKeyEmitter/);
	assert.match(batcher, /MESSAGE_FLUSH_INTERVAL_MS = 50/);
	assert.match(liveStream, /this\.streamingText\.set\(agentId, nextText\)/);
	// 2027-02 性能治理：ANSI 剥离挪到 emit（每 100ms flush 一次），delta 热路径推原文，
	// 不再每个 delta 对全量累积文本跑正则（O(N²)/消息）。
	assert.match(liveStream, /this\.textEmitter\.push\(agentId, nextText\)/);
	assert.match(liveStream, /const text = stripAnsi\(rawText\)/, "strip 必须在 emitTextStreamNow 开口");

	const cancelCount = agentManager.match(/this\.liveStream\.clearTextChannel\(agentId\)/g)?.length ?? 0;
	assert.ok(cancelCount >= 4, "text channel must clear on end/settled/abort paths");
	assert.match(liveStream, /clearTextChannel\(agentId: string\) \{[\s\S]*?textEmitter\.cancel\(agentId\);[\s\S]*?streamingText\.delete\(agentId\)/);
});

test("main process: top-level message_start creates empty skeleton", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(agentManager, /allowEmpty:\s*true/);
	assert.match(agentManager, /options\?: \{ allowEmpty\?: boolean \}/);
	// 顶层 message_start（非 assistantMessageEvent）必须 allowEmpty + flush
	const topStart = agentManager.indexOf('typed.type === "message_start"');
	const autoRetry = agentManager.indexOf('typed.type === "auto_retry_start"');
	assert.ok(topStart >= 0 && autoRetry > topStart);
	const block = agentManager.slice(topStart, autoRetry);
	assert.match(block, /allowEmpty:\s*true/);
	assert.match(block, /flushMessageEmit/);
	assert.match(block, /streamingAgents\.add/);

	// text_delta 分支内不得调用 upsertAssistantMessage
	const textDeltaIdx = agentManager.indexOf('if (eventType === "text_delta")');
	const thinkingDeltaIdx = agentManager.indexOf('if (eventType === "thinking_delta")');
	assert.ok(textDeltaIdx >= 0 && thinkingDeltaIdx > textDeltaIdx);
	const textDeltaBlock = agentManager.slice(textDeltaIdx, thinkingDeltaIdx);
	assert.doesNotMatch(textDeltaBlock, /this\.upsertAssistantMessage\(/);
	assert.match(textDeltaBlock, /this\.liveStream\.accumulateText\(/);

	const thinkingEndIdx = agentManager.indexOf('if (eventType === "thinking_end")');
	const thinkingDeltaBlock = agentManager.slice(thinkingDeltaIdx, thinkingEndIdx);
	assert.doesNotMatch(thinkingDeltaBlock, /this\.upsertAssistantMessage\(/);
	assert.match(thinkingDeltaBlock, /this\.liveStream\.pushThinkingDelta\(/);
});

test("main process: message_end pushes final text with done flag", () => {
	// 双通道推送已随 Live 流域迁入 LiveStreamChannel（Wave 3）；终态推送在 finalizeText。
	const liveStream = readFileSync("src/main/pi/liveStreamChannel.ts", "utf8");
	assert.match(liveStream, /this\.emitTextStreamNow\(agentId, finalText, true\)/);
	// 2027-02 起 emit 开口改收 rawText、内部 strip（ANSI 剥离从 per-delta 挪到 emit）
	assert.match(liveStream, /emitTextStreamNow\(agentId: string, rawText: string, done = false\)/);
});

test("renderer: streamingTextByIdAtom updates from agents:text-stream without runtime bump", () => {
	const atoms = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");
	assert.match(atoms, /export const streamingTextByIdAtom = atom/);
	assert.match(atoms, /Record<string, \{ content: string; streaming: boolean; held\?: boolean \}>/);
	assert.match(atoms, /event\.sourceChannel === "agents:text-stream"/);
	assert.match(atoms, /const streaming = !done && text\.length > 0/);
	assert.match(atoms, /delete nextMap\[event\.sessionId\]/);

	// text-stream 分支必须 early return，避免无条件写 sessionRuntimeByIdAtom
	const textStreamIdx = atoms.indexOf('event.sourceChannel === "agents:text-stream"');
	const messagesIdx = atoms.indexOf('event.sourceChannel === "agents:message"');
	assert.ok(textStreamIdx >= 0 && messagesIdx > textStreamIdx);
	const textStreamBlock = atoms.slice(textStreamIdx, messagesIdx);
	assert.match(textStreamBlock, /\breturn;/);
});

test("IPC channel wiring for agents:text-stream", () => {
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	assert.match(ipc, /agentsTextStream: "agents:text-stream"/);

	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(agentManager, /ipcChannels\.agentsTextStream/);
});

test("UI: AnswerOutput live path; TurnRow does not subscribe streaming atom", () => {
	const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
	assert.match(turnRow, /sessionId\?: string/);
	assert.match(turnRow, /lastInterimId/);
	assert.match(turnRow, /liveInterimId/);
	assert.match(turnRow, /mode="live"/);
	assert.doesNotMatch(turnRow, /StreamingAnswerBubble/);
	assert.doesNotMatch(turnRow, /streamingTextByIdAtom/);
	assert.match(turnRow, /if \(prev\.isStreaming \|\| next\.isStreaming\) return false;/);

	const answer = readFileSync("src/renderer/src/components/session/AnswerOutput.tsx", "utf8");
	assert.match(answer, /streamingTextByIdAtom/);
	// live 走 MarkdownStream（与思考同构）：打字机收进 MarkdownStream，
	// 不得自持 useSmoothStream 造成双重打字机
	assert.match(answer, /<MarkdownStream/);
	assert.doesNotMatch(answer, /from "\.\.\/\.\.\/utils\/useSmoothStream"/);
	assert.match(answer, /mode: "live" \| "settled"/);
	assert.match(answer, /execution-interim markdown-body/);
	// 中间回答分档：过程层弱于最终回答；live 当前正文仍走 answer 档
	assert.match(answer, /AnswerOutputVariant = "process" \| "answer"/);
	assert.match(answer, /data-variant=\{props\.variant \?\? "process"\}/);
	assert.match(answer, /answerOutputClassName\("answer"\)/);
	assert.match(answer, /data-variant="answer"/);

	const interim = readFileSync("src/renderer/src/components/session/turn/InterimAnswer.tsx", "utf8");
	assert.match(interim, /AnswerOutput/);

	const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	assert.match(timeline, /sessionId=\{sessionId\}/);
	assert.match(timeline, /isRunStreaming = isTurnRunning && item.id === lastDisplayedItemId/);
	assert.doesNotMatch(timeline, /streamingTextByIdAtom/);
	assert.doesNotMatch(timeline, /streamingMessageId/);
});

test("UI: settled AnswerOutput can play assistant-answer-settle fade", () => {
	const answer = readFileSync("src/renderer/src/components/session/AnswerOutput.tsx", "utf8");
	const css = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
	const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
	assert.match(answer, /settle\?: boolean/);
	assert.match(answer, /data-settle=\{props\.settle \? "1" : undefined\}/);
	assert.match(css, /\.execution-interim\[data-settle="1"\]/);
	assert.match(css, /assistant-answer-settle/);
	assert.match(turnRow, /settleId === item\.id/);
	assert.match(turnRow, /prevLiveIdRef/);
});
