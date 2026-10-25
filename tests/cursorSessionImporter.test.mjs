import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * CursorSessionImporter 单测。
 *
 * 与 WorkBuddy / zcode importer 测试同款做法：把 TS 源转译成 CJS 后在 vm 沙箱运行，
 * mock electron（app.getPath("home") 指向临时目录），fs 用真实实现。
 * 会话数据按 Cursor Agent JSONL 真实 schema 构造，不依赖真实 Cursor 安装。
 */

function transpile(sourcePath, sandbox) {
	const source = readFileSync(sourcePath, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	vm.runInNewContext(outputText, sandbox, { filename: sourcePath });
	return sandbox.exports;
}

function loadImporter(homePath) {
	// 统一沙箱加载器：相对 import 自动按**源文件目录**解析（不再手写 require 桥 +
	// tryRequireLocalTs 补层）。registry 保留给需要直接取纯函数的用例
	// （registry.source / registry.convert 等）。
	const load = createTsSandbox({ stubs: { electron: { app: { getPath: () => homePath } } } });
	const registry = {
		source: load("src/main/sessions/cursorSessionSource.ts"),
		convert: load("src/main/sessions/cursorSessionConvert.ts"),
	};
	const mod = load("src/main/sessions/CursorSessionImporter.ts");
	return { importer: new mod.CursorSessionImporter(), registry };
}

const SID = "1959804f-221e-4840-b049-cbf339590e25";

function writeTranscript(root, slug, sessionId, entries, options = {}) {
	const transcripts = join(root, ".cursor", "projects", slug, "agent-transcripts");
	const dir = options.subagent ? join(transcripts, sessionId, "subagents") : options.flat ? transcripts : join(transcripts, sessionId);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${options.fileId ?? sessionId}.jsonl`);
	writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
	return file;
}

function wrappedUser(query, timestamp = "Tuesday, Sep 15, 2026, 4:35 PM (UTC+8)") {
	return [`<timestamp>${timestamp}</timestamp>`, "<user_info>OS Version: win32 10.0.26200</user_info>", "<agent_skills>Skill list that is not the user question</agent_skills>", `<user_query>\n${query}\n</user_query>`].join("\n");
}

function baseEntries({ userText = "帮我导入 Cursor 会话", extraAssistant = [] } = {}) {
	return [
		{
			role: "user",
			message: {
				content: [{ type: "text", text: wrappedUser(userText) }],
			},
		},
		{
			role: "assistant",
			message: {
				content: [
					{ type: "text", text: "先核对本地 JSONL 格式。" },
					{
						type: "tool_use",
						name: "Read",
						input: { path: "F:\\PiDeck\\src\\shared\\types\\imports.ts", limit: 40 },
					},
				],
			},
		},
		...extraAssistant,
	];
}

function readLines(file) {
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test("纯函数: encodeCursorProjectSlug Windows 与 POSIX", () => {
	const home = mkdtempSync(join(tmpdir(), "cursor-home-"));
	try {
		const { registry } = loadImporter(home);
		const { encodeCursorProjectSlug } = registry.source;
		assert.equal(encodeCursorProjectSlug("F:\\PiDeck"), "f-PiDeck");
		assert.equal(encodeCursorProjectSlug("F:/PiDeck"), "f-PiDeck");
		assert.equal(encodeCursorProjectSlug("/home/u/repo"), "home-u-repo");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("纯函数: extractCursorUserText 抽 user_query，丢掉注入包装", () => {
	const home = mkdtempSync(join(tmpdir(), "cursor-home-"));
	try {
		const { registry } = loadImporter(home);
		const { extractCursorUserText } = registry.source;
		assert.equal(extractCursorUserText(wrappedUser("真正的提问")), "真正的提问");
		assert.equal(extractCursorUserText("<timestamp>now</timestamp>\n没有 query 的原文"), "没有 query 的原文");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("纯函数: parseCursorClock 解析 Cursor 时间戳", () => {
	const home = mkdtempSync(join(tmpdir(), "cursor-home-"));
	try {
		const { registry } = loadImporter(home);
		const { parseCursorClock, parseCursorTimestampFromText } = registry.source;
		const ms = parseCursorClock("Tuesday, Sep 15, 2026, 4:35 PM (UTC+8)");
		assert.ok(ms > 0, "应解析出有效时间");
		assert.equal(new Date(ms).getUTCFullYear(), 2026);
		assert.equal(parseCursorTimestampFromText(wrappedUser("x")), parseCursorClock("Tuesday, Sep 15, 2026, 4:35 PM (UTC+8)"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("convertCursorContentBlocks: 未知块 JSON、无字节图片写占位", () => {
	const home = mkdtempSync(join(tmpdir(), "cursor-home-"));
	try {
		const { registry } = loadImporter(home);
		const converted = registry.convert.convertCursorContentBlocks(
			[
				{ type: "image", filename: "a.png" },
				{ type: "mystery", foo: 1 },
			],
			"sid",
			{ n: 0 },
		);
		assert.deepEqual(JSON.parse(JSON.stringify(converted.content)), [
			{ type: "text", text: "[image: a.png]" },
			{ type: "text", text: '{"type":"mystery","foo":1}' },
		]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("scan: 按 slug 定位 agent-transcripts，跳过 subagents，标题取 user_query", async () => {
	const home = mkdtempSync(join(tmpdir(), "cursor-home-"));
	try {
		const main = writeTranscript(home, "f-PiDeck", SID, baseEntries({ userText: "帮我导入 Cursor 会话" }));
		writeTranscript(home, "f-PiDeck", SID, [{ role: "user", message: { content: [{ type: "text", text: wrappedUser("子代理不该出现") }] } }], {
			subagent: true,
			fileId: "c1a0252e-b737-4781-93fa-696d6c275d7d",
		});
		writeTranscript(home, "f-PiDeck", "aaaa-bbbb-cccc", [
			{
				role: "user",
				message: { content: [{ type: "text", text: wrappedUser("第二个会话", "Tuesday, Sep 15, 2026, 5:00 PM (UTC+8)") }] },
			},
		]);

		const { importer } = loadImporter(home);
		const sessions = await importer.scan("F:\\PiDeck");

		assert.equal(sessions.length, 2);
		assert.equal(sessions[0].title, "第二个会话");
		assert.equal(sessions[1].sourcePath, main);
		assert.equal(sessions[1].title, "帮我导入 Cursor 会话");
		assert.ok(sessions.every((session) => !session.sourcePath.includes("subagents")));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("scan: 兼容 agent-transcripts 根目录扁平 jsonl", async () => {
	const home = mkdtempSync(join(tmpdir(), "cursor-home-"));
	try {
		const file = writeTranscript(home, "f-PiDeck", SID, baseEntries({ userText: "扁平布局" }), { flat: true });
		const { importer } = loadImporter(home);
		const sessions = await importer.scan("F:\\PiDeck");
		assert.equal(sessions.length, 1);
		assert.equal(sessions[0].sourcePath, file);
		assert.equal(sessions[0].title, "扁平布局");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 忠实转写 user / assistant 文本 / tool_use 参数，丢弃 turn_ended", async () => {
	const home = mkdtempSync(join(tmpdir(), "cursor-home-"));
	try {
		const file = writeTranscript(home, "f-PiDeck", SID, [
			...baseEntries({ userText: "帮我导入 Cursor 会话" }),
			{ type: "turn_ended", status: "success" },
			{
				role: "assistant",
				message: {
					content: [{ type: "text", text: "已经核对完格式。" }],
				},
			},
		]);

		const { importer } = loadImporter(home);
		const report = await importer.import("F:\\PiDeck", [file]);
		assert.equal(report.imported, 1);
		assert.equal(report.results[0].messageCount, 4);

		const lines = readLines(report.results[0].targetPath);
		assert.equal(lines[0].type, "session");
		assert.equal(lines[0].id, SID);
		assert.equal(lines[0].cwd, "F:\\PiDeck");
		assert.equal(lines[1].type, "cursor_import");
		assert.equal(lines[1].cursorSessionId, SID);
		assert.equal(lines.at(-1).type, "session_info");
		assert.equal(lines.at(-1).name, "帮我导入 Cursor 会话");

		const users = lines.filter((line) => line.type === "message" && line.message?.role === "user");
		assert.equal(users.length, 1);
		assert.equal(users[0].message.content[0].text, "帮我导入 Cursor 会话");
		assert.ok(!users[0].message.content[0].text.includes("agent_skills"));
		assert.ok(!users[0].message.content[0].text.includes("<timestamp>"));

		const assistants = lines.filter((line) => line.type === "message" && line.message?.role === "assistant");
		assert.equal(assistants.length, 2);
		assert.deepEqual(
			assistants[0].message.content.map((item) => item.type),
			["text", "toolCall"],
		);
		assert.equal(assistants[0].message.content[0].text, "先核对本地 JSONL 格式。");
		assert.equal(assistants[0].message.content[1].name, "Read");
		assert.deepEqual(assistants[0].message.content[1].arguments, {
			path: "F:\\PiDeck\\src\\shared\\types\\imports.ts",
			limit: 40,
		});
		assert.equal(assistants[1].message.content[0].text, "已经核对完格式。");

		const toolResults = lines.filter((line) => line.type === "message" && line.message?.role === "toolResult");
		assert.equal(toolResults.length, 1);
		assert.equal(assistants[0].message.stopReason, "toolUse");
		assert.equal(assistants[1].message.stopReason, "stop");
		assert.equal(toolResults[0].message.toolCallId, assistants[0].message.content[1].id);
		assert.equal(toolResults[0].message.toolName, "Read");
		assert.equal(toolResults[0].message.isError, false);
		assert.equal(toolResults[0].message.content[0].text, "");
		const assistantIndex = lines.indexOf(assistants[0]);
		assert.equal(lines[assistantIndex + 1], toolResults[0], "toolResult 紧跟发起该调用的 assistant");
		assert.ok(!lines.some((line) => line.type === "turn_ended"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 源里已有 tool_result 时按原文写入，不重复补空结果", async () => {
	const home = mkdtempSync(join(tmpdir(), "cursor-home-"));
	try {
		const file = writeTranscript(home, "f-PiDeck", SID, [
			{
				role: "user",
				message: { content: [{ type: "text", text: wrappedUser("带结果的调用") }] },
			},
			{
				role: "assistant",
				message: {
					content: [
						{ type: "tool_use", id: "call_1", name: "Read", input: { path: "a.ts" } },
						{ type: "tool_result", tool_use_id: "call_1", content: "hello from cursor" },
					],
				},
			},
		]);
		const { importer } = loadImporter(home);
		const report = await importer.import("F:\\PiDeck", [file]);
		const lines = readLines(report.results[0].targetPath);
		const toolResults = lines.filter((line) => line.type === "message" && line.message?.role === "toolResult");
		assert.equal(toolResults.length, 1);
		assert.equal(toolResults[0].message.toolCallId, "call_1");
		assert.equal(toolResults[0].message.content[0].text, "hello from cursor");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: tool_use.input 为 JSON 字符串时解析成对象参数", async () => {
	const home = mkdtempSync(join(tmpdir(), "cursor-home-"));
	try {
		const file = writeTranscript(home, "f-PiDeck", SID, [
			{
				role: "user",
				message: { content: [{ type: "text", text: wrappedUser("字符串参数") }] },
			},
			{
				role: "assistant",
				message: {
					content: [{ type: "tool_use", id: "call_json", name: "Read", input: '{"path":"a.ts","limit":10}' }],
				},
			},
		]);
		const { importer } = loadImporter(home);
		const report = await importer.import("F:\\PiDeck", [file]);
		const lines = readLines(report.results[0].targetPath);
		const assistant = lines.find((line) => line.type === "message" && line.message?.role === "assistant");
		assert.equal(assistant.message.content[0].type, "toolCall");
		assert.deepEqual(assistant.message.content[0].arguments, { path: "a.ts", limit: 10 });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: thinking 块转成 pi thinking，保留原文", async () => {
	const home = mkdtempSync(join(tmpdir(), "cursor-home-"));
	try {
		const file = writeTranscript(home, "f-PiDeck", SID, [
			{
				role: "user",
				message: { content: [{ type: "text", text: wrappedUser("看看思考") }] },
			},
			{
				role: "assistant",
				message: {
					content: [
						{ type: "thinking", thinking: "先定位导入器" },
						{ type: "text", text: "开始转写。" },
					],
				},
			},
		]);
		const { importer } = loadImporter(home);
		const report = await importer.import("F:\\PiDeck", [file]);
		const lines = readLines(report.results[0].targetPath);
		const assistant = lines.find((line) => line.type === "message" && line.message?.role === "assistant");
		assert.deepEqual(
			assistant.message.content.map((item) => item.type),
			["thinking", "text"],
		);
		assert.equal(assistant.message.content[0].thinking, "先定位导入器");
		assert.equal(assistant.message.content[1].text, "开始转写。");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 未知 content 块序列化保留，不静默丢弃", async () => {
	const home = mkdtempSync(join(tmpdir(), "cursor-home-"));
	try {
		const file = writeTranscript(home, "f-PiDeck", SID, [
			{
				role: "user",
				message: { content: [{ type: "text", text: wrappedUser("未知块") }] },
			},
			{
				role: "assistant",
				message: {
					content: [
						{ type: "text", text: "ok" },
						{ type: "mystery_block", payload: { keep: true } },
					],
				},
			},
		]);
		const { importer } = loadImporter(home);
		const report = await importer.import("F:\\PiDeck", [file]);
		const lines = readLines(report.results[0].targetPath);
		const assistant = lines.find((line) => line.type === "message" && line.message?.role === "assistant");
		assert.equal(assistant.message.content[0].text, "ok");
		assert.match(assistant.message.content[1].text, /mystery_block/);
		assert.match(assistant.message.content[1].text, /"keep":true/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 重复导入标记为 current，源文件变化后标记为 outdated", async () => {
	const home = mkdtempSync(join(tmpdir(), "cursor-home-"));
	try {
		const file = writeTranscript(home, "f-PiDeck", SID, baseEntries({ userText: "帮我导入 Cursor 会话" }));
		const { importer } = loadImporter(home);
		const first = await importer.import("F:\\PiDeck", [file]);
		assert.equal(first.results[0].overwritten, false);

		let sessions = await importer.scan("F:\\PiDeck");
		assert.equal(sessions[0].status, "current");

		writeTranscript(home, "f-PiDeck", SID, [...baseEntries({ userText: "帮我导入 Cursor 会话" }), { role: "assistant", message: { content: [{ type: "text", text: "补充一句" }] } }]);

		sessions = await importer.scan("F:\\PiDeck");
		assert.equal(sessions[0].status, "outdated");

		const second = await importer.import("F:\\PiDeck", [file]);
		assert.equal(second.results[0].overwritten, true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 拒绝 ~/.cursor/projects 之外的路径", async () => {
	const home = mkdtempSync(join(tmpdir(), "cursor-home-"));
	const outside = mkdtempSync(join(tmpdir(), "cursor-outside-"));
	try {
		const evil = join(outside, "leak.jsonl");
		writeFileSync(
			evil,
			JSON.stringify({
				role: "user",
				message: { content: [{ type: "text", text: wrappedUser("x") }] },
			}) + "\n",
			"utf8",
		);
		const { importer } = loadImporter(home);
		const report = await importer.import("F:\\PiDeck", [evil]);
		assert.equal(report.imported, 0);
		assert.equal(report.failed, 1);
		assert.match(report.results[0].error, /outside/);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});
