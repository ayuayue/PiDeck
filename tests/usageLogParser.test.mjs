import assert from "node:assert/strict";
import test from "node:test";
// Node 22 type stripping：直接加载主进程纯函数 TS（streamGate.test.mjs 同款模式）
import { parseUsageLogContent, parseUsageLogLine } from "../src/main/usageStats/usageLogParser.ts";

/**
 * usageLogParser：pi-tracker usage.jsonl 行解析（防御式）。
 * 数据格式来自 pi-tracker@0.3.0 src/storage/jsonl-store.ts：
 *   10 字段（旧）: [ts, sid, cwd, model, in, out, cR, cW, tot, cost]
 *   11 字段（新）: 同上 + costKnown(0|1)
 * 解析规则必须与上游兼容逻辑一致，且对任意坏行不抛异常。
 */

/** 构造一行合法记录（11 字段） */
function line10(overrides = {}) {
	const a = [1710000000000, "sess-1", "/home/user/proj", "anthropic/claude-sonnet-4", 100, 50, 0, 0, 150, 0.01];
	return JSON.stringify(Object.assign(a, overrides));
}
function line11(overrides = {}) {
	const a = [1710000000000, "sess-1", "/home/user/proj", "anthropic/claude-sonnet-4", 100, 50, 0, 0, 150, 0.01, 1];
	return JSON.stringify(Object.assign(a, overrides));
}

test("parses a valid 11-field line with all fields mapped", () => {
	const r = parseUsageLogLine(line11());
	assert.deepEqual(r, {
		ts: 1710000000000,
		sid: "sess-1",
		cwd: "/home/user/proj",
		model: "anthropic/claude-sonnet-4",
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: 0.01,
		costKnown: true,
	});
});

test("parses a valid 10-field legacy line (costKnown inferred from cost > 0)", () => {
	const r = parseUsageLogLine(line10());
	assert.equal(r.costKnown, true);
	assert.equal(r.totalTokens, 150);
});

test("10-field legacy line with zero cost infers costKnown=false", () => {
	const r = parseUsageLogLine(line10({ 9: 0 }));
	assert.equal(r.costKnown, false);
});

test("11-field line with costKnown=0 keeps costKnown=false even when cost > 0", () => {
	const r = parseUsageLogLine(line11({ 9: 5, 10: 0 }));
	assert.equal(r.costKnown, false);
});

test("rejects malformed JSON lines without throwing", () => {
	assert.equal(parseUsageLogLine("not json at all"), null);
	assert.equal(parseUsageLogLine("{broken json"), null);
});

test("rejects non-array JSON and wrong field counts", () => {
	assert.equal(parseUsageLogLine('{"type":"message"}'), null);
	assert.equal(parseUsageLogLine("[1,2,3]"), null);
	assert.equal(parseUsageLogLine(JSON.stringify(new Array(9).fill(0))), null);
	assert.equal(parseUsageLogLine(JSON.stringify(new Array(12).fill(0))), null);
});

test("rejects lines with non-numeric token fields (defensive type check)", () => {
	const bad = line11();
	const parsed = JSON.parse(bad);
	parsed[4] = "100"; // input as string
	assert.equal(parseUsageLogLine(JSON.stringify(parsed)), null);
});

test("rejects lines with non-string sid/cwd/model", () => {
	const bad = JSON.parse(line11());
	bad[1] = 42;
	assert.equal(parseUsageLogLine(JSON.stringify(bad)), null);
	const bad2 = JSON.parse(line11());
	bad2[3] = null;
	assert.equal(parseUsageLogLine(JSON.stringify(bad2)), null);
});

test("skips blank lines; trailing CR is tolerated by JSON.parse (CRLF stripping is reader's job)", () => {
	assert.equal(parseUsageLogLine(""), null);
	assert.equal(parseUsageLogLine("   "), null);
	// JSON.parse 容忍尾随空白（\r 属空白字符），因此带 \r 的行仍可解析；
	// 读取层负责按 LF 切分时剥离 \r，parser 无需特判。
	const r = parseUsageLogLine(line11() + "\r");
	assert.ok(r);
	assert.equal(r.ts, 1710000000000);
});

test("parseUsageLogContent aggregates skipped counts (blank lines not counted)", () => {
	const content = [line11(), "bad line", "", line10(), line11({ 4: "x" })].join("\n");
	const { records, skippedLines } = parseUsageLogContent(content);
	assert.equal(records.length, 2);
	assert.equal(skippedLines, 2); // bad line + type-broken；空行不计坏行
});

test("U+2028 inside JSON string is preserved (strict LF framing)", () => {
	// cwd 含 U+2028 分隔符时 JSON 字符串内允许，解析不应被拆行
	const a = JSON.parse(line11());
	a[2] = "/home/user/\u2028proj";
	const r = parseUsageLogLine(JSON.stringify(a));
	assert.ok(r);
	assert.equal(r.cwd, "/home/user/\u2028proj");
});
