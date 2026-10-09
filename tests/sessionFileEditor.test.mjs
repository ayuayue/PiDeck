import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

// 用统一 TS 沙箱加载：相对 import（如 logging/sharedLogger）按源文件目录解析
const load = createTsSandbox({ globals: { AggregateError } });

const { SessionFileEditor } = load("src/main/pi/SessionFileEditor.ts");

function header(overrides = {}) {
	return { type: "session", version: 3, id: "session-header", ...overrides };
}

function message(id, parentId, role, content, overrides = {}) {
	return {
		type: "message",
		id,
		parentId,
		message: { role, content },
		...overrides,
	};
}

function encode(entries, { eol = "\n", trailing = true, leading = "" } = {}) {
	return `${leading}${entries.map((entry) => JSON.stringify(entry)).join(eol)}${trailing ? eol : ""}`;
}

function fileRef(path, overrides = {}) {
	return {
		protocolPath: path,
		hostPath: path,
		environment: "native",
		...overrides,
	};
}

function target(overrides = {}) {
	return {
		entryId: "a1",
		role: "assistant",
		text: "answer",
		activeLeafId: "a1",
		...overrides,
	};
}

function basicEntries(content = "answer") {
	return [header(), message("u1", null, "user", "hello"), message("a1", "u1", "assistant", content)];
}

