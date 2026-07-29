import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadComposerBehaviorModule() {
	const source = readFileSync("src/renderer/src/composerBehavior.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, {
		filename: "composerBehavior.ts",
	});
	return sandbox.exports;
}

test("ignores Enter while an IME composition is being confirmed", () => {
	const { getComposerEnterIntent } = loadComposerBehaviorModule();

	const intent = getComposerEnterIntent(
		{
			key: "Enter",
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			nativeEvent: { isComposing: true },
		},
		"enter-send",
	);

	assert.equal(intent, "ignore");
});

test("sends on plain Enter when Enter-to-send is enabled", () => {
	const { getComposerEnterIntent } = loadComposerBehaviorModule();

	const intent = getComposerEnterIntent(
		{
			key: "Enter",
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			nativeEvent: { isComposing: false },
		},
		"enter-send",
	);

	assert.equal(intent, "send");
});

test("inserts newline on Ctrl+Enter when Enter-to-send is enabled", () => {
	const { getComposerEnterIntent } = loadComposerBehaviorModule();

	const intent = getComposerEnterIntent(
		{
			key: "Enter",
			ctrlKey: true,
			metaKey: false,
			shiftKey: false,
			nativeEvent: { isComposing: false },
		},
		"enter-send",
	);

	assert.equal(intent, "newline");
});

test("keeps normal composer submissions visible without hidden agent instructions", () => {
	const { buildComposerPromptSubmission } = loadComposerBehaviorModule();

	const submission = buildComposerPromptSubmission("Fix the bug", "normal");

	assert.equal(submission.message, "Fix the bug");
	assert.equal(submission.agentMessage, undefined);
});

test("wraps plan composer submissions with the hidden PiDeck plan marker", () => {
	const { buildComposerPromptSubmission, PI_DECK_PLAN_MODE_MARKER } = loadComposerBehaviorModule();

	const submission = buildComposerPromptSubmission("Inspect first", "plan");

	assert.equal(submission.message, "Inspect first");
	assert.match(submission.agentMessage, new RegExp(`^${PI_DECK_PLAN_MODE_MARKER}\\n`));
	assert.match(submission.agentMessage, /Inspect first/);
	assert.match(submission.agentMessage, /Plan:/);
});

// 复现：普通输入不重渲染 App，live ref 已是全文，但闭包里的 renderedPrompt 仍是旧值。
// ArrowUp 必须快照 live 草稿，否刕 ArrowDown 会丢掉继续输入的部分。
test("history navigation snapshots the live draft instead of the last rendered prompt", () => {
	const { resolveComposerHistoryDraft } = loadComposerBehaviorModule();

	const draft = resolveComposerHistoryDraft({
		activeAgentId: "agent-1",
		livePromptByAgent: {
			"agent-1": "第一段输入 继续输入的后半段",
		},
		// 上次重渲染时的旧 prompt（例如仅在 IME 确认/有无内容翻转时更新）
		renderedPrompt: "第一段输入",
	});

	assert.equal(draft, "第一段输入 继续输入的后半段");
});

test("history navigation falls back to rendered prompt when live draft is missing", () => {
	const { resolveComposerHistoryDraft } = loadComposerBehaviorModule();

	const draft = resolveComposerHistoryDraft({
		activeAgentId: "agent-1",
		livePromptByAgent: {},
		renderedPrompt: "fallback draft",
	});

	assert.equal(draft, "fallback draft");
});

test("history line bounds use the live draft cursor position", () => {
	const { getComposerHistoryLineBounds } = loadComposerBehaviorModule();

	const multi = getComposerHistoryLineBounds("line1\nline2", 2);
	assert.equal(multi.isFirstLine, true);
	assert.equal(multi.isLastLine, false);

	const last = getComposerHistoryLineBounds("line1\nline2", 8);
	assert.equal(last.isFirstLine, false);
	assert.equal(last.isLastLine, true);
});

// confirm 扩展层走 select([是,否])：桌面端必须识别为纯是否题，不展示自定义输入。
test("detects yes/no confirm options and rejects multi-choice selects", () => {
	const { isYesNoConfirmOptions } = loadComposerBehaviorModule();

	assert.equal(isYesNoConfirmOptions(["是", "否"]), true);
	assert.equal(isYesNoConfirmOptions(["Yes", "No"]), true);
	assert.equal(
		isYesNoConfirmOptions([
			{ label: "是", value: "yes" },
			{ label: "否", value: "no" },
		]),
		true,
	);
	assert.equal(isYesNoConfirmOptions(["继续", "查看目录", "写代码"]), false);
	assert.equal(isYesNoConfirmOptions(["是"]), false);
	assert.equal(isYesNoConfirmOptions(["是", "否", "其它"]), false);
});
