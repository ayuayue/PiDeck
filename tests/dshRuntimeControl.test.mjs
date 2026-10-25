import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { applyDshControlEvent, beginDshCancel } = loadTsCommonJs("src/main/dsh/dshRuntimeControl.ts");

const idle = () => ({
	status: "idle",
	isStreaming: false,
	cancelGeneration: 0,
	cancelled: false,
});

test("turn/start 把 DSH 标成 running，turn/end 必须回到 idle", () => {
	let state = idle();
	state = applyDshControlEvent(state, "turn/start", 0).next;
	assert.equal(state.status, "running");
	assert.equal(state.isStreaming, true);
	state = applyDshControlEvent(state, "turn/end", 0).next;
	assert.equal(state.status, "idle");
	assert.equal(state.isStreaming, false);
});

test("assistant/message 带 tool-call 块不是回合终点：保持 running，只收流式标记", () => {
	// DSH 事件顺序：LLM 流结束先落 assistant/message（内容含 tool-call），
	// 之后才是 tool/call → 工具执行 → tool/result → 下一轮 LLM 流。
	// 若此时回 idle，工具执行期间 UI 提前显示空闲（发送按钮/无动画），用户误以为已停止。
	let state = applyDshControlEvent(idle(), "turn/start", 0).next;
	state = applyDshControlEvent(state, "assistant/message", 0, {
		message: {
			content: [
				{ type: "text", text: "我先看一下。" },
				{ type: "tool-call", id: "call-1", name: "pwsh", arguments: {} },
			],
		},
	}).next;
	assert.equal(state.status, "running");
	assert.equal(state.isStreaming, false);
	assert.equal(state.cancelled, false);
});

test("assistant/message 无 tool-call（终态答复）回 idle", () => {
	let state = applyDshControlEvent(idle(), "turn/start", 0).next;
	state = applyDshControlEvent(state, "assistant/message", 0, {
		message: { content: [{ type: "text", text: "完成了。" }] },
	}).next;
	assert.equal(state.status, "idle");
	assert.equal(state.isStreaming, false);
});

test("assistant/message 无 message/content 结构时保守按终态处理（回 idle）", () => {
	let state = applyDshControlEvent(idle(), "turn/start", 0).next;
	state = applyDshControlEvent(state, "assistant/message", 0, {}).next;
	assert.equal(state.status, "idle");
});

test("abort 之后迟到的 chunk / turn/start 不能再点亮 streaming", () => {
	let state = applyDshControlEvent(idle(), "turn/start", 0).next;
	state = beginDshCancel(state);
	assert.equal(state.status, "idle");
	assert.equal(state.isStreaming, false);
	assert.equal(state.cancelGeneration, 1);

	const staleStart = applyDshControlEvent(state, "turn/start", 0);
	assert.equal(staleStart.ignoreStream, true);
	assert.equal(staleStart.next.isStreaming, false);
	assert.equal(staleStart.next.status, "idle");

	const staleChunk = applyDshControlEvent(state, "assistant/chunk", 0);
	assert.equal(staleChunk.ignoreStream, true);
	assert.equal(staleChunk.next.isStreaming, false);
});

test("abort 后的 turn/end（旧世代）只收口 cancelled，不重新 running", () => {
	let state = beginDshCancel(applyDshControlEvent(idle(), "turn/start", 0).next);
	const ended = applyDshControlEvent(state, "turn/end", 0);
	assert.equal(ended.next.cancelled, false);
	assert.equal(ended.next.status, "idle");
	assert.equal(ended.next.isStreaming, false);
	assert.equal(ended.ignoreStream, true);
});

// ── 停止竞态回归：cancelled 期间旧回合残留事件必须全部丢弃 ──────────────────
// 生产路径里 eventGeneration 与 prev.cancelGeneration 同代（泵在处理帧时才快照），
// 真正挡住「停止了还在跑 / 消息串台」的是 cancelled 守卫而非世代不匹配分支。

test("abort 后同世代 assistant/message 被丢弃：不投影、不清 cancelled", () => {
	let state = applyDshControlEvent(idle(), "turn/start", 0).next;
	state = beginDshCancel(state);
	const stale = applyDshControlEvent(state, "assistant/message", 1, {
		message: { content: [{ type: "text", text: "停止后的完整回答" }] },
	});
	assert.equal(stale.ignoreStream, true, "旧回合终态消息必须丢弃");
	assert.equal(stale.next.cancelled, true, "assistant/message 不得提前解除 cancelled（须等 turn/end）");
	assert.equal(stale.next.isStreaming, false);
	assert.equal(stale.next.status, "idle");
});

test("abort 后 tool/call、tool/result 被丢弃（工具卡片不再点亮）", () => {
	let state = applyDshControlEvent(idle(), "turn/start", 0).next;
	state = beginDshCancel(state);
	const call = applyDshControlEvent(state, "tool/call", 1, { toolName: "pwsh" });
	assert.equal(call.ignoreStream, true, "abort 后工具调用不得投影");
	const result = applyDshControlEvent(state, "tool/result", 1, {});
	assert.equal(result.ignoreStream, true);
	assert.equal(result.next.cancelled, true);
	assert.equal(result.next.status, "idle");
});

test("abort 后 user/message 仍放行且保持 cancelled（用户新消息文本不能丢）", () => {
	let state = applyDshControlEvent(idle(), "turn/start", 0).next;
	state = beginDshCancel(state);
	const incoming = applyDshControlEvent(state, "user/message", 1, {
		content: [{ type: "text", text: "新问题" }],
	});
	assert.equal(incoming.ignoreStream, false, "user/message 必须投影");
	assert.equal(incoming.next.cancelled, true, "cancelled 仍保持，直到 turn/end");
});

test("abort 后同世代 turn/end 收口 cancelled（与旧世代路径一致）", () => {
	let state = applyDshControlEvent(idle(), "turn/start", 0).next;
	state = beginDshCancel(state);
	const ended = applyDshControlEvent(state, "turn/end", 1);
	assert.equal(ended.next.cancelled, false);
	assert.equal(ended.next.status, "idle");
	assert.equal(ended.next.isStreaming, false);
	assert.equal(ended.ignoreStream, true);
});

test("abort 后同世代迟到 chunk 不重开 streaming", () => {
	let state = applyDshControlEvent(idle(), "turn/start", 0).next;
	state = beginDshCancel(state);
	const chunk = applyDshControlEvent(state, "assistant/chunk", 1, {
		chunk: { type: "text-delta", text: "尾" },
	});
	assert.equal(chunk.ignoreStream, true);
	assert.equal(chunk.next.isStreaming, false);
	assert.equal(chunk.next.status, "idle");
});

test("idle 时 beginDshCancel 是 no-op（cancelled 不会等不到 turn/end）", () => {
	// 回合已结束后再点停止：没有 turn/end 可等，若置 cancelled 会让后续
	// sendPrompt 的 waitForIdle 被卡满超时（每轮发送白等 30s）。
	const state = beginDshCancel(idle());
	assert.equal(state.cancelled, false);
	assert.equal(state.cancelGeneration, 0);
	assert.equal(state.status, "idle");
	assert.equal(state.isStreaming, false);
});