function parseLines(text) {
	return text
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

function byOriginalOrId(entries, id) {
	return entries.find((entry) => entry.id === id || entry.originalEntryId === id);
}

async function withTempSession(entries, options, run) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-session-editor-"));
	const path = join(directory, "session.jsonl");
	const original = typeof entries === "string" || Buffer.isBuffer(entries) ? entries : encode(entries, options);
	try {
		await writeFile(path, original);
		return await run({ directory, path, original: Buffer.from(original) });
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

function deferred() {
	let resolve;
	const promise = new Promise((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

/**
 * 编辑 = 追加 pi 原生 `context_edit`，不再原地改写原文。
 *
 * 这是本轮最关键的语义变更：旧实现把目标行的正文直接改掉，原文就此从历史里消失
 * （只能从备份找回），编辑也不可撤销。pi 的做法是「原文不动、另记一条编辑指令」，
 * 模型上下文按指令投影，历史仍可追溯。
 */
test("edit appends a native context_edit and leaves the original line untouched", async () => {
	await withTempSession(basicEntries("旧答案"), { eol: "\r\n", trailing: true, leading: "\r\n" }, async ({ path }) => {
		const before = await readFile(path, "utf8");
		const originalAnswerLine = before.split("\r\n")[2];
		let markerSeen = false;
		const editor = new SessionFileEditor();
		const result = await editor.editMessage({
			file: fileRef(path),
			target: target({ text: "旧答案" }),
			newText: "新答案",
			reload: async () => {
				markerSeen = (await readFile(path, "utf8")).includes("_reloadMarker");
			},
		});

		const after = await readFile(path, "utf8");
		assert.equal(markerSeen, true);
		assert.equal(after.includes("_reloadMarker"), false);
		assert.equal(after.startsWith("\r\n"), true, "首部空行必须保留");
		assert.equal(after.endsWith("\r\n"), true, "尾随换行必须保留");
		// 原文行逐字节不变（含 CRLF）——这是「不再丢原文」的直接证据
		assert.equal(after.split("\r\n")[2], originalAnswerLine);
		assert.equal(byOriginalOrId(parseLines(after), "a1").message.content, "旧答案", "原文保持不变");

		const edit = parseLines(after).find((entry) => entry.type === "context_edit");
		assert.ok(edit, "必须追加 context_edit 条目");
		assert.equal(edit.targetId, "a1");
		assert.deepEqual(edit.replacement, { content: "新答案" });
		assert.equal(typeof edit.id, "string");
		assert.equal(edit.parentId, "a1", "新记录接在当前叶之后（成为新的 leaf）");
		assert.equal(typeof edit.timestamp, "string");

		assert.equal(result.targetEntryId, "a1");
		assert.deepEqual([...result.changedEntryIds], ["a1"]);
		assert.equal(await readFile(result.backupPath, "utf8"), before);
	});
});
/** 编辑仍只改文本：图片 / 思考 / 工具块必须原样保留在替换内容里（否则模型会丢附件）。 */
test("edit replacement keeps non-text blocks and collapses multiple text blocks", async () => {
	const content = [
		{ type: "thinking", thinking: "reason" },
		{ type: "text", text: "first" },
		{ type: "image", data: "image-data" },
		{ type: "text", text: "second" },
	];
	await withTempSession(basicEntries(content), {}, async ({ path }) => {
		const editor = new SessionFileEditor();
		await editor.editMessage({
			file: fileRef(path),
			target: target({ text: "firstsecond" }),
			newText: "replacement",
			reload: async () => undefined,
		});
		const edit = parseLines(await readFile(path, "utf8")).find((entry) => entry.type === "context_edit");
		assert.deepEqual(
			edit.replacement.content.map((block) => block.type),
			["thinking", "text", "image"],
		);
		assert.equal(edit.replacement.content[1].text, "replacement");
		assert.equal(edit.replacement.content[0].thinking, "reason");
		assert.equal(edit.replacement.content[2].data, "image-data");
	});
});

test("edit replacement appends a text block when the message has only non-text blocks", async () => {
	await withTempSession(basicEntries([{ type: "thinking", thinking: "reason" }]), {}, async ({ path }) => {
		const editor = new SessionFileEditor();
		await editor.editMessage({
			file: fileRef(path),
			target: target({ text: "" }),
			newText: "visible",
			reload: async () => undefined,
		});
		const edit = parseLines(await readFile(path, "utf8")).find((entry) => entry.type === "context_edit");
		assert.deepEqual(
			edit.replacement.content.map((block) => block.type),
			["thinking", "text"],
		);
		assert.equal(edit.replacement.content[1].text, "visible");
	});
});

test("locator supports legacy message IDs and unique active-branch text fallback", async () => {
	await withTempSession(basicEntries(), {}, async ({ path }) => {
		const editor = new SessionFileEditor();
		await editor.editMessage({
			file: fileRef(path),
			target: target({
				entryId: undefined,
				legacyMessageId: "agent-1-history-a1",
				legacyAgentId: "agent-1",
			}),
			newText: "legacy",
			reload: async () => undefined,
		});
		// 第二次按「正在显示的文本」定位（改写后的 legacy）。文件里 a1 仍是原文 answer，
		// 文本回退必须同时认原文与有效文本，否则用户连续编辑第二次就会报「消息未找到」。
		await editor.editMessage({
			file: fileRef(path),
			target: target({ entryId: undefined, text: "legacy" }),
			newText: "fallback",
			reload: async () => undefined,
		});
		const edits = parseLines(await readFile(path, "utf8")).filter((entry) => entry.type === "context_edit");
		assert.equal(edits.length, 2, "两次编辑各追加一条 context_edit（不覆盖原文）");
		assert.equal(edits[0].targetId, "a1");
		assert.deepEqual(edits[1].replacement, { content: "fallback" });
		// 原文仍在
		assert.equal(byOriginalOrId(parseLines(await readFile(path, "utf8")), "a1").message.content, "answer");
	});
});

test("locator fails closed for duplicate text, stale leaf, off-branch ID and role mismatch", async () => {
	const entries = [header(), message("u1", null, "user", "same"), message("a1", "u1", "assistant", "one"), message("u2", "a1", "user", "same"), message("a2", "u2", "assistant", "two"), message("u-other", null, "user", "other"), message("a-other", "u-other", "assistant", "other-answer")];
	await withTempSession(entries, {}, async ({ path, original }) => {
		const editor = new SessionFileEditor();
		await expectCode(
			editor.editMessage({
				file: fileRef(path),
				target: target({ entryId: undefined, role: "user", text: "same", activeLeafId: "a2" }),
				newText: "ambiguous",
				reload: async () => undefined,
			}),
			"SESSION_ENTRY_AMBIGUOUS",
		);
		await expectCode(
			editor.editMessage({
				file: fileRef(path),
				target: target({ entryId: "a2", text: "two", activeLeafId: "missing-leaf" }),
				newText: "stale",
				reload: async () => undefined,
			}),
			"SESSION_ENTRY_NOT_FOUND",
		);
		await expectCode(
			editor.editMessage({
				file: fileRef(path),
				target: target({ entryId: "a1", text: "one", activeLeafId: "a-other" }),
				newText: "wrong-branch",
				reload: async () => undefined,
			}),
			"SESSION_ENTRY_NOT_FOUND",
		);
		await expectCode(
			editor.editMessage({
				file: fileRef(path),
				target: target({ entryId: "u-other", role: "assistant", text: "other", activeLeafId: "a-other" }),
				newText: "wrong-role",
				reload: async () => undefined,
			}),
			"SESSION_ENTRY_ROLE_INVALID",
		);
		assert.equal((await readFile(path)).equals(original), true);
		assert.equal(
			(await readdir(join(path, ".."))).some((name) => name.endsWith(".edit-backup")),
			false,
		);
	});
});

test("parser rejects empty, invalid UTF-8, malformed JSON, duplicate IDs, headers, dangling parents and cycles", async (t) => {
	const cases = [
		["empty", "", "SESSION_FILE_EMPTY"],
		["invalid UTF-8", Buffer.from([0xff, 0xfe]), "SESSION_FILE_INVALID_JSONL"],
		["malformed JSON", `${JSON.stringify(header())}\n{bad}\n`, "SESSION_FILE_INVALID_JSONL"],
		["duplicate ID", encode([header(), message("u1", null, "user", "a"), message("u1", null, "user", "b")]), "SESSION_FILE_INVALID_JSONL"],
		["missing header", encode([message("u1", null, "user", "a")]), "SESSION_FILE_INVALID_JSONL"],
		["duplicate header", encode([header(), header({ id: "header-2" }), message("u1", null, "user", "a")]), "SESSION_FILE_INVALID_JSONL"],
		["dangling parent", encode([header(), message("u1", "missing", "user", "a")]), "SESSION_FILE_INVALID_JSONL"],
		["cycle", encode([header(), message("u1", "a1", "user", "a"), message("a1", "u1", "assistant", "b")]), "SESSION_FILE_INVALID_JSONL"],
	];
	for (const [name, bytes, code] of cases) {
		await t.test(name, async () => {
			await withTempSession(bytes, {}, async ({ path, original }) => {
				const editor = new SessionFileEditor();
				await expectCode(
					editor.editMessage({
						file: fileRef(path),
						target: target(),
						newText: "blocked",
						reload: async () => undefined,
					}),
					code,
				);
				assert.equal((await readFile(path)).equals(original), true);
			});
		});
	}
});

/**
 * 复刻 pi SessionManager._buildIndex + buildSessionPath 的活动分支投影。
 * tombstone 若没有 id/parentId，leaf 会落在删除记录上，get_messages 整页变空。
 */
/**
 * 测试侧的 pi 投影模拟：取最后一条带 id 的条目为 leaf，沿父链回溯，
 * 再按路径上的 context_edit 投影（移出上下文 / 替换内容）。
 * 与 pi `buildSessionProjection` 的这两条规则一致，用来断言「模型实际会看到什么」。
 */
function piActiveMessageTexts(entries) {
	const byId = new Map();
	let leafId;
	for (const entry of entries) {
		if (entry.type === "session") continue;
		byId.set(entry.id, entry);
		leafId = entry.id;
	}
	let leaf = leafId ? byId.get(leafId) : undefined;
	if (!leaf) {
		leaf = [...entries].reverse().find((entry) => entry.type !== "session");
	}
	const path = [];
	let current = leaf;
	while (current) {
		path.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	const edits = new Map();
	for (const entry of path) {
		if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement);
	}
	const texts = [];
	for (const entry of path) {
		if (entry.type !== "message") continue;
		const replacement = edits.get(entry.id);
		if (replacement === null) continue;
		if (replacement !== undefined) {
			if (typeof replacement.content === "string") texts.push(replacement.content);
			else if (Array.isArray(replacement.content)) texts.push(replacement.content);
			continue;
		}
		texts.push(entry.message?.content);
	}
	return texts;
}

test("deleting the current leaf must not empty pi's remaining active branch", async () => {
	const entries = [header(), message("u1", null, "user", "keep me"), message("a1", "u1", "assistant", "keep answer"), message("u2", "a1", "user", "delete leaf"), message("a2", "u2", "assistant", "leaf answer")];
	await withTempSession(entries, {}, async ({ path }) => {
		const editor = new SessionFileEditor({ now: () => 123 });
		await editor.deleteMessage({
			file: fileRef(path),
			target: target({ entryId: "a2", role: "assistant", text: "leaf answer", activeLeafId: "a2" }),
			reload: async () => undefined,
		});
		const next = parseLines(await readFile(path, "utf8"));
		// 原文行保留，删除表达为追加的 context_edit（replacement: null）。
		assert.equal(byOriginalOrId(next, "a2").type, "message", "原文不得被改写");
		const edit = next.find((entry) => entry.type === "context_edit");
		assert.ok(edit, "必须追加 context_edit");
		assert.equal(edit.targetId, "a2");
		assert.equal(edit.replacement, null);
		// 新记录的 parentId = 当前叶，所以 leaf 落在它上面，分支仍然完整可达。
		assert.equal(edit.parentId, "a2");
		assert.equal(edit.id, next[next.length - 1].id, "context_edit 必须是新的 leaf");
		assert.deepEqual(piActiveMessageTexts(next), ["keep me", "keep answer", "delete leaf"]);
	});
});

test("resending the latest user turn must keep earlier turns visible to pi", async () => {
	const entries = [header(), message("u1", null, "user", "first"), message("a1", "u1", "assistant", "first answer"), message("u2", "a1", "user", "resend me"), message("a2", "u2", "assistant", "second answer")];
	await withTempSession(entries, {}, async ({ path }) => {
		const editor = new SessionFileEditor({ now: () => 123 });
		await editor.truncateForResend({
			file: fileRef(path),
			target: target({ entryId: "u2", role: "user", text: "resend me", activeLeafId: "a2" }),
			reload: async () => undefined,
		});
		const next = parseLines(await readFile(path, "utf8"));
		assert.deepEqual(piActiveMessageTexts(next), ["first", "first answer"]);
	});
});

test("deleting an assistant answer also tombstones that turn's thinking and tools", async () => {
	// 一轮常态：user → thinking-only → toolResult → 最终回答 → 下一轮 user → 回答
	// 只墓碑最终回答时，思考/工具会改挂到下一轮，分组后就会串台。
	const entries = [
		header(),
		message("u1", null, "user", "first question"),
		message("think1", "u1", "assistant", [{ type: "thinking", thinking: "plan A" }]),
		message("tool1", "think1", "toolResult", "ok"),
		message("a1", "tool1", "assistant", "answer one"),
		message("u2", "a1", "user", "second question"),
		message("a2", "u2", "assistant", "answer two"),
	];
	await withTempSession(entries, {}, async ({ path }) => {
		const editor = new SessionFileEditor({ now: () => 123 });
		await editor.deleteMessage({
			file: fileRef(path),
			target: target({ entryId: "a1", role: "assistant", text: "answer one", activeLeafId: "a2" }),
			reload: async () => undefined,
		});
		const next = parseLines(await readFile(path, "utf8"));
		// 三条原文都保留，各自追加一条 replacement: null。
		assert.equal(byOriginalOrId(next, "a1").type, "message");
		assert.equal(byOriginalOrId(next, "think1").type, "message");
		assert.equal(byOriginalOrId(next, "tool1").type, "message");
		const excluded = next.filter((entry) => entry.type === "context_edit").map((entry) => entry.targetId);
		// 顺序不参与语义（沿父链上溯，从叶子往根）；用集合断言，避免实现顺序变化就误报。
		assert.deepEqual(new Set(excluded), new Set(["a1", "think1", "tool1"]), "最终回答与它的过程链一起移出上下文");
		// 父链没有被重接：u2 仍挂在 a1 之后（context_edit 是旁路记录，不改树形）
		assert.equal(byOriginalOrId(next, "u2").parentId, "a1");
		assert.deepEqual(piActiveMessageTexts(next), ["first question", "second question", "answer two"]);
	});
});

test("delete tombstones the target, reparents direct children and leaves grandchildren and siblings intact", async () => {
	const entries = [header(), message("u1", null, "user", "delete me"), message("a1", "u1", "assistant", "child one"), message("a2", "u1", "assistant", "child two"), message("u2", "a1", "user", "grandchild"), message("sibling", null, "assistant", "sibling")];
	await withTempSession(entries, {}, async ({ path }) => {
		const editor = new SessionFileEditor({ now: () => 123 });
		const result = await editor.deleteMessage({
			file: fileRef(path),
			target: target({ entryId: "u1", role: "user", text: "delete me", activeLeafId: "u2" }),
			reload: async () => undefined,
		});
		const next = parseLines(await readFile(path, "utf8"));
		// 只追加一条记录，不重接任何子节点、不动兄弟分支——这是与旧墓碑实现最大的差别：
		// 旧实现把子节点的 parentId 改写到祖父，会让后续审计难以还原原始树形。
		assert.equal(byOriginalOrId(next, "u1").type, "message");
		assert.equal(byOriginalOrId(next, "a1").parentId, "u1");
		assert.equal(byOriginalOrId(next, "a2").parentId, "u1");
		assert.equal(byOriginalOrId(next, "u2").parentId, "a1");
		assert.equal(byOriginalOrId(next, "sibling").parentId, null);
		const edits = next.filter((entry) => entry.type === "context_edit");
		assert.equal(edits.length, 1, "user 消息没有过程链，只移出它自己");
		assert.equal(edits[0].targetId, "u1");
		assert.deepEqual([...result.changedEntryIds], ["u1"]);
	});
});

test("resend tombstones the user root and all descendants while preserving sibling branches", async () => {
	const entries = [
		header(),
		message("root", null, "user", "root"),
		message("u1", "root", "user", "resend"),
		message("a1", "u1", "assistant", "answer"),
		message("u2", "a1", "user", "follow-up"),
		message("a2", "u2", "assistant", "follow-answer"),
		message("u-sibling", "root", "user", "sibling"),
		message("a-sibling", "u-sibling", "assistant", "sibling-answer"),
	];
	await withTempSession(entries, {}, async ({ path }) => {
		const editor = new SessionFileEditor({ now: () => 123 });
		const result = await editor.truncateForResend({
			file: fileRef(path),
			target: target({ entryId: "u1", role: "user", text: "resend", activeLeafId: "a2" }),
			reload: async () => undefined,
		});
		const next = parseLines(await readFile(path, "utf8"));
		for (const id of ["u1", "a1", "u2", "a2"]) {
			assert.equal(byOriginalOrId(next, id).type, "deleted");
			assert.equal(byOriginalOrId(next, id).reason, "resend-truncate");
		}
		assert.equal(byOriginalOrId(next, "u-sibling").type, "message");
		assert.equal(byOriginalOrId(next, "a-sibling").type, "message");
		assert.deepEqual(new Set(result.changedEntryIds), new Set(["u1", "a1", "u2", "a2"]));
	});
});

test("resend rejects assistant roots before backup or write", async () => {
	await withTempSession(basicEntries(), {}, async ({ path, original, directory }) => {
		const editor = new SessionFileEditor();
		await expectCode(
			editor.truncateForResend({
				file: fileRef(path),
				target: target(),
				reload: async () => undefined,
			}),
			"SESSION_ENTRY_ROLE_INVALID",
		);
		assert.equal((await readFile(path)).equals(original), true);
		assert.equal(
			(await readdir(directory)).some((name) => name.endsWith(".edit-backup")),
			false,
		);
	});
});

test("backup creation is mandatory and failure leaves the session byte-for-byte unchanged", async () => {
	await withTempSession(basicEntries(), {}, async ({ path, original }) => {
		const editor = new SessionFileEditor({
			fs: {
				open: async (candidate, flags) => {
					if (candidate.endsWith(".edit-backup")) {
						const error = new Error("backup denied");
						error.code = "EACCES";
						throw error;
					}
					return open(candidate, flags);
				},
			},
		});
		await expectCode(
			editor.editMessage({
				file: fileRef(path),
				target: target(),
				newText: "must-not-write",
				reload: async () => undefined,
			}),
			"SESSION_BACKUP_FAILED",
		);
		assert.equal((await readFile(path)).equals(original), true);
	});
});

test("backup pruning retains the current exact backup even when its UUID sorts first", async () => {
	await withTempSession(basicEntries(), {}, async ({ path, original, directory }) => {
		const stamp = "0000000000123";
		for (const suffix of ["100-old", "200-old", "300-old"]) {
			await writeFile(join(directory, `${basename(path)}.${stamp}-${suffix}.edit-backup`), `old-${suffix}`);
		}
		const uuids = ["000-current", "temp", "marker", "cleanup"];
		const editor = new SessionFileEditor({
			now: () => 123,
			randomUUID: () => uuids.shift() ?? `later-${Math.random()}`,
		});
		const result = await editor.editMessage({
			file: fileRef(path),
			target: target(),
			newText: "changed",
			reload: async () => undefined,
		});
		const backups = (await readdir(directory)).filter((name) => name.endsWith(".edit-backup"));
		assert.equal(backups.length, 3);
		assert.equal(backups.includes(basename(result.backupPath)), true);
		assert.equal((await readFile(result.backupPath)).equals(original), true);
	});
});

test("temp open, write, sync and rename failures preserve the original and clean temporary files", async (t) => {
	for (const fault of ["open", "write", "sync", "rename"]) {
		await t.test(fault, async () => {
			await withTempSession(basicEntries(), {}, async ({ path, original, directory }) => {
				const editor = new SessionFileEditor({
					fs: {
						open: async (candidate, flags) => {
							if (!candidate.endsWith(".tmp")) return open(candidate, flags);
							if (fault === "open") throw new Error("temp open failed");
							const handle = await open(candidate, flags);
							return {
								writeFile: async (data) => {
									if (fault === "write") throw new Error("temp write failed");
									await handle.writeFile(data);
								},
								sync: async () => {
									if (fault === "sync") throw new Error("temp sync failed");
									await handle.sync();
								},
								close: () => handle.close(),
							};
						},
						rename: async (from, to) => {
							if (fault === "rename" && from.endsWith(".tmp")) throw new Error("rename failed");
							await rename(from, to);
						},
					},
					sleep: async () => undefined,
				});
				await expectCode(
					editor.editMessage({
						file: fileRef(path),
						target: target(),
						newText: "blocked",
						reload: async () => undefined,
					}),
					"SESSION_ATOMIC_WRITE_FAILED",
				);
				assert.equal((await readFile(path)).equals(original), true);
				assert.equal(
					(await readdir(directory)).some((name) => name.endsWith(".tmp")),
					false,
				);
			});
		});
	}
});

test("EPERM rename retries succeed when the expected file stays unchanged", async () => {
	await withTempSession(basicEntries(), {}, async ({ path }) => {
		let attempts = 0;
		const editor = new SessionFileEditor({
			fs: {
				rename: async (from, to) => {
					attempts += 1;
					if (attempts <= 2) {
						const error = new Error("busy");
						error.code = "EPERM";
						throw error;
					}
					await rename(from, to);
				},
			},
			sleep: async () => undefined,
		});
		await editor.editMessage({
			file: fileRef(path),
			target: target(),
			newText: "retried",
			reload: async () => undefined,
		});
		assert.equal(attempts >= 5, true);
		// 编辑语义已改为追加 context_edit：断言新记录落到盘上（原文保持不动）。
		assert.equal(
			parseLines(await readFile(path, "utf8")).some((entry) => entry.type === "context_edit" && entry.replacement?.content === "retried"),
			true,
		);
	});
});

test("rename retry rechecks expected bytes and refuses a Pi append between attempts", async () => {
	await withTempSession(basicEntries(), {}, async ({ path, original, directory }) => {
		let attempts = 0;
		const externalLine = `${JSON.stringify({ type: "custom", note: "external" })}\n`;
		const editor = new SessionFileEditor({
			fs: {
				rename: async (from, to) => {
					attempts += 1;
					if (attempts === 1) {
						await appendFile(to, externalLine);
						const error = new Error("busy");
						error.code = "EPERM";
						throw error;
					}
					await rename(from, to);
				},
			},
			sleep: async () => undefined,
		});
		await expectCode(
			editor.editMessage({
				file: fileRef(path),
				target: target(),
				newText: "must-not-commit",
				reload: async () => undefined,
			}),
			"SESSION_FILE_CHANGED",
		);
		const current = await readFile(path);
		assert.equal(current.equals(Buffer.concat([original, Buffer.from(externalLine)])), true);
		assert.equal(
			(await readdir(directory)).some((name) => name.endsWith(".tmp")),
			false,
		);
	});
});

test("temp fsync completion is followed by a final expected-byte check", async () => {
	await withTempSession(basicEntries(), {}, async ({ path, original }) => {
		const externalLine = `${JSON.stringify({ type: "custom", note: "after-sync" })}\n`;
		let changed = false;
		const editor = new SessionFileEditor({
			fs: {
				open: async (candidate, flags) => {
					const handle = await open(candidate, flags);
					if (!candidate.endsWith(".tmp")) return handle;
					return {
						writeFile: (data) => handle.writeFile(data),
						sync: async () => {
							await handle.sync();
							if (!changed) {
								changed = true;
								await appendFile(path, externalLine);
							}
						},
						close: () => handle.close(),
					};
				},
			},
		});
		await expectCode(
			editor.editMessage({
				file: fileRef(path),
				target: target(),
				newText: "must-not-commit",
				reload: async () => undefined,
			}),
			"SESSION_FILE_CHANGED",
		);
		assert.equal((await readFile(path)).equals(Buffer.concat([original, Buffer.from(externalLine)])), true);
	});
});

test("module-level physical locking serializes two editor instances and native/WSL aliases", async () => {
	await withTempSession(basicEntries(), {}, async ({ path }) => {
		const firstEntered = deferred();
		const releaseFirst = deferred();
		let secondEntered = false;
		const first = new SessionFileEditor();
		const second = new SessionFileEditor();
		const firstPromise = first.editMessage({
			file: fileRef(path),
			target: target(),
			newText: "first",
			reload: async () => {
				firstEntered.resolve();
				await releaseFirst.promise;
			},
		});
		await firstEntered.promise;
		const secondPromise = second.editMessage({
			file: fileRef(path, {
				protocolPath: "/mnt/c/alias/session.jsonl",
				environment: "wsl",
				wslDistro: "Ubuntu",
			}),
			target: target({ text: "first" }),
			newText: "second",
			reload: async () => {
				secondEntered = true;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(secondEntered, false);
		releaseFirst.resolve();
		await Promise.all([firstPromise, secondPromise]);
		assert.equal(secondEntered, true);
		assert.equal(
			parseLines(await readFile(path, "utf8")).some((entry) => entry.type === "context_edit" && entry.replacement?.content === "second"),
			true,
		);
	});
});

test("different physical files can mutate concurrently", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-session-editor-parallel-"));
	const firstPath = join(directory, "first.jsonl");
	const secondPath = join(directory, "second.jsonl");
	try {
		await Promise.all([writeFile(firstPath, encode(basicEntries())), writeFile(secondPath, encode(basicEntries()))]);
		const bothEntered = deferred();
		const release = deferred();
		let entered = 0;
		const reload = async () => {
			entered += 1;
			if (entered === 2) bothEntered.resolve();
			await release.promise;
		};
		const first = new SessionFileEditor().editMessage({
			file: fileRef(firstPath),
			target: target(),
			newText: "first",
			reload,
		});
		const second = new SessionFileEditor().editMessage({
			file: fileRef(secondPath),
			target: target(),
			newText: "second",
			reload,
		});
		await bothEntered.promise;
		assert.equal(entered, 2);
		release.resolve();
		await Promise.all([first, second]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("public reload exposes its own marker and removes a moved marker without dropping header updates", async () => {
	await withTempSession(basicEntries(), {}, async ({ path }) => {
		const editor = new SessionFileEditor();
		await editor.reload({
			file: fileRef(path),
			reload: async () => {
				const lines = (await readFile(path, "utf8"))
					.trimEnd()
					.split("\n")
					.map((line) => JSON.parse(line));
				const session = lines.shift();
				assert.equal(typeof session._reloadMarker, "string");
				session.updatedByPi = true;
				lines.push(session);
				await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
			},
		});
		const next = parseLines(await readFile(path, "utf8"));
		const session = next.find((entry) => entry.type === "session");
		assert.equal(session.updatedByPi, true);
		assert.equal("_reloadMarker" in session, false);
		assert.equal(next.at(-1).type, "session");
	});
});

test("foreign markers are rejected before backup, mutation or callback", async () => {
	const entries = basicEntries();
	entries[0]._reloadMarker = "foreign";
	await withTempSession(entries, {}, async ({ path, original, directory }) => {
		let called = false;
		const editor = new SessionFileEditor();
		await expectCode(
			editor.editMessage({
				file: fileRef(path),
				target: target(),
				newText: "blocked",
				reload: async () => {
					called = true;
				},
			}),
			"SESSION_MARKER_CONFLICT",
		);
		assert.equal(called, false);
		assert.equal((await readFile(path)).equals(original), true);
		assert.equal(
			(await readdir(directory)).some((name) => name.endsWith(".edit-backup")),
			false,
		);
	});
});

test("reload failure restores the exact transaction backup and reloads the restored runtime", async () => {
	await withTempSession(basicEntries(), { eol: "\r\n", trailing: true }, async ({ path, original }) => {
		let calls = 0;
		const editor = new SessionFileEditor();
		const error = await expectCode(
			editor.editMessage({
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
		assert.equal(calls, 2);
		assert.equal((await readFile(path)).equals(original), true);
		assert.equal((await readFile(error.backupPath)).equals(original), true);
		assert.equal((await readFile(path, "utf8")).includes("_reloadMarker"), false);
	});
});

test("reload-time external data causes rollback conflict and is never overwritten", async () => {
	await withTempSession(basicEntries(), {}, async ({ path, original }) => {
		const externalLine = `${JSON.stringify({ type: "custom", note: "reload-external" })}\n`;
		const editor = new SessionFileEditor();
		const error = await expectCode(
			editor.editMessage({
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
		assert.match(error.details.originalError, /reload failed/);
	});
});

test("a second reload failure reports rollback-reload failure after restoring the file", async () => {
	await withTempSession(basicEntries(), {}, async ({ path, original }) => {
		let calls = 0;
		const editor = new SessionFileEditor();
		const error = await expectCode(
			editor.deleteMessage({
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
		assert.equal((await readFile(path, "utf8")).includes("_reloadMarker"), false);
	});
});

test("appendMessages chains entries after the current leaf and keeps header/trailing bytes", async () => {
	await withTempSession(basicEntries("answer"), { eol: "\n", trailing: true }, async ({ path }) => {
		const before = await readFile(path, "utf8");
		const editor = new SessionFileEditor();
		const result = await editor.appendMessages({
			file: fileRef(path),
			reload: async () => undefined,
			entries: [
				{ role: "user", content: [{ type: "text", text: "画一只猫" }] },
				{
					role: "assistant",
					content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }],
					extra: { api: "openai-images", provider: "siliconflow", model: "Kwai-Kolors/Kolors" },
				},
			],
		});

		const after = parseLines(await readFile(path, "utf8"));
		assert.equal(after.length, 5);
		// 首条追加消息以原 leaf（a1）为 parent，第二条串在第一条之后
		assert.equal(after[3].type, "message");
		assert.equal(after[3].parentId, "a1");
		assert.equal(after[3].message.role, "user");
		assert.deepEqual(after[3].message.content, [{ type: "text", text: "画一只猫" }]);
		assert.equal(after[4].parentId, after[3].id);
		assert.equal(after[4].message.role, "assistant");
		assert.equal(after[4].message.api, "openai-images");
		assert.equal(after[4].message.provider, "siliconflow");
		assert.equal(after[4].message.model, "Kwai-Kolors/Kolors");
		assert.deepEqual(after[4].message.content, [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }]);
		assert.equal(result.targetEntryId, after[3].id);
		assert.deepEqual([...result.changedEntryIds], [after[3].id, after[4].id]);
		assert.equal(await readFile(result.backupPath, "utf8"), before);
	});
});

/**
 * 回归（2026-10 实测发现）：编辑/删除会追加 context_edit，它成为新的 leaf；
 * 之后追加的消息必须以该记录为 parent，否则会绕开编辑分叉——pi 沿新 leaf 回溯父链
 * 时收集不到那条编辑，用户的修改静默失效（表现为「改了但模型还是看到旧的」）。
 */
test("appendMessages chains after a context_edit leaf so the edit stays on the branch", async () => {
	await withTempSession(basicEntries("v0"), {}, async ({ path }) => {
		const editor = new SessionFileEditor();
		await editor.editMessage({
			file: fileRef(path),
			target: target({ text: "v0" }),
			newText: "v1",
			reload: async () => undefined,
		});
		const editEntry = parseLines(await readFile(path, "utf8")).find((entry) => entry.type === "context_edit");
		assert.ok(editEntry, "编辑必须留下 context_edit");

		await editor.appendMessages({
			file: fileRef(path),
			reload: async () => undefined,
			entries: [{ role: "user", content: [{ type: "text", text: "after edit" }] }],
		});
		const after = parseLines(await readFile(path, "utf8"));
		const appended = after[after.length - 1];
		assert.equal(appended.type, "message");
		assert.equal(appended.parentId, editEntry.id, "新消息必须接在 context_edit 之后（否则编辑掉出分支）");
		// 用同一套 pi 投影规则复核：模型看到的应是 v1，而不是被绕过的 v0。
		// 新追加的消息是块状 content，投影后保持数组形态（与 pi 一致）。
		assert.deepEqual(piActiveMessageTexts(after), ["hello", "v1", [{ type: "text", text: "after edit" }]]);
	});
});

test("appendMessages with empty file (header only) starts a fresh chain from null parent", async () => {
	await withTempSession([header()], {}, async ({ path }) => {
		const editor = new SessionFileEditor();
		await editor.appendMessages({
			file: fileRef(path),
			reload: async () => undefined,
			entries: [{ role: "user", content: [{ type: "text", text: "first" }] }],
		});
		const after = parseLines(await readFile(path, "utf8"));
		assert.equal(after.length, 2);
		assert.equal(after[1].parentId, null);
		assert.equal(after[1].message.role, "user");
	});
});

test("appendMessages rejects empty entry list before backup or write", async () => {
	await withTempSession(basicEntries(), {}, async ({ path, original }) => {
		const editor = new SessionFileEditor();
		await expectCode(
			editor.appendMessages({
				file: fileRef(path),
				reload: async () => undefined,
				entries: [],
			}),
			"SESSION_ENTRY_NOT_FOUND",
		);
		assert.equal((await readFile(path)).equals(original), true);
	});
});

test("appendMessages runs reload with marker and cleans it up", async () => {
	await withTempSession(basicEntries(), {}, async ({ path }) => {
		let markerSeen = false;
		const editor = new SessionFileEditor();
		await editor.appendMessages({
			file: fileRef(path),
			reload: async () => {
				markerSeen = (await readFile(path, "utf8")).includes("_reloadMarker");
			},
			entries: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		});
		assert.equal(markerSeen, true);
		assert.equal((await readFile(path, "utf8")).includes("_reloadMarker"), false);
	});
});

/**
 * 大会话编辑的体量护栏（2026-09 第三次同类闪退）。
 *
 * 编辑/删除/重发需要完整文档（定位条目 + 重算 parentId 链），无法像读取那样流式化，
 * 因此原实现对会话文件 readFile(utf8) + 逐行 JSON.parse。主进程 V8 老生代堆被钉在
 * 384MB：几百 MB 的会话会让 V8 FatalProcessOutOfMemory **abort 主进程**（闪退、无堆栈），
 * 超过 V8 单字符串上限（约 5.37 亿字符）则抛 ERR_STRING_TOO_LONG（实测 1GB 文件）。
 *
 * 现在先 stat 过护栏：超限抛 SESSION_FILE_TOO_LARGE（可读错误），不读文件。
 */
test("编辑超过整读上限的会话：报 SESSION_FILE_TOO_LARGE 且不读文件", async () => {
	await withTempSession(basicEntries(), {}, async ({ path }) => {
		let readCalls = 0;
		const editor = new SessionFileEditor({
			fs: {
				// 只覆盖 stat：声称文件超大，触发护栏
				stat: async () => ({ size: 512 * 1024 * 1024 }),
				readFile: async (...args) => {
					readCalls += 1;
					return readFile(...args);
				},
			},
		});

		await expectCode(
			editor.editMessage({
				file: fileRef(path),
				target: target({ text: "answer" }),
				newText: "新",
			}),
			"SESSION_FILE_TOO_LARGE",
		);
		assert.equal(readCalls, 0, "超限时不应读取会话文件（读取会 abort 主进程）");
	});
});

test("编辑未超限的会话：护栏放行，正常写入", async () => {
	await withTempSession(basicEntries("旧答案"), {}, async ({ path }) => {
		// 默认 fs 带真实 stat：正常大小文件必须照常编辑（护栏不能误伤）
		const editor = new SessionFileEditor();
		const result = await editor.editMessage({
			file: fileRef(path),
			target: target({ text: "旧答案" }),
			newText: "新答案",
			reload: async () => undefined,
		});
		assert.ok(result);
		assert.equal((await readFile(path, "utf8")).includes("新答案"), true);
	});
});

test("体量护栏：缺省 stat 时不误伤（测试替身兼容）", async () => {
	await withTempSession(basicEntries("旧答案"), {}, async ({ path }) => {
		// 只提供 readFile 的替身（无 stat）：应跳过护栏而不是抛错
		const editor = new SessionFileEditor({
			fs: {
				readFile: async (...args) => readFile(...args),
				realpath: async (p) => p,
				open: async (...args) => open(...args),
				readdir: async (...args) => readdir(...args),
				rename: async (...args) => rename(...args),
				unlink: async (...args) => unlink(...args),
			},
		});
		const result = await editor.editMessage({
			file: fileRef(path),
			target: target({ text: "旧答案" }),
			newText: "替身也能改",
			reload: async () => undefined,
		});
		assert.ok(result);
		assert.equal((await readFile(path, "utf8")).includes("替身也能改"), true);
	});
});
