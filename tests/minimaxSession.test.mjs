import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * MinimaxCode（~/.minimax）会话导入单测：扫描（manifest/cwd 探测/归属过滤）+
 * 转换（pi JSONL 行格式）+ 增量判定（import 标记）。
 *
 * fixture 按真实布局构造：v2/sessions/YYYY/MM/DD/HH-mm-ss-SSS-session_<id>/ 下
 * manifest.json + messages.jsonl（{message:{role,content,timestamp}} 行）+ llm-call.json
 * （systemPrompt 内嵌 `working directory: <path>`）。
 */

const PROJECT_PATH = "F:\\PiDeck";

function loadModules() {
	const load = createTsSandbox({ stubs: {} });
	return {
		source: load("src/main/sessions/minimaxSessionSource.ts"),
		convert: load("src/main/sessions/minimaxSessionConvert.ts"),
	};
}

/** 造一个 minimax 会话目录（messages 行形状：{message_id, message:{role, content[], timestamp}}）。 */
function makeSessionDir(home, { day = "2026/03/15", name = "10-00-00-000-session_abc123", sessionId = "sess-abc123", cwd = PROJECT_PATH, messages = null } = {}) {
	// minimaxSessionsRoot(home) = home/.minimax/v2/sessions（fixture 必须落在真实根下）
	const dir = join(home, ".minimax", "v2", "sessions", ...day.split("/"), name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ sessionId, createdAtMs: 1773000000000, updatedAtMs: 1773000100000, paths: { projectPath: cwd } }));
	// cwd 为空时不写 llm-call.json：模拟无 working directory 行的会话（归属只能靠 sqlite 索引）
	if (cwd) writeFileSync(join(dir, "llm-call.json"), JSON.stringify({ systemPrompt: `You are a coding agent.\nworking directory: ${cwd}\nOther context.` }));
	const lines = messages ?? [
		{ message_id: "m1", turn_id: "t1", message: { role: "user", content: [{ type: "text", text: "帮我看看这个报错" }], timestamp: 1773000001000 } },
		{
			message_id: "m2",
			turn_id: "t1",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "分析中" },
					{ type: "text", text: "报错原因是 X" },
				],
				timestamp: 1773000002000,
			},
		},
	];
	writeFileSync(join(dir, "messages.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"));
	return dir;
}

