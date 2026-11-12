import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { sessionIpcSource } from "./helpers/sessionIpcSources.mjs";

const { composeAgentInstruction, shouldInjectAgentPersona } = loadTsCommonJs("src/main/agents/agentPersonaInstruction.ts");
const sessionIpc = sessionIpcSource;

/** 生产模块在 vm 沙箱里创建的对象原型属于另一个 realm，深度比较前转成本 realm 的普通对象。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

test("blank persona leaves both the visible message and any hidden payload untouched", () => {
	assert.deepEqual(plain(composeAgentInstruction({ persona: "", message: "你好", backend: undefined })), { message: "你好" });
	assert.deepEqual(plain(composeAgentInstruction({ persona: "  \n\t ", message: "你好", backend: "dsh" })), { message: "你好" });
	// 计划模式等用法依赖 agentMessage 传隐藏标记：没有角色设定时不能把它丢掉。
	assert.deepEqual(plain(composeAgentInstruction({ persona: "", message: "你好", existingAgentMessage: "PLAN_MARKER", backend: "pi" })), { message: "你好", agentMessage: "PLAN_MARKER" });
});

test("pi (and unspecified backend) keeps the visible message and prepends the persona to the hidden payload", () => {
	const composed = plain(composeAgentInstruction({ persona: "你是审查员", message: "看看这段代码", backend: "pi" }));
	assert.deepEqual(composed, { message: "看看这段代码", agentMessage: "你是审查员\n\n看看这段代码" });
	// 缺省后端（旧会话记录没有 backend）按 pi 处理：隐藏通道是既有行为。
	assert.deepEqual(plain(composeAgentInstruction({ persona: "你是审查员", message: "看看这段代码", backend: undefined })), composed);
});

test("existing hidden payload is prefixed, not replaced, so plan/goal markers survive", () => {
	const composed = plain(composeAgentInstruction({ persona: "你是审查员", message: "看看这段代码", existingAgentMessage: "PLAN_MODE\n\n看看这段代码", backend: "pi" }));
	assert.equal(composed.message, "看看这段代码");
	assert.equal(composed.agentMessage, "你是审查员\n\nPLAN_MODE\n\n看看这段代码");
});

test("dsh falls back to a visible prefix and never sends agentMessage", () => {
	const composed = plain(composeAgentInstruction({ persona: "你是审查员", message: "看看这段代码", backend: "dsh" }));
	assert.deepEqual(composed, { message: "你是审查员\n\n看看这段代码" });
	// DSH host 见到 agentMessage 会拒收整条 prompt：调用方已带的隐藏载荷也必须丢弃。
	assert.equal("agentMessage" in composed, false);
	assert.deepEqual(plain(composeAgentInstruction({ persona: "你是审查员", message: "看看这段代码", existingAgentMessage: "PLAN_MODE", backend: "dsh" })), { message: "你是审查员\n\n看看这段代码" });
});

test("acp keeps the hidden channel (acpTurnSettlement supports agentMessage)", () => {
	assert.deepEqual(plain(composeAgentInstruction({ persona: "你是翻译", message: "hello", backend: "acp" })), { message: "hello", agentMessage: "你是翻译\n\nhello" });
	// 生图/生视频等非对话后端同样按「有隐藏通道」处理，由各自发送链路忽略该字段。
	assert.equal(composeAgentInstruction({ persona: "你是翻译", message: "hello", backend: "imagegen" }).agentMessage, "你是翻译\n\nhello");
});

test("persona is trimmed but internal line structure is preserved", () => {
	const composed = plain(composeAgentInstruction({ persona: "\n  第一行\n第二行  \n\n", message: "正文", backend: "pi" }));
	assert.equal(composed.agentMessage, "第一行\n第二行\n\n正文");
	assert.equal(composed.message, "正文");
});

test("unicode persona and message are concatenated verbatim without rewriting", () => {
	const persona = "你是 PiDeck 的翻译官：只输出译文。";
	const message = "Give me a pen.";
	const composed = composeAgentInstruction({ persona, message, backend: "pi" });
	assert.equal(composed.agentMessage, `${persona}\n\n${message}`);
	assert.equal(composed.message, message);
});

test("persona is injected on the session's first turn only", () => {
	assert.equal(shouldInjectAgentPersona({ sessionStatus: "draft", alreadyInjected: false }), true, "新会话首轮必须注入");
	assert.equal(shouldInjectAgentPersona({ sessionStatus: "active", alreadyInjected: false }), false, "首条已落盘后不得重复注入");
	assert.equal(shouldInjectAgentPersona({ sessionStatus: "draft", alreadyInjected: true }), false, "draft→active 回写前已注入过也不得重拼");
	assert.equal(shouldInjectAgentPersona({ sessionStatus: "active", alreadyInjected: true }), false);
	assert.equal(shouldInjectAgentPersona({ sessionStatus: undefined, alreadyInjected: false }), false, "没有 catalog 记录时保守不注入");
});

test("sessionsSendPrompt still strips hidden payloads from every bound DSH send", () => {
	const dshFallback = sessionIpc.match(/if \(persona && boundRecord\?\.backend === "dsh"\) \{\s*if \(promptInput === input\) promptInput = \{ \.\.\.input \};\s*delete promptInput\.agentMessage;\s*\}/);
	assert.ok(dshFallback, "后续 DSH 发送也必须删除 agentMessage，避免 host 拒收");
	const firstTurnComposition = sessionIpc.indexOf("if (persona && boundRecord && injectPersona) {");
	assert.ok(firstTurnComposition >= 0 && dshFallback.index > firstTurnComposition, "隐藏载荷清理不能受首轮注入门禁限制");
});

/* ── 发送前收口 applyBoundAgentPersona（桌面 IPC 与 Web 服务两个入口共用） ── */

