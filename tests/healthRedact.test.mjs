/**
 * 环境诊断的隐私核心：redact.ts 脱敏纯函数。
 *
 * 隐私红线是「宁可多脱敏，不可少脱敏」——报告一旦漏掉 API Key / home 路径 / 邮箱
 * 就是不可逆泄露。用测试锁定这些规则，防止未来改动让某个规则失效。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { REDACTED, REDACTED_EMAIL, REDACTED_PHONE, createPathMasker, redactForReport, redactSecrets, truncateText } = loadTsCommonJs("src/main/health/redact.ts");

test("redactSecrets masks API keys with common prefixes", () => {
	// sk- 前缀保留可读性，凭据本体脱敏
	assert.equal(redactSecrets("key=sk-abcdef1234567890"), `key=sk-${REDACTED}`);
	assert.equal(redactSecrets("Bearer aBcDeFgHiJkLmNoPqRsTuV"), `Bearer ${REDACTED}`);
	assert.equal(redactSecrets("Authorization: github_pat_1234567890123456789012345678"), `Authorization: ${REDACTED}`);
	assert.ok(!redactSecrets("sk-abcdef1234567890").includes("abcdef1234567890"));
});

test("redactSecrets masks structured key/value fields", () => {
	assert.equal(redactSecrets('"apiKey": "secret-value"'), `"apiKey": ${REDACTED}`);
	assert.equal(redactSecrets("apiKey=mysecrettoken123"), `apiKey=${REDACTED}`);
	assert.equal(redactSecrets("token=mysecrettoken123"), `token=${REDACTED}`);
	assert.equal(redactSecrets("password: hunter2"), `password: ${REDACTED}`);
	// 空值不该被替换：常见占位符如 "token": "" 保持不变
	assert.equal(redactSecrets('"token": ""'), '"token": ""');
});

test("redactSecrets masks emails and phone numbers", () => {
	assert.equal(redactSecrets("contact me at user@example.com"), `contact me at ${REDACTED_EMAIL}`);
	assert.equal(redactSecrets("call 13812345678 now"), `call ${REDACTED_PHONE} now`);
});

test("createPathMasker replaces home directory with ~", () => {
	const mask = createPathMasker("C:/Users/john");
	assert.equal(mask("C:/Users/john/AppData/Roaming/PiDeck"), "~/AppData/Roaming/PiDeck");
	// 兜底规则：非 home 的其他用户路径也脱敏
	const result = mask("D:/Users/someone/foo");
	assert.ok(!result.includes("someone"));
});

test("createPathMasker masks /Users/<name> and /home/<name> skeletons", () => {
	const mask = createPathMasker("/home/alice");
	assert.equal(mask("/home/alice/.pi/agent"), "~/.pi/agent");
	assert.equal(mask("/home/bob/.config"), "/home/<user>/.config");
	assert.equal(mask("/Users/carol/Documents"), "/Users/<user>/Documents");
});

test("redactForReport composes path mask then secret redact", () => {
	const out = redactForReport("log at C:/Users/jane/AppData with key=sk-abcdef1234567890", "C:/Users/jane");
	assert.ok(!out.includes("jane"));
	assert.ok(!out.includes("abcdef1234567890"));
});

test("truncateText keeps short text and truncates long text", () => {
	assert.equal(truncateText("short", 100), "short");
	const long = "a".repeat(500);
	const out = truncateText(long, 100);
	assert.ok(out.length <= 100);
	assert.ok(out.endsWith("…"));
});
