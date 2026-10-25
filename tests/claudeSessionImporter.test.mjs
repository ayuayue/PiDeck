import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

function loadImporter(homePath) {
	// 用统一沙箱加载器：相对 import 自动按**源文件目录**解析（不再手写 require 桥 +
	// tryRequireLocalTs 补层）。生产代码新增本地依赖时不会再连锁破坏本测试。
	const load = createTsSandbox({
		stubs: { electron: { app: { getPath: () => homePath } } },
	});
	return new (load("src/main/sessions/ClaudeSessionImporter.ts").ClaudeSessionImporter)();
}

function writeClaudeSession(home, projectPath, sessionId, entries) {
	const slug = projectPath
		.replace(/\\/g, "/")
		.replace(/^([A-Za-z]):\//, "$1--")
		.replace(/\//g, "-");
	const dir = join(home, ".claude", "projects", slug);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${sessionId}.jsonl`);
	writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
	return file;
}

test("import: user.content 里的 tool_result 写成 pi toolResult，不变成用户气泡", async () => {
	const home = mkdtempSync(join(tmpdir(), "claude-home-"));
	try {
		const projectPath = "F:\\PiDeck";
		const file = writeClaudeSession(home, projectPath, "sess-1", [
			{
				type: "user",
				sessionId: "sess-1",
				cwd: projectPath,
				timestamp: "2026-09-15T00:00:00.000Z",
				message: { role: "user", content: "看看这个文件" },
			},
			{
				type: "assistant",
				sessionId: "sess-1",
				cwd: projectPath,
				timestamp: "2026-09-15T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "我先读。" },
						{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } },
					],
				},
			},
			{
				type: "user",
				sessionId: "sess-1",
				cwd: projectPath,
				timestamp: "2026-09-15T00:00:02.000Z",
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "export const x = 1;" }],
				},
			},
			{
				type: "assistant",
				sessionId: "sess-1",
				cwd: projectPath,
				timestamp: "2026-09-15T00:00:03.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "文件很短。" }] },
			},
		]);

		const importer = loadImporter(home);
		const report = await importer.import(projectPath, [file]);
		assert.equal(report.imported, 1);
		const lines = readFileSync(report.results[0].targetPath, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));

		const users = lines.filter((line) => line.type === "message" && line.message?.role === "user");
		assert.equal(users.length, 1);
		assert.equal(users[0].message.content[0].text, "看看这个文件");
		assert.ok(!JSON.stringify(users).includes("[object Object]"));

		const toolResults = lines.filter((line) => line.type === "message" && line.message?.role === "toolResult");
		assert.equal(toolResults.length, 1);
		assert.equal(toolResults[0].message.toolCallId, "toolu_1");
		assert.equal(toolResults[0].message.content[0].text, "export const x = 1;");

		const assistants = lines.filter((line) => line.type === "message" && line.message?.role === "assistant");
		const call = assistants[0].message.content.find((item) => item.type === "toolCall");
		assert.deepEqual(call.arguments, { file_path: "a.ts" });
		assert.equal(assistants[0].message.stopReason, "toolUse");
		assert.equal(assistants[1].message.stopReason, "stop");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 未知块落成 JSON，无字节图片写占位，end_turn 归一为 stop", async () => {
	const home = mkdtempSync(join(tmpdir(), "claude-home-"));
	try {
		const projectPath = "F:\\PiDeck";
		const file = writeClaudeSession(home, projectPath, "sess-2", [
			{
				type: "user",
				sessionId: "sess-2",
				cwd: projectPath,
				timestamp: "2026-09-15T00:00:00.000Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "看这张图" },
						{ type: "image", filename: "shot.png" },
					],
				},
			},
			{
				type: "assistant",
				sessionId: "sess-2",
				cwd: projectPath,
				timestamp: "2026-09-15T00:00:01.000Z",
				message: {
					role: "assistant",
					stop_reason: "end_turn",
					content: [
						{ type: "text", text: "收到。" },
						{ type: "mystery", foo: 1 },
					],
				},
			},
		]);

		const importer = loadImporter(home);
		const report = await importer.import(projectPath, [file]);
		assert.equal(report.imported, 1);
		const lines = readFileSync(report.results[0].targetPath, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));

		const user = lines.find((line) => line.type === "message" && line.message?.role === "user");
		assert.equal(user.message.content[0].text, "看这张图");
		assert.equal(user.message.content[1].text, "[image: shot.png]");

		const assistant = lines.find((line) => line.type === "message" && line.message?.role === "assistant");
		assert.equal(assistant.message.stopReason, "stop");
		assert.equal(assistant.message.content[0].text, "收到。");
		assert.equal(assistant.message.content[1].text, '{"type":"mystery","foo":1}');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