const { applyBoundAgentPersona } = loadTsCommonJs("src/main/agents/agentPersonaInstruction.ts");

test("applyBoundAgentPersona: unbound session leaves the payload untouched", () => {
	const prompt = { sessionId: "s1", requestId: "r1", message: "你好" };
	const result = plain(applyBoundAgentPersona({ prompt, persona: undefined, sessionStatus: "draft", backend: "pi", alreadyInjected: false }));
	assert.deepEqual(result, { prompt, injected: false });
	assert.equal(applyBoundAgentPersona({ prompt, persona: "   ", sessionStatus: "draft", backend: "pi", alreadyInjected: false }).injected, false, "空白人设不算绑定");
});

test("applyBoundAgentPersona: first draft turn injects persona into the hidden payload and keeps request fields", () => {
	const result = applyBoundAgentPersona({ prompt: { sessionId: "s1", requestId: "r1", message: "看看这段" }, persona: "你是审查员", sessionStatus: "draft", backend: "pi", alreadyInjected: false });
	assert.equal(result.injected, true);
	assert.equal(result.prompt.sessionId, "s1", "收口只改载荷，不能丢 request 元数据");
	assert.equal(result.prompt.requestId, "r1");
	assert.equal(result.prompt.message, "看看这段");
	assert.equal(result.prompt.agentMessage, "你是审查员\n\n看看这段");
});

test("applyBoundAgentPersona: later turns and already-injected drafts are not re-injected", () => {
	const prompt = { sessionId: "s1", message: "第二轮" };
	assert.equal(applyBoundAgentPersona({ prompt, persona: "你是审查员", sessionStatus: "active", backend: "pi", alreadyInjected: false }).injected, false);
	assert.deepEqual(plain(applyBoundAgentPersona({ prompt, persona: "你是审查员", sessionStatus: "active", backend: "pi", alreadyInjected: false }).prompt), prompt);
	// 首条已被接受、catalog 的 draft→active 还没回写：内存标记挡住重复注入
	assert.equal(applyBoundAgentPersona({ prompt, persona: "你是审查员", sessionStatus: "draft", backend: "pi", alreadyInjected: true }).injected, false);
	// 没有 catalog 记录时保守不注入
	assert.equal(applyBoundAgentPersona({ prompt, persona: "你是审查员", sessionStatus: undefined, backend: "pi", alreadyInjected: false }).injected, false);
});

test("applyBoundAgentPersona: DSH never carries agentMessage, even after the first turn", () => {
	const composed = applyBoundAgentPersona({ prompt: { message: "正文", agentMessage: "PLAN_MARKER" }, persona: "你是审查员", sessionStatus: "draft", backend: "dsh", alreadyInjected: false });
	assert.equal(composed.injected, true);
	assert.equal(composed.prompt.message, "你是审查员\n\n正文");
	assert.equal("agentMessage" in composed.prompt, false, "host 见到 agentMessage 会拒收整条 prompt");

	// 已注入过（后续轮次）也要清理调用方带来的隐藏标记
	const later = applyBoundAgentPersona({ prompt: { message: "第二轮", agentMessage: "PLAN_MARKER" }, persona: "你是审查员", sessionStatus: "active", backend: "dsh", alreadyInjected: true });
	assert.equal(later.injected, false);
	assert.equal("agentMessage" in later.prompt, false);
	assert.equal(later.prompt.message, "第二轮");
});

test("applyBoundAgentPersona: plan-mode hidden payload survives the pi first turn", () => {
	const result = applyBoundAgentPersona({ prompt: { message: "只分析", agentMessage: "PLAN_MODE\n\n只分析" }, persona: "你是审查员", sessionStatus: "draft", backend: "pi", alreadyInjected: false });
	assert.equal(result.prompt.agentMessage, "你是审查员\n\nPLAN_MODE\n\n只分析", "人设前置而不是覆盖计划模式标记");
});
