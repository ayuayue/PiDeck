import assert from "node:assert/strict";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();

/** 造一份只读绑定表：SESSION 一个会话，代号 1。 */
function makeBinding() {
	const { RuntimeBinding } = load("src/main/sessions/runtime/runtimeBinding.ts");
	const sessionIdByAgent = new Map([["agent-A", "session-A"]]);
	const agentIdBySession = new Map([["session-A", "agent-A"]]);
	const generationBySession = new Map([["session-A", 1]]);
	return new RuntimeBinding({ get: () => ({ id: "session-A" }) }, sessionIdByAgent, agentIdBySession, generationBySession);
}

/**
 * 事故形状（2026-11-16，PR #552 评审指出，实测确认）：
 * 文档曾说 target 的两个字段都校验，传错 generation 一律 SESSION_RUNTIME_CHANGED。
 * 实际 stop 走 resolveStopTarget，只要有 live 绑定就取当前代号，不比对请求里的值：
 * 传 999 仍返回 ok:true 并真把目标停下。restart / model 才走 requireBoundTarget 严格比对。
 * 文档已按实现改；这三条测试把语义钉住，防止以后改实现时文档与行为再次分叉。
 */

test("stop 的目标规范化：live agentId + 错误 generation 不抛，取当前代号", () => {
	const b = makeBinding();
	const stopTarget = b.resolveStopTarget({ sessionId: "session-A", agentId: "agent-A", runtimeGeneration: 999 });
	assert.equal(stopTarget.runtimeGeneration, 1, "应取 live 绑定里的当前代号，而不是请求里那个");
	assert.equal(stopTarget.agentId, "agent-A");
});

test("stop 停的是 agentId 指向的会话，不是 URL 里的 sessionId", () => {
	const b = makeBinding();
	const stopTarget = b.resolveStopTarget({ sessionId: "session-B", agentId: "agent-A", runtimeGeneration: 1 });
	assert.equal(stopTarget.sessionId, "session-A", "agentId 更权威：它会覆盖请求里的 sessionId");
});

test("restart / model 这类命令的目标校验：generation 传错直接拒", () => {
	const b = makeBinding();
	assert.throws(
		() => b.requireBoundTarget({ sessionId: "session-A", agentId: "agent-A", runtimeGeneration: 999 }),
		(error) => error.code === "SESSION_RUNTIME_CHANGED",
		"非 stop 的命令必须比对代号，传错返回 SESSION_RUNTIME_CHANGED",
	);
});

test("stop 的 agentId 没有 live 绑定时报不可用，不误停别人", () => {
	const b = makeBinding();
	assert.throws(
		() => b.resolveStopTarget({ sessionId: "session-A", agentId: "agent-ghost", runtimeGeneration: 1 }),
		(error) => error.code === "SESSION_RUNTIME_UNAVAILABLE",
	);
});
