import assert, { deepEqual } from "node:assert";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 「提交/推送」快捷建议的意图检测回归（纯函数，见 commitIntentSuggestions.ts）。
 * 判据是「最终回复自然语言提到提交/推送」，代码块内的 git 命令不算命中。
 */

const modulePath = fileURLToPath(new URL("../src/renderer/src/utils/commitIntentSuggestions.ts", import.meta.url));
const { finalAssistantText, hasCommitIntent, commitSuggestionsForRun } = loadTsCommonJs(modulePath);

let nextId = 0;
const assistantMessage = (text, stopReason) => ({
	id: `msg-${(nextId += 1)}`,
	agentId: "agent-1",
	role: "assistant",
	text,
	timestamp: Date.now(),
	stopReason,
});
const run = (...messages) => ({
	kind: "agent-run",
	id: `run-${(nextId += 1)}`,
	items: messages.map((message) => ({ kind: "message", message })),
	startedAt: 0,
	endedAt: 1,
	askWaitMs: 0,
	askPending: false,
});

test("最终回复提到提交时命中，并给出固定两条建议", () => {
	const r = run(assistantMessage("修改已完成，你可以确认后提交这些改动。", "stop"));
	assert.equal(hasCommitIntent(finalAssistantText(r)), true);
	const suggestions = commitSuggestionsForRun(r);
	deepEqual(
		suggestions.map((s) => s.id),
		["commit", "commitPush"],
	);
});

test("推送语境（推送到远程）也命中", () => {
	assert.equal(hasCommitIntent("改动已就绪，需要的话我可以推送到远程。"), true);
	assert.equal(hasCommitIntent("let me know if you want me to push to origin."), true);
});
test("代码块里的 git 命令不算命中（模型只是展示命令）", () => {
	assert.equal(hasCommitIntent("用法：\n```bash\ngit commit -m 'feat: x'\ngit push origin main\n```\n随时可用。"), false);
	assert.equal(hasCommitIntent("行内代码 `git push` 示例"), false);
});

test("非 git 语义的「提交」固定搭配不命中（提交节点/调度队列/表单等）", () => {
	assert.equal(hasCommitIntent("任务已提交调度器排队执行。"), false);
	assert.equal(hasCommitIntent("请先填写提交表单。"), false);
});

test("与提交无关的回复不命中；裸 push/推送通知语境不算", () => {
	assert.equal(hasCommitIntent("这个函数的边界条件已修复，测试全绿。"), false);
	assert.equal(hasCommitIntent("we should push the array here."), false);
	assert.equal(hasCommitIntent("消息推送服务已接入。"), false);
	assert.equal(hasCommitIntent(undefined), false);
});

test("最终回复取 stopReason=stop 的 assistant 文本；中间工具回合文本不参与判定", () => {
	const r = run(assistantMessage("我先提交一下预览看效果。", "toolUse"), assistantMessage("修复完成，等你确认。", "stop"));
	assert.equal(finalAssistantText(r), "修复完成，等你确认。");
	assert.equal(commitSuggestionsForRun(r).length, 0);
});

test("stopReason 缺失时回退最后一条非空 assistant 文本", () => {
	const r = run(assistantMessage("中间过程", "toolUse"), assistantMessage("可以提交了吗？", undefined));
	assert.equal(finalAssistantText(r), "可以提交了吗？");
	assert.equal(commitSuggestionsForRun(r).length, 2);
});

test("空 run / 无 run 时不渲染建议", () => {
	deepEqual(commitSuggestionsForRun(undefined), []);
	deepEqual(commitSuggestionsForRun(run()), []);
});