test("scanMinimaxSessions：cwd 匹配当前项目的会话才返回，且元数据齐全", async () => {
	const { source } = loadModules();
	const root = mkdtempSync(join(tmpdir(), "minimax-scan-"));
	try {
		makeSessionDir(root, { sessionId: "sess-match" });
		makeSessionDir(root, { day: "2026/03/16", name: "11-00-00-000-session_other", sessionId: "sess-other", cwd: "F:\\OtherProject", messages: [{ message_id: "x", turn_id: "x", message: { role: "user", content: [{ type: "text", text: "别的项目" }], timestamp: 1 } }] });
		const metas = await source.scanMinimaxSessions(source.minimaxSessionsRoot(root), PROJECT_PATH);
		assert.equal(metas.length, 1, "cwd 不匹配的会话不列出");
		assert.equal(metas[0].sessionId, "sess-match");
		assert.equal(metas[0].cwd, PROJECT_PATH);
		assert.ok(metas[0].messagesPath.endsWith("messages.jsonl"));
		assert.ok(metas[0].sourceSize > 0);
		assert.ok(Array.isArray(metas[0].headLines) && metas[0].headLines.length > 0, "标题/预览用头部行已读取");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("scanMinimaxSessions：无 manifest / 空 messages 的目录跳过", async () => {
	const { source } = loadModules();
	const root = mkdtempSync(join(tmpdir(), "minimax-invalid-"));
	try {
		const dir = makeSessionDir(root, { sessionId: "sess-empty" });
		// 清空 messages.jsonl → size 0 → 无效
		writeFileSync(join(dir, "messages.jsonl"), "");
		const metas = await source.scanMinimaxSessions(source.minimaxSessionsRoot(root), PROJECT_PATH);
		assert.equal(metas.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("convertMinimaxSessionTo：行格式与 Codex/Kimi 导入器同构（version 3 头 + import 标记 + message 行）", async () => {
	const { source, convert } = loadModules();
	const root = mkdtempSync(join(tmpdir(), "minimax-convert-"));
	try {
		const dir = makeSessionDir(root, { sessionId: "sess-fmt" });
		const meta = (await source.scanMinimaxSessions(source.minimaxSessionsRoot(root), PROJECT_PATH))[0];
		const lines = [];
		const result = await convert.convertMinimaxSessionTo({
			projectPath: PROJECT_PATH,
			meta,
			translate: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
			entries: meta.headLines,
			sink: (line) => lines.push(line),
		});
		const head = JSON.parse(lines[0]);
		assert.equal(head.type, "session");
		assert.equal(head.version, 3);
		assert.equal(head.id, "sess-fmt");
		assert.equal(head.cwd, PROJECT_PATH);
		// 头行必须带 name（首条真实首问）：不带则 SessionScanner 回退「首条 user 文本」，
		// 把 <system-reminder> 注入块当标题（issue：标题匹配上了提示词）
		assert.equal(typeof head.name, "string");
		assert.ok(head.name.length > 0, "name 非空");

		const mark = JSON.parse(lines[1]);
		assert.equal(mark.type, "minimax_import");
		assert.equal(mark.sourcePath, meta.messagesPath);
		assert.equal(mark.sourceMtime, meta.sourceMtime);
		assert.equal(mark.sourceSize, meta.sourceSize);

		const user = JSON.parse(lines[2]);
		assert.equal(user.type, "message");
		assert.equal(user.message.role, "user");
		assert.deepEqual(
			user.message.content.map((block) => block.type),
			["text"],
		);
		assert.equal(user.message.timestamp, 1773000001000, "消息时间戳透传（ms）");

		const assistant = JSON.parse(lines[3]);
		assert.equal(assistant.message.role, "assistant");
		assert.deepEqual(
			assistant.message.content.map((block) => block.type),
			["thinking", "text"],
			"thinking 块保留原形状",
		);
		assert.ok(assistant.message.usage && assistant.message.usage.totalTokens === 0, "assistant 行带 zeroUsage");
		assert.equal(assistant.parentId, user.id, "父子链通过 id/parentId 串起来");

		assert.equal(result.messageCount, 2);
		assert.equal(result.title, "帮我看看这个报错");
		assert.ok(result.preview.includes("帮我看看这个报错"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("convertMinimaxSessionTo：tool_use/tool_result 直通，未知块降级为文本占位；无 user 时回退默认标题", async () => {
	const { source, convert } = loadModules();
	const root = mkdtempSync(join(tmpdir(), "minimax-blocks-"));
	try {
		const dir = makeSessionDir(root, {
			sessionId: "sess-blocks",
			messages: [
				{
					message_id: "m1",
					turn_id: "t1",
					message: {
						role: "user",
						content: [
							{ type: "weird", payload: { a: 1 } },
							{ type: "text", text: "跑一下测试" },
						],
						timestamp: 1773000001000,
					},
				},
				{ message_id: "m2", turn_id: "t1", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "bash", input: { command: "npm test" } }], timestamp: 1773000002000 } },
				{ message_id: "m3", turn_id: "t1", message: { role: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "3 passed" }] }, timestamp: 1773000003000 },
			],
		});
		const meta = (await source.scanMinimaxSessions(source.minimaxSessionsRoot(root), PROJECT_PATH))[0];
		const lines = [];
		const result = await convert.convertMinimaxSessionTo({
			projectPath: PROJECT_PATH,
			meta,
			translate: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
			entries: meta.headLines,
			sink: (line) => lines.push(line),
		});
		const user = JSON.parse(lines[2]);
		assert.equal(user.message.content[0].type, "text", "未知块降级为 text");
		assert.ok(user.message.content[0].text.includes("weird"), "降级块保留原 JSON 供查看");
		const assistant = JSON.parse(lines[3]);
		assert.equal(assistant.message.content[0].type, "tool_use");
		// tool_result 不是 user/assistant：跳过（与「只导出对话轮」的其它导入器口径一致）
		assert.equal(lines.length, 4, "session 头 + import 标记 + 2 条消息（tool_result 跳过）");
		assert.equal(result.messageCount, 2);
		assert.equal(result.title, "跑一下测试");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("convertMinimaxSessionTo：sqlite 会话名（sourceTitle）优先于首问与兜底", async () => {
	const { source, convert } = loadModules();
	const root = mkdtempSync(join(tmpdir(), "minimax-title-"));
	try {
		const titleMessages = [{ message_id: "m1", turn_id: "t1", message: { role: "user", content: [{ type: "text", text: "跑一下测试" }], timestamp: 1773000001000 } }];
		makeSessionDir(root, { sessionId: "sess-title", messages: titleMessages });
		const meta = (await source.scanMinimaxSessions(source.minimaxSessionsRoot(root), PROJECT_PATH))[0];
		meta.sourceTitle = "打招呼";
		const lines = [];
		const result = await convert.convertMinimaxSessionTo({
			projectPath: PROJECT_PATH,
			meta,
			translate: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
			entries: meta.headLines,
			sink: (line) => lines.push(line),
		});
		assert.equal(result.title, "打招呼");
		assert.equal(JSON.parse(lines[0]).name, "打招呼", "头行 name 用 sqlite 会话名");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("scanMinimaxSessions：sqlite 索引注入标题；cwd 缺失时用 workspace_dir 兑底匹配项目", async () => {
	const { source } = loadModules();
	const root = mkdtempSync(join(tmpdir(), "minimax-index-"));
	try {
		// 无 llm-call.json（cwd 空）：归属判定只能靠索引 workspace_dir
		makeSessionDir(root, { sessionId: "sess-idx", cwd: null, messages: [{ message_id: "m1", turn_id: "t1", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1773000001000 } }] });
		const index = new Map([["sess-idx", { title: "打招呼", workspaceDir: PROJECT_PATH }]]);
		const metas = await source.scanMinimaxSessions(source.minimaxSessionsRoot(root), PROJECT_PATH, index);
		assert.equal(metas.length, 1);
		assert.equal(metas[0].sourceTitle, "打招呼");
		assert.equal(metas[0].cwd, PROJECT_PATH, "cwd 用索引 workspace_dir");
		// workspace_dir 不匹配：不返回
		const other = new Map([["sess-idx", { title: "打招呼", workspaceDir: "C:/other/project" }]]);
		assert.equal((await source.scanMinimaxSessions(source.minimaxSessionsRoot(root), PROJECT_PATH, other)).length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("readMinimaxSqliteIndex：读真 sqlite fixture（node:sqlite 造库）；损坏 db 降级空 Map", async () => {
	const { source } = loadModules();
	const root = mkdtempSync(join(tmpdir(), "minimax-sqlite-"));
	try {
		const { DatabaseSync } = await import("node:sqlite");
		mkdirSync(join(root, "sqlite"), { recursive: true });
		const db = new DatabaseSync(join(root, "sqlite", "runtime-state.sqlite"));
		db.exec("CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, title TEXT, workspace_dir TEXT)");
		db.prepare("INSERT INTO local_runtime_sessions VALUES (?, ?, ?)").run("sess-a", "打招呼", "C:/w/a");
		db.prepare("INSERT INTO local_runtime_sessions VALUES (?, ?, ?)").run("sess-b", null, "C:/w/b");
		db.close();
		const index = await source.readMinimaxSqliteIndex(root);
		assert.equal(index.get("sess-a")?.title, "打招呼");
		assert.equal(index.get("sess-b")?.title, undefined, "null 标题不注入");
		assert.equal(index.get("sess-b")?.workspaceDir, "C:/w/b");
		// 不存在的目录 → 空 Map（不抛）
		assert.equal((await source.readMinimaxSqliteIndex(join(root, "nope"))).size, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("convertMinimaxSessionTo：没有任何 user 消息时用 translate 回退标题", async () => {
	const { source, convert } = loadModules();
	const root = mkdtempSync(join(tmpdir(), "minimax-fallback-"));
	try {
		makeSessionDir(root, {
			sessionId: "sess-fallback",
			messages: [{ message_id: "m1", turn_id: "t1", message: { role: "assistant", content: [{ type: "text", text: "只有助手" }], timestamp: 1773000001000 } }],
		});
		const meta = (await source.scanMinimaxSessions(source.minimaxSessionsRoot(root), PROJECT_PATH))[0];
		const result = await convert.convertMinimaxSessionTo({
			projectPath: PROJECT_PATH,
			meta,
			translate: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
			entries: meta.headLines,
			sink: () => {},
		});
		assert.equal(result.title, 'session.importedTitle:{"source":"MinimaxCode"}');
		// 无真实首问时头行 name 同样落到兜底文案，不会回退到注入块文本
		const headLines = [];
		await convert.convertMinimaxSessionTo({
			projectPath: PROJECT_PATH,
			meta,
			translate: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
			entries: meta.headLines,
			sink: (line) => headLines.push(line),
		});
		assert.equal(JSON.parse(headLines[0]).name, 'session.importedTitle:{"source":"MinimaxCode"}');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("readMinimaxImportMeta：从导入产物头部读回 import 标记（有界读路径）", async () => {
	const { source, convert } = loadModules();
	const root = mkdtempSync(join(tmpdir(), "minimax-meta-"));
	try {
		const dir = makeSessionDir(root, { sessionId: "sess-meta" });
		const meta = (await source.scanMinimaxSessions(source.minimaxSessionsRoot(root), PROJECT_PATH))[0];
		const target = join(root, "out", "minimax_sess-meta.jsonl");
		mkdirSync(join(root, "out"), { recursive: true });
		const lines = [];
		await convert.convertMinimaxSessionTo({ projectPath: PROJECT_PATH, meta, translate: (key) => key, entries: meta.headLines, sink: (line) => lines.push(line) });
		writeFileSync(target, lines.join("\n"));
		// 模拟源文件后续更新：mtime 变化 → outdated
		utimesSync(meta.messagesPath, new Date(meta.sourceMtime + 5000), new Date(meta.sourceMtime + 5000));

		const readBack = await source.readMinimaxImportMeta(target);
		assert.equal(readBack.sourceMtime, meta.sourceMtime);
		assert.equal(readBack.sourceSize, meta.sourceSize);

		const metas2 = await source.scanMinimaxSessions(source.minimaxSessionsRoot(root), PROJECT_PATH);
		assert.ok(metas2[0].sourceMtime >= meta.sourceMtime + 4000, "扫描读到新 mtime（utimes 精度取整，容差 1s）");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
