import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function entry(id, suffix) {
	return { type: "message", id, parentId: `parent-${id}`, message: { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: suffix }] } };
}

function candidateTable(content) {
	let offset = 0;
	const entries = [];
	for (const line of content.split("\n")) {
		if (!line) continue;
		const bytes = Buffer.byteLength(line);
		const parsed = JSON.parse(line);
		entries.push({ id: parsed.id, parentId: null, type: "message", offset, byteLength: bytes, hasMessage: true, subagentCandidate: line.includes("acp_delegate") || line.includes('"subagent"') });
		offset += bytes + 1;
	}
	return { entries, lastEntryId: entries.at(-1)?.id, endsWithNewline: content.endsWith("\n") };
}

function delegateCall(id) {
	return JSON.stringify({ type: "message", id, parentId: "off-topic-branch", message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: { agent: "reviewer", task: "review history" } }] } }) + "\n";
}

function delegateResult(id, toolCallId) {
	return JSON.stringify({ type: "message", id, parentId: "off-topic-branch", message: { role: "toolResult", toolCallId, toolName: "subagent", content: [{ type: "text", text: "done" }] } }) + "\n";
}

function createReader(readIndexTable = async (path) => candidateTable(await fsPromises.readFile(path, "utf8"))) {
	let indexedBytesRead = 0;
	const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts", { stubs: { "node:fs/promises": { ...fsPromises, open: async (...args) => {
		const handle = await fsPromises.open(...args);
		return { ...handle, read: async (...readArgs) => { const result = await handle.read(...readArgs); indexedBytesRead += result.bytesRead; return result; } };
	} } } });
	return { reader: new SessionHistoryReader({ toHostPath: (path) => path, readIndexTable }), readBytes: () => indexedBytesRead };
}

test("子代理候选行索引：append 后只读取新增事件，保留非活动分支与终态", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-subagent-incremental-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, Array.from({ length: 32 }, (_, i) => JSON.stringify(entry(`noise-${i}`, "x".repeat(16 * 1024))) + "\n").join("") + delegateCall("call-1"));
	const { reader, readBytes } = createReader();
	const first = await reader.readDerivedSubagentEntries(file);
	assert.equal(first.length, 1, "off-branch 派发不能被 activeBranch 过滤掉");
	assert.equal(first[0].type, "reviewer");
	const initialBytes = readBytes();
	assert.ok(initialBytes < 16 * 1024, "首次读取只能物化候选事件，不能读整段无关历史");
	appendFileSync(file, delegateResult("result-1", "call-1"));
	const appended = await reader.readDerivedSubagentEntries(file);
	assert.equal(appended.length, 1);
	assert.equal(appended[0].status, "completed");
	assert.equal(readBytes() - initialBytes, Buffer.byteLength(delegateResult("result-1", "call-1")), "追加轮次不能再次读取旧候选行");

	writeFileSync(file, `${JSON.stringify(entry("replacement", "rewritten"))}\n`);
	utimesSync(file, new Date(), new Date(Date.now() + 2_000));
	assert.equal((await reader.readDerivedSubagentEntries(file)).length, 0, "文件重写后必须丢弃原派发，不能复用旧尾部状态");
});

test("子代理候选行索引：Go 不可用或旧表缺少标记时回退完整派生", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-subagent-index-fallback-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, delegateCall("call-2") + delegateResult("result-2", "call-2"));
	let unavailableCalls = 0;
	const unavailable = createReader(async () => {
		unavailableCalls++;
		throw new Error("session-store unavailable");
	});
	assert.equal((await unavailable.reader.readDerivedSubagentEntries(file))[0].status, "completed");
	assert.equal(unavailableCalls, 1);

	const legacy = createReader(async (path) => {
		const table = candidateTable(await fsPromises.readFile(path, "utf8"));
		return { ...table, entries: table.entries.map(({ subagentCandidate: _legacyField, ...item }) => item) };
	});
	assert.equal((await legacy.reader.readDerivedSubagentEntries(file))[0].status, "completed", "旧版条目表不能静默漏掉候选事件");
});
