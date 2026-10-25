import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * AgentManager 成功 settled 事件契约（本次宠物提醒改造新增的 onAgentSettled 订阅点）。
 * 源码级断言：防止「abort 被误报为完成」的回归 —— abort 路径（recentlyAborted 或
 * abort settled 兜底定时器（AbortStreamGateController.hasSettledFallback 命中）不得触发 notifyAgentSettled。
 */

const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");

test("settled branch distinguishes abort settled from real completion", () => {
	assert.match(source, /const isAbortSettled\s*=\s*[\s\S]{0,120}recentlyAborted\.has\(agentId\)[\s\S]{0,120}abortGate\.hasSettledFallback\(agentId\)/);
});

test("notifyAgentSettled is only emitted for non-abort settled completions", () => {
	assert.match(source, /if \(!isAbortSettled\) this\.notifyAgentSettled\(agentId, runtime\.tab\.title\);/);
});

test("notifyAgentSettled has exactly two call sites: settled and get_state fallback", () => {
	const calls = source.match(/this\.notifyAgentSettled\(/g) ?? [];
	assert.equal(calls.length, 2);
});

test("markIdle fallback path also notifies settled after confirming no work", () => {
	assert.match(source, /兜底确认无工作也算成功空闲[\s\S]{0,80}this\.notifyAgentSettled\(agentId, runtime\.tab\.title\);/);
});
