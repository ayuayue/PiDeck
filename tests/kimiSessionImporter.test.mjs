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

function loopEvent(event, offset) {
	return { type: "context.append_loop_event", agentId: "main", event, time: 1_700_000_010_000 + offset };
}

function loopStep({ id = "demo", callId = "loop_call", messageId = "loop_message", text = "示例助手回复", offset = 0 } = {}) {
	const turnId = "turn_1";
	return [
		loopEvent({ type: "step.begin", uuid: id, turnId, step: 1 }, offset),
		loopEvent({ type: "content.part", stepUuid: id, turnId, part: { type: "text", text } }, offset + 1),
		loopEvent({ type: "tool.call", stepUuid: id, turnId, toolCallId: callId, name: "Read", args: { path: "example.txt" } }, offset + 2),
		loopEvent({ type: "tool.result", toolCallId: callId, result: { output: [{ type: "text", text: "示例工具输出" }], isError: true } }, offset + 3),
		loopEvent({ type: "step.end", uuid: id, turnId, messageId, finishReason: "tool_calls", usage: { inputOther: 12, output: 7 } }, offset + 4),
	];
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
		assert.equal(lines[2].modelId, "kimi code");

		const messages = lines.filter((line) => line.type === "message");
		// 两种快照去重后，只写一次独立回复和一次调用。
		assert.equal(messages.length, 4);
		assert.equal(messages[0].message.role, "user");
		assert.deepEqual(messages[0].message.content, [{ type: "text", text: "帮我导入 Kimi Code 会话" }]);

		const assistant = messages[1].message;
		assert.equal(assistant.role, "assistant");
		assert.deepEqual(assistant.content[0], { type: "thinking", thinking: "先读文件确认结构", thinkingSignature: "kimi_thinking" });
		assert.deepEqual(assistant.content[1], { type: "text", text: "好的，先看一下。" });
		assert.equal(assistant.content.length, 2);
		assert.equal(assistant.stopReason, "stop");
		const call = messages[2].message;
		assert.equal(call.role, "assistant");
		assert.equal(call.stopReason, "toolUse");
		assert.deepEqual(call.content, [{ type: "toolCall", id: "tool_abc123", name: "Read", arguments: { path: "package.json" } }]);
		assert.equal(call.usage.totalTokens, 0);
		assert.equal(assistant.usage.input, 14537);
		assert.equal(assistant.usage.output, 196);
		assert.equal(assistant.usage.cacheRead, 16640);

		const toolResult = messages[3].message;
		assert.equal(toolResult.role, "toolResult");
		assert.equal(toolResult.toolCallId, "tool_abc123");
		assert.equal(toolResult.toolName, "Read");
		assert.equal(toolResult.isError, false);

		// parentId 链式推进，session_info（标题）追加在文件末尾（issue #114）
		assert.equal(messages[0].parentId, lines[2].id);
		assert.equal(messages[1].parentId, messages[0].id);
		assert.equal(messages[2].parentId, messages[1].id);
		assert.equal(messages[3].parentId, messages[2].id);
		const last = lines[lines.length - 1];
		assert.equal(last.type, "session_info");
		assert.equal(last.name, "导入目标");
		assert.equal(last.parentId, messages[3].id);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: Kimi Code 1.5 循环事件恢复回复与工具结果，内部 origin 不出现在聊天里", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const reminder = "<system-reminder>示例系统提醒</system-reminder>";
	const task = '<notification type="task.failed">示例任务失败</notification>';
	const user = userMessage(reminder, 1_700_000_003_000);
	user.message.origin = { kind: "user" };
	const injection = userMessage(reminder);
	injection.message.origin = { kind: "injection" };
	const notification = userMessage(task, 1_700_000_002_000);
	notification.message.origin = { kind: "task" };
	const session = writeKimiSession(home, {
		wire: [
			{ type: "metadata", protocol_version: "1.5" },
			injection,
			notification,
			{ type: "agent.message.appended", time: notification.time, message: { message: { ...notification.message, origin: undefined }, meta: { origin: { kind: "task" } } } },
			user,
			...loopStep(),
			loopEvent({ type: "content.part", turnId: "turn_1", part: { type: "text", text: "未结束的回复" } }, 5),
		],
	});
	appendIndexLine(home, indexRowFor(session.sessionDir));
	const { importer } = loadImporter(home);
	const [summary] = await importer.scan(PROJECT_PATH);
	assert.equal(summary.preview, reminder);
	assert.equal(summary.messageCount, 5);
	const report = await importer.import(PROJECT_PATH, [session.wirePath]);
	assert.equal(report.failed, 0);
	const messages = readLines(importTarget(home)).filter((line) => line.type === "message");
	assert.deepEqual(
		messages.map(({ message }) => message.role),
		["user", "assistant", "assistant", "toolResult", "assistant"],
	);
	assert.equal(messages[0].message.content[0].text, reminder);
	const assistant = messages[1].message;
	assert.deepEqual(assistant.content, [{ type: "text", text: "示例助手回复" }]);
	assert.equal(assistant.stopReason, "stop");
	assert.equal(assistant.usage.output, 7);
	const call = messages[2].message;
	assert.deepEqual(call.content, [{ type: "toolCall", id: "loop_call", name: "Read", arguments: { path: "example.txt" } }]);
	assert.equal(call.stopReason, "toolUse");
	assert.equal(call.usage.totalTokens, 0);
	const toolResult = messages[3].message;
	assert.equal(messages[3].parentId, messages[2].id);
	assert.equal(toolResult.toolCallId, "loop_call");
	assert.equal(toolResult.toolName, "Read");
	assert.equal(toolResult.content[0].text, "示例工具输出");
	assert.equal(toolResult.isError, true);
	assert.equal(messages[4].message.content[0].text, "未结束的回复");
});

