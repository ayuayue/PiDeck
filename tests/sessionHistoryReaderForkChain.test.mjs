import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// fork 子会话只落增量（header 带 parentSession 指针）：Reader 必须沿链把祖先活动分支
// 的消息前置合并进时间线，否则重发/编辑 fork 出的子会话冷启动后看不到先前对话。
const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");

function textFromContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item) => item?.type === "text")
		.map((item) => item.text ?? "")
		.join("");
}

function createReader(pathMap) {
	return new SessionHistoryReader({
		toHostPath: (sessionPath) => pathMap.get(sessionPath) ?? sessionPath,
		convertMessages: (_agentId, rawMessages, entryIds = []) => rawMessages.filter((message) => message && typeof message === "object" && "role" in message).map((message, index) => ({ id: entryIds[index] ?? `message-${index}`, role: message.role, text: textFromContent(message.content) })),
		trimMessages: (messages) => messages,
		translate: () => "Summary unavailable.",
	});
}

function messageEntry(id, parentId, role, text) {
	return JSON.stringify({ id, parentId, type: "message", message: { role, content: [{ type: "text", text }] } });
}

test("fork child timeline follows parentSession chain: ancestor prefix prepended, no duplication", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-history-forkchain-"));
	try {
		const parentPath = join(directory, "parent.jsonl");
		const childPath = join(directory, "child.jsonl");
		// 祖先：ALPHA 一轮（fork 锚点在第一轮 user 之后，历史与分支都留在祖先文件）
		await writeFile(
			parentPath,
			[
				JSON.stringify({ id: "session-parent", type: "session" }),
				JSON.stringify({ id: "p-model", parentId: "session-parent", type: "model_change", provider: "workbuddy", modelId: "cn:hy3" }),
				messageEntry("p-user-1", "p-model", "user", "ALPHA"),
				messageEntry("p-assistant-1", "p-user-1", "assistant", "ok: ALPHA"),
				messageEntry("p-user-2", "p-assistant-1", "user", "BETA"),
				messageEntry("p-assistant-2", "p-user-2", "assistant", "ok: BETA"),
			].join("\n"),
			"utf8",
		);
		// 子会话（pi fork 产物形态）：header 带 parentSession + 自己的设置拷贝 + fork 点之后的新轮
		await writeFile(
			childPath,
			[
				JSON.stringify({ id: "session-child", type: "session", parentSession: parentPath }),
				JSON.stringify({ id: "c-model", parentId: "session-child", type: "model_change", provider: "workbuddy", modelId: "cn:hy3" }),
				messageEntry("c-user-1", "c-model", "user", "GAMMA"),
				messageEntry("c-assistant-1", "c-user-1", "assistant", "ok: GAMMA"),
			].join("\n"),
			"utf8",
		);
		const pathMap = new Map([
			["/root/child.jsonl", childPath],
			["/root/parent.jsonl", parentPath],
		]);
		const messages = await createReader(pathMap).readSessionDisplayMessages("/root/child.jsonl");
		// vm realm 数组原型与本 realm 不同：deepEqual 会误判 → 先落回本 realm 再比较
		const texts = Array.from(messages, (message) => message.text);
		// 完整历史 = 祖先活动分支（ALPHA/BETA 两轮）+ 子会话新轮（GAMMA），顺序保持
		assert.deepEqual(texts, ["ALPHA", "ok: ALPHA", "BETA", "ok: BETA", "GAMMA", "ok: GAMMA"]);
		// 无重复：BETA 只出现在被裁掉的祖先分支里，但祖先活动分支就是 fork 时刻状态——
		// 这里验证的是同一消息不因链合并而出现两次
		assert.equal(texts.filter((text) => text === "GAMMA").length, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("missing fork ancestor degrades to child-only timeline instead of failing", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-history-forkchain-missing-"));
	try {
		const childPath = join(directory, "child.jsonl");
		await writeFile(childPath, [JSON.stringify({ id: "session-child", type: "session", parentSession: join(directory, "deleted-parent.jsonl") }), messageEntry("c-user-1", "session-child", "user", "GAMMA")].join("\n"), "utf8");
		const messages = await createReader(new Map([["/root/child.jsonl", childPath]])).readSessionDisplayMessages("/root/child.jsonl");
		assert.deepEqual(
			Array.from(messages, (message) => message.text),
			["GAMMA"],
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("cyclic parentSession pointers terminate via visited guard", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-history-forkchain-cycle-"));
	try {
		const childPath = join(directory, "child.jsonl");
		// 互相指向的病态文件（手工构造/损坏）：不得死循环
		await writeFile(childPath, [JSON.stringify({ id: "session-child", type: "session", parentSession: "/root/child.jsonl" }), messageEntry("c-user-1", "session-child", "user", "GAMMA")].join("\n"), "utf8");
		const messages = await createReader(new Map([["/root/child.jsonl", childPath]])).readSessionDisplayMessages("/root/child.jsonl");
		assert.deepEqual(
			Array.from(messages, (message) => message.text),
			["GAMMA"],
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
