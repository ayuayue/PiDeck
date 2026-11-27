import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildTurnDisplay, resolveLiveThinkingMessageId } = loadTsCommonJs("src/renderer/src/components/session/timeline/buildTurnDisplay.ts");
const { resolveLiveThinkingKey } = loadTsCommonJs("src/renderer/src/components/session/timeline/liveMount.ts");

/**
 * Live 思考段的归属判据（2026-11-26 真机「会话思考不见了」）。
 *
 * 现象：流式期间那一轮只显示一行空思考，正文与耗时都没有；落盘后同一个问题消失
 * （历史消息自带 thinking）。日志侧只能看到 `agents:thinking` 事件在推，界面没内容。
 *
 * 成因：主进程 live 段 id = `msg-thinking-<运行期 uuid>`，渲染层消息 id 可能是投影 id
 * `<agentId>-history-<entryId>`。旧实现要求两者**全等**才挂载思考步，于是流式期间
 * 思考整段不挂载、或挂上了但拿 group.id 查 live atom 永远是空。
 */
const run = (items) => ({ kind: "agent-run", id: "run-1", items, startedAt: 1, endedAt: 2, askWaitMs: 0, askPending: false });
const assistant = (id, extra = {}) => ({ kind: "message", message: { id, agentId: "a1", role: "assistant", text: "", timestamp: 1, ...extra } });

test("① id 全等命中：live 段归到那一条（正常情形，行为不变）", () => {
	const items = [assistant("m1"), assistant("m2")];
	assert.equal(resolveLiveThinkingMessageId(items, "msg-thinking-m2"), "m2");
	// 即使本轮已结束也认：这是同一个身份，不是猜的
	assert.equal(resolveLiveThinkingMessageId(items, "msg-thinking-m2", { isComplete: true }), "m2");
});

test("② id 不同形 + 本轮未结束：归到本轮最后一条 assistant（流式期间思考必须可见）", () => {
	// 反例：旧实现只比对 msg-thinking-<消息 id>，这里会返回 undefined → 思考步根本不挂
	const items = [assistant("agent-1-history-e1"), assistant("agent-1-history-e2")];
	const liveId = "msg-thinking-3f7c9a10-0b4d-4f2e-9d55-2c0b9e77a111";
	assert.equal(resolveLiveThinkingMessageId(items, liveId, { isComplete: false }), "agent-1-history-e2");
});

test("③ id 不同形 + 本轮已结束：不挂（宁可没有，也不把上一轮残留显示成本轮思考）", () => {
	const items = [assistant("agent-1-history-e1")];
	const liveId = "msg-thinking-3f7c9a10-0b4d-4f2e-9d55-2c0b9e77a111";
	assert.equal(resolveLiveThinkingMessageId(items, liveId, { isComplete: true }), undefined);
	assert.equal(resolveLiveThinkingMessageId(items, liveId), undefined, "缺省按已结束处理（保守）");
});

test("④ 本轮没有 assistant 消息：返回 undefined，不猜", () => {
	const items = [{ kind: "tool-group", id: "t1", messages: [] }];
	assert.equal(resolveLiveThinkingMessageId(items, "msg-thinking-uuid", { isComplete: false }), undefined);
});

test("⑤ 挂上之后 body 带 liveId：叶子靠它查正文，不靠 thinkingId 拼", () => {
	// 这是「挂上了也是空行」的那一半：group.id 仍是 msg-thinking-<消息 id>（Live→History 不 remount），
	// 真正取正文用的 id 必须一起交下去。
	const liveId = "msg-thinking-3f7c9a10-0b4d-4f2e-9d55-2c0b9e77a111";
	const items = buildTurnDisplay(run([assistant("agent-1-history-e1")]), { showThinking: true, isComplete: false, liveThinkingId: liveId });
	const entry = items.find((item) => item.kind === "process-entry" && item.entry.kind === "thinking-entry");
	assert.ok(entry, "流式中必须挂出思考步");
	assert.equal(entry.entry.liveId, liveId, "liveId 必须交给叶子（否则查不到流式正文）");
	assert.equal(entry.entry.id, "msg-thinking-agent-1-history-e1", "稳定 id 保持 msg-thinking-<消息 id>，与历史同身份");
});

test("⑥ 已结束时同一条被历史接管：不带 liveId，正文来自消息自身", () => {
	const items = buildTurnDisplay(run([assistant("agent-1-history-e1", { thinking: "落盘的思考正文" })]), { showThinking: true, isComplete: true, liveThinkingId: "msg-thinking-uuid" });
	const entry = items.find((item) => item.kind === "process-entry" && item.entry.kind === "thinking-entry");
	assert.ok(entry);
	assert.equal(entry.entry.liveId, undefined, "结束后不得继续挂 live 通道");
	assert.equal(entry.entry.group.text, "落盘的思考正文");
});

test("⑦ 叶子取正文的键：liveId 优先于 group.id（后者只是拼接猜测）", () => {
	// 反例：叶子只用 group.id 时，chart 上挂着的思考步永远查到空 —— 界面就是一行空思考。
	const liveId = "msg-thinking-3f7c9a10-0b4d-4f2e-9d55-2c0b9e77a111";
	assert.equal(resolveLiveThinkingKey({ liveId, groupId: "msg-thinking-agent-1-history-e1" }), liveId);
	assert.equal(resolveLiveThinkingKey({ groupId: "msg-thinking-m1" }), "msg-thinking-m1", "没有 liveId 时回退 group.id（历史轮）");
	assert.equal(resolveLiveThinkingKey({ liveId: "  ", groupId: "msg-thinking-m1" }), "msg-thinking-m1", "空白 liveId 不算命中");
});