test("import: 中间回复单独可见，多个同名工具调用及结果按 wire 顺序保留", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const [begin, part, call, result, end] = loopStep();
	const anotherCall = loopEvent({ ...call.event, toolCallId: "next_call" }, 4);
	const anotherResult = loopEvent({ ...result.event, toolCallId: "next_call" }, 5);
	const followup = loopEvent({ type: "content.part", part: { type: "text", text: "第二次调用之后" } }, 6);
	const final = loopEvent({ type: "content.part", part: { type: "text", text: "最终回答" } }, 8);
	const session = writeKimiSession(home, {
		wire: [userMessage("检查两个文件"), begin, part, call, result, anotherCall, anotherResult, followup, { ...end, time: followup.time + 1 }, final],
	});
	const { importer } = loadImporter(home);
	const report = await importer.import(PROJECT_PATH, [session.wirePath]);
	assert.equal(report.failed, 0);
	const messages = readLines(importTarget(home))
		.filter(({ type }) => type === "message")
		.map(({ message }) => message);
	assert.deepEqual(
		messages.map(({ role }) => role),
		["user", "assistant", "assistant", "toolResult", "assistant", "toolResult", "assistant", "assistant"],
	);
	assert.deepEqual(
		messages.slice(1).map((message) => message.timestamp),
		[part, call, result, anotherCall, anotherResult, followup, final].map((entry) => entry.time),
	);
	assert.deepEqual(messages[1].content, [{ type: "text", text: "示例助手回复" }]);
	assert.equal(messages[1].stopReason, "stop");
	for (const [at, id] of [
		[2, "loop_call"],
		[4, "next_call"],
	]) {
		assert.equal(messages[at].stopReason, "toolUse");
		assert.deepEqual(messages[at].content, [{ type: "toolCall", id, name: "Read", arguments: { path: "example.txt" } }]);
		assert.equal(messages[at + 1].toolCallId, id);
	}
	assert.deepEqual(messages[6].content, [{ type: "text", text: "第二次调用之后" }]);
	assert.equal(messages[6].stopReason, "stop");
	assert.equal(messages[7].content[0].text, "最终回答");
	assert.equal(
		messages.reduce((sum, { usage }) => sum + (usage?.output ?? 0), 0),
		7,
	);
});

test("import: 调用后的阶段文本保留源时间，等待已有结果配对，截断时也可见", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const [begin, , call, result, end] = loopStep();
	const notice = loopEvent({ type: "content.part", part: { type: "text", text: "已经发起读取" } }, 3);
	const snapshot = toolResultMessage(notice.time + 1);
	snapshot.message.toolCallId = call.event.toolCallId;
	const truncatedCall = loopEvent({ ...call.event, toolCallId: "truncated" }, 7);
	const last = loopEvent({ ...notice.event, part: { type: "text", text: "截断前的文本" } }, 8);
	const session = writeKimiSession(home, { wire: [begin, call, notice, snapshot, { ...result, time: snapshot.time + 1 }, { ...end, time: snapshot.time + 2 }, truncatedCall, last] });
	const { importer } = loadImporter(home);
	assert.equal((await importer.import(PROJECT_PATH, [session.wirePath])).failed, 0);
	const messages = readLines(importTarget(home))
		.filter((line) => line.type === "message")
		.map((line) => line.message);
	assert.deepEqual(
		messages.map((m) => m.stopReason ?? m.role),
		["toolUse", "toolResult", "stop", "toolUse", "stop"],
	);
	assert.equal(messages[1].toolCallId, messages[0].content[0].id);
	assert.equal(messages[1].toolName, "Read");
	assert.deepEqual(messages[2].content, [notice.event.part]);
	assert.deepEqual(messages[4].content, [last.event.part]);
	assert.deepEqual(
		messages.map((m) => m.timestamp),
		[call, snapshot, notice, truncatedCall, last].map((entry) => entry.time),
	);
});

