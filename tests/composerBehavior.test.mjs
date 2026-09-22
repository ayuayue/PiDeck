import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadComposerBehaviorModule() {
	// composerBehavior 现在会调用纯消息块 codec；使用共享依赖图加载器，
	// 避免手写 VM loader 在生产模块新增本地 import 后失去 require 能力。
	return loadTsCommonJs("src/renderer/src/composerBehavior.ts");
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

test("ignores Chromium keyCode 229 even when the native composing flag is absent", () => {
	const { getComposerEnterIntent } = loadComposerBehaviorModule();

	assert.equal(
		getComposerEnterIntent(
			{
				key: "Enter",
				ctrlKey: false,
				metaKey: false,
				shiftKey: false,
				nativeEvent: { keyCode: 229 },
			},
			"enter-send",
		),
		"ignore",
	);
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

test("inserts newline on Shift+Enter when Enter-to-send is enabled", () => {
	const { getComposerEnterIntent } = loadComposerBehaviorModule();

	assert.equal(
		getComposerEnterIntent(
			{
				key: "Enter",
				ctrlKey: false,
				metaKey: false,
				shiftKey: true,
				nativeEvent: { isComposing: false },
			},
			"enter-send",
		),
		"newline",
	);
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

// plan 模式是一次性提交流：回车即发，不再受 sendShortcut（enter/ctrl-enter/shift-enter）影响。
test("plan mode sends on plain Enter regardless of sendShortcut", () => {
	const { isPlanModeSendKey } = loadComposerBehaviorModule();

	assert.equal(
		isPlanModeSendKey({
			key: "Enter",
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			nativeEvent: { isComposing: false },
		}),
		true,
	);
});

test("plan mode keeps Shift+Enter as newline", () => {
	const { isPlanModeSendKey } = loadComposerBehaviorModule();

	assert.equal(
		isPlanModeSendKey({
			key: "Enter",
			ctrlKey: false,
			metaKey: false,
			shiftKey: true,
			nativeEvent: { isComposing: false },
		}),
		false,
	);
});

test("plan mode keeps Ctrl+Enter as newline", () => {
	const { isPlanModeSendKey } = loadComposerBehaviorModule();

	assert.equal(
		isPlanModeSendKey({
			key: "Enter",
			ctrlKey: true,
			metaKey: false,
			shiftKey: false,
		}),
		false,
	);
});

test("plan mode ignores Enter while an IME composition is being confirmed", () => {
	const { isPlanModeSendKey } = loadComposerBehaviorModule();

	assert.equal(
		isPlanModeSendKey({
			key: "Enter",
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			nativeEvent: { isComposing: true },
		}),
		false,
	);
});

test("plan mode ignores non-Enter keys", () => {
	const { isPlanModeSendKey } = loadComposerBehaviorModule();

	assert.equal(
		isPlanModeSendKey({
			key: "a",
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
		}),
		false,
	);
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

test("wraps goal composer submissions with the hidden PiDeck goal marker", () => {
	const { buildComposerPromptSubmission, PI_DECK_GOAL_MODE_MARKER } = loadComposerBehaviorModule();

	const submission = buildComposerPromptSubmission("Ship the release", "goal");

	assert.equal(submission.message, "Ship the release");
	assert.equal(submission.agentMessage, `${PI_DECK_GOAL_MODE_MARKER}\nShip the release`);
});

test("goal and plan modes leave slash commands unmarked", () => {
	const { buildComposerPromptSubmission } = loadComposerBehaviorModule();
	assert.equal(buildComposerPromptSubmission("/goal pause", "goal").agentMessage, undefined);
	assert.equal(buildComposerPromptSubmission("/plan off", "plan").agentMessage, undefined);
});

test("deriveComposerAgentMode keeps explicit normal over a still-active DSH goal", () => {
	const { deriveComposerAgentMode } = loadComposerBehaviorModule();
	assert.equal(
		deriveComposerAgentMode({
			backend: "dsh",
			localMode: "normal",
			goalPhase: "active",
		}),
		"normal",
	);
	assert.equal(
		deriveComposerAgentMode({
			backend: "dsh",
			goalPhase: "active",
		}),
		"goal",
	);
	assert.equal(
		deriveComposerAgentMode({
			backend: "dsh",
			localMode: "goal",
			planModeActive: true,
		}),
		"plan",
	);
});

test("applyDshGoalSendTransform prefixes /goal only when creating a new objective", () => {
	const { applyDshGoalSendTransform } = loadComposerBehaviorModule();
	assert.equal(
		applyDshGoalSendTransform({
			message: "Fix the build",
			mode: "goal",
		}),
		"/goal Fix the build",
	);
	assert.equal(
		applyDshGoalSendTransform({
			message: "keep going",
			mode: "goal",
			goal: { phase: "active" },
		}),
		"keep going",
	);
	assert.equal(
		applyDshGoalSendTransform({
			message: "/goal pause",
			mode: "goal",
		}),
		"/goal pause",
	);
});

test("parsePiGoalWidget reads phase, rounds, and objective", () => {
	const { parsePiGoalWidget } = loadComposerBehaviorModule();
	const parsed = parsePiGoalWidget(["active · 3/32", "Ship the release"]);
	assert.equal(parsed?.phase, "active");
	assert.equal(parsed?.objective, "Ship the release");
	assert.equal(parsed?.roundsStarted, 3);
	assert.equal(parsed?.maxGoalRounds, 32);
	assert.equal(parsePiGoalWidget(["not a header", "x"]), undefined);
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

test("expandPromptTemplates keeps /name as-is when the template body is empty (frontmatter only)", () => {
	const { expandPromptTemplates } = loadComposerBehaviorModule();
	// 回归：UI 新建模板只写 frontmatter、正文待编辑（PromptManager.create 行为），
	// 直接发送 /name 时旧实现展开出空白消息（仅剩分隔符 \n\n），被主进程拒为“消息不能为空”。
	const templates = [
		{
			name: "commit-push",
			path: "C:/Users/me/.pi/agent/prompts/commit-push.md",
			description: "提交推送",
			content: "---\ndescription: 提交推送\n---\n",
		},
		{
			name: "review",
			path: "builtin://review",
			description: "审查",
			content: "---\ndescription: 审查\n---\n\n请审查暂存的 Git 更改",
		},
	];

	// 只有空模板：消息保持原文，标记 emptyTemplateName
	const emptyOnly = expandPromptTemplates("/commit-push ", templates);
	assert.equal(emptyOnly.message, "/commit-push ");
	assert.equal(emptyOnly.emptyTemplateName, "commit-push");

	// 空模板无尾随空格：同样保持原文
	const noTrailing = expandPromptTemplates("/commit-push", templates);
	assert.equal(noTrailing.message, "/commit-push");
	assert.equal(noTrailing.emptyTemplateName, "commit-push");

	// 正常模板把名称和正文一起持久化：模型仍读正文，时间线重载后可恢复 /review chip。
	const normal = expandPromptTemplates("/review", templates);
	assert.equal(normal.message, '<prompt_template name="review">\n请审查暂存的 Git 更改\n</prompt_template>');
	assert.equal(normal.emptyTemplateName, undefined);
	assert.equal(normal.description, "审查");

	// 消息同时含空模板与普通文本：展开其余部分，仍标记空模板
	const mixed = expandPromptTemplates("先看下 /commit-push 再处理", templates);
	assert.equal(mixed.message, "先看下 /commit-push 再处理");
	assert.equal(mixed.emptyTemplateName, "commit-push");
});
