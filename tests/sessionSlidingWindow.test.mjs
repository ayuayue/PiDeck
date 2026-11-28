import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, stat, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");
const { boundHistoryWindow, messagePayloadBytes, HISTORY_WINDOW_BYTE_BUDGET, HISTORY_WINDOW_MESSAGE_LIMIT } = loadTsCommonJs("src/renderer/src/atoms/session-history-window.ts");
const { sessionDiskPageCursor } = loadTsCommonJs("src/renderer/src/utils/sessionDiskPageCursor.ts");
const { AgentMessageProjector } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts");
const projector = new AgentMessageProjector({ translate: (key) => key, isAskAborted: () => false });
const reader = () => new SessionHistoryReader({ toHostPath: (path) => path, convertMessages: (agent, raw, ids) => projector.convert(agent, raw, ids), trimMessages: (m) => m, translate: () => "Summary" });
const ids = (messages) => Array.from(messages, (m) => m.meta?.entryId ?? m.id);
/** Only the current payload window and light identity lists survive each read. */
async function traverse(path, t) {
	const host = reader();
	let page = await host.readSessionDisplayTurnPage(path, "test", undefined, 32);
	let window = boundHistoryWindow(page.messages, sessionDiskPageCursor(page), "newer");
	let peakCount = 0,
		peakBytes = 0,
		evictions = 0,
		reads = 1;
	const check = () => {
		const bytes = window.messages.reduce((sum, m) => sum + messagePayloadBytes(m), 0);
		peakCount = Math.max(peakCount, window.messages.length);
		peakBytes = Math.max(peakBytes, bytes);
		assert.ok(window.messages.length <= HISTORY_WINDOW_MESSAGE_LIMIT);
		assert.ok(bytes <= HISTORY_WINDOW_BYTE_BUDGET || window.messages.length === 1);
		assert.equal(new Set(ids(window.messages)).size, window.messages.length);
	};
	check();
	const reversePages = [ids(page.messages)];
	while (window.page.nextBefore !== null) {
		assert.ok(reads++ < 2000, "older cursor terminates");
		const anchor = window.page.nextBeforeEntryId,
			before = window.page.nextBefore;
		page = await host.readSessionDisplayTurnPage(path, "test", before, 32, anchor);
		assert.ok(page.nextBefore === null || page.nextBefore < before, "older cursor strictly advances");
		reversePages.push(ids(page.messages));
		const merged = [...page.messages, ...window.messages.filter((m) => !new Set(ids(page.messages)).has(m.meta.entryId))];
		window = boundHistoryWindow(merged, { ...page, nextAfterEntryId: window.page.nextAfterEntryId }, "older");
		if (window.messages.length < merged.length) evictions++;
		check();
	}
	const expected = [...new Set(reversePages.reverse().flat())];
	assert.equal(new Set(expected).size, expected.length, "backward file pages do not duplicate entries");
	const forward = ids(window.messages);
	while (window.page.nextAfterEntryId) {
		assert.ok(reads++ < 4000, "newer cursor terminates");
		const anchor = window.page.nextAfterEntryId;
		page = await host.readSessionDisplayTurnPage(path, "test", undefined, 32, undefined, { afterEntryId: anchor });
		assert.notEqual(page.nextAfterEntryId, anchor, "newer cursor must not repeat");
		const known = new Set(forward);
		forward.push(...ids(page.messages).filter((id) => !known.has(id)));
		const retainedIds = new Set(ids(window.messages));
		const merged = [...window.messages, ...page.messages.filter((m) => !retainedIds.has(m.meta?.entryId ?? m.id))];
		window = boundHistoryWindow(merged, { ...page, nextBefore: window.page.nextBefore, nextBeforeEntryId: window.page.nextBeforeEntryId }, "newer");
		check();
	}
	const mismatch = forward.findIndex((id, i) => id !== expected[i]);
	if (mismatch >= 0) {
		for (const id of new Set([...forward.slice(mismatch - 2, mismatch + 5), ...expected.slice(mismatch - 2, mismatch + 5)])) t.diagnostic(JSON.stringify({ mismatch, id, position: await host.resolveEntryPosition(path, id) }));
	}
	assert.deepEqual(forward, expected, "both directions cover exactly the same ordered file identities");
	assert.ok(evictions > 0, "fixture actually exceeded residency budget");
	t.diagnostic(JSON.stringify({ path, messages: expected.length, reads, evictions, peakCount, peakUtf16JsonBytes: peakBytes }));
}
test("file reader and renderer budget traverse 1500 turns in both directions", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-slide-")),
		path = join(dir, "history.jsonl");
	try {
		const entries = [{ type: "session", id: "header", version: 3 }];
		for (let i = 0; i < 3000; i++) entries.push({ type: "message", id: "e" + i, parentId: i ? "e" + (i - 1) : "header", message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: "body " + i + "x".repeat(2000) }] } });
		await writeFile(path, entries.map((e) => JSON.stringify(e)).join("\n"));
		await traverse(path, t);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("window budget rejects three broken implementations", () => {
	const all = Array.from({ length: 1024 }, (_, i) => ({ id: "e" + i, role: "user", text: "x", meta: { entryId: "e" + i } }));
	const cursor = { total: 1024, nextBefore: null };
	const verify = (result) => {
		assert.ok(result.messages.length <= 512, "unbounded cache");
		assert.equal(result.page.nextAfterEntryId, result.messages.at(-1).meta.entryId, "nonadvancing recovery edge");
		const values = ids(result.messages).map((id) => Number(id.slice(1)));
		values.forEach((n, i) => {
			if (i) assert.equal(n, values[i - 1] + 1, "duplicate or missing entry");
		});
	};
	const good = boundHistoryWindow(all, cursor, "older");
	verify(good);
	for (const bad of [
		{ messages: all, page: cursor },
		{ ...good, page: { ...good.page, nextAfterEntryId: "e0" } },
		{ ...good, messages: [good.messages[0], ...good.messages.slice(0, -1)] },
	])
		assert.throws(() => verify(bad));
	const huge = { ...all[0], text: "x".repeat(HISTORY_WINDOW_BYTE_BUDGET) };
	assert.equal(boundHistoryWindow([huge, all[1]], cursor, "older").messages.length, 1);
	assert.throws(
		() =>
			boundHistoryWindow(
				all.map((m) => ({ ...m, meta: {} })),
				cursor,
				"older",
			),
		/IDENTITY_MISSING/,
	);
});
/** Opt-in read-only scan: no private session body is printed or committed. */
test("largest real session passes the same bidirectional residency contract", { skip: !process.env.PIDECK_REAL_SESSION_ROOT }, async (t) => {
	const root = process.env.PIDECK_REAL_SESSION_ROOT;
	let largest;
	for (const file of await readdir(root, { recursive: true })) {
		if (!file.endsWith(".jsonl")) continue;
		const path = join(root, file),
			info = await stat(path);
		if (!largest || info.size > largest.bytes) largest = { path, bytes: info.size };
	}
	assert.ok(largest);
	let records = 0,
		user = 0,
		assistant = 0;
	for await (const line of createInterface({ input: createReadStream(largest.path), crlfDelay: Infinity })) {
		records++;
		try {
			const e = JSON.parse(line);
			user += Number(e.message?.role === "user");
			assistant += Number(e.message?.role === "assistant");
		} catch {}
	}
	t.diagnostic(JSON.stringify({ ...largest, records, user, assistant }));
	await traverse(largest.path, t);
});
