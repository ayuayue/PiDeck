/**
 * SessionHistoryReader 的 custom_message（扩展通知）卡片合成。
 *
 * 背景（用户反馈）：后台子代理完成时 pi 用 sendCustomMessage 唤醒父会话，落盘为
 * custom_message 条目。旧实现整条丢弃 → 唤醒不可见，且两个回合并进同一个 run，
 * 上一轮最终回答被折叠、「后面的变成最后」。
 *
 * 断言的行为：
 * - 通知条目投影为 system + meta.type="customMessage"（带 customType/display/entryId）
 * - 插入位置 = 该通知之前有多少条消息条目（即落在下一条消息之前）
 * - 尾部通知（最后一条消息之后）排在列表末尾，且不在相邻两页里重复出现
 * - 与压缩卡片共存时按 +1 补偿，不错位一格
 * - 白名单外的内部上下文注入（display:false）仍生成条目（回合边界真实存在），
 *   是否画卡片由渲染层白名单决定
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");
const { AgentMessageProjector } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts");
const { isNotifiableCustomType } = loadTsCommonJs("src/renderer/src/components/session/notifySummary.ts");

/** 用真实投影器（而非字段回显 stub），保证卡片偏移与压缩卡片 meta 口径一致。 */
function createReader() {
	const projector = new AgentMessageProjector({
		translate: (key) => String(key),
		isAskAborted: () => false,
	});
	return new SessionHistoryReader({
		toHostPath: (sessionPath) => sessionPath,
		convertMessages: (agentId, rawMessages, entryIds) => projector.convert(agentId, rawMessages, entryIds),
		trimMessages: (messages) => messages,
		translate: (key) => String(key),
	});
}

function writeSession(fileName, lines) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-notify-cards-"));
	const filePath = join(dir, fileName);
	writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
	return filePath;
}

function header() {
	return JSON.stringify({
		type: "session",
		id: "session-1",
		cwd: "/tmp",
		timestamp: "2026-09-20T09:59:00.000Z",
	});
}

function userMessage(id, parentId, text) {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		message: { role: "user", content: [{ type: "text", text }] },
	});
}

function assistantMessage(id, parentId, text) {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
	});
}

function customMessage(id, parentId, options = {}) {
	return JSON.stringify({
		type: "custom_message",
		customType: options.customType ?? "subagent-notify",
		content: options.content ?? "Background task completed: **delegate**\n\ndelegate: ok",
		display: options.display === true,
		id,
		parentId,
		timestamp: options.timestamp ?? "2026-09-20T10:00:00.000Z",
	});
}

/** appendEntry（type:"custom"）会话条目：扩展输出，data 为任意 JSON 载荷。 */
function customEntry(id, parentId, customType, data, options = {}) {
	return JSON.stringify({
		type: "custom",
		customType,
		data,
		id,
		parentId,
		timestamp: options.timestamp ?? "2026-09-20T10:00:00.000Z",
	});
}

/** 消息列表的「角色/类型 + 文本」摘要，用于断言顺序。 */
function outline(messages) {
	// 注意：先 [...spread] 再 map。投影器来自 vm 加载的模块，其数组是另一个 realm 的
	// Array，直接 .map 会因为 species 规则仍返回跨 realm 数组，deepStrictEqual 会因
	// prototype 不同而报「same structure but not reference-equal」。
	return [...messages].map((message) => {
		if (message.meta?.type === "customMessage") return `custom:${message.meta.customType}`;
		if (message.meta?.type === "customEntry") return `entry:${message.meta.customType}`;
		if (message.meta?.type === "compaction") return "compaction";
		return `${message.role}:${message.text}`;
	});
}

test("通知条目投影为 system 卡片并插在下一条消息之前", async () => {
	const filePath = writeSession("notify-basic.jsonl", [header(), userMessage("u1", "session-1", "q1"), assistantMessage("a1", "u1", "a1"), customMessage("cm1", "a1", { display: true }), assistantMessage("a2", "cm1", "a2")]);
	const window = await createReader().readLoadWindow(filePath, "agent-1", 20, 500);

	assert.deepEqual(outline(window.messages), ["user:q1", "assistant:a1", "custom:subagent-notify", "assistant:a2"]);
	const card = window.messages[2];
	assert.equal(card.role, "system");
	assert.equal(card.meta.display, true);
	assert.equal(card.meta.entryId, "cm1");
	// 正文原样保留（渲染层负责「折叠一行 + 展开全文」）
	assert.match(card.text, /Background task completed/);
});

