import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const jsonl = loadTsCommonJs("src/main/sessions/jsonlLineStream.ts");
const reads = [];
const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts", {
	stubs: {
		"../sessions/jsonlLineStream": {
			...jsonl,
			scanJsonlLines: async (filePath, visitor, options) => {
				const summary = await jsonl.scanJsonlLines(filePath, visitor, options);
				reads.push({ start: options?.start ?? 0, bytes: summary.bytesScanned });
				return summary;
			},
		},
	},
});

const T0 = "2026-08-02T11:46:21.399Z";
const T1 = "2026-08-02T11:47:46.554Z";

function createReader() {
	return new SessionHistoryReader({
		toHostPath: (sessionPath) => sessionPath,
		convertMessages: () => [],
		trimMessages: (messages) => messages,
		translate: () => "",
	});
}

let fixtureId = 0;

function message(role, content, timestamp, extra = {}) {
	return JSON.stringify({ type: "message", id: `message-${role}-${timestamp}-${++fixtureId}`, timestamp, message: { role, content, ...extra } }) + "\n";
}

function toolCall(name, id, args) {
	return message("assistant", [{ type: "toolCall", id, name, arguments: args }], T0);
}

function appendWithFreshMtime(filePath, contents) {
	const mtimeMs = statSync(filePath).mtimeMs;
	appendFileSync(filePath, contents);
	utimesSync(filePath, new Date(), new Date(Math.max(Date.now(), mtimeMs + 2_000)));
}

test("derived subagent cache scans only appended bytes and keeps dispatch/result pairing", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-subagent-tail-cache-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const filePath = join(dir, "session.jsonl");
	const filler = message("assistant", [{ type: "text", text: "history ".repeat(40_000) }], T0);
	const dispatch = toolCall("subagent", "call-1", { agent: "researcher", task: "trace the lag" });
	writeFileSync(filePath, filler + dispatch);
	const reader = createReader();

	reads.length = 0;
	const initialBytes = statSync(filePath).size;
	const first = await reader.readDerivedSubagentEntries(filePath);
	assert.equal(first.length, 1);
	assert.equal(first[0].id, "call-1");
	assert.equal(first[0].status, "running");
	assert.deepEqual(reads[0], { start: 0, bytes: initialBytes });

	appendWithFreshMtime(filePath, message("assistant", [{ type: "text", text: "irrelevant answer" }], T1));
	const deltaBytes = statSync(filePath).size - initialBytes;
	const unrelated = await reader.readDerivedSubagentEntries(filePath);
	assert.equal(unrelated.length, 1);
	assert.equal(unrelated[0].status, "running");
	assert.deepEqual(reads[1], { start: initialBytes, bytes: deltaBytes }, "unrelated streaming output must not reread the old session");

	appendWithFreshMtime(filePath, message("toolResult", [{ type: "text", text: "done" }], T1, { toolName: "subagent", toolCallId: "call-1" }));
	const finalBytes = statSync(filePath).size;
	const completed = await reader.readDerivedSubagentEntries(filePath);
	assert.equal(completed.length, 1);
	assert.equal(completed[0].status, "completed", "the delta must retain the original dispatch");
	assert.equal(completed[0].result, "done");
	assert.deepEqual(reads[2], { start: initialBytes + deltaBytes, bytes: finalBytes - initialBytes - deltaBytes });
});

test("derived subagent cache falls back after an incomplete line, then incrementally applies ACP completion", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-subagent-partial-cache-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const filePath = join(dir, "session.jsonl");
	writeFileSync(filePath, toolCall("acp_delegate", "acp-call-1", { agent: "Explore", task: "find a root cause" }) + message("toolResult", [{ type: "text", text: "Dispatched. runId `del-1`" }], T0, { toolName: "acp_delegate", toolCallId: "acp-call-1" }));
	const reader = createReader();
	// 此用例专门验证无可用索引时的尾部缓存。候选行索引自身的 append 边界由
	// sessionSubagentIncrementalIndex.test.mjs 覆盖，不该把索引内部扫描算成这里的 fallback。
	reader.scanDerivedSubagentEntriesFromIndex = async () => null;

	reads.length = 0;
	await reader.readDerivedSubagentEntries(filePath);
	const previousCompleteBytes = statSync(filePath).size;
	appendWithFreshMtime(filePath, toolCall("subagent", "partial-call", { agent: "coder", task: "unfinished" }).slice(0, -1));
	const partialBytes = statSync(filePath).size;
	const partial = await reader.readDerivedSubagentEntries(filePath);
	assert.equal(partial.find((entry) => entry.id === "partial-call").status, "running", "a complete JSON object without a final newline retains the old fallback semantics");
	assert.deepEqual(reads[1], { start: previousCompleteBytes, bytes: partialBytes - previousCompleteBytes }, "the newly appended complete JSON object is still readable without a final newline");

	appendWithFreshMtime(filePath, "\n" + message("user", [{ type: "text", text: "[acp_delegate completed] runId `del-1`" }], T1));
	const completedBytes = statSync(filePath).size;
	const completed = await reader.readDerivedSubagentEntries(filePath);
	assert.equal(completed.find((entry) => entry.id === "partial-call").status, "running");
	assert.equal(completed.find((entry) => entry.id === "acp-call-1").status, "completed");
	assert.deepEqual(reads[2], { start: 0, bytes: completedBytes }, "an unterminated line invalidates the offset cache and must be rescanned from the beginning");
	assert.equal(reads.length, 3, "unchanged files do not reopen the scanner");
});

test("derived subagent cache scans an appended legacy ACP notification and invalidates truncation", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-subagent-rewritten-cache-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const filePath = join(dir, "session.jsonl");
	writeFileSync(filePath, toolCall("acp_delegate", "acp-call-2", { agent: "Explore", task: "investigate" }) + message("toolResult", [{ type: "text", text: "Dispatched. runId `del-2`" }], T0, { toolName: "acp_delegate", toolCallId: "acp-call-2" }));
	const reader = createReader();

	reads.length = 0;
	await reader.readDerivedSubagentEntries(filePath);
	await reader.readDerivedSubagentEntries(filePath);
	const initialBytes = statSync(filePath).size;
	appendWithFreshMtime(filePath, message("user", [{ type: "text", text: "[acp_delegate completed] runId `del-2`" }], T1));
	const completed = await reader.readDerivedSubagentEntries(filePath);
	assert.equal(completed[0].status, "completed");
	assert.deepEqual(reads[1], { start: initialBytes, bytes: statSync(filePath).size - initialBytes });

	writeFileSync(filePath, JSON.stringify({ type: "session", id: "rewritten", timestamp: T1 }) + "\n");
	utimesSync(filePath, new Date(), new Date(Date.now() + 4_000));
	const rewritten = await reader.readDerivedSubagentEntries(filePath);
	assert.equal(rewritten.length, 0);
	assert.deepEqual(reads[2], { start: 0, bytes: statSync(filePath).size });
});
