import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * KimiSessionImporter 单测。
 *
 * 与 Cursor / Claude importer 测试同款做法：createTsSandbox 把生产 TS 转译成 CJS 在
 * vm 沙箱运行，mock electron（app.getPath("home") 指向临时目录），fs 用真实实现。
 * 会话数据按 Kimi Code 真实落盘 schema 构造（~/.kimi-code/session_index.jsonl +
 * <sessionDir>/state.json + <sessionDir>/agents/main/wire.jsonl），不依赖真实安装。
 */

const PROJECT_PATH = "F:\\PiDeck";
const SESSION_ID = "session_52ad22b1-d7fa-4654-88dc-3d08920688a3";

function loadImporter(homePath) {
	const load = createTsSandbox({ stubs: { electron: { app: { getPath: () => homePath } } } });
	const registry = {
		source: load("src/main/sessions/kimiSessionSource.ts"),
		convert: load("src/main/sessions/kimiSessionConvert.ts"),
	};
	const mod = load("src/main/sessions/KimiSessionImporter.ts");
	return { importer: new mod.KimiSessionImporter(), registry };
}

function readLines(file) {
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/** 按真实布局写一个 Kimi Code 会话：索引行 + state.json + agents/main/wire.jsonl。 */
function writeKimiSession(home, options = {}) {
	const sessionId = options.sessionId ?? SESSION_ID;
	const sessionDir = join(home, ".kimi-code", "sessions", "wd_test_0123456789", sessionId);
	const wireDir = join(sessionDir, "agents", "main");
	mkdirSync(wireDir, { recursive: true });
	writeFileSync(
		join(sessionDir, "state.json"),
		JSON.stringify({
			id: sessionId,
			version: 2,
			cwd: options.cwd ?? PROJECT_PATH,
			createdAt: options.createdAt ?? 1_700_000_000_000,
			updatedAt: options.updatedAt ?? 1_700_000_060_000,
			title: options.title ?? "",
			lastPrompt: options.lastPrompt ?? "",
			archived: false,
			agents: { main: { type: "main" } },
		}),
		"utf8",
	);
	const wirePath = join(wireDir, "wire.jsonl");
	const lines = (options.wire ?? baseWire()).map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
	writeFileSync(wirePath, `${lines.join("\n")}\n`, "utf8");
	return { sessionDir, wirePath };
}

/** 追加一行到全局索引（逐行容错，坏行也会被跳过）。 */
function appendIndexLine(home, line) {
	const indexPath = join(home, ".kimi-code", "session_index.jsonl");
	mkdirSync(join(home, ".kimi-code"), { recursive: true });
	const existing = readFileSyncSafe(indexPath);
	writeFileSync(indexPath, existing + (typeof line === "string" ? line : JSON.stringify(line)) + "\n", "utf8");
}

function readFileSyncSafe(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function indexRowFor(sessionDir, workDir = PROJECT_PATH) {
	return { sessionId: sessionDir.split(/[\\/]/).pop(), sessionDir: sessionDir.replace(/\\/g, "/"), workDir };
}

function userMessage(text, time = 1_700_000_001_000) {
	return {
		type: "context.append_message",
		agentId: "main",
		time,
		message: { role: "user", id: `msg_u_${time}`, content: [{ type: "text", text }], toolCalls: [] },
	};
}

function assistantAppended(time = 1_700_000_002_000) {
	return {
		type: "agent.message.appended",
		kind: "event",
		time,
		message: {
			message: {
				role: "assistant",
				id: `msg_a_${time}`,
				content: [
					{ type: "think", think: "先读文件确认结构" },
					{ type: "text", text: "好的，先看一下。" },
				],
				toolCalls: [{ type: "function", id: "tool_abc123", name: "Read", arguments: '{"path":"package.json"}' }],
			},
			meta: {
				source: "llm",
				usage: { inputOther: 14537, output: 196, inputCacheRead: 16640, inputCacheCreation: 0 },
				finish: { finishReason: "tool_calls" },
			},
		},
	};
}

/** 同一条 assistant 消息的 context 视图（无 usage），用于验证去重后只留 appended 版本。 */
function assistantContextView(time = 1_700_000_002_000) {
	const appended = assistantAppended(time);
	return {
		type: "context.append_message",
		agentId: "main",
		time,
		message: appended.message.message,
	};
}

function toolResultMessage(time = 1_700_000_003_000) {
	return {
		type: "context.append_message",
		agentId: "main",
		time,
		message: { role: "tool", id: `msg_t_${time}`, toolCallId: "tool_abc123", content: [{ type: "text", text: '{"name":"pideck"}' }] },
	};
}

function baseWire() {
	return [{ type: "metadata", protocol_version: "1.5", created_at: 1_700_000_000_000 }, userMessage("帮我导入 Kimi Code 会话"), assistantAppended(), assistantContextView(), toolResultMessage()];
}

function importTarget(home, sessionId = SESSION_ID) {
	return join(home, ".pi", "agent", "sessions", "--F--PiDeck--", `kimi_${sessionId}.jsonl`);
}

test("scan: 按 workDir 匹配当前项目，标题取 state.title，按 updatedAt 倒序", async () => {
	const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
	try {
		const a = writeKimiSession(home, { sessionId: "session_aaaa", title: "修 bug", updatedAt: 1_700_000_060_000 });
		const b = writeKimiSession(home, { sessionId: "session_bbbb", title: "写文档", updatedAt: 1_700_000_120_000 });
		const other = writeKimiSession(home, { sessionId: "session_cccc", cwd: "F:\\Other", title: "别的项目" });
		appendIndexLine(home, indexRowFor(a.sessionDir));
		appendIndexLine(home, indexRowFor(b.sessionDir));
		appendIndexLine(home, indexRowFor(other.sessionDir, "F:\\Other"));

		const { importer } = loadImporter(home);
		const sessions = await importer.scan(PROJECT_PATH);

		assert.equal(sessions.length, 2);
		assert.equal(sessions[0].title, "写文档");
		assert.equal(sessions[1].title, "修 bug");
		assert.equal(sessions[0].status, "new");
		assert.ok(sessions[0].targetPath.endsWith("kimi_session_bbbb.jsonl"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("scan: 索引坏行跳过；title 为空回退 lastPrompt；缺 workDir 时按 state.cwd 匹配", async () => {
	const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
	try {
		const session = writeKimiSession(home, { title: "", lastPrompt: "最后一条提问" });
		appendIndexLine(home, "{broken json");
		const row = indexRowFor(session.sessionDir);
		delete row.workDir;
		appendIndexLine(home, row);

		const { importer } = loadImporter(home);
		const sessions = await importer.scan(PROJECT_PATH);

		assert.equal(sessions.length, 1);
		assert.equal(sessions[0].title, "最后一条提问");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: user/assistant/tool 转写为 pi 消息，think→thinking，arguments 字符串解析成对象", async () => {
	const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
	try {
		const session = writeKimiSession(home, { title: "导入目标" });
		appendIndexLine(home, indexRowFor(session.sessionDir));

		const { importer } = loadImporter(home);
		const report = await importer.import(PROJECT_PATH, [session.wirePath]);

		assert.equal(report.failed, 0);
		assert.equal(report.imported, 1);
		const lines = readLines(importTarget(home));

		assert.equal(lines[0].type, "session");
		assert.equal(lines[0].id, SESSION_ID);
		assert.equal(lines[0].cwd, PROJECT_PATH);
		assert.equal(lines[1].type, "kimi_import");
		assert.equal(lines[1].sourceSessionId, SESSION_ID);
		assert.equal(lines[2].type, "model_change");
		assert.equal(lines[2].provider, "kimi");

		const messages = lines.filter((line) => line.type === "message");
		// assistant 的 context 视图与 appended 视图去重后只剩一条
		assert.equal(messages.length, 3);
		assert.equal(messages[0].message.role, "user");
		assert.deepEqual(messages[0].message.content, [{ type: "text", text: "帮我导入 Kimi Code 会话" }]);

		const assistant = messages[1].message;
		assert.equal(assistant.role, "assistant");
		assert.deepEqual(assistant.content[0], { type: "thinking", thinking: "先读文件确认结构", thinkingSignature: "kimi_thinking" });
		assert.deepEqual(assistant.content[1], { type: "text", text: "好的，先看一下。" });
		assert.equal(assistant.content[2].type, "toolCall");
		assert.equal(assistant.content[2].name, "Read");
		assert.deepEqual(assistant.content[2].arguments, { path: "package.json" });
		assert.equal(assistant.usage.input, 14537);
		assert.equal(assistant.usage.output, 196);
		assert.equal(assistant.usage.cacheRead, 16640);
		assert.equal(assistant.stopReason, "toolUse");

		const toolResult = messages[2].message;
		assert.equal(toolResult.role, "toolResult");
		assert.equal(toolResult.toolCallId, "tool_abc123");
		assert.equal(toolResult.toolName, "Read");
		assert.equal(toolResult.isError, false);

		// parentId 链式推进，session_info（标题）追加在文件末尾（issue #114）
		assert.equal(messages[0].parentId, lines[2].id);
		assert.equal(messages[1].parentId, messages[0].id);
		assert.equal(messages[2].parentId, messages[1].id);
		const last = lines[lines.length - 1];
		assert.equal(last.type, "session_info");
		assert.equal(last.name, "导入目标");
		assert.equal(last.parentId, messages[2].id);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: wire 尾部半行/坏行被跳过，其余消息照常导入", async () => {
	const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
	try {
		const session = writeKimiSession(home, {
			title: "容错",
			wire: [userMessage("第一条"), "{not valid json", userMessage("第二条", 1_700_000_004_000), '{"type":"context.append_message","agentId":"main","time":1700'],
		});
		appendIndexLine(home, indexRowFor(session.sessionDir));

		const { importer } = loadImporter(home);
		const report = await importer.import(PROJECT_PATH, [session.wirePath]);

		assert.equal(report.failed, 0);
		const messages = readLines(importTarget(home)).filter((line) => line.type === "message");
		assert.equal(messages.length, 2);
		assert.equal(messages[1].message.content[0].text, "第二条");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import → scan: 状态从 new 变 current，源更新后变 outdated", async () => {
	const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
	try {
		const session = writeKimiSession(home, { title: "状态流转" });
		appendIndexLine(home, indexRowFor(session.sessionDir));

		const { importer } = loadImporter(home);
		await importer.import(PROJECT_PATH, [session.wirePath]);

		let sessions = await importer.scan(PROJECT_PATH);
		assert.equal(sessions[0].status, "current");

		// 源会话继续产生消息（wire 体积变化）→ 已导入产物判定为 outdated
		writeFileSync(session.wirePath, `${readFileSync(session.wirePath, "utf8")}${JSON.stringify(userMessage("后续追问", 1_700_000_005_000))}\n`, "utf8");
		sessions = await importer.scan(PROJECT_PATH);
		assert.equal(sessions[0].status, "outdated");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 拒绝 ~/.kimi-code 之外的源路径（路径逃逸防护）", async () => {
	const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
	try {
		const outside = join(home, "elsewhere", "wire.jsonl");
		mkdirSync(join(home, "elsewhere"), { recursive: true });
		writeFileSync(outside, `${JSON.stringify(userMessage("越界"))}\n`, "utf8");

		const { importer } = loadImporter(home);
		const report = await importer.import(PROJECT_PATH, [outside]);

		assert.equal(report.imported, 0);
		assert.equal(report.failed, 1);
		assert.match(report.results[0].error, /outside/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("纯函数: kimiMessageKey 优先用消息 id，缺 id 退化为内容哈希", async () => {
	const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
	try {
		const { registry } = loadImporter(home);
		const { extractKimiMessage, kimiMessageKey } = registry.convert;

		const withId = extractKimiMessage(userMessage("你好"));
		assert.equal(kimiMessageKey(withId), "id:msg_u_1700000001000");

		const noIdRecord = userMessage("你好");
		delete noIdRecord.message.id;
		const noId = extractKimiMessage(noIdRecord);
		assert.ok(kimiMessageKey(noId).startsWith("sig:user:"));
		// 同内容同角色 → 同键（两种 wire 记录视图去重依赖这一点）
		const sameContent = userMessage("你好");
		delete sameContent.message.id;
		assert.equal(kimiMessageKey(noId), kimiMessageKey(extractKimiMessage(sameContent)));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("纯函数: convertKimiAssistantContent 兼容 OpenAI 风格 function 包装的 toolCalls", async () => {
	const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
	try {
		const { registry } = loadImporter(home);
		const { convertKimiAssistantContent } = registry.convert;
		// vm 沙箱内对象的 prototype 与测试 realm 不同，deepEqual 前先做 JSON 往返
		const converted = JSON.parse(
			JSON.stringify(
				convertKimiAssistantContent({
					kind: "appended",
					id: "m1",
					role: "assistant",
					time: 1,
					content: [{ type: "text", text: "执行命令" }],
					toolCalls: [{ type: "function", id: "tool_x", function: { name: "Bash", arguments: '{"command":"ls"}' } }],
					toolCallId: "",
					usage: undefined,
					finishReason: "tool_calls",
				}),
			),
		);
		const toolCall = converted.content.find((block) => block.type === "toolCall");
		assert.equal(toolCall.name, "Bash");
		assert.deepEqual(toolCall.arguments, { command: "ls" });
		assert.deepEqual(converted.toolNames, [{ id: "tool_x", name: "Bash" }]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
