import assert from "node:assert/strict";
import test from "node:test";
import { dshBillModelKey, parseDshBillLogLine } from "../src/main/usageStats/dshBillLogParser.ts";

/**
 * dsh-bill records.jsonl 行解析（防御式）。
 * 数据格式来自 dsh-bill@0.13.0：对象行，含 time/sessionId/provider/model/token 桶/usd/priced。
 */

function rec(overrides = {}) {
	return JSON.stringify({
		time: 1710000000000,
		sessionId: "session-abc",
		provider: "deepseek",
		model: "deepseek-v4-flash",
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 20,
		cacheWriteTokens: 10,
		usd: 0.0123,
		priced: true,
		...overrides,
	});
}

test("parses a priced dsh-bill line into UsageRecord", () => {
	const r = parseDshBillLogLine(rec());
	assert.deepEqual(r, {
		ts: 1710000000000,
		sid: "session-abc",
		cwd: "DSH",
		model: "deepseek/deepseek-v4-flash",
		input: 100,
		output: 50,
		cacheRead: 20,
		cacheWrite: 10,
		totalTokens: 180,
		cost: 0.0123,
		costKnown: true,
	});
});

test("priced=false keeps costKnown=false even when usd is present", () => {
	const r = parseDshBillLogLine(rec({ priced: false, usd: 0.5 }));
	assert.equal(r.costKnown, false);
	assert.equal(r.cost, 0);
});

test("missing usd is treated as unknown cost", () => {
	const raw = JSON.parse(rec());
	delete raw.usd;
	const r = parseDshBillLogLine(JSON.stringify(raw));
	assert.equal(r.costKnown, false);
	assert.equal(r.cost, 0);
});

test("does not double-prefix a model that already contains a slash", () => {
	const r = parseDshBillLogLine(rec({ provider: "openrouter", model: "openrouter/deepseek-chat" }));
	assert.equal(r.model, "openrouter/deepseek-chat");
});

test("unknown provider leaves the bare model name", () => {
	assert.equal(dshBillModelKey("unknown", "gpt-4o"), "gpt-4o");
	const r = parseDshBillLogLine(rec({ provider: "unknown", model: "gpt-4o" }));
	assert.equal(r.model, "gpt-4o");
});

test("rejects malformed JSON, arrays, and missing identity without throwing", () => {
	assert.equal(parseDshBillLogLine("not json"), null);
	assert.equal(parseDshBillLogLine("[1,2,3]"), null);
	assert.equal(parseDshBillLogLine(rec({ sessionId: "" })), null);
	assert.equal(parseDshBillLogLine(rec({ model: "" })), null);
	assert.equal(parseDshBillLogLine(rec({ time: 0 })), null);
});

test("rejects negative or non-numeric token fields", () => {
	assert.equal(parseDshBillLogLine(rec({ inputTokens: -1 })), null);
	assert.equal(parseDshBillLogLine(rec({ outputTokens: "50" })), null);
});

test("blank lines return null (reader does not count them as skipped)", () => {
	assert.equal(parseDshBillLogLine(""), null);
	assert.equal(parseDshBillLogLine("   "), null);
});
