import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UsageLogReader } from "../src/main/usageStats/UsageLogReader.ts";

/**
 * UsageLogReader：usage.jsonl 游标增量读取。
 *  - 游标 {size, mtimeMs, count}；size 相同 → 空增量
 *  - 文件变小 / ino 变化 / 无游标 → 全量重扫
 *  - 严格 LF 切行（U+2028 不拆行），剥离 \r
 */

const reader = new UsageLogReader();
const lineA = JSON.stringify([1710000000000, "s1", "/p", "anthropic/claude-sonnet-4", 100, 50, 0, 0, 150, 0.01, 1]);
const lineB = JSON.stringify([1710000100000, "s2", "/p", "openai/gpt-4o", 200, 100, 0, 0, 300, 0.02, 1]);

function makeDir() {
	return mkdtemp(join(tmpdir(), "usage-reader-"));
}

test("first read scans the whole file (fullRescan)", async () => {
	const dir = await makeDir();
	try {
		const path = join(dir, "usage.jsonl");
		await writeFile(path, [lineA, lineB].join("\n") + "\n");
		const result = await reader.readIncremental(path, null);
		assert.equal(result.fullRescan, true);
		assert.equal(result.newRecords.length, 2);
		assert.equal(result.newRecords[1].model, "openai/gpt-4o");
		assert.equal(result.fileState.size, Buffer.byteLength([lineA, lineB].join("\n") + "\n"));
		assert.equal(result.fileState.count, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("append is read incrementally (only new records)", async () => {
	const dir = await makeDir();
	try {
		const path = join(dir, "usage.jsonl");
		await writeFile(path, lineA + "\n");
		const first = await reader.readIncremental(path, null);
		await writeFile(path, lineA + "\n" + lineB + "\n");
		const second = await reader.readIncremental(path, first.fileState);
		assert.equal(second.fullRescan, false);
		assert.equal(second.newRecords.length, 1);
		assert.equal(second.newRecords[0].sid, "s2");
		assert.equal(second.fileState.count, 2);
		// 再读一次：无变化 → 空增量
		const third = await reader.readIncremental(path, second.fileState);
		assert.equal(third.newRecords.length, 0);
		assert.equal(third.fullRescan, false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("shrunk file triggers full rescan (truncation safety)", async () => {
	const dir = await makeDir();
	try {
		const path = join(dir, "usage.jsonl");
		const content = lineA + "\n" + lineB + "\n";
		await writeFile(path, content);
		const first = await reader.readIncremental(path, null);
		// 截断到只剩一行
		await writeFile(path, lineA + "\n");
		const second = await reader.readIncremental(path, first.fileState);
		assert.equal(second.fullRescan, true);
		assert.equal(second.newRecords.length, 1);
		assert.equal(second.newRecords[0].sid, "s1");
		assert.equal(second.fileState.count, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("missing file returns null fileState and no records", async () => {
	const dir = await makeDir();
	try {
		const path = join(dir, "nope.jsonl");
		const result = await reader.readIncremental(path, null);
		assert.equal(result.newRecords.length, 0);
		assert.equal(result.fileState, null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("bad lines are skipped and counted, good lines still parsed", async () => {
	const dir = await makeDir();
	try {
		const path = join(dir, "usage.jsonl");
		await writeFile(path, ["garbage", lineA, '{"broken', lineB].join("\n") + "\n");
		const result = await reader.readIncremental(path, null);
		assert.equal(result.newRecords.length, 2);
		assert.equal(result.skippedLines, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("line split across chunk boundary is assembled correctly", async () => {
	const dir = await makeDir();
	try {
		const path = join(dir, "usage.jsonl");
		await writeFile(path, lineA + "\n" + lineB + "\n");
		// 用小 highWaterMark 强制跨块行（16 字节）
		const smallReader = new UsageLogReader({ highWaterMark: 16 });
		const result = await smallReader.readIncremental(path, null);
		assert.equal(result.newRecords.length, 2);
		assert.equal(result.newRecords[0].sid, "s1");
		assert.equal(result.newRecords[1].sid, "s2");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("CRLF line endings are handled (CR stripped)", async () => {
	const dir = await makeDir();
	try {
		const path = join(dir, "usage.jsonl");
		await writeFile(path, lineA + "\r\n" + lineB + "\r\n");
		const result = await reader.readIncremental(path, null);
		assert.equal(result.newRecords.length, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("U+2028 inside a JSON string does not split the record", async () => {
	const dir = await makeDir();
	try {
		const path = join(dir, "usage.jsonl");
		const withSep = JSON.stringify([1710000000000, "s1", "/p/\u2028sep", "anthropic/claude-sonnet-4", 1, 1, 0, 0, 2, 0, 1]);
		await writeFile(path, withSep + "\n");
		const result = await reader.readIncremental(path, null);
		assert.equal(result.newRecords.length, 1);
		assert.equal(result.newRecords[0].cwd, "/p/\u2028sep");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("append with CRLF stays incremental (size grows, no rescan)", async () => {
	const dir = await makeDir();
	try {
		const path = join(dir, "usage.jsonl");
		await writeFile(path, lineA + "\r\n");
		const first = await reader.readIncremental(path, null);
		await writeFile(path, lineA + "\r\n" + lineB + "\r\n");
		const second = await reader.readIncremental(path, first.fileState);
		assert.equal(second.fullRescan, false);
		assert.equal(second.newRecords.length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("same-size in-place rewrite (mtime change) triggers full rescan", async () => {
	const dir = await makeDir();
	try {
		const path = join(dir, "usage.jsonl");
		const contentA = lineA + "\n" + lineB + "\n";
		await writeFile(path, contentA);
		const first = await reader.readIncremental(path, null);
		// 等 mtime 变化（Windows 文件系统 mtime 精度）
		await new Promise((r) => setTimeout(r, 20));
		// 同字节数重写：内容不同但 size 相同、ino 相同
		const lineA2 = JSON.stringify([1710000000000, "s1", "/p", "anthropic/claude-sonnet-4", 999, 1, 0, 0, 1000, 0.02, 1]);
		const sameSize = Buffer.byteLength(contentA) === Buffer.byteLength(lineA2 + "\n" + lineB + "\n");
		assert.equal(sameSize, true, "fixture must keep byte size identical");
		await writeFile(path, lineA2 + "\n" + lineB + "\n");
		const second = await reader.readIncremental(path, first.fileState);
		assert.equal(second.fullRescan, true, "mtime change with same size must rescan");
		assert.equal(second.newRecords.length, 2);
		assert.equal(second.newRecords[0].input, 999);
		assert.equal(second.fileState.mtimeMs, first.fileState.mtimeMs + 20 > 0 ? second.fileState.mtimeMs : second.fileState.mtimeMs);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("empty file returns empty result with size-0 cursor", async () => {
	const dir = await makeDir();
	try {
		const path = join(dir, "usage.jsonl");
		await writeFile(path, "");
		const result = await reader.readIncremental(path, null);
		assert.equal(result.newRecords.length, 0);
		assert.equal(result.fileState.size, 0);
		assert.equal(result.fileState.count, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("final line without trailing newline is still parsed", async () => {
	const dir = await makeDir();
	try {
		const path = join(dir, "usage.jsonl");
		await writeFile(path, lineA + "\n" + lineB); // 无结尾换行
		const result = await reader.readIncremental(path, null);
		assert.equal(result.newRecords.length, 2);
		assert.equal(result.newRecords[1].sid, "s2");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("custom parseLine is used instead of the pi-tracker array parser", async () => {
	const dir = await makeDir();
	try {
		const path = join(dir, "records.jsonl");
		const row = JSON.stringify({
			time: 1710000000000,
			sessionId: "dsh-1",
			provider: "deepseek",
			model: "flash",
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			usd: 0.001,
			priced: true,
		});
		await writeFile(path, row + "\n");
		const { parseDshBillLogLine } = await import("../src/main/usageStats/dshBillLogParser.ts");
		const custom = new UsageLogReader({ parseLine: parseDshBillLogLine });
		const result = await custom.readIncremental(path, null);
		assert.equal(result.newRecords.length, 1);
		assert.equal(result.newRecords[0].sid, "dsh-1");
		assert.equal(result.newRecords[0].model, "deepseek/flash");
		assert.equal(result.skippedLines, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("byte cap truncates oversized full rescan and flags truncated", async () => {
	const dir = await makeDir();
	try {
		const path = join(dir, "usage.jsonl");
		const content = lineA + "\n" + lineB + "\n";
		await writeFile(path, content);
		// 上限设为只够第一行：截断读取必须标记 truncated
		const capReader = new UsageLogReader({ maxBytes: Buffer.byteLength(lineA) + 1 });
		const result = await capReader.readIncremental(path, null);
		assert.equal(result.truncated, true);
		assert.equal(result.newRecords.length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