test("尾部通知（最后一条消息之后）排在列表末尾", async () => {
	const filePath = writeSession("notify-tail.jsonl", [header(), userMessage("u1", "session-1", "q1"), assistantMessage("a1", "u1", "a1"), customMessage("cm-tail", "a1")]);
	const window = await createReader().readLoadWindow(filePath, "agent-1", 20, 500);

	assert.deepEqual(outline(window.messages), ["user:q1", "assistant:a1", "custom:subagent-notify"]);
});

test("分页：通知卡片在所有页里恰好出现一次（不重复、不丢失）", async () => {
	const filePath = writeSession("notify-pages.jsonl", [header(), userMessage("u1", "session-1", "q1"), assistantMessage("a1", "u1", "a1"), customMessage("cm1", "a1"), assistantMessage("a2", "cm1", "a2"), assistantMessage("a3", "a2", "a3"), customMessage("cm-tail", "a3")]);
	const reader = createReader();

	// 逐页上翻（turnCount=1 让页边界尽量贴到回合边界，专门探边界处的卡片）
	const pages = [];
	let before = 4;
	for (let guard = 0; guard < 10 && before !== null; guard += 1) {
		const page = await reader.readSessionDisplayTurnPage(filePath, "agent-1", before, 1);
		pages.push(page);
		before = page.nextBefore;
	}
	assert.equal(before, null, "分页应在有限页内读完");

	// 页按「新 → 旧」返回，倒序拼接后应与整段消息序列一致：
	// 卡片归属唯一一页（半开区间），既不会在相邻两页各插一张，也不会丢。
	const flat = pages.reverse().flatMap((page) => outline(page.messages));
	assert.deepEqual(flat, ["user:q1", "assistant:a1", "custom:subagent-notify", "assistant:a2", "assistant:a3", "custom:subagent-notify"]);
	const cardIds = pages.flatMap((page) => [...page.messages].filter((message) => message.meta?.type === "customMessage").map((m) => m.id));
	assert.equal(new Set(cardIds).size, cardIds.length, "同一通知不能在多页重复出现");
});

test("与压缩卡片共存时按 +1 补偿，不错位", async () => {
	const filePath = writeSession("notify-compaction.jsonl", [
		header(),
		userMessage("u1", "session-1", "q1"),
		JSON.stringify({
			type: "compaction",
			id: "c1",
			parentId: "u1",
			summary: "已归档的摘要",
			firstKeptEntryId: "a1",
			tokensBefore: 4321,
			timestamp: "2026-09-20T09:59:30.000Z",
		}),
		assistantMessage("a1", "c1", "a1"),
		customMessage("cm1", "a1"),
		assistantMessage("a2", "cm1", "a2"),
	]);
	const window = await createReader().readLoadWindow(filePath, "agent-1", 20, 500);

	// 压缩卡片插在 a1 之前（firstKeptEntryId），通知在 a1 之后 → 必须排在压缩卡片之后
	assert.deepEqual(outline(window.messages), ["user:q1", "compaction", "assistant:a1", "custom:subagent-notify", "assistant:a2"]);
});

test("白名单外的 custom_message 也生成条目，但渲染层白名单判定为不展示", async () => {
	const filePath = writeSession("notify-internal.jsonl", [
		header(),
		userMessage("u1", "session-1", "q1"),
		assistantMessage("a1", "u1", "a1"),
		customMessage("cm-plan", "a1", {
			customType: "pi-deck-plan-mode-context",
			content: "内部上下文注入",
			display: false,
		}),
		assistantMessage("a2", "cm-plan", "a2"),
	]);
	const window = await createReader().readLoadWindow(filePath, "agent-1", 20, 500);

	assert.deepEqual(outline(window.messages), ["user:q1", "assistant:a1", "custom:pi-deck-plan-mode-context", "assistant:a2"]);
	const card = window.messages[2];
	assert.equal(card.meta.display, false);
	// 卡片不展示，但它标记的回合边界仍然存在（渲染层按 meta.type === "customMessage" 断轮）
	assert.equal(isNotifiableCustomType(card.meta.customType), false);
});

