import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * Qoder 导入器契约测试。
 *
 * Qoder transcript 与 Claude 同构（ClaudeSessionImporter 作基类复用整条管线），
 * 差异点必须逐一钉住：
 * 1. 源库根目录 ~/.qoder-cn/projects，项目 slug 与 Claude 同规则；
 * 2. 扫描只取顶层 <sessionId>.jsonl，不递归 <sessionId>/subagents/ 子目录；
 * 3. 产物文件名 qoder_<id>.jsonl，导入标记 qoder_import；
 * 4. Qoder 独有的元数据行（workspace-directories/runtime-config/attachment 等）跳过不报错。
 */

function loadImporter(homePath) {
	const load = createTsSandbox({
		stubs: { electron: { app: { getPath: () => homePath } } },
	});
	return new (load("src/main/sessions/QoderSessionImporter.ts").QoderSessionImporter)();
}

function slugFor(projectPath) {
	return projectPath
		.replace(/\\/g, "/")
		.replace(/^([A-Za-z]):\//, "$1--")
		.replace(/\//g, "-");
}

function writeQoderSession(home, projectPath, sessionId, entries) {
	const dir = join(home, ".qoder-cn", "projects", slugFor(projectPath));
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${sessionId}.jsonl`);
	writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
	return { dir, file };
}

function makeEntries(projectPath, sessionId) {
	return [
		// Qoder 独有元数据行：头部解析与转换都必须容忍（跳过而非报错）
		{ type: "workspace-directories", sessionId, directories: [projectPath] },
		{ type: "runtime-config", sessionId, model: "qfmodel", timestamp: 1790297722191 },
		{
			type: "user",
			sessionId,
			cwd: projectPath,
			timestamp: "2026-09-25T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "你好" }] },
		},
		{
			type: "attachment",
			sessionId,
			cwd: projectPath,
			attachment: { type: "skill_listing", content: "- mcp-config: ..." },
		},
		{
			type: "assistant",
			sessionId,
			cwd: projectPath,
			timestamp: "2026-09-25T00:00:01.000Z",
			model: "qfmodel",
			message: {
				role: "assistant",
				model: "qfmodel",
				content: [
					{ type: "thinking", thinking: "简单问候。", signature: "" },
					{ type: "text", text: "你好！" },
					{ type: "tool_use", id: "toolq_1", name: "Read", input: { file_path: "a.ts" } },
				],
			},
		},
		{
			type: "user",
			sessionId,
			cwd: projectPath,
			timestamp: "2026-09-25T00:00:02.000Z",
			message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolq_1", content: "export const x = 1;" }] },
		},
		{
			type: "assistant",
			sessionId,
			cwd: projectPath,
			timestamp: "2026-09-25T00:00:03.000Z",
			message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "文件很短。" }] },
		},
	];
}

test("scan: 只列顶层会话，不混入 subagents 子目录里的子代理转录", async () => {
	const home = mkdtempSync(join(tmpdir(), "qoder-home-"));
	try {
		const projectPath = "F:\\PiDeck";
		const { dir, file } = writeQoderSession(home, projectPath, "sess-1", makeEntries(projectPath, "sess-1"));
		// 子代理转录：同构且带 cwd/sessionId，若递归收集会被误列为可导入会话
		const subDir = join(dir, "sess-1", "subagents");
		mkdirSync(subDir, { recursive: true });
		writeFileSync(join(subDir, "agent-explore.jsonl"), JSON.stringify(makeEntries(projectPath, "agent-explore").filter((entry) => entry.type === "user" || entry.type === "assistant")) + "\n", "utf8");
		void file;

		const importer = loadImporter(home);
		const sessions = await importer.scan(projectPath);
		assert.equal(sessions.length, 1);
		assert.equal(sessions[0].id, "sess-1");
		assert.equal(sessions[0].status, "new");
		assert.equal(sessions[0].title, "你好");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 产物为 qoder_<id>.jsonl + qoder_import 标记，工具调用折叠为 pi 消息", async () => {
	const home = mkdtempSync(join(tmpdir(), "qoder-home-"));
	try {
		const projectPath = "F:\\PiDeck";
		const { file } = writeQoderSession(home, projectPath, "sess-1", makeEntries(projectPath, "sess-1"));

		const importer = loadImporter(home);
		const report = await importer.import(projectPath, [file]);
		assert.equal(report.imported, 1);
		const targetPath = report.results[0].targetPath;
		assert.match(targetPath, /qoder_sess-1\.jsonl$/);

		const lines = readFileSync(targetPath, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));

		// 导入标记行（SessionScanner 靠它把会话归类为 qoder 来源）
		const importMark = lines.find((line) => line.type === "qoder_import");
		assert.ok(importMark, "缺少 qoder_import 标记行");
		assert.equal(importMark.sourceSessionId, "sess-1");

		// Qoder 独有元数据行不得泄漏进 pi 会话
		assert.ok(!lines.some((line) => ["workspace-directories", "runtime-config", "attachment", "file-history-snapshot"].includes(line.type)));

		const users = lines.filter((line) => line.type === "message" && line.message?.role === "user");
		assert.equal(users.length, 1);
		assert.equal(users[0].message.content[0].text, "你好");

		const toolResults = lines.filter((line) => line.type === "message" && line.message?.role === "toolResult");
		assert.equal(toolResults.length, 1);
		assert.equal(toolResults[0].message.toolCallId, "toolq_1");
		assert.equal(toolResults[0].message.content[0].text, "export const x = 1;");

		const assistants = lines.filter((line) => line.type === "message" && line.message?.role === "assistant");
		assert.equal(assistants[0].message.model, "qfmodel", "行内 model 应保留源模型名");
		const call = assistants[0].message.content.find((item) => item.type === "toolCall");
		assert.deepEqual(call.arguments, { file_path: "a.ts" });
		assert.equal(assistants[1].message.stopReason, "stop", "end_turn 应归一为 stop");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 拒绝读取 ~/.qoder-cn/projects 之外的路径", async () => {
	const home = mkdtempSync(join(tmpdir(), "qoder-home-"));
	try {
		const projectPath = "F:\\PiDeck";
		const outside = join(home, "elsewhere", "sess-x.jsonl");
		mkdirSync(join(home, "elsewhere"), { recursive: true });
		writeFileSync(outside, JSON.stringify({ type: "user", sessionId: "sess-x", cwd: projectPath, message: { role: "user", content: "hi" } }) + "\n", "utf8");

		const importer = loadImporter(home);
		const report = await importer.import(projectPath, [outside]);
		assert.equal(report.failed, 1);
		assert.equal(report.results[0].success, false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: Claude 导入器根目录不受子类影响（sourceRoot 覆盖只作用于 Qoder）", async () => {
	const home = mkdtempSync(join(tmpdir(), "qoder-home-"));
	try {
		const projectPath = "F:\\PiDeck";
		const { file } = writeQoderSession(home, projectPath, "sess-1", makeEntries(projectPath, "sess-1"));
		const load = createTsSandbox({ stubs: { electron: { app: { getPath: () => home } } } });
		const ClaudeImporter = load("src/main/sessions/ClaudeSessionImporter.ts").ClaudeSessionImporter;
		const claude = new ClaudeImporter();
		// Claude 导入器只认 ~/.claude/projects，Qoder 目录里的会话对它不可见
		assert.equal((await claude.scan(projectPath)).length, 0);
		void file;
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
