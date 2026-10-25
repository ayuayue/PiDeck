import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
	return module.exports;
}

const follow = compile("src/renderer/src/lib/stick-to-bottom/followState.ts");
const engineSource = readFileSync("src/renderer/src/lib/stick-to-bottom/useStickToBottom.ts", "utf8");

test("down-wheel at physical bottom relocks without requiring a scroll event (bug 2)", () => {
	assert.equal(follow.shouldRelockFromDownInput(0, 25), true);
	assert.equal(follow.shouldRelockFromDownInput(10), true);
	assert.equal(follow.shouldRelockFromDownInput(25), true);
	assert.equal(follow.shouldRelockFromDownInput(26), false);
	assert.equal(follow.shouldRelockFromDownInput(100), false);
});

test("engine reports user intent only from confirmed input", () => {
	assert.match(engineSource, /reportUserIntent\(decision\.report, "input"\)/);
	assert.match(engineSource, /onUserIntent\?: \(intent: ScrollUserIntent, source: ScrollIntentSource\) => void/);
	assert.match(engineSource, /const reportUserIntent = useCallback\(\(intent: ScrollUserIntent, source: ScrollIntentSource\) => \{\s*optionsRef\.current\?\.onUserIntent\?\.\(intent, source\);/);
	assert.doesNotMatch(engineSource, /lastUserIntentRef/);
	assert.match(engineSource, /applyUserInput\(\s*deltaY < 0 \? "up" : "down"/);
});

test("MessageScroller wires user scroll intent from engine to the timeline controller", () => {
	const scrollerSource = readFileSync("src/renderer/src/components/agents/message-scroller.tsx", "utf8");
	const timelineSource = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	assert.match(scrollerSource, /onUserScrollIntent\?: \(intent: "up" \| "down", source: "scroll" \| "input"\) => void/);
	assert.match(scrollerSource, /onUserIntent: onUserScrollIntent,/);
	assert.match(scrollerSource, /engineNoteWheel\(event\.deltaY, event\.target\)/);
	assert.match(timelineSource, /onUserScrollIntent=\{controller\.setUserScrollIntent\}/);
});