test("空正文通知不占位", async () => {
	const filePath = writeSession("notify-empty.jsonl", [header(), userMessage("u1", "session-1", "q1"), assistantMessage("a1", "u1", "a1"), customMessage("cm-empty", "a1", { content: "   " }), assistantMessage("a2", "cm-empty", "a2")]);
	const window = await createReader().readLoadWindow(filePath, "agent-1", 20, 500);

	assert.deepEqual(outline(window.messages), ["user:q1", "assistant:a1", "assistant:a2"]);
});

test("扩展输出条目（appendEntry）投影为 customEntry 卡片并插在下一条消息之前", async () => {
	const filePath = writeSession("entry-basic.jsonl", [header(), userMessage("u1", "session-1", "q1"), assistantMessage("a1", "u1", "a1"), customEntry("e1", "a1", "pi-plan-btw", { query: "帮我看下迁移进度", depth: "brief" }), assistantMessage("a2", "e1", "a2")]);
	const window = await createReader().readLoadWindow(filePath, "agent-1", 20, 500, { entryRendererTypes: ["pi-plan-btw"] });

	assert.deepEqual(outline(window.messages), ["user:q1", "assistant:a1", "entry:pi-plan-btw", "assistant:a2"]);
	const card = window.messages[2];
	assert.equal(card.role, "system");
	assert.equal(card.meta.type, "customEntry");
	assert.equal(card.meta.entryId, "e1");
	// data 原样透传给渲染层（格式化是渲染层职责）；text 是折叠行预览（首个字符串字段）
	assert.deepEqual({ ...card.meta.data }, { query: "帮我看下迁移进度", depth: "brief" });
	assert.equal(card.text, "帮我看下迁移进度");
	assert.equal(card.id, "agent-1-customentry-e1");
});

test("内部记账类 customType（subagents: / pi-deck- 前缀）不投影成卡片", async () => {
	const filePath = writeSession("entry-internal.jsonl", [
		header(),
		userMessage("u1", "session-1", "q1"),
		assistantMessage("a1", "u1", "a1"),
		customEntry("e-record", "a1", "subagents:record", { id: "run-1", status: "running" }),
		customEntry("e-todo", "a1", "pi-deck-todo", { items: [] }),
		assistantMessage("a2", "e-todo", "a2"),
	]);
	const window = await createReader().readLoadWindow(filePath, "agent-1", 20, 500);

	// 高频记账快照不进时间线，否则子代理运行期会刷屏
	assert.deepEqual(outline(window.messages), ["user:q1", "assistant:a1", "assistant:a2"]);
});

test("未注册 registerEntryRenderer 的 customType 不投影成卡片（白名单口径）", async () => {
	const filePath = writeSession("entry-unregistered.jsonl", [header(), userMessage("u1", "session-1", "q1"), assistantMessage("a1", "u1", "a1"), customEntry("e1", "a1", "codemode-store", { set: {} }), assistantMessage("a2", "e1", "a2")]);
	// 扩展没注册渲染器（如 codemode 的内部 KV 写入）→ 时间线不出现裸 JSON 卡
	const window = await createReader().readLoadWindow(filePath, "agent-1", 20, 500, { entryRendererTypes: [] });
	assert.deepEqual(outline(window.messages), ["user:q1", "assistant:a1", "assistant:a2"]);
});

test("超大 data 载荷不进入渲染层：只带 dataTruncated 标记", async () => {
	const filePath = writeSession("entry-oversize.jsonl", [header(), userMessage("u1", "session-1", "q1"), assistantMessage("a1", "u1", "a1"), customEntry("e-big", "a1", "dump-snapshot", { blob: "x".repeat(20 * 1024) }), assistantMessage("a2", "e-big", "a2")]);
	const window = await createReader().readLoadWindow(filePath, "agent-1", 20, 500, { entryRendererTypes: ["dump-snapshot"] });

	const card = window.messages.find((message) => message.meta?.type === "customEntry");
	assert.ok(card, "条目本身仍应可见（可见性不应依赖载荷大小）");
	assert.equal(card.meta.dataTruncated, true);
	assert.equal("data" in card.meta, false, "超大载荷不得透传给渲染层");
});
