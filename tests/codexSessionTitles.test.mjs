import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { __resetCodexThreadTitleCacheForTests, loadCodexThreadTitles, lookupCodexThreadTitle } from "../src/main/sessions/codexSessionTitles.ts";

/**
 * Codex 会话名导入单测。
 *
 * 背景：rollout-*.jsonl 里没有会话名（session_meta 只有 id/cwd 等字段）。
 * Codex 自己维护一份纯文本索引 ~/.codex/session_index.jsonl：
 * 每行 `{ id, thread_name, updated_at }`，thread_name 就是侧栏显示的会话名
 * （改过名就是新名，没改过是官方自动标题）。旧实现读的是 SQLite 状态库，
 * 要拷临时副本、受锁/WAL 影响；索引是几十 KB 文本，直接有界读取即可。
 */

function loadImporter(homePath) {
	const load = createTsSandbox({ stubs: { electron: { app: { getPath: () => homePath }, shell: {} } } });
	const mod = load("src/main/sessions/CodexSessionImporter.ts");
	return { ...mod, importer: new mod.CodexSessionImporter() };
}

/** 新格式 Codex Desktop 会话：user 消息为 response_item，带 content_item_kinds 元数据 */
function desktopJsonl(id, cwd) {
	const lines = [];
	lines.push(
		JSON.stringify({
			type: "session_meta",
			payload: { id, cwd, timestamp: "2026-09-11T10:19:13.271Z", originator: "Codex Desktop", history_mode: "paginated" },
		}),
	);
	// 注入包装消息（无 user.text，应被整体丢弃）
	lines.push(
		JSON.stringify({
			type: "response_item",
			payload: {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "<recommended_plugins>\n- Airtable\n</recommended_plugins>" }],
				internal_chat_message_metadata_passthrough: { content_item_kinds: ["plugins.recommendations"] },
			},
		}),
	);
	// 首轮真实用户消息：前面是环境包装块，末尾才是用户原话（同一条消息）
	lines.push(
		JSON.stringify({
			type: "response_item",
			payload: {
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "<environment_context>\n  <cwd>X</cwd>\n</environment_context>\n帮我写一份操作手册",
					},
				],
				internal_chat_message_metadata_passthrough: { content_item_kinds: ["environments.environment_context", "user.text"] },
			},
		}),
	);
	lines.push(
		JSON.stringify({
			type: "response_item",
			payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "好的，我先看一下。" }] },
		}),
	);
	return `${lines.join("\n")}\n`;
}