for (const format of ["loop", "snapshot", "mixed"]) {
	test(`import: ${format} 并行调用共用一条 toolUse，逆序返回均可配对`, async (t) => {
		const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
		t.after(() => rmSync(home, { recursive: true, force: true }));
		const [begin, part, callA, resultA, end] = loopStep({ callId: "A" });
		const callB = loopEvent({ ...callA.event, toolCallId: "B", name: "Write" }, 3);
		const resultB = loopEvent({ ...resultA.event, toolCallId: "B" }, 4);
		const explicit = assistantAppended(end.time + 3);
		explicit.message.message.content = [{ type: "think", think: "准备调用" }];
		explicit.message.message.toolCalls = [
			{ id: "A", name: "Read" },
			{ id: "B", name: "Write" },
		];
		const directB = toolResultMessage(explicit.time + 1);
		directB.message.toolCallId = "B";
		const directA = toolResultMessage(explicit.time + 2);
		directA.message.toolCallId = "A";
		const loop = [begin, part, callA, callB, resultB, { ...resultA, time: resultB.time + 1 }, { ...end, time: resultB.time + 2 }];
		const wire = format === "loop" ? loop : format === "snapshot" ? [explicit, directB, directA] : [...loop, explicit];
		const session = writeKimiSession(home, { wire });
		const { importer } = loadImporter(home);
		assert.equal((await importer.import(PROJECT_PATH, [session.wirePath])).failed, 0);
		const messages = readLines(importTarget(home))
			.filter((line) => line.type === "message")
			.map((line) => line.message);
		if (format === "loop") {
			assert.equal(messages[0].stopReason, "stop");
			assert.deepEqual(messages[0].content, [part.event.part]);
		}
		const [calls, b, a] = messages.slice(format === "loop" ? 1 : 0);
		assert.equal(messages.length, format === "loop" ? 4 : 3);
		assert.equal(calls.stopReason, "toolUse");
		assert.deepEqual(
			calls.content.filter((block) => block.type === "toolCall").map((block) => block.id),
			["A", "B"],
		);
		if (format !== "loop") assert.deepEqual(calls.content[0], { type: "thinking", thinking: "准备调用", thinkingSignature: "kimi_thinking" });
		assert.deepEqual(
			[b, a].map((message) => [message.role, message.toolCallId, message.toolName]),
			[
				["toolResult", "B", "Write"],
				["toolResult", "A", "Read"],
			],
		);
		for (const message of messages.filter((message) => message.role === "assistant")) {
			assert.deepEqual([message.provider, message.model, message.api], ["kimi", "kimi code", "kimi-import"]);
		}
		assert.equal(
			messages.reduce((sum, { usage }) => sum + (usage?.output ?? 0), 0),
			format === "loop" ? 7 : 196,
		);
	});
}

test("import: 混合 wire 保留完整消息，循环事件只补缺失的回复或工具结果", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const explicit = assistantAppended(1_700_000_010_005);
	delete explicit.message.message.id;
	explicit.message.meta.messageId = "loop_message";
	const resultSnapshot = toolResultMessage(1_700_000_010_006);
	const secondExplicit = {
		type: "agent.message.appended",
		time: 1_700_000_010_015,
		message: { message: { role: "assistant", toolCalls: [{ id: "missing_result", name: "Read" }] }, meta: { messageId: "second_message" } },
	};
	const session = writeKimiSession(home, {
		wire: [
			userMessage("验证混合格式"),
			...loopStep({ callId: "tool_abc123" }),
			explicit,
			resultSnapshot,
			...loopStep({ id: "second", callId: "missing_result", messageId: "second_message", offset: 10 }),
			secondExplicit,
			...loopStep({ id: "third", callId: "third_call", messageId: "third_message", offset: 20 }),
			loopEvent({ type: "content.part", stepUuid: "text_step", part: { type: "text", text: "循环事件文本" } }, 30),
			loopEvent({ type: "step.end", uuid: "text_step", messageId: "text_message" }, 31),
			{
				type: "agent.message.appended",
				time: 1_700_000_010_032,
				message: { message: { role: "assistant", content: [{ type: "text", text: "完整消息文本" }] }, meta: { messageId: "text_message" } },
			},
		],
	});
	const { importer } = loadImporter(home);
	assert.equal((await importer.import(PROJECT_PATH, [session.wirePath])).failed, 0);
	const messages = readLines(importTarget(home))
		.filter((line) => line.type === "message")
		.map((line) => line.message);
	assert.deepEqual(
		messages.map(({ role }) => role),
		["user", "assistant", "assistant", "toolResult", "assistant", "toolResult", "assistant", "assistant", "toolResult", "assistant"],
	);
	assert.equal(messages[1].usage.output, 196);
	assert.equal(messages[2].content[0].id, "tool_abc123");
	assert.equal(messages[3].content[0].text, '{"name":"pideck"}');
	assert.equal(messages[5].toolCallId, "missing_result");
	assert.equal(messages[6].content[0].text, "示例助手回复");
	assert.equal(messages[8].toolCallId, "third_call");
	assert.equal(messages[9].content[0].text, "完整消息文本");
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

		// 转换版本升级后，即使源文件不变也允许用户手动重导。
		const target = importTarget(home);
		const oldEntries = readLines(target);
		assert.equal(oldEntries[1].version, 3);
		oldEntries[1].version = 2;
		writeFileSync(target, `${oldEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
		assert.equal((await importer.scan(PROJECT_PATH))[0].status, "outdated");
		assert.equal((await importer.import(PROJECT_PATH, [session.wirePath])).results[0].overwritten, true);
		assert.equal((await importer.scan(PROJECT_PATH))[0].status, "current");

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
