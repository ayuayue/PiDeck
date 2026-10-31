/**
 * 瞬时失败分类器单测。
 *
 * 断言用真实生产日志里的错误文本（magpie 网关 / undici / 网关回 HTML），
 * 而不是编造的样例：这些正是 pi 白名单认不出、导致「任务直接停止」的那批。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { classifyFailure, isTransientFailure, failureMessage } = loadTsCommonJs("src/shared/retry/transientFailure.ts");

/** 分类结果来自 vm 沙箱，跨 realm 的对象原型不同：摊平成字面量再比对。 */
const verdictOf = (input) => ({ ...classifyFailure(input) });

/** [错误文本, 期望 kind, 期望是否重试] */
const CASES = [
	// 断连：undici / Node 传输层的真实文案
	["upstream request failed: read ECONNRESET", "network", true],
	["Error: connect ECONNREFUSED 127.0.0.1:7890", "network", true],
	["write EPIPE", "network", true],
	["UND_ERR_SOCKET: other side closed", "network", true],
	["premature close", "stream", true],
	["socket hang up", "stream", true],
	["fetch failed", "stream", true],
	["ACP connection closed before response", "stream", true],
	["acp agent stdout ended", "unknown", true],
	// 网关半截响应
	["Unexpected token '<', \"<html>502 Bad Gateway</html>\" is not valid JSON", "stream", true],
	["Unexpected end of JSON input", "stream", true],
	["empty response from provider", "stream", true],
	["502 Bad Gateway", "gateway", true],
	["Bad Gateway", "gateway", true],
	["upstream request failed", "gateway", true],
	["overloaded_error", "gateway", true],
	// 限流：magpie 的真实 429 文案（pi 日志里连试 50 次的那条）
	[
		'429: {"code":null,"message":"wb: {\\"code\\":6000,\\"msg\\":\\"您的使用量已超出频率限制，将在 2026-10-23 13:38:09 UTC+8 重置\\"}",' +
			'"type":"rate_limit_error"}',
		"rate-limit",
		true,
	],
	["rate limit exceeded, please retry later", "rate-limit", true],
	["request timed out after 60000ms", "timeout", true],
	// 终局：重试只是拖长失败
	["insufficient_quota", "quota", false],
	["402 Payment Required: 余额不足", "quota", false],
	["401 Unauthorized: invalid api key", "auth", false],
	["403 Forbidden", "auth", false],
	["maximum context length exceeded", "context-overflow", false],
	["400 Bad Request: invalid parameter temperature", "invalid-request", false],
	["404 model not found", "invalid-request", false],
	["self-signed certificate in certificate chain", "tls", false],
];

for (const [message, kind, retry] of CASES) {
	test(`classifyFailure(${JSON.stringify(message.slice(0, 48))}) → ${kind}/${retry ? "retry" : "fatal"}`, () => {
		const verdict = classifyFailure({ message });
		assert.equal(verdict.kind, kind, `kind 判定: ${message}`);
		assert.equal(verdict.retry, retry, `是否重试: ${message}`);
		assert.equal(isTransientFailure({ message }), retry);
	});
}

test("classifyFailure:HTTP 状态码优先于文本，但 5xx 仍先走终局规则", () => {
	assert.deepEqual(verdictOf({ message: "whatever", status: 503 }), { retry: true, kind: "gateway", reason: "status:503" });
	assert.deepEqual(verdictOf({ message: "whatever", status: 429 }), { retry: true, kind: "rate-limit", reason: "status:429" });
	assert.deepEqual(verdictOf({ message: "whatever", status: 408 }), { retry: true, kind: "timeout", reason: "status:408" });
	// 网关回 500 但 body 是额度耗尽：重试没意义，终局规则赢
	assert.equal(classifyFailure({ message: "insufficient_quota", status: 500 }).retry, false);
	assert.equal(classifyFailure({ message: "whatever", status: 422 }).kind, "invalid-request");
});

test("classifyFailure:用户主动中止永不重试", () => {
	assert.deepEqual(verdictOf({ message: "read ECONNRESET", cancelled: true }), { retry: false, kind: "cancelled", reason: "cancelled" });
});

test("classifyFailure:认不出的错误默认允许重试(调用方只在无产出时重试，成本可控)", () => {
	assert.deepEqual(verdictOf({ message: "something nobody has seen before" }), { retry: true, kind: "unknown", reason: "unclassified" });
	assert.equal(classifyFailure({ message: "" }).retry, true);
});

test("failureMessage:Error 取 message、null 不留 \"null\" 字面量", () => {
	assert.equal(failureMessage(new Error("read ECONNRESET")), "read ECONNRESET");
	assert.equal(failureMessage("plain"), "plain");
	assert.equal(failureMessage(null), "");
	assert.equal(failureMessage(undefined), "");
	assert.equal(failureMessage({ code: 1 }), "[object Object]");
});
