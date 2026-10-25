import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 大会话流式加载回归（2026-09 打开大会话即闪退）。
 *
 * 旧实现把整份会话 JSONL `readFile(utf8)` 再 `split("\n")`，两个硬边界必然踩中：
 *  - 超过 V8 单字符串上限（≈5.37 亿字符）的文件直接 ERR_STRING_TOO_LONG；
 *  - 几百 MB 的文件先建出大字符串、再撞主进程 384MB 老生代堆上限 →
 *    V8 FatalProcessOutOfMemory abort 主进程（= 应用闪退，连堆栈都记不下来）。
 *
 * 因此这里锁两条不变式：
 *  1. 索引重建/分页**不得**调用 fs.readFile（只允许 open + 按 offset 的定位读）；
 *  2. 单行超长时仍能保住 id/parentId 链（丢链会让更早历史整段消失）。
 */

const stream = loadTsCommonJs("src/main/sessions/jsonlLineStream.ts");

function toHostPath(filePath) {
	return filePath;
}

function createReader(options = {}) {
	const forcedMaxLineBytes = options.maxLineBytes;
	const readFileCalls = [];
	// fs 替身：open/stat 用真实实现，readFile 直接抛——索引重建/分页一旦退回
	// 「整文件读成字符串」就立刻失败（这正是大会话闪退的成因）。
	const fsGuard = {
		...realFs,
		readFile: async (...args) => {
			readFileCalls.push(args);
			throw new Error("SessionHistoryReader must not read a whole session file into memory");
		},
	};
	const historyReader = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts", {
		stubs: {
			"node:fs/promises": fsGuard,
			...(forcedMaxLineBytes === undefined
				? {}
				: {
						// 强制小阈值/小块：用真实实现驱动超长行与跨块路径，不必真造 64MB 行
						"../sessions/jsonlLineStream": {
							...stream,
							scanJsonlLines: (filePath, visitor, scanOptions = {}) =>
								stream.scanJsonlLines(filePath, visitor, {
									...scanOptions,
									maxLineBytes: forcedMaxLineBytes,
									chunkBytes: 512,
								}),
						},
					}),
		},
	});
	const reader = new historyReader.SessionHistoryReader({
		toHostPath,
		convertMessages: (_agentId, rawMessages, entryIds = []) =>
			rawMessages
				.filter((message) => message && typeof message === "object" && message.role && message.role !== "compactionSummary")
				.map((message, index) => ({
					id: entryIds[index] ?? `message-${index}`,
					role: message.role,
					text: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
					meta: { entryId: entryIds[index] },
				})),
		trimMessages: (messages) => messages,
		translate: () => "Summary unavailable.",
	});
	return { reader, readFileCalls };
}

function line(entry) {
	return JSON.stringify(entry);
}

