import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox({ globals: { AggregateError } });
const { SessionFileEditor } = load("src/main/pi/SessionFileEditor.ts");
const stream = load("src/main/pi/sessionFileStream.ts");

/**
 * 大会话的流式编辑路径（sessionFileStream.ts）。
 *
 * 用 `maxInMemoryBytes` 小阈值让真实文件走流式分支（不必造 32MB 文件）：
 * 语义必须与整读路径完全一致 —— 编辑=追加 context_edit、删除=追加多条、
 * 重发=墓碑化后代、删图=改写目标行；未改写的行逐字节保留。
 */

const STREAM_LIMIT = 128;

function header(overrides = {}) {
	return { type: "session", version: 3, id: "session-header", ...overrides };
}

function message(id, parentId, role, content, overrides = {}) {
	return { type: "message", id, parentId, message: { role, content }, ...overrides };
}

function encode(entries, { eol = "\n", trailing = true } = {}) {
	return `${entries.map((entry) => JSON.stringify(entry)).join(eol)}${trailing ? eol : ""}`;
}

function fileRef(path) {
	return { protocolPath: path, hostPath: path, environment: "native" };
}

function target(overrides = {}) {
	return { entryId: "a1", role: "assistant", text: "answer", activeLeafId: "a1", ...overrides };
}

