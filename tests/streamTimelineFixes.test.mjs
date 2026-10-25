import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const thinkingStep = readFileSync("src/renderer/src/components/session/turn/ThinkingStep.tsx", "utf8");
const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
const stick = readFileSync("src/renderer/src/lib/stick-to-bottom/useStickToBottom.ts", "utf8");

test("ThinkingStep typewriter follows only its live streaming entry", () => {
	// 禁止用整轮 isStreaming 回退，否则上一段已落盘思考会跟下一段一起打字
	assert.match(thinkingStep, /const isStreaming = Boolean\(live\?\.streaming && live\.endedAt <= 0\);/);
	assert.doesNotMatch(thinkingStep, /props\.isStreaming/);
	assert.doesNotMatch(turnRow, /ThinkingStep[\s\S]*?isStreaming=\{props\.isStreaming\}/);
});

test("execution Collapsible onOpenChange sets open state instead of toggling", () => {
	assert.match(turnRow, /onOpenChange=\{setStepsVisibleFromUser\}/);
	assert.doesNotMatch(turnRow, /onOpenChange=\{toggleSteps\}/);
});

test("stick-to-bottom follow flag is strict isAtBottom (not near-bottom OR)", () => {
	assert.match(stick, /对外「是否锁底跟随」只用严格 isAtBottom/);
	assert.doesNotMatch(stick, /isAtBottom:\s*isAtBottom\s*\|\|\s*isNearBottom/);
});
