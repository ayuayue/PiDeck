import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stripPath = "src/renderer/src/components/session/SessionGoalStrip.tsx";
const stripSource = () => readFileSync(stripPath, "utf8");
const viewSource = () => readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
const startSource = () => readFileSync("src/renderer/src/components/session/SessionStartSurface.tsx", "utf8");
const zh = () => readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = () => readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("goal strip hides when absent or complete and keeps blocked visible", () => {
	const source = stripSource();
	// 无投影 / 已完成不占输入区；blocked 仍展示，否则卡住原因看不见
	assert.match(source, /if \(!goal \|\| goal\.phase === "complete"\) return null/);
	assert.match(source, /goal\.phase === "blocked"/);
	assert.match(source, /runDshGoalAction\(agentId, action\)/);
	assert.match(source, /parsePiGoalWidget/);
	assert.match(source, /\/goal pause/);
	assert.match(source, /ConfirmDialog/);
});

test("goal strip is a 36px independent card in the same family as todo", () => {
	const source = stripSource();
	assert.match(source, /data-testid="session-goal-strip"/);
	assert.match(source, /<ComposerWidgetFrame/);
	assert.match(source, /from "\.\/ComposerWidgetLayout"/);
	assert.match(source, /flex h-9 w-full items-center/);
	assert.match(source, /t\("sessionGoal\.aria"\)/);
	assert.doesNotMatch(source, /createDshGoal/);
});

test("session view and start surface mount the strips then goal", () => {
	const view = viewSource();
	const start = startSource();
	assert.match(view, /<SessionTodoStrip sessionId=\{sessionId\} \/>/);
	assert.match(view, /<SessionSubagentsStrip[\s\S]*?onOpenChildSession=\{onOpenBranchSession\}/);
	assert.match(view, /<SessionGoalStrip sessionId=\{sessionId\} \/>/);
	assert.ok(view.indexOf("<SessionTodoStrip") < view.indexOf("<SessionSubagentsStrip") && view.indexOf("<SessionSubagentsStrip") < view.indexOf("<SessionGoalStrip"), "strip order must be todo → subagents → goal in SessionView widgets");
	// 「修改的文件」已改为每轮末尾的 chip 行（turn/TurnFileChanges），不再占 composer 槽位
	assert.doesNotMatch(view, /SessionFilesStrip/);
	assert.match(start, /<SessionTodoStrip sessionId=\{props\.sessionId\} \/>/);
	assert.match(start, /<SessionSubagentsStrip sessionId=\{props\.sessionId\} \/>/);
	assert.match(start, /<SessionGoalStrip sessionId=\{props\.sessionId\} \/>/);
	assert.doesNotMatch(start, /SessionFilesStrip/);
});

test("goal and queue copy is present in both locale dictionaries", () => {
	for (const locale of [zh(), en()]) {
		assert.match(locale, /"sessionGoal\.aria"/);
		assert.match(locale, /"sessionQueue\.count": "\{n\}/);
	}
});
