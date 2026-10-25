/**
 * 打开已有 pi 会话时主进程卡死（窗口关闭/最小化/设置都点不了）。
 *
 * 用户症状：dev 启动后点 pi 会话，界面停在「正在启动 Agent…」，DSH 会话正常。
 * 根因：attach 走 get_messages 时 pi 把整段历史打成单行 JSON；PiRpcClient 在 stdout
 * data 回调里同步 JSON.parse，主进程事件循环被堵住（窗口按钮也是 IPC）。
 * 即便改走 JSONL 文件，readRecentMessages 若整文件 split + 逐行 parse 且不让出
 * 事件循环，大会话同样会冻死 UI。
 *
 * 本文件断言公开契约：attach 不得再发 get_messages；文件回退必须走会 yield 的
 * 显示索引，只物化最近 N 轮。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { trimHistoryMessages } = loadTsCommonJs("src/main/pi/agentUtils.ts");

const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");

function createReader() {
	return new SessionHistoryReader({
		toHostPath: (sessionPath) => sessionPath,
		convertMessages: (_agentId, rawMessages, entryIds = []) =>
			rawMessages.map((message, index) => ({
				id: entryIds[index] ?? `message-${index}`,
				role: message.role,
				text: typeof message.content === "string" ? message.content : (message.content?.[0]?.text ?? ""),
			})),
		trimMessages: (messages, maxTurns) => trimHistoryMessages(messages, maxTurns),
		translate: () => "Summary unavailable.",
	});
}

function jsonlSession(turnCount) {
	const rows = [JSON.stringify({ id: "session", type: "session" })];
	let parent = "session";
	for (let i = 1; i <= turnCount; i += 1) {
		const userId = `u${i}`;
		const assistantId = `a${i}`;
		rows.push(
			JSON.stringify({
				id: userId,
				parentId: parent,
				type: "message",
				message: { role: "user", content: [{ type: "text", text: `q${i}` }] },
			}),
		);
		rows.push(
			JSON.stringify({
				id: assistantId,
				parentId: userId,
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: `a${i}` }] },
			}),
		);
		parent = assistantId;
	}
	return rows.join("\n") + "\n";
}

test("attaching a persisted Session never asks pi for get_messages", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const createUnlocked = source.slice(source.indexOf("private async createUnlocked"), source.indexOf("\n\tasync rename("));
	// 握手后历史必须走 JSONL 尾部；get_messages 单行 JSON.parse 会冻住整个 Electron。
	assert.match(createUnlocked, /readRecentMessagesFromSessionFile/);
	assert.doesNotMatch(createUnlocked, /client\.request\(\{\s*type:\s*"get_messages"/);
});

test("loadMessages falls back to the session file, not get_messages, when a path exists", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const start = source.indexOf("async loadMessages(");
	const end = source.indexOf("private getAgentSessionIdentityDefaults");
	assert.ok(start >= 0 && end > start, "loadMessages slice must be non-empty");
	const loadMessages = source.slice(start, end);
	// 编辑/删除/重试若漏 earlyPromise，旧实现会再发 get_messages，大会话二次冻死。
	assert.match(loadMessages, /readRecentMessagesFromSessionFile/);
	assert.match(loadMessages, /runtime\.tab\.sessionPath/);
	// 有会话文件时禁止 get_entries：整棵 entry 树单行 JSON.parse 同样冻窗。
	assert.match(loadMessages, /getRecentActiveEntryIds/);
	assert.match(loadMessages, /useFileEntryIds/);
});

test("readRecentMessages uses the yielding display index instead of a one-turn full-file parse", () => {
	const source = readFileSync("src/main/pi/SessionHistoryReader.ts", "utf8");
	const start = source.indexOf("async readRecentMessages(");
	const end = source.indexOf("async scanCompactions(");
	assert.ok(start >= 0 && end > start, "readRecentMessages must precede scanCompactions");
	const fn = source.slice(start, end);
	assert.match(fn, /getSessionDisplayIndex/);
	assert.match(fn, /readIndexedSessionMessages/);
	// 旧实现：readFile + split + 同步 JSON.parse 每一行，主进程窗口消息排队。
	assert.doesNotMatch(fn, /content\.split\(/);
});

test("scanCompactions reuses the display index instead of parsing the file a second time", () => {
	const source = readFileSync("src/main/pi/SessionHistoryReader.ts", "utf8");
	const fn = source.slice(source.indexOf("async scanCompactions("));
	assert.match(fn, /getSessionDisplayIndex/);
});

test("readRecentMessages only materializes the last N turns from a long Session", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-history-tail-"));
	const sessionPath = join(directory, "session.jsonl");
	try {
		await writeFile(sessionPath, jsonlSession(20), "utf8");
		const reader = createReader();
		const response = await reader.readRecentMessages(sessionPath, 3);
		const messages = response.data?.messages ?? [];
		assert.equal(response.command, "get_messages");
		assert.equal(messages.length, 6);
		assert.equal(messages[0].content[0].text, "q18");
		assert.equal(messages[5].content[0].text, "a20");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
