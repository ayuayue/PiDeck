import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { atom } from "jotai/vanilla";
import { atomFamily, selectAtom } from "jotai/vanilla/utils";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 「发送失败后消息被吞」回归（2026-10 用户反馈，DSH 会话）。
 *
 * 根因链：
 * 1. 渲染层发送时先插入乐观用户气泡（id = requestId，meta.pendingUserMessage）；
 * 2. DSH 的模型解析发生在回合 prepareRequest 阶段，早于 session.append("user/message")
 *    （node_modules/@deepseek-ai/dsh-agent-loop：step() 先 prepareRequest，再 append 用户消息）；
 * 3. 模型配置错误（pi-ai provider … has no configured model）让回合直接 turn/end(error)，
 *    用户消息从未写进会话日志；
 * 4. 运行时快照整段替换窗口 → 乐观气泡被替换掉，界面上只剩一条错误诊断。
 *
 * 修复：快照合并时把「尚未被宿主记录」的气泡按锚点接回原位；宿主记录后（同文本）
 * 或投递被拒时撤掉。逻辑住在 session-atoms（它被大量手写 vm 加载器编译，
 * 新增相对 import 会整片 MODULE_NOT_FOUND）。
 */

const load = createTsSandbox({
	stubs: {
		jotai: { atom, useStore: () => ({}), useSetAtom: () => () => {}, useAtomValue: () => undefined },
		"jotai/utils": { atomFamily, selectAtom, atomWithStorage: (_key, initial) => atom(initial) },
	},
});
const { PENDING_USER_MESSAGE_META, carryPendingUserMessages, isPendingUserMessage, removePendingUserMessages } = load("src/renderer/src/atoms/session-atoms.ts");

function user(id, text, meta) {
	return { id, role: "user", text, timestamp: 1, ...(meta ? { meta } : {}) };
}
function pending(id, text, requestId = id) {
	return user(id, text, { [PENDING_USER_MESSAGE_META]: true, requestId });
}
function assistant(id, text) {
	return { id, role: "assistant", text, timestamp: 2, stopReason: "stop" };
}
function errorMessage(id, text) {
	return { id, role: "error", text, timestamp: 3 };
}
function ids(messages) {
	// 生产模块在 vm 沙箱里加载，返回沙箱 realm 数组；Array.from 转宿主数组后才能深比较。
	return Array.from(messages, (message) => message.id);
}

test("宿主快照没有这条用户消息时（模型解析失败）：气泡接回原位，排在错误卡之前", () => {
	const history = [user("u1", "旧问题"), assistant("a1", "旧回答")];
	const previous = [...history, pending("req-1", "新问题")];
	// 回合直接 error 收口：快照只有历史 + 错误诊断，没有 user/message
	const snapshot = [...history, errorMessage("dsh:9", 'pi-ai provider "magpie" has no configured model')];
	const merged = carryPendingUserMessages(previous, snapshot);
	assert.deepEqual(ids(merged), ["u1", "a1", "req-1", "dsh:9"]);
	assert.equal(isPendingUserMessage(merged[2]), true);
});

test("宿主已经记录了这条用户消息（同文本）：气泡让位给正式消息，不重复", () => {
	const history = [user("u1", "旧问题"), assistant("a1", "旧回答")];
	const previous = [...history, pending("req-1", "新问题")];
	const snapshot = [...history, user("dsh:10", "新问题"), assistant("dsh:11", "回答")];
	assert.deepEqual(ids(carryPendingUserMessages(previous, snapshot)), ["u1", "a1", "dsh:10", "dsh:11"]);
});

test("文本比较忽略首尾/连续空白差异（宿主可能重排空行）", () => {
	const previous = [user("u1", "旧"), pending("req-1", "第一行\n\n第二行")];
	const snapshot = [user("u1", "旧"), user("dsh:10", "  第一行 第二行  ")];
	assert.deepEqual(ids(carryPendingUserMessages(previous, snapshot)), ["u1", "dsh:10"]);
});

test("没有 pending 标记的普通用户消息不受影响（宿主投影永远不会被误判）", () => {
	const previous = [user("u1", "旧问题")];
	const snapshot = [user("u1", "旧问题"), errorMessage("dsh:2", "boom")];
	assert.deepEqual(ids(carryPendingUserMessages(previous, snapshot)), ["u1", "dsh:2"]);
});

test("多次快照连续到达：气泡锚在同一位置，不随刷新漂移", () => {
	const history = [user("u1", "旧"), assistant("a1", "旧答")];
	const previous = [...history, pending("req-1", "新问题")];
	let current = carryPendingUserMessages(previous, [...history, errorMessage("dsh:9", "boom")]);
	assert.deepEqual(ids(current), ["u1", "a1", "req-1", "dsh:9"]);
	// 下一条快照（宿主又追加了状态卡）仍要保留，且位置不变
	current = carryPendingUserMessages(current, [...history, errorMessage("dsh:9", "boom"), errorMessage("dsh:12", "again")]);
	assert.deepEqual(ids(current), ["u1", "a1", "req-1", "dsh:9", "dsh:12"]);
});

test("投递被拒：按 requestId 撤掉乐观气泡（文字已回填草稿）", () => {
	const messages = [user("u1", "旧"), pending("req-1", "新问题"), assistant("a1", "答")];
	assert.deepEqual(ids(removePendingUserMessages(messages, "req-1")), ["u1", "a1"]);
	assert.deepEqual(ids(removePendingUserMessages(messages, "req-2")), ["u1", "req-1", "a1"]);
});

test("接线：快照两条路径都接管；发送路径写标记并在拒绝时撤销", () => {
	const sessionAtoms = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");
	const send = readFileSync("src/renderer/src/hooks/useSessionSend.ts", "utf8");
	// 全量窗口段替换 + 增量 flush 合并都必须走同一套接管逻辑
	assert.equal((sessionAtoms.match(/carryPendingUserMessages\(/gu) ?? []).length, 3, "函数定义 + 两条快照路径");
	// 乐观气泡带标记（两处发布点）
	assert.equal((send.match(/pendingUserMessage: true, requestId/gu) ?? []).length, 2);
	// 拒绝路径撤气泡（ensureSessionId 失败 / prepareMessage 失败 / 空模板 / 宿主拒绝）
	assert.ok((send.match(/dropPendingUserMessage\(/gu) ?? []).length >= 4);
});