/** 写一份 session_index.jsonl（追加式：同 id 多条时最后一条为准） */
function writeSessionIndex(homePath, entries) {
	mkdirSync(join(homePath, ".codex"), { recursive: true });
	const lines = entries.map((entry) => JSON.stringify({ updated_at: "2026-09-11T10:19:13.271Z", ...entry }));
	writeFileSync(join(homePath, ".codex", "session_index.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

test("codex desktop session: title from first user text with wrapper blocks stripped", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-title-desktop-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions", "2026", "09", "11");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "rollout-2026-09-11T18-19-13-01a08ffa.jsonl"), desktopJsonl("thread-1", project));

		const { importer } = loadImporter(home);
		const summaries = await importer.scan(project);
		assert.equal(summaries.length, 1);
		// 标题 = 首条用户原话（包装块已剥）；不是 rollout-… 文件名
		assert.equal(summaries[0].title, "帮我写一份操作手册");
		assert.equal(summaries[0].preview, "帮我写一份操作手册");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex desktop session: question-reply wrapper does not become the title", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-title-question-"));
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions", "2026", "09", "11");
		mkdirSync(sessions, { recursive: true });
		const lines = [
			JSON.stringify({ type: "session_meta", payload: { id: "thread-q", cwd: project, timestamp: "2026-09-11T10:19:13.271Z" } }),
			JSON.stringify({
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: '<send_user_message_question_reply>\n[{"questionItemId":"x"}]\n</send_user_message_question_reply>' }],
					internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
				},
			}),
		];
		writeFileSync(join(sessions, "rollout-q.jsonl"), `${lines.join("\n")}\n`);

		const { importer } = loadImporter(home);
		const summaries = await importer.scan(project);
		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].title, "Codex session 2026-09-11", "问答回传不算用户原话，兜底为 Codex 会话+日期（测试沙箱内用缺省英文文案）");
		assert.ok(!summaries[0].title.includes("questionItemId"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex title: prefers session_index name over jsonl first message", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-title-index-"));
	__resetCodexThreadTitleCacheForTests();
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions", "2026", "09", "11");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "rollout-db.jsonl"), desktopJsonl("thread-db", project));
		// 用户在 Codex 里改过名：thread_name 应该赢过首条消息
		writeSessionIndex(home, [{ id: "thread-db", thread_name: "我的论文讨论" }]);

		const { importer } = loadImporter(home);
		const summaries = await importer.scan(project);
		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].title, "我的论文讨论");
	} finally {
		__resetCodexThreadTitleCacheForTests();
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex title: append-only index uses the last entry for a renamed session", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-title-append-"));
	__resetCodexThreadTitleCacheForTests();
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions", "2026", "09", "11");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "rollout-append.jsonl"), desktopJsonl("thread-append", project));
		writeSessionIndex(home, [
			{ id: "thread-append", thread_name: "旧名字" },
			{ id: "thread-append", thread_name: "改名后的名字" },
		]);

		const { importer } = loadImporter(home);
		const summaries = await importer.scan(project);
		assert.equal(summaries[0].title, "改名后的名字", "追加式索引必须取最后一条");
	} finally {
		__resetCodexThreadTitleCacheForTests();
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex title: index tolerates broken lines and missing entries", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-title-broken-"));
	__resetCodexThreadTitleCacheForTests();
	try {
		mkdirSync(join(home, ".codex"), { recursive: true });
		// 末行可能是追加写到一半的残行；非法 JSON 不能影响其它条目
		writeFileSync(join(home, ".codex", "session_index.jsonl"), `${JSON.stringify({ id: "thread-ok", thread_name: "正常名字" })}\nnot-json\n{"id":"thread-half","thread_na`, "utf8");

		const maps = await loadCodexThreadTitles(join(home, ".codex"));
		assert.equal(maps.byId.get("thread-ok")?.name, "正常名字");
		assert.equal(maps.byId.size, 1, "坏行/半行不应产生条目");
	} finally {
		__resetCodexThreadTitleCacheForTests();
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex title: no index file means empty maps (jsonl fallback keeps working)", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-title-noindex-"));
	__resetCodexThreadTitleCacheForTests();
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions", "2026", "09", "11");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "rollout-noindex.jsonl"), desktopJsonl("thread-noindex", project));

		const maps = await loadCodexThreadTitles(join(home, ".codex"));
		assert.equal(maps.byId.size, 0);

		const { importer } = loadImporter(home);
		const summaries = await importer.scan(project);
		assert.equal(summaries[0].title, "帮我写一份操作手册", "索引缺失时仍用 jsonl 首条用户消息");
	} finally {
		__resetCodexThreadTitleCacheForTests();
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex title: falls back to dated name when there is no index and no user text", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-title-fallback-"));
	__resetCodexThreadTitleCacheForTests();
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions", "2026", "09", "11");
		mkdirSync(sessions, { recursive: true });
		const lines = [JSON.stringify({ type: "session_meta", payload: { id: "thread-empty", cwd: project, timestamp: "2026-09-11T10:19:13.271Z" } }), JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "好的。" }] } })];
		writeFileSync(join(sessions, "rollout-empty.jsonl"), `${lines.join("\n")}\n`);

		const { importer } = loadImporter(home);
		const summaries = await importer.scan(project);
		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].title, "Codex session 2026-09-11");
		assert.ok(!/rollout-/i.test(summaries[0].title), "不应再回退到源文件名");
	} finally {
		__resetCodexThreadTitleCacheForTests();
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex title lookup: matches by session id and by rollout filename uuid", () => {
	const maps = { byId: new Map([["019f5b14-4742-7ca1-8c11-784dd0faf0d4", { name: "模型部署" }]]) };
	assert.equal(lookupCodexThreadTitle(maps, "019f5b14-4742-7ca1-8c11-784dd0faf0d4", undefined)?.name, "模型部署");
	// 源路径缺 id 时从文件名反解 uuid（rollout-<时间戳>-<uuid>.jsonl）
	const sourcePath = "C:\\Users\\Administrator\\.codex\\sessions\\2026\\07\\13\\rollout-2026-07-13T18-44-48-019f5b14-4742-7ca1-8c11-784dd0faf0d4.jsonl";
	assert.equal(lookupCodexThreadTitle(maps, undefined, sourcePath)?.name, "模型部署");
	assert.equal(lookupCodexThreadTitle(maps, "missing", "D:/y/rollout-2026-01-01T00-00-00-11111111-2222-3333-4444-555555555555.jsonl"), undefined);
});

test("codex title loader: reads the plain-text index without leaving temp copies", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-title-nocopy-"));
	__resetCodexThreadTitleCacheForTests();
	try {
		writeSessionIndex(home, [{ id: "thread-live", thread_name: "直连标题" }]);
		const before = readdirSync(tmpdir()).filter((name) => name.startsWith("pideck-codex-titles-"));

		const maps = await loadCodexThreadTitles(join(home, ".codex"));
		assert.equal(maps.byId.get("thread-live")?.name, "直连标题");

		const after = readdirSync(tmpdir()).filter((name) => name.startsWith("pideck-codex-titles-"));
		assert.deepEqual(after, before, "索引是纯文本读取，不得产生任何临时副本");
	} finally {
		__resetCodexThreadTitleCacheForTests();
		rmSync(home, { recursive: true, force: true });
	}
});

test("codex import: streaming path writes index-derived title into session_info", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-title-import-"));
	__resetCodexThreadTitleCacheForTests();
	try {
		const project = join(home, "proj");
		const sessions = join(home, ".codex", "sessions", "2026", "09", "11");
		mkdirSync(sessions, { recursive: true });
		const rolloutPath = join(sessions, "rollout-imp.jsonl");
		writeFileSync(rolloutPath, desktopJsonl("thread-imp", project));
		writeSessionIndex(home, [{ id: "thread-imp", thread_name: "索引改名标题" }]);

		const { importer } = loadImporter(home);
		const report = await importer.import(project, [rolloutPath]);
		assert.equal(report.results[0].success, true);
		assert.equal(report.results[0].title, "索引改名标题");

		// session_info（文件末行）同样携带该标题：重开/侧栏扫描读到一致的名字
		const targetLines = readFileSync(report.results[0].targetPath, "utf8").trim().split("\n");
		const last = JSON.parse(targetLines[targetLines.length - 1]);
		assert.equal(last.type, "session_info");
		assert.equal(last.name, "索引改名标题");
	} finally {
		__resetCodexThreadTitleCacheForTests();
		rmSync(home, { recursive: true, force: true });
	}
});
