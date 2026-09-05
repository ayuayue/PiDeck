import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { collectSessionFileChanges, collectRunFileChanges, fileChangeToDiffLines } from "../src/renderer/src/components/session/TimelineFormat.ts";
import { collectLatestTurnFileChanges } from "../src/shared/fileChanges.ts";

/**
 * 会话文件修改汇总收集逻辑测试：
 * write/edit 工具消息 → 文件列表（去重 + 次数累计 + 最后一次 diff 内容）。
 * 纯函数已迁往 shared/fileChanges，TimelineFormat re-export 保持本测试 import 路径不变。
 */
function toolMessage(overrides = {}) {
	return {
		id: overrides.id ?? `m-${Math.random().toString(36).slice(2)}`,
		agentId: "a",
		role: "assistant",
		text: "",
		timestamp: Date.now(),
		meta: {
			toolName: overrides.toolName ?? "write",
			args: overrides.args ?? {},
		},
	};
}

test("collectSessionFileChanges: write tool yields the file with full content", () => {
	const messages = [
		toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "export const a = 1;" } }),
	];
	const files = collectSessionFileChanges(messages);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "src/a.ts");
	assert.equal(files[0].content, "export const a = 1;");
	assert.equal(files[0].count, 1);
});

test("collectSessionFileChanges: same file written twice counts twice and keeps the last content", () => {
	const messages = [
		toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "v1" } }),
		toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "v2" } }),
	];
	const files = collectSessionFileChanges(messages);
	assert.equal(files.length, 1);
	assert.equal(files[0].count, 2);
	assert.equal(files[0].content, "v2");
});

test("collectSessionFileChanges: edit tool captures the changed region", () => {
	const messages = [
		toolMessage({
			path: "src/b.ts",
			toolName: "edit",
			args: {
				file_path: "src/b.ts",
				old_string: "const x = 1;",
				new_string: "const x = 2;",
			},
		}),
	];
	const files = collectSessionFileChanges(messages);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "src/b.ts");
	assert.equal(files[0].originalContent, "const x = 1;");
	assert.equal(files[0].content, "const x = 2;");
});

test("collectSessionFileChanges: non-file tools and file-less args are ignored", () => {
	const messages = [
		toolMessage({ toolName: "bash", args: { command: "ls" } }),
		toolMessage({ toolName: "read", args: { file_path: "README.md" } }),
		toolMessage({ toolName: "write", args: {} }),
	];
	assert.deepEqual(collectSessionFileChanges(messages), []);
});

test("collectSessionFileChanges: different files are kept separately", () => {
	const messages = [
		toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "a" } }),
		toolMessage({ path: "src/b.ts", args: { file_path: "src/b.ts", content: "b" } }),
	];
	const files = collectSessionFileChanges(messages);
	assert.equal(files.length, 2);
	assert.deepEqual(
		files.map((f) => f.path).sort(),
		["src/a.ts", "src/b.ts"],
	);
});

test("collectRunFileChanges: gathers file changes from one run only", () => {
	const run = {
		kind: "agent-run",
		id: "run-1",
		startedAt: 1000,
		endedAt: 2000,
		items: [
			{ kind: "message", message: { role: "user", id: "u1", text: "hi", timestamp: 1100 } },
			{
				kind: "tool-group",
				id: "tg-1",
				messages: [
					toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "v1" } }),
					toolMessage({ toolName: "bash", args: { command: "ls" } }),
				],
			},
			{ kind: "thinking-group", id: "th-1", text: "", startedAt: 1200, endedAt: 1300, messages: [] },
			{ kind: "message", message: { role: "assistant", id: "a1", text: "done", timestamp: 1900 } },
		],
	};
	const files = collectRunFileChanges(run);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "src/a.ts");
	assert.equal(files[0].count, 1);
});

function userMessage(text = "hi") {
	return {
		id: `u-${Math.random().toString(36).slice(2)}`,
		agentId: "a",
		role: "user",
		text,
		timestamp: Date.now(),
	};
}

test("collectLatestTurnFileChanges: only aggregates files after the last user message", () => {
	const messages = [
		userMessage("第一轮提问"),
		toolMessage({ path: "src/old.ts", args: { file_path: "src/old.ts", content: "old" } }),
		userMessage("第二轮提问"),
		toolMessage({ path: "src/new.ts", args: { file_path: "src/new.ts", content: "new" } }),
	];
	const files = collectLatestTurnFileChanges(messages);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "src/new.ts");
	// 历史轮次（第一轮）的文件不出现
	assert.ok(!files.some((f) => f.path === "src/old.ts"));
});

test("collectLatestTurnFileChanges: earlier-turn hits do not count into the latest turn", () => {
	const messages = [
		userMessage("提问1"),
		toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "v1" } }),
		userMessage("提问2"),
		toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "v2" } }),
	];
	const files = collectLatestTurnFileChanges(messages);
	assert.equal(files.length, 1);
	assert.equal(files[0].count, 1); // 只统计最新一轮的一次命中
	assert.equal(files[0].content, "v2");
});

test("collectLatestTurnFileChanges: no user message falls back to full aggregation", () => {
	const messages = [
		toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "a" } }),
	];
	const files = collectLatestTurnFileChanges(messages);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "src/a.ts");
});

test("collectLatestTurnFileChanges: no messages after the last user returns empty", () => {
	const messages = [userMessage("刚提问，还没回答")];
	assert.deepEqual(collectLatestTurnFileChanges(messages), []);
});

test("fileChangeToDiffLines: write yields all-added lines, edit yields removed+added", () => {
	const writeLines = fileChangeToDiffLines({ originalContent: "", content: "a\nb" });
	assert.deepEqual(writeLines, [
		{ id: "added-0", type: "added", content: "a" },
		{ id: "added-1", type: "added", content: "b" },
	]);
	const editLines = fileChangeToDiffLines({ originalContent: "old1\nold2", content: "new1" });
	assert.deepEqual(editLines, [
		{ id: "removed-0", type: "removed", content: "old1" },
		{ id: "removed-1", type: "removed", content: "old2" },
		{ id: "added-0", type: "added", content: "new1" },
	]);
});

test("file changes render through the files strip, not a per-strip owner", () => {
	const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	assert.ok(!timeline.includes("TurnFileChanges"), "timeline should not own the file strip");
	const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
	assert.doesNotMatch(turnRow, /TurnFileChanges/);
	const sessionView = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
	assert.match(sessionView, /SessionFilesStrip/);
	assert.match(sessionView, /latestAgentRun/);
	const strip = readFileSync("src/renderer/src/components/session/SessionFilesStrip.tsx", "utf8");
	assert.match(strip, /useSessionFileChanges\(/, "files strip should use the session-level file changes hook");
	assert.match(strip, /data-testid="session-files-strip"/);
	assert.doesNotMatch(strip, /MAX_VISIBLE_FILES|moreFiles/, "no truncation/more-files UI in the files strip");
});
