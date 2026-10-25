import assert from "node:assert/strict";
import test from "node:test";
import { resolveLiveInterimId } from "../src/renderer/src/components/session/timeline/liveMount.ts";

/**
 * Live 正文挂载判定测试。
 *
 * 回归背景（2026-08）：steer 打断后，上一轮没有最终回答、尾部是空文本 interim
 * （纯工具调用消息的骨架挂载点）。旧判定只看「会话存在活动正文流 + 尾部空骨架」，
 * 不看本轮是否最后一个 agent-run——新一轮流式时旧轮也挂 live，读同一个会话级
 * 流式槽，把新一轮正文在旧轮底部再打印一遍：同一个中间回复前后同时出现两份。
 */

const base = {
	sessionId: "s1",
	lastInterimId: "msg-1",
	liveTextActive: true,
	lastMessageText: "",
	agentRunning: false,
	isStreaming: false,
	isLastAgentRun: true,
};

test("最后一个 agent-run + 空文本骨架 + 活动流 → 挂载 live（正常流式挂载点）", () => {
	assert.equal(resolveLiveInterimId(base), "msg-1");
});

test("非最后一个 agent-run + 空文本骨架 + 活动流 → 不挂载（steer 打断后的旧轮不得挂会话级流式槽）", () => {
	assert.equal(resolveLiveInterimId({ ...base, isLastAgentRun: false }), undefined);
});

test("非最后一个 agent-run 即使 agentRunning/isStreaming 也不挂载", () => {
	assert.equal(resolveLiveInterimId({ ...base, isLastAgentRun: false, agentRunning: true, isStreaming: true }), undefined);
});

test("最后一个 agent-run + 已落定正文 + 流式中 → 保持挂载", () => {
	assert.equal(resolveLiveInterimId({ ...base, lastMessageText: "已落定的正文", isStreaming: true }), "msg-1");
});

test("最后一个 agent-run + 已落定正文 + 无流式 → 不挂载（settled，落回容器内渲染）", () => {
	assert.equal(resolveLiveInterimId({ ...base, lastMessageText: "已落定的正文" }), undefined);
});

test("无活动流 → 不挂载", () => {
	assert.equal(resolveLiveInterimId({ ...base, liveTextActive: false }), undefined);
});

test("无会话 / 无挂载点 → 不挂载", () => {
	assert.equal(resolveLiveInterimId({ ...base, sessionId: undefined }), undefined);
	assert.equal(resolveLiveInterimId({ ...base, lastInterimId: undefined }), undefined);
});

test("isLastAgentRun 缺省（旧调用方未传）→ 不挂载，防御性拒绝", () => {
	assert.equal(resolveLiveInterimId({ ...base, isLastAgentRun: undefined }), undefined);
});
