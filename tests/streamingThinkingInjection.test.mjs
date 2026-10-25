import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const turnRowSource = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
const timelineSource = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
const buildSource = readFileSync("src/renderer/src/components/session/timeline/buildTurnDisplay.ts", "utf8");
const thinkingStepSource = readFileSync("src/renderer/src/components/session/turn/ThinkingStep.tsx", "utf8");

/**
 * Live 思考：与 History 共用 msg-thinking-* 身份，由 buildTurnDisplay + ThinkingStep(atom) 消费。
 */
test("TurnRow mounts thinking via liveThinkingId identity, not a separate live group", () => {
	assert.match(turnRowSource, /liveThinkingId\?: string/);
	assert.match(turnRowSource, /liveThinkingId: props\.liveThinkingId/);
	assert.match(turnRowSource, /buildTurnDisplay\(run/);
	assert.doesNotMatch(turnRowSource, /liveThinkingGroup/);
	assert.doesNotMatch(turnRowSource, /\$\{run\.id\}:live-thinking/);
	assert.doesNotMatch(turnRowSource, /streamingThinking\?:/);
	assert.doesNotMatch(turnRowSource, /effectiveRun/);
});

test("buildTurnDisplay emits thinking-group when liveThinkingId hits assistant message", () => {
	assert.match(buildSource, /liveThinkingId\?: string/);
	assert.match(buildSource, /isLive/);
	assert.match(buildSource, /thinking \|\| \(showThinking && isLive\)/);
	assert.match(buildSource, /id: thinkingId/);
});

test("ThinkingStep reads live text from per-id atom family", () => {
	assert.match(thinkingStepSource, /streamingThinkingEntryByIdAtomFamily/);
	assert.match(thinkingStepSource, /live\?\.text \?\? props\.group\.text/);
});

test("streaming thinking flows into the execution area, not the timeline footer", () => {
	assert.doesNotMatch(timelineSource, /thinking-card markdown-body/);
	assert.doesNotMatch(timelineSource, /thinking-card-content/);
	assert.match(timelineSource, /liveThinkingId=\{liveThinkingId\}/);
	assert.doesNotMatch(timelineSource, /liveThinkingId=\{isRunStreaming \? liveThinkingId/);
	assert.match(timelineSource, /liveThinkingIdBySessionIdAtomFamily/);
	assert.doesNotMatch(timelineSource, /streamingThinkingByIdAtom/);
	assert.match(turnRowSource, /isStreaming=\{props\.isStreaming \?\? false\}/);
});