test("scanJsonlLines reports byte-accurate offsets across chunk boundaries and CRLF", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-jsonl-stream-"));
	const hostPath = join(directory, "session.jsonl");
	try {
		const lines = [line({ id: "a", type: "session" }), line({ id: "b", type: "message", message: { role: "user", content: "中文内容 emoji 🚀 混排" } }), line({ id: "c", type: "message", message: { role: "assistant", content: "ok" } })];
		// CRLF + 末尾换行：byteLength 不含 \n、含 \r（与旧 split 口径一致）
		const raw = `${lines.join("\r\n")}\r\n`;
		await writeFile(hostPath, raw, "utf8");

		const seen = [];
		const summary = await stream.scanJsonlLines(
			hostPath,
			(text, context) => {
				seen.push({ text, ...context });
			},
			{ chunkBytes: 7 },
		); // 极小分块：强制跨块续行（含多字节字符被切开）

		assert.equal(summary.lines, 3);
		assert.equal(summary.oversizedLines, 0);
		assert.equal(summary.trailingBytes, 0);
		assert.equal(summary.endsWithNewline, true);
		assert.equal(summary.bytesScanned, Buffer.byteLength(raw, "utf8"));
		// 回调文本是原始行（含 \r，由解析方按需 strip）——与旧 split("\n") 口径一致
		assert.equal(Array.from(seen, (item) => item.text).join("|"), lines.map((text) => `${text}\r`).join("|"));
		// 每行 byteLength = 原行字节数（含 \r），下一行 offset 连续
		let expectedOffset = 0;
		for (const [index, item] of seen.entries()) {
			const rawLine = Buffer.from(lines[index], "utf8").length + 1; // +\r
			assert.equal(item.byteLength, rawLine, `line ${index} byteLength`);
			assert.equal(item.offset, expectedOffset, `line ${index} offset`);
			assert.equal(item.complete, true);
			expectedOffset += rawLine + 1;
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("scanJsonlLines marks an unterminated tail as incomplete and yields on schedule", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-jsonl-tail-"));
	const hostPath = join(directory, "session.jsonl");
	try {
		// pi 正在追加：最后一行没有 \n（半行），增量索引必须能识别出来
		await writeFile(hostPath, `${line({ id: "a" })}\n${line({ id: "b" })}`, "utf8");
		let yields = 0;
		const seen = [];
		const summary = await stream.scanJsonlLines(
			hostPath,
			(text, context) => {
				seen.push({ text, ...context });
			},
			{
				chunkBytes: 16,
				yieldEveryLines: 1,
				yieldToEventLoop: async () => {
					yields += 1;
				},
			},
		);

		assert.equal(seen.length, 2);
		assert.equal(seen[0].complete, true);
		assert.equal(seen[1].complete, false);
		assert.equal(summary.endsWithNewline, false);
		assert.ok(summary.trailingBytes > 0);
		assert.ok(yields >= 2);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("scanJsonlLines degrades oversized lines to a prefix without dropping offsets", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-jsonl-oversize-"));
	const hostPath = join(directory, "session.jsonl");
	try {
		const hugeBody = "x".repeat(5000);
		const huge = line({ id: "huge", parentId: "a", type: "message", message: { role: "user", content: hugeBody } });
		const raw = `${line({ id: "a" })}\n${huge}\n${line({ id: "tail" })}\n`;
		await writeFile(hostPath, raw, "utf8");

		const seen = [];
		const oversized = [];
		const summary = await stream.scanJsonlLines(
			hostPath,
			(text, context) => {
				seen.push({ text, ...context });
			},
			{
				maxLineBytes: 1024,
				chunkBytes: 256,
				onOversizedLine: (info) => oversized.push(info),
			},
		);

		// 超长行不进 visitor（不 decode 正文），只回调前缀
		assert.equal(Array.from(seen, (item) => item.text).join("|"), `${line({ id: "a" })}|${line({ id: "tail" })}`);
		assert.equal(summary.oversizedLines, 1);
		assert.equal(summary.lines, 3);
		assert.equal(oversized.length, 1);
		assert.equal(oversized[0].byteLength, Buffer.byteLength(huge, "utf8"));
		assert.ok(oversized[0].prefix.includes('"id":"huge"'));
		assert.ok(!oversized[0].prefix.includes(hugeBody));
		// 超长行之后的 offset 仍然精确
		const tailOffset = Buffer.byteLength(`${line({ id: "a" })}\n${huge}\n`, "utf8");
		assert.equal(seen[1].offset, tailOffset);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("scanJsonlLines stops early when the visitor has enough data", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-jsonl-stop-"));
	const hostPath = join(directory, "session.jsonl");
	try {
		await writeFile(hostPath, `${[1, 2, 3, 4, 5].map((n) => line({ id: `m${n}` })).join("\n")}\n`, "utf8");
		const seen = [];
		await stream.scanJsonlLines(
			hostPath,
			(text) => {
				seen.push(text);
				if (seen.length === 2) return "stop";
			},
			{ chunkBytes: 8 },
		);
		assert.equal(seen.length, 2);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rewriteJsonlLines streams line transforms and drops rejected lines", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-jsonl-rewrite-"));
	const sourcePath = join(directory, "src.jsonl");
	const targetPath = join(directory, "dst.jsonl");
	try {
		await writeFile(sourcePath, `${["keep-1", "", "drop-me", "keep-2"].join("\n")}\n`, "utf8");
		const result = await stream.rewriteJsonlLines(
			sourcePath,
			targetPath,
			(text) => {
				if (!text.trim()) return null;
				if (text === "drop-me") return null;
				return text.trim();
			},
			{ chunkBytes: 8 },
		);

		assert.equal(result.writtenLines, 2);
		assert.equal(result.lines, 4);
		assert.equal(await readFile(targetPath, "utf8"), "keep-1\nkeep-2\n");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("SessionHistoryReader indexes and pages without ever calling fs.readFile", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-history-stream-"));
	const hostPath = join(directory, "session.jsonl");
	try {
		const entries = [line({ id: "root", type: "session", timestamp: "2026-01-01T00:00:00.000Z" })];
		for (let turn = 1; turn <= 6; turn += 1) {
			entries.push(
				line({
					id: `u${turn}`,
					parentId: turn === 1 ? "root" : `a${turn - 1}`,
					type: "message",
					message: { role: "user", content: `问题 ${turn}` },
				}),
			);
			entries.push(
				line({
					id: `a${turn}`,
					parentId: `u${turn}`,
					type: "message",
					message: { role: "assistant", content: `回答 ${turn}` },
				}),
			);
		}
		await writeFile(hostPath, `${entries.join("\n")}\n`, "utf8");

		const { reader, readFileCalls } = createReader();
		const page = await reader.readSessionDisplayTurnPage(hostPath, "_viewer", undefined, 2);
		assert.equal(page.total, 12);
		assert.equal(Array.from(page.messages, (message) => message.text).join(","), "问题 5,回答 5,问题 6,回答 6");
		assert.equal(page.nextBefore, 8);
		assert.deepEqual(readFileCalls, [], "索引重建/分页不得整文件 readFile");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("SessionHistoryReader.readLoadWindow returns a bounded tail window with total", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-history-window-"));
	const hostPath = join(directory, "session.jsonl");
	try {
		const { reader } = createReader();
		const entries = [line({ id: "root", type: "session" })];
		for (let turn = 1; turn <= 8; turn += 1) {
			entries.push(
				JSON.stringify({
					id: `u${turn}`,
					parentId: turn === 1 ? "root" : `a${turn - 1}`,
					type: "message",
					message: { role: "user", content: `问 ${turn}` },
				}),
			);
			entries.push(
				JSON.stringify({
					id: `a${turn}`,
					parentId: `u${turn}`,
					type: "message",
					message: { role: "assistant", content: `答 ${turn}` },
				}),
			);
		}
		await writeFile(hostPath, `${entries.join("\n")}\n`, "utf8");

		// Web 的整量读入口：只给尾部窗口，并回传 total/windowStart 供客户端判断截断
		const window = await reader.readLoadWindow(hostPath, "_viewer", 2, 1000);
		assert.equal(window.total, 16);
		assert.equal(window.windowStart, 12);
		assert.equal(Array.from(window.messages, (message) => message.text).join(","), "问 7,答 7,问 8,答 8");

		// 条目预算更紧时窗口可以更小（单轮超预算则整轮保留）
		const tiny = await reader.readLoadWindow(hostPath, "_viewer", 8, 3);
		assert.equal(tiny.total, 16);
		assert.ok(tiny.windowStart > window.windowStart);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("SessionHistoryReader keeps the parent chain through an oversized line", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-history-oversize-"));
	const hostPath = join(directory, "session.jsonl");
	try {
		const hugeBody = "y".repeat(4000);
		const entries = [
			line({ id: "root", type: "session" }),
			line({ id: "u1", parentId: "root", type: "message", message: { role: "user", content: "第一条" } }),
			// 巨型行（真实场景：内联 base64 附件）：正文不解析，但必须保住 id/parentId
			line({ id: "huge1", parentId: "u1", type: "message", message: { role: "assistant", content: hugeBody } }),
			line({ id: "u2", parentId: "huge1", type: "message", message: { role: "user", content: "第二条" } }),
		];
		await writeFile(hostPath, `${entries.join("\n")}\n`, "utf8");

		const { reader, readFileCalls } = createReader({ maxLineBytes: 1024 });
		const page = await reader.readSessionDisplayTurnPage(hostPath, "_viewer", undefined, 10);

		// 丢 id 会让 traceActiveBranch 从超长行断链，u2 整段消失；保住链则 u1/u2 都可见
		assert.equal(Array.from(page.messages, (message) => message.text).join("|"), "第一条|第二条");
		assert.equal(page.total, 2);
		assert.deepEqual(readFileCalls, []);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
