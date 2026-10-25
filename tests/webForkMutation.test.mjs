import assert from "node:assert/strict";
import { test } from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * Web 端 fork 化重试（重发/编辑迁移）策略层回归：
 * 与桌面 useSessionHistoryMutations.runForkMutation 同构——锚点解析优先级、
 * DSH seq 锚点、文本回退取尾部最近一条、尾部替换 vs 分支模式、重投文本选择。
 * 背景：Web 端此前重发/编辑直接原地改写且旧会话不隐藏，导致重发后出现两个重复会话
 * （桌面端通过 fork + supersededBy 解决）；2027-04 Web 端对齐桌面语义。
 */

const load = createTsSandbox();
const { forkEntryIdFromMessage, resolveWebForkEntryId, isLastUserMessageIn, forkPromptText } = load("src/renderer/src/web/webForkMutation.ts");

const userMessage = (id, text, metadata) => ({ id, role: "user", parts: [{ type: "text", text }], ...(metadata ? { metadata } : {}) });
const target = { sessionId: "s1", agentId: "a1", runtimeGeneration: 1 };

test("forkEntryIdFromMessage 优先 metadata.entryId", () => {
	assert.equal(forkEntryIdFromMessage(userMessage("m1", "hi", { entryId: "entry-42" })), "entry-42");
});

test("forkEntryIdFromMessage 解析 id 的 -history- 后缀（过滤纯数字时间戳形态）", () => {
	assert.equal(forkEntryIdFromMessage(userMessage("abc-history-msg_7f3", "hi")), "msg_7f3");
	// 后缀是数字（历史序号形态，非 entryId）不命中
	assert.equal(forkEntryIdFromMessage(userMessage("abc-history-123", "hi")), undefined);
});

test("forkEntryIdFromMessage 解析 DSH 的 dsh:<seq> id → seq 锚点", () => {
	assert.equal(forkEntryIdFromMessage(userMessage("dsh:12", "hi")), "seq:12");
});

test("resolveWebForkEntryId 文本回退从尾部取最近一条匹配（重复文本时锚定用户所指）", async () => {
	const fetcher = async () => [
		{ entryId: "e1", text: "same question" },
		{ entryId: "e2", text: "other" },
		{ entryId: "e3", text: "same question" },
	];
	assert.equal(await resolveWebForkEntryId(userMessage("u9", "same question"), target, fetcher), "e3");
});

test("resolveWebForkEntryId fetch 失败时返回 undefined 不抛（上层 toast）", async () => {
	const fetcher = async () => {
		throw new Error("boom");
	};
	assert.equal(await resolveWebForkEntryId(userMessage("u9", "text"), target, fetcher), undefined);
});

test("isLastUserMessageIn：尾部替换（false→branchMode=false 旧会话隐藏）vs 分支模式", () => {
	const messages = [userMessage("u1", "q1"), { id: "a1", role: "assistant", parts: [{ type: "text", text: "r1" }] }, userMessage("u2", "q2")];
	assert.equal(isLastUserMessageIn(messages, "u2"), true, "最后一条用户消息 → 尾部替换");
	assert.equal(isLastUserMessageIn(messages, "u1"), false, "历史锚点 → 分支模式（旧会话保留）");
	assert.equal(isLastUserMessageIn(messages, "missing"), false);
	assert.equal(isLastUserMessageIn([], "u1"), false, "无消息列表（未加载）按分支模式保守处理");
});

test("forkPromptText：编辑用新文本；重发优先 fork 返回原文，缺失回退时间线文本", () => {
	const message = userMessage("u1", "timeline text");
	assert.equal(forkPromptText("edit", { text: "server text" }, message, "new text"), "new text");
	assert.equal(forkPromptText("resend", { text: "server text" }, message), "server text");
	assert.equal(forkPromptText("resend", {}, message), "timeline text");
	assert.equal(forkPromptText("resend", { text: "" }, message), "timeline text");
});