function parseLines(text) {
	return text
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

function streamingEditor(options = {}) {
	return new SessionFileEditor({ maxInMemoryBytes: STREAM_LIMIT, ...options });
}

async function withSession(text, run) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-session-stream-"));
	const path = join(directory, "session.jsonl");
	await writeFile(path, text);
	try {
		return await run({ directory, path, original: Buffer.from(text) });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function expectCode(promise, code) {
	let observed;
	await assert.rejects(promise, (error) => {
		observed = error;
		return error?.code === code;
	});
	return observed;
}

function basicEntries() {
	return [header(), message("u1", null, "user", "hello"), message("a1", "u1", "assistant", "answer")];
}

test("流式编辑：原文行逐字节保留，context_edit 追加到末尾，marker 清理干净", async () => {
	const entries = basicEntries();
	await withSession(encode(entries), async ({ directory, path }) => {
		let markerSeen = false;
		const result = await streamingEditor().editMessage({
			file: fileRef(path),
			target: target(),
			newText: "新",
			reload: async () => {
				markerSeen = (await readFile(path, "utf8")).includes("_reloadMarker");
			},
		});
		assert.equal(result.targetEntryId, "a1");
		assert.equal(markerSeen, true, "reload 期间必须有 marker");
		const text = await readFile(path, "utf8");
		assert.equal(text.includes("_reloadMarker"), false, "reload 后必须清掉 marker");

		const parsed = parseLines(text);
		assert.deepEqual(parsed.slice(0, 3), entries, "原文件行必须逐字节保留");
		const edit = parsed[3];
		assert.equal(edit.type, "context_edit");
		assert.equal(edit.targetId, "a1");
		assert.deepEqual(edit.replacement, { content: "新" });
		assert.equal(edit.parentId, "a1", "context_edit 的父节点是当前叶");

		const backups = (await readdir(directory)).filter((name) => name.endsWith(".edit-backup"));
		assert.equal(backups.length, 1);
	});
});

test("流式删除：assistant 连同过程链（thinking-only / toolResult）一起移出上下文", async () => {
	const entries = [header(), message("u1", null, "user", "hello"), message("th1", "u1", "assistant", [{ type: "thinking", thinking: "thinking..." }]), message("tr1", "th1", "toolResult", "tool output"), message("a1", "tr1", "assistant", "answer")];
	await withSession(encode(entries), async ({ path }) => {
		await streamingEditor().deleteMessage({ file: fileRef(path), target: target({ activeLeafId: "a1" }), reload: async () => undefined });
		const parsed = parseLines(await readFile(path, "utf8"));
		assert.deepEqual(parsed.slice(0, 5), entries, "删除不改写原文");
		const edits = parsed.slice(5);
		assert.deepEqual(
			edits.map((entry) => entry.targetId),
			["a1", "tr1", "th1"],
			"目标回答与同轮过程链按由近到远移出上下文",
		);
		assert.ok(edits.every((entry) => entry.type === "context_edit" && entry.replacement === null));
		assert.equal(edits[0].parentId, "a1");
		assert.equal(edits[1].parentId, edits[0].id, "多条 context_edit 必须串成 parent 链");
		assert.equal(edits[2].parentId, edits[1].id);
	});
});

test("流式重发截断：后代条目原地墓碑化，目标消息保留", async () => {
	const entries = [header(), message("u1", null, "user", "hello"), message("a1", "u1", "assistant", "answer"), message("u2", "a1", "user", "again"), message("a2", "u2", "assistant", "answer2")];
	await withSession(encode(entries), async ({ path }) => {
		await streamingEditor().truncateForResend({ file: fileRef(path), target: target({ entryId: "u1", role: "user", text: "hello" }), reload: async () => undefined });
		const parsed = parseLines(await readFile(path, "utf8"));
		assert.equal(parsed.length, entries.length, "截断不改行数");
		const byId = new Map(parsed.map((entry) => [entry.id ?? entry.originalEntryId, entry]));
		// 重发的语义是「回到这条消息重来」：目标 user 消息本身也要墓碑化，随后重新发送。
		for (const id of ["u1", "a1", "u2", "a2"]) assert.equal(byId.get(id).type, "deleted", `${id} 必须被墓碑化`);
		assert.equal(byId.get("a1").parentId, "u1", "墓碑保留 id + parentId（pi 沿父链回溯）");
		assert.equal(byId.get("a2").reason, "resend-truncate");
	});
});

test("流式删图：只改写目标行，图片数量/哈希校验失败报 SESSION_ENTRY_NOT_FOUND", async () => {
	const entries = [
		header(),
		message("u1", null, "user", [
			{ type: "text", text: "hi" },
			{ type: "image", source: { data: "IMAGE" } },
		]),
	];
	await withSession(encode(entries), async ({ path }) => {
		const imageTarget = { index: 0, expectedImageCount: 1, expectedHash: createHash("sha256").update("IMAGE").digest("hex") };
		await streamingEditor().removeImage({ file: fileRef(path), target: target({ entryId: "u1", role: "user", activeLeafId: "u1" }), imageTarget, reload: async () => undefined });
		const parsed = parseLines(await readFile(path, "utf8"));
		assert.deepEqual(parsed[1].message.content, [{ type: "text", text: "hi" }]);

		await withSession(encode(entries), async ({ path: secondPath }) => {
			await expectCode(streamingEditor().removeImage({ file: fileRef(secondPath), target: target({ entryId: "u1", role: "user", activeLeafId: "u1" }), imageTarget: { ...imageTarget, expectedHash: "0".repeat(64) }, reload: async () => undefined }), "SESSION_ENTRY_NOT_FOUND");
			assert.equal((await readFile(secondPath, "utf8")).includes('"image"'), true, "校验失败不得改写文件");
		});
	});
});

test("流式改写保持 CRLF 与中间空行，未改行逐字节不变", async () => {
	const entries = [header(), { type: "custom", note: "keep me" }, message("u1", null, "user", "hello"), message("a1", "u1", "assistant", "answer")];
	const original = encode(entries, { eol: "\r\n" }).replace(`${JSON.stringify(entries[1])}\r\n`, `${JSON.stringify(entries[1])}\r\n\r\n`);
	await withSession(original, async ({ path }) => {
		await streamingEditor().editMessage({ file: fileRef(path), target: target(), newText: "新", reload: async () => undefined });
		const text = await readFile(path, "utf8");
		assert.ok(text.startsWith(`${JSON.stringify(entries[0])}\r\n${JSON.stringify(entries[1])}\r\n\r\n`), "未改行原样保留（含空行与 CRLF）");
		assert.ok(text.endsWith("\r\n"), "追加行沿用原文件行尾");
		const last = parseLines(text).at(-1);
		assert.equal(last.type, "context_edit");
	});
});

test("无尾换行文件追加新行：自动补换行，文件仍可解析（小文件路径同修）", async () => {
	const entries = basicEntries();
	for (const editor of [streamingEditor(), new SessionFileEditor()]) {
		await withSession(encode(entries, { trailing: false }), async ({ path }) => {
			await editor.editMessage({ file: fileRef(path), target: target(), newText: "新", reload: async () => undefined });
			const text = await readFile(path, "utf8");
			const parsed = parseLines(text);
			assert.equal(parsed.length, entries.length + 1, "最后一行与追加行不能粘成一串");
			assert.equal(parsed.at(-1).type, "context_edit");
			assert.ok(text.endsWith("\n"));
		});
	}
});

test("流式路径 reload 失败：恢复精确备份并重新 reload（与整读路径同语义）", async () => {
	await withSession(encode(basicEntries(), { eol: "\r\n" }), async ({ path, original }) => {
		let calls = 0;
		const error = await expectCode(
			streamingEditor().editMessage({
				file: fileRef(path),
				target: target(),
				newText: "rolled-back",
				reload: async () => {
					calls += 1;
					if (calls === 1) throw new Error("primary reload failed");
				},
			}),
			"SESSION_RELOAD_FAILED",
		);
		assert.equal(calls, 2, "回滚后必须再 reload 一次恢复运行时");
		assert.equal((await readFile(path)).equals(original), true);
		assert.equal((await readFile(error.backupPath)).equals(original), true);
		assert.equal((await readFile(path, "utf8")).includes("_reloadMarker"), false);
	});
});

test("流式路径 reload 期间外部写入：拒绝回滚覆盖（ROLLBACK_CONFLICT）", async () => {
	await withSession(encode(basicEntries()), async ({ path, original }) => {
		const externalLine = `${JSON.stringify({ type: "custom", note: "reload-external" })}\n`;
		const error = await expectCode(
			streamingEditor().editMessage({
				file: fileRef(path),
				target: target(),
				newText: "edited-before-conflict",
				reload: async () => {
					await appendFile(path, externalLine);
					throw new Error("reload failed after external append");
				},
			}),
			"SESSION_ROLLBACK_CONFLICT",
		);
		const current = await readFile(path, "utf8");
		assert.equal(current.includes("edited-before-conflict"), true);
		assert.equal(current.includes("reload-external"), true);
		assert.equal(current.includes("_reloadMarker"), false);
		assert.equal((await readFile(error.backupPath)).equals(original), true);
	});
});

test("流式路径两次 reload 都失败：恢复文件后报 ROLLBACK_RELOAD_FAILED", async () => {
	await withSession(encode(basicEntries()), async ({ path, original }) => {
		let calls = 0;
		const error = await expectCode(
			streamingEditor().deleteMessage({
				file: fileRef(path),
				target: target(),
				reload: async () => {
					calls += 1;
					throw new Error(`reload failure ${calls}`);
				},
			}),
			"SESSION_ROLLBACK_RELOAD_FAILED",
		);
		assert.equal(calls, 2);
		assert.equal((await readFile(path)).equals(original), true);
		assert.equal((await readFile(error.backupPath)).equals(original), true);
	});
});

test("流式路径读前已含 reload marker：拒绝并且不写文件", async () => {
	await withSession(encode([{ ...header(), _reloadMarker: "other" }, message("u1", null, "user", "hello"), message("a1", "u1", "assistant", "answer")]), async ({ directory, path, original }) => {
		await expectCode(streamingEditor().editMessage({ file: fileRef(path), target: target(), newText: "新", reload: async () => undefined }), "SESSION_MARKER_CONFLICT");
		assert.equal((await readFile(path)).equals(original), true);
		assert.deepEqual(await readdir(directory), ["session.jsonl"]);
	});
});

test("流式复制的并发保护：扫描后文件变化则拒绝改写并清理临时文件", async () => {
	await withSession(encode(basicEntries()), async ({ directory, path }) => {
		const scan = await stream.scanSessionFile(path);
		await appendFile(path, `${JSON.stringify({ type: "custom", note: "external" })}\n`);
		await assert.rejects(stream.rewriteSessionFile(path, { replaceLines: new Map(), appendLines: ['{"type":"custom"}'] }, scan.hash), (error) => error.code === "SESSION_FILE_CHANGED");
		const leftovers = (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
		assert.deepEqual(leftovers, [], "失败的临时文件必须清理");
	});
});

test("流式读跨 chunk：多行与超长单行都不串行", async () => {
	// 每行 ~20KB × 32 行 ≈ 640KB（超过 256KB 读块）：未修「跨块行缓存被下次读覆盖」时这里会解析失败。
	const big = "z".repeat(20_000);
	const entries = [header(), message("u1", null, "user", big), message("a1", "u1", "assistant", big)];
	for (let index = 0; index < 30; index += 1) entries.push({ type: "custom", note: `${index}:${big}` });
	await withSession(encode(entries), async ({ path }) => {
		await streamingEditor().editMessage({ file: fileRef(path), target: target({ activeLeafId: "a1" }), newText: "新", reload: async () => undefined });
		const parsed = parseLines(await readFile(path, "utf8"));
		assert.deepEqual(parsed.slice(0, entries.length), entries, "所有原行必须逐字节保留");
		assert.equal(parsed.at(-1).type, "context_edit");
	});
});

test("流式读跨 chunk：目标本身是超过读块的超长行（base64 图片级）", async () => {
	// 400KB 单行 > 256KB 读块：readSessionLineAt 必须跨多次 read 拼出一行。
	const huge = "w".repeat(400_000);
	const entries = [header(), message("u1", null, "user", [{ type: "text", text: huge }]), message("a1", "u1", "assistant", "answer")];
	await withSession(encode(entries), async ({ path }) => {
		await streamingEditor().editMessage({ file: fileRef(path), target: target({ entryId: "u1", role: "user", text: huge, activeLeafId: "a1" }), newText: "新", reload: async () => undefined });
		const parsed = parseLines(await readFile(path, "utf8"));
		assert.deepEqual(parsed.slice(0, entries.length), entries, "超长原行不得被截断或改写");
		assert.deepEqual(parsed.at(-1).replacement, { content: [{ type: "text", text: "新" }] });
	});
});

test("流式与整读路径结果等价（编辑 / 删除 / 重发）", async () => {
	const editEntries = [
		header(),
		message("u1", null, "user", [
			{ type: "text", text: "hello" },
			{ type: "image", source: { data: "IMG" } },
		]),
		message("a1", "u1", "assistant", "answer"),
	];
	const deleteEntries = [header(), message("u1", null, "user", "hello"), message("th1", "u1", "assistant", [{ type: "thinking", thinking: "t" }]), message("tr1", "th1", "toolResult", "tool"), message("a1", "tr1", "assistant", "answer")];
	const resendEntries = [header(), message("u1", null, "user", "hello"), message("a1", "u1", "assistant", "answer"), message("u2", "a1", "user", "again")];

	/** 归一化随机 id / timestamp：context_edit 的 id 与链式 parentId 都压成占位符。 */
	function normalize(text) {
		const entries = parseLines(text);
		const editIds = new Set(entries.filter((entry) => entry.type === "context_edit").map((entry) => entry.id));
		return entries.map((entry) => {
			if (entry.type === "context_edit") {
				const copy = { ...entry, id: "<edit>", timestamp: "<ts>" };
				if (copy.parentId && editIds.has(copy.parentId)) copy.parentId = "<edit>";
				return copy;
			}
			// 墓碑的 ts 是操作时刻，两条路径必然不同（"操作时间"不是行为差异）。
			if (entry.type === "deleted") return { ...entry, ts: 0 };
			return entry;
		});
	}

	async function runBoth(entries, apply) {
		let large;
		await withSession(encode(entries), async ({ path }) => {
			await apply(streamingEditor(), path);
			large = normalize(await readFile(path, "utf8"));
		});
		let small;
		await withSession(encode(entries), async ({ path }) => {
			await apply(new SessionFileEditor(), path);
			small = normalize(await readFile(path, "utf8"));
		});
		assert.deepEqual(large, small);
	}

	await runBoth(editEntries, (editor, path) => editor.editMessage({ file: fileRef(path), target: target({ text: "answer" }), newText: "新", reload: async () => undefined }));
	await runBoth(deleteEntries, (editor, path) => editor.deleteMessage({ file: fileRef(path), target: target(), reload: async () => undefined }));
	await runBoth(resendEntries, (editor, path) => editor.truncateForResend({ file: fileRef(path), target: target({ entryId: "u1", role: "user", text: "hello" }), reload: async () => undefined }));
});
