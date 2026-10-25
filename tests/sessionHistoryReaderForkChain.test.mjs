import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// parentSession 链既可能引用增量子文件，也可能包含 pi fork 的完整前缀拷贝：
// Reader 必须保留每条消息的字节来源，并避免重复注入子文件已有的消息。
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

test("second-level incremental fork reads each ancestor from its original file", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-history-forkchain-nested-"));
	try {
		const rootPath = join(directory, "root.jsonl");
		const parentPath = join(directory, "parent.jsonl");
		const childPath = join(directory, "child.jsonl");
		await writeFile(rootPath, [JSON.stringify({ id: "root", type: "session" }), messageEntry("r-user", "root", "user", "ROOT 中文"), messageEntry("r-assistant", "r-user", "assistant", "root reply")].join("\n"));
		await writeFile(parentPath, [JSON.stringify({ id: "parent", type: "session", parentSession: rootPath }), messageEntry("p-user", "parent", "user", "PARENT"), messageEntry("p-assistant", "p-user", "assistant", "parent reply")].join("\n"));
		await writeFile(childPath, [JSON.stringify({ id: "child", type: "session", parentSession: parentPath }), messageEntry("c-user", "child", "user", "CHILD")].join("\n"));
		const reader = createReader(new Map());
		const messages = await reader.readSessionDisplayMessages(childPath);
		assert.deepEqual(
			Array.from(messages, (message) => message.text),
			["ROOT 中文", "root reply", "PARENT", "parent reply", "CHILD"],
		);
		const page = await reader.readSessionDisplayTurnPage(childPath, "_viewer", undefined, 2);
		assert.deepEqual(
			Array.from(page.messages, (message) => message.text),
			["PARENT", "parent reply", "CHILD"],
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("copied fork prefix is child-authoritative and does not inherit the parent's later branch", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-history-forkchain-copied-"));
	try {
		const rootPath = join(directory, "root.jsonl");
		const parentPath = join(directory, "parent.jsonl");
		const childPath = join(directory, "child.jsonl");
		const prefix = [messageEntry("r-user", null, "user", "SHARED 中文"), messageEntry("r-assistant", "r-user", "assistant", "shared reply")];
		await writeFile(rootPath, [JSON.stringify({ id: "root", type: "session" }), ...prefix, messageEntry("later", "r-assistant", "user", "ROOT LATER BRANCH")].join("\n"));
		const parentBranch = [...prefix, messageEntry("p-user", "r-assistant", "user", "PARENT ONLY")];
		await writeFile(parentPath, [JSON.stringify({ id: "parent", type: "session", parentSession: rootPath }), ...parentBranch].join("\n"));
		// 子文件保留同 id 的自身拷贝；该拷贝必须从子文件读取，父分支之后的消息不可混入。
		const childBranch = [messageEntry("r-user", null, "user", "CHILD COPY 中文"), prefix[1], messageEntry("c-user", "r-assistant", "user", "CHILD ONLY")];
		await writeFile(childPath, [JSON.stringify({ id: "child", type: "session", parentSession: parentPath }), ...childBranch].join("\n"));
		const reader = createReader(new Map());
		const messages = await reader.readSessionDisplayMessages(childPath);
		assert.deepEqual(
			Array.from(messages, (message) => message.text),
			["CHILD COPY 中文", "shared reply", "CHILD ONLY"],
		);
		assert.equal(new Set(Array.from(messages, (message) => message.id)).size, messages.length);
		const page = await reader.readSessionDisplayTurnPage(childPath, "_viewer", undefined, 1);
		assert.equal(page.total, 3);
		assert.deepEqual(
			Array.from(page.messages, (message) => message.text),
			["CHILD ONLY"],
		);
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
