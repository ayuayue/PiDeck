import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * Claude/Qoder 源 transcript 是 uuid/parentUuid **树**（rewind、中断续聊产生多分支），
 * 本文件覆盖导入器的活链重建与 tool 配对守卫——回归目标：产物里不得出现
 * 「前面没有 tool_calls 的孤儿 toolResult」（严格供应商 400：Messages with role
 * 'tool' must be a response to a preceding message with 'tool_calls'）。
 */

function loadImporter(homePath) {
	// 用统一沙箱加载器：相对 import 自动按**源文件目录**解析（不再手写 require 桥）。
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

function readImportedLines(targetPath) {
	return readFileSync(targetPath, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/** 与 pi transformMessages 同口径：找出「前面没有 tool_calls 的孤儿 toolResult」。 */
function findOrphanToolResults(lines) {
	const pending = new Set();
	const orphans = [];
	for (const line of lines) {
		if (line.type !== "message") continue;
		const msg = line.message;
		if (msg.role === "assistant") {
			pending.clear();
			for (const item of msg.content) if (item.type === "toolCall") pending.add(item.id);
		} else if (msg.role === "user") {
			pending.clear();
		} else if (msg.role === "toolResult") {
			if (!pending.has(msg.toolCallId)) orphans.push(msg.toolCallId);
			pending.delete(msg.toolCallId);
		}
	}
	return orphans;
}

test("import: uuid/parentUuid 树按活链重建，rewind 废弃分支不产生孤儿 toolResult", async () => {
	const home = mkdtempSync(join(tmpdir(), "claude-home-"));
	try {
		const projectPath = "F:\\PiDeck";
		// 真实事故形态：主链 a1 的 tool_use 后，旧分支 x1/x2 与新分支 y1 都按时间混在文件里
		const file = writeClaudeSession(home, projectPath, "sess-branch", [
			{ type: "user", uuid: "u1", parentUuid: null, sessionId: "sess-branch", cwd: projectPath, timestamp: "2026-09-15T00:00:00.000Z", message: { role: "user", content: "帮我生成一张猫的图片" } },
			{ type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: "sess-branch", cwd: projectPath, timestamp: "2026-09-15T00:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_t1", name: "Task", input: { prompt: "draw" } }] } },
			// 废弃分支（rewind 前的旧尝试）
			{ type: "user", uuid: "x1", parentUuid: "a1", sessionId: "sess-branch", cwd: projectPath, timestamp: "2026-09-15T00:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_t1", content: "旧分支结果不应出现" }] } },
			{ type: "assistant", uuid: "x2", parentUuid: "x1", sessionId: "sess-branch", cwd: projectPath, timestamp: "2026-09-15T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "旧分支回复不应出现" }] } },
			// 活链分支（rewind 后的真实继续）
			{ type: "user", uuid: "y1", parentUuid: "a1", sessionId: "sess-branch", cwd: projectPath, timestamp: "2026-09-15T00:00:04.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_t1", content: "新分支结果" }] } },
			{ type: "assistant", uuid: "a2", parentUuid: "y1", sessionId: "sess-branch", cwd: projectPath, timestamp: "2026-09-15T00:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "图片已生成" }] } },
		]);

		const importer = loadImporter(home);
		const report = await importer.import(projectPath, [file]);
		assert.equal(report.imported, 1);
		const lines = readImportedLines(report.results[0].targetPath);
		const raw = readFileSync(report.results[0].targetPath, "utf8");

		assert.ok(!raw.includes("旧分支结果不应出现"), "废弃分支的 tool_result 不应进入产物");
		assert.ok(!raw.includes("旧分支回复不应出现"), "废弃分支的 assistant 不应进入产物");
		assert.ok(raw.includes("新分支结果"), "活链分支内容必须保留");
		assert.ok(raw.includes("图片已生成"), "活链末尾 assistant 必须保留");
		assert.deepEqual(findOrphanToolResults(lines), [], "产物不得含孤儿 toolResult（严格供应商 400 根因）");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 文件以 sidechain 记录结尾时仍选主链尖端，不丢主会话", async () => {
	const home = mkdtempSync(join(tmpdir(), "claude-home-"));
	try {
		const projectPath = "F:\\PiDeck";
		const file = writeClaudeSession(home, projectPath, "sess-sidechain", [
			{ type: "user", uuid: "u1", parentUuid: null, sessionId: "sess-sidechain", cwd: projectPath, timestamp: "2026-09-15T00:00:00.000Z", message: { role: "user", content: "跑个子任务" } },
			{ type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: "sess-sidechain", cwd: projectPath, timestamp: "2026-09-15T00:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_task", name: "Task", input: { prompt: "sub" } }] } },
			{ type: "user", uuid: "y1", parentUuid: "a1", sessionId: "sess-sidechain", cwd: projectPath, timestamp: "2026-09-15T00:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_task", content: "子任务完成" }] } },
			{ type: "assistant", uuid: "a2", parentUuid: "y1", sessionId: "sess-sidechain", cwd: projectPath, timestamp: "2026-09-15T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "主会话总结" }] } },
			// sidechain（Task 子代理）转录写在文件最后：绝不能成为活链尖端
			{ type: "user", uuid: "s1", parentUuid: "a1", isSidechain: true, sessionId: "sess-sidechain", cwd: projectPath, timestamp: "2026-09-15T00:00:04.000Z", message: { role: "user", content: "子代理内部上下文不应出现" } },
			{ type: "assistant", uuid: "s2", parentUuid: "s1", isSidechain: true, sessionId: "sess-sidechain", cwd: projectPath, timestamp: "2026-09-15T00:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "子代理内部回复不应出现" }] } },
		]);

		const importer = loadImporter(home);
		const report = await importer.import(projectPath, [file]);
		assert.equal(report.imported, 1);
		const lines = readImportedLines(report.results[0].targetPath);
		const raw = readFileSync(report.results[0].targetPath, "utf8");

		assert.ok(raw.includes("主会话总结"), "主链末尾必须保留（sidechain 不能当活链尖端）");
		assert.ok(!raw.includes("子代理内部"), "sidechain 支线转录不应进入产物");
		assert.deepEqual(findOrphanToolResults(lines), []);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 混合 entry [text, tool_result] 先写 toolResult 再写文本，保持配对", async () => {
	const home = mkdtempSync(join(tmpdir(), "claude-home-"));
	try {
		const projectPath = "F:\\PiDeck";
		// 中断后带新文本继续的真实形态：一个 user entry 同时带新文本与 tool_result
		const file = writeClaudeSession(home, projectPath, "sess-mixed", [
			{ type: "user", sessionId: "sess-mixed", cwd: projectPath, timestamp: "2026-09-15T00:00:00.000Z", message: { role: "user", content: "生成图片" } },
			{ type: "assistant", sessionId: "sess-mixed", cwd: projectPath, timestamp: "2026-09-15T00:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_m1", name: "Bash", input: { command: "gen" } }] } },
			{
				type: "user",
				sessionId: "sess-mixed",
				cwd: projectPath,
				timestamp: "2026-09-15T00:00:02.000Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "换个风格" },
						{ type: "tool_result", tool_use_id: "toolu_m1", content: "image.webp" },
					],
				},
			},
			{ type: "assistant", sessionId: "sess-mixed", cwd: projectPath, timestamp: "2026-09-15T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "好的" }] } },
		]);

		const importer = loadImporter(home);
		const report = await importer.import(projectPath, [file]);
		assert.equal(report.imported, 1);
		const lines = readImportedLines(report.results[0].targetPath);

		assert.deepEqual(findOrphanToolResults(lines), [], "混合 entry 不得因文本抢先而产生孤儿");
		const messages = lines.filter((line) => line.type === "message");
		const toolResultIndex = messages.findIndex((line) => line.message.role === "toolResult");
		const userTextIndex = messages.findIndex((line) => line.message.role === "user" && line.message.content[0]?.text === "换个风格");
		assert.ok(toolResultIndex >= 0 && userTextIndex >= 0);
		assert.ok(toolResultIndex < userTextIndex, "toolResult 必须先于同 entry 的用户文本");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 无法配对的 tool_result 降级为用户文本，不产生孤儿 tool 消息", async () => {
	const home = mkdtempSync(join(tmpdir(), "claude-home-"));
	try {
		const projectPath = "F:\\PiDeck";
		const file = writeClaudeSession(home, projectPath, "sess-orphan", [
			{ type: "user", sessionId: "sess-orphan", cwd: projectPath, timestamp: "2026-09-15T00:00:00.000Z", message: { role: "user", content: "开始" } },
			{ type: "assistant", sessionId: "sess-orphan", cwd: projectPath, timestamp: "2026-09-15T00:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_o1", name: "Read", input: { file_path: "a.ts" } }] } },
			{ type: "user", sessionId: "sess-orphan", cwd: projectPath, timestamp: "2026-09-15T00:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_o1", content: "正常结果" }] } },
			// 孤儿：toolu_ghost 没有对应的 tool_use（源文件损坏/中断残留）
			{ type: "user", sessionId: "sess-orphan", cwd: projectPath, timestamp: "2026-09-15T00:00:03.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ghost", content: "幽灵结果内容" }] } },
		]);

		const importer = loadImporter(home);
		const report = await importer.import(projectPath, [file]);
		assert.equal(report.imported, 1);
		const lines = readImportedLines(report.results[0].targetPath);

		assert.deepEqual(findOrphanToolResults(lines), []);
		assert.ok(!lines.some((line) => line.type === "message" && line.message?.role === "toolResult" && line.message.toolCallId === "toolu_ghost"), "孤儿不得写成 toolResult 消息");
		const demoted = lines.find((line) => line.type === "message" && line.message?.role === "user" && String(line.message.content[0]?.text ?? "").includes("幽灵结果内容"));
		assert.ok(demoted, "孤儿结果的内容必须以用户文本保留");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import/scan: 旧转换器版本的产物标记 outdated，引导重导修复", async () => {
	const home = mkdtempSync(join(tmpdir(), "claude-home-"));
	try {
		const projectPath = "F:\\PiDeck";
		const file = writeClaudeSession(home, projectPath, "sess-version", [{ type: "user", sessionId: "sess-version", cwd: projectPath, timestamp: "2026-09-15T00:00:00.000Z", message: { role: "user", content: "版本检查" } }]);

		const importer = loadImporter(home);
		const report = await importer.import(projectPath, [file]);
		assert.equal(report.imported, 1);
		const targetPath = report.results[0].targetPath;

		const scanned = await importer.scan(projectPath);
		assert.equal(scanned.length, 1);
		assert.equal(scanned[0].status, "current", "新导入产物应为 current");

		// 模拟旧版本转换器产物（version 1 标记）
		const raw = readFileSync(targetPath, "utf8");
		const markerLine = raw.split(/\r?\n/).find((line) => line.includes('"claude_import"'));
		assert.ok(markerLine, "产物必须含 claude_import 标记");
		const downgraded = raw.replace(markerLine, markerLine.replace(/"version":\d+/, '"version":0'));
		assert.notEqual(downgraded, raw, "标记版本必须可被降级（断言替换真的发生）");
		writeFileSync(targetPath, downgraded, "utf8");

		const rescanned = await importer.scan(projectPath);
		assert.equal(rescanned[0].status, "outdated", "旧转换器版本必须标记 outdated 引导重导");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
