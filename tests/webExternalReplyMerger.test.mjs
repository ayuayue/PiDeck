import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// ExternalReplyMerger 是 webExternalStream.ts 的纯函数部分（hook 不在 Node 测试范围）。
// 模块顶层 import react 与 webApi（window 有 typeof 守卫），在 VM 沙箱可正常加载。
const { ExternalReplyMerger } = loadTsCommonJs("src/renderer/src/web/webExternalStream.ts");

function frame(type, extra = {}) {
	return { type, ...extra };
}

test("merger streams text deltas into a single assistant message", () => {
	const merger = new ExternalReplyMerger();
	assert.equal(merger.hasContent(), false);
	merger.applyFrame(frame("start", { messageId: "m1" }));
	merger.applyFrame(frame("text-start"));
	merger.applyFrame(frame("text-delta", { delta: "你好" }));
	merger.applyFrame(frame("text-delta", { delta: "，世界" }));

	const snapshot = merger.snapshot();
	assert.equal(snapshot.message.id, "m1");
	assert.equal(snapshot.message.role, "assistant");
	assert.deepEqual([...snapshot.message.parts.filter((part) => part.type === "text").map((part) => `${part.text}`)], ["你好，世界"]);
	assert.equal(snapshot.finished, false);
	assert.equal(merger.hasContent(), true);
});

test("merger renders reasoning blocks with streaming state transitions", () => {
	const merger = new ExternalReplyMerger();
	merger.applyFrame(frame("start", { messageId: "m1" }));
	merger.applyFrame(frame("reasoning-start"));
	merger.applyFrame(frame("reasoning-delta", { delta: "想一想" }));
	let reasoning = merger.snapshot().message.parts.find((part) => part.type === "reasoning");
	assert.equal(reasoning.state, "streaming");

	merger.applyFrame(frame("reasoning-end"));
	reasoning = merger.snapshot().message.parts.find((part) => part.type === "reasoning");
	assert.equal(reasoning.state, "done");

	// 结束后再到的新 reasoning 块仍是独立 part（工具循环多跳场景）
	merger.applyFrame(frame("reasoning-start"));
	merger.applyFrame(frame("reasoning-delta", { delta: "再想想" }));
	const reasoningParts = merger.snapshot().message.parts.filter((part) => part.type === "reasoning");
	assert.equal(reasoningParts.length, 2);
});

test("merger maps tool frames to dynamic-tool parts matching WebTimeline consumption", () => {
	const merger = new ExternalReplyMerger();
	merger.applyFrame(frame("start", { messageId: "m1" }));
	merger.applyFrame(frame("tool-input-start", { toolCallId: "call-1", toolName: "bash" }));
	let tool = merger.snapshot().message.parts.find((part) => part.type === "dynamic-tool");
	assert.equal(tool.state, "input-streaming");

	merger.applyFrame(frame("tool-input-available", { toolCallId: "call-1", toolName: "bash", input: { command: "ls" } }));
	tool = merger.snapshot().message.parts.find((part) => part.type === "dynamic-tool");
	assert.equal(tool.state, "input-available");

	merger.applyFrame(frame("tool-output-available", { toolCallId: "call-1", output: { stdout: "ok" } }));
	tool = merger.snapshot().message.parts.find((part) => part.type === "dynamic-tool");
	assert.equal(tool.state, "output-available");
	assert.equal(JSON.stringify(tool.output), JSON.stringify({ stdout: "ok" }));
});

test("merger deduplicates repeated tool input frames and settles terminal tool states", () => {
	const merger = new ExternalReplyMerger();
	merger.applyFrame(frame("start", { messageId: "m1" }));
	// 重连/重放场景：同一 toolCallId 的 input 帧重复到达不得生成第二张工具卡
	merger.applyFrame(frame("tool-input-available", { toolCallId: "call-1", toolName: "read" }));
	merger.applyFrame(frame("tool-input-available", { toolCallId: "call-1", toolName: "read" }));
	merger.applyFrame(frame("tool-output-error", { toolCallId: "call-1", errorText: "boom" }));
	// 已 settle 的工具卡再收到 input 帧也不得拍回 running
	merger.applyFrame(frame("tool-input-available", { toolCallId: "call-1", toolName: "read" }));

	const parts = merger.snapshot().message.parts.filter((part) => part.type === "dynamic-tool");
	assert.equal(parts.length, 1);
	assert.equal(parts[0].state, "output-error");
	assert.equal(parts[0].errorText, "boom");
});

test("merger closes open blocks on finish and ignores frames after finish", () => {
	const merger = new ExternalReplyMerger();
	merger.applyFrame(frame("start", { messageId: "m1" }));
	merger.applyFrame(frame("reasoning-start"));
	merger.applyFrame(frame("reasoning-delta", { delta: "尾部思考" }));
	merger.applyFrame(frame("text-start"));
	merger.applyFrame(frame("text-delta", { delta: "答案" }));
	merger.applyFrame(frame("finish"));

	let snapshot = merger.snapshot();
	assert.equal(snapshot.finished, true);
	assert.equal(snapshot.message.parts.find((part) => part.type === "reasoning").state, "done");
	// finish 后迟到帧不再生效
	snapshot = merger.applyFrame(frame("text-delta", { delta: "迟到" }));
	assert.equal(snapshot.message.parts.find((part) => part.type === "text").text, "答案");
});

test("merger captures error frame as errorText and finishes the stream", () => {
	const merger = new ExternalReplyMerger();
	merger.applyFrame(frame("start", { messageId: "m1" }));
	merger.applyFrame(frame("text-delta", { delta: "部分输出" }));
	const snapshot = merger.applyFrame(frame("error", { errorText: "provider down" }));
	assert.equal(snapshot.finished, true);
	assert.equal(snapshot.errorText, "provider down");
});

test("merger resets between runs", () => {
	const merger = new ExternalReplyMerger();
	merger.applyFrame(frame("start", { messageId: "m1" }));
	merger.applyFrame(frame("text-delta", { delta: "第一轮" }));
	merger.applyFrame(frame("finish"));
	merger.reset();

	assert.equal(merger.hasContent(), false);
	assert.equal(merger.snapshot(), null);
	merger.applyFrame(frame("start", { messageId: "m2" }));
	merger.applyFrame(frame("text-delta", { delta: "第二轮" }));
	const snapshot = merger.snapshot();
	assert.equal(snapshot.message.id, "m2");
	assert.deepEqual([...snapshot.message.parts.filter((part) => part.type === "text").map((part) => `${part.text}`)], ["第二轮"]);
});

test("merger tolerates deltas before start frame", () => {
	const merger = new ExternalReplyMerger();
	merger.applyFrame(frame("text-delta", { delta: "无 start 帧" }));
	const snapshot = merger.snapshot();
	assert.equal(typeof snapshot.message.id, "string");
	assert.equal(snapshot.message.parts.find((part) => part.type === "text").text, "无 start 帧");
});
