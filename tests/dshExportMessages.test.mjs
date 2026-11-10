import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function entry(seq, type, data, view) {
	return { event: { seq, type, time: 1_700_000_000_000 + seq, data }, view };
}

function user(seq, text) {
	return entry(seq, "user/message", { source: { kind: "user" }, content: [{ type: "text", text }] });
}

function page(events, hasMore = false) {
	return { result: { ok: true, value: { events, hasMore } } };
}

function collectorFixture(pages, limits) {
	const { collectDshExportMessages } = loadTsCommonJs("src/main/dsh/dshExportMessages.ts");
	const calls = [];
	let nextPage = 0;
	return {
		calls,
		collect: () =>
			collectDshExportMessages({
				agentId: "dsh:fixture-session",
				limits,
				async historyPage(beforeSeq, maxMessages) {
					calls.push({ beforeSeq, maxMessages });
					const response = pages[nextPage++];
					if (response instanceof Error) throw response;
					assert.ok(response, "the collector must not read beyond the supplied pages");
					return response;
				},
			}),
	};
}

/** All history, attachment, and file I/O is in-memory; no real DSH session is opened. */
function managerFixture(pages, partialNotice = "fixture partial history notice") {
	const writes = [];
	const calls = { started: 0, history: [], attachment: [] };
	let nextPage = 0;
	const client = {
		async sessionsHistory(request) {
			calls.history.push(request);
			const response = pages[nextPage++];
			if (response instanceof Error) throw response;
			assert.ok(response, "the collector must not read beyond the supplied pages");
			return response;
		},
		async sessionsAttachment(request) {
			calls.attachment.push(request);
			return { result: { ok: true, value: { data: "aGVsbG8=", attachment: { mediaType: "image/png" } } } };
		},
	};
	const host = {
		onHostReady() {},
		async ensureStarted() {
			calls.started += 1;
		},
		getClient: () => client,
		async readSessionCursor() {
			return 100;
		},
	};
	const { DshAgentManager } = loadTsCommonJs("src/main/dsh/DshAgentManager.ts", {
		stubs: {
			"node:fs/promises": {
				async mkdir() {},
				async writeFile(path, content, encoding) {
					writes.push({ path, content, encoding });
				},
			},
		},
	});
	const manager = new DshAgentManager(
		host,
		() => undefined,
		() => false,
		undefined,
		undefined,
		() => "/fixture/exports",
		() => "fixture",
		undefined,
		undefined,
		(key) => {
			assert.equal(key, "sessionShare.partialNotice");
			return partialNotice;
		},
	);
	return { manager, host, calls, writes };
}

test("live HTML export reads older history instead of exporting only the runtime tail", async () => {
	const fixture = managerFixture([page([user(3, "newest persisted message")], true), page([user(1, "old message outside runtime window")])]);
	fixture.manager.runtime = () => ({
		sessionId: "fixture-session",
		tab: { title: "fixture live" },
		cwd: "/fixture/workspace",
		messages: [{ id: "tail", agentId: "dsh:fixture-session", role: "user", text: "cache-only tail", timestamp: 1_700_000_000_000 }],
	});
	const result = await fixture.manager.exportHtml("fixture-agent");
	assert.equal(fixture.calls.history.length, 2);
	assert.equal(fixture.calls.started, 1);
	assert.equal(result.truncated, false);
	assert.ok(fixture.writes[0].content.includes("old message outside runtime window"));
	assert.ok(fixture.writes[0].content.includes("newest persisted message"));
	assert.ok(!fixture.writes[0].content.includes("cache-only tail"));
});

test("history export rejects a failed history read with a stable code and writes no fake empty HTML", async () => {
	const fixture = managerFixture([{ result: { ok: false, error: { code: "host-unavailable", message: "private fixture details", details: {} } } }]);
	await assert.rejects(fixture.manager.exportSessionHtml("fixture-session", "fixture title"), { message: "DSH_EXPORT_READ_FAILED" });
	assert.equal(fixture.writes.length, 0);
});

test("collector projects one ordered event stream so tool calls/results and model state span pages", async () => {
	const resultA = entry(6, "tool/result", { message: { source: { callId: "call-a" }, content: [{ type: "text", text: "alpha result" }] } }, { label: "result a" });
	const resultB = entry(7, "tool/result", { message: { source: { callId: "call-b" }, content: [{ type: "text", text: "beta result" }] } }, { label: "result b" });
	const answer = entry(8, "assistant/message", {
		message: {
			content: [
				{ type: "reasoning", text: "fixture reasoning" },
				{ type: "text", text: "fixture final answer" },
			],
		},
	});
	const fixture = collectorFixture(
		[
			page([answer, resultB, resultA], true),
			page([
				resultB,
				entry(4, "tool/call", { callId: "call-b", toolName: "grep", arguments: '{"pattern":"beta"}' }, { label: "call b" }),
				user(1, "fixture question"),
				entry(3, "tool/call", { callId: "call-a", toolName: "read", arguments: '{"path":"fixture.txt"}' }, { label: "call a" }),
				entry(2, "request/context", { provider: "fixture-provider", model: "fixture-model" }),
			]),
		],
		{ pageSize: 2 },
	);
	const collection = await fixture.collect();
	assert.equal(collection.truncated, false);
	assert.deepEqual(fixture.calls, [
		{ beforeSeq: undefined, maxMessages: 2 },
		{ beforeSeq: 6, maxMessages: 2 },
	]);
	assert.deepEqual(
		Array.from(collection.messages, (message) => message.id),
		["dsh:1", "dsh:3", "dsh:4", "dsh:8"],
	);
	const [, toolA, toolB, assistant] = collection.messages;
	assert.equal(toolA.agentId, "dsh:fixture-session");
	assert.equal(toolA.text, "read: alpha result");
	assert.equal(toolB.text, "grep: beta result");
	assert.equal(toolA.meta.status, "done");
	assert.equal(toolB.meta.status, "done");
	assert.equal(toolA.meta.durationMs, 3);
	assert.equal(toolA.meta.args.path, "fixture.txt");
	assert.equal(toolA.meta.view.label, "call a");
	assert.equal(toolA.meta.resultView.label, "result a");
	assert.equal(assistant.model.modelId, "fixture-model");
	assert.equal(assistant.thinking, "fixture reasoning");
	assert.equal(assistant.text, "fixture final answer");
});

test("collector returns a genuinely empty session, but read failures never masquerade as empty or partial success", async () => {
	const empty = await collectorFixture([page([])]).collect();
	assert.equal(empty.messages.length, 0);
	assert.equal(empty.truncated, false);
	for (const response of [new Error("private fixture transport details"), { result: { ok: false, error: { code: "host-unavailable", message: "private fixture error", details: {} } } }]) {
		const fixture = collectorFixture([page([user(4, "already read recent history")], true), response]);
		await assert.rejects(fixture.collect(), { code: "DSH_EXPORT_READ_FAILED", message: "DSH_EXPORT_READ_FAILED" });
	}
});

test("collector rejects hasMore without events or valid seq instead of silently stopping", async () => {
	for (const events of [[], [{ event: undefined, view: undefined }], [user(undefined, "missing seq")], [user(Number.NaN, "invalid seq")]]) {
		const fixture = collectorFixture([page(events, true)]);
		await assert.rejects(fixture.collect(), (error) => /^DSH_EXPORT_(?:CURSOR_STALLED|PAGE_INVALID)$/.test(error.code));
		assert.equal(fixture.calls.length, 1);
	}
});

test("collector rejects nondecreasing cursors even on the final page", async () => {
	for (const hasMore of [false, true]) {
		for (const seq of [4, 5]) {
			const fixture = collectorFixture([page([user(4, "recent")], true), page([user(seq, "nondecreasing")], hasMore)]);
			await assert.rejects(fixture.collect(), { code: "DSH_EXPORT_CURSOR_STALLED" });
			assert.equal(fixture.calls.length, 2);
		}
	}
});

test("collector tolerates overlapping duplicates but rejects unseen events beyond the backward cursor", async () => {
	const recent = user(4, "recent original");
	const good = await collectorFixture([page([recent], true), page([user(2, "older"), user(4, "conflicting duplicate")])]).collect();
	assert.equal(good.truncated, false);
	assert.deepEqual(
		Array.from(good.messages, (message) => message.text),
		["older", "recent original"],
	);
	await assert.rejects(collectorFixture([page([recent], true), page([user(2, "older"), user(5, "not an older event")])]).collect(), { code: "DSH_EXPORT_CURSOR_STALLED" });
});

test("collector stops at the page budget, marks truncation, and keeps the latest page", async () => {
	const fixture = collectorFixture([page([user(4, "recent"), user(3, "recent older")], true)], { maxPages: 1 });
	const collection = await fixture.collect();
	assert.equal(fixture.calls.length, 1);
	assert.equal(collection.truncated, true);
	assert.deepEqual(
		Array.from(collection.messages, (message) => message.text),
		["recent older", "recent"],
	);
	const complete = await collectorFixture([page([user(4, "recent")])], { maxPages: 1 }).collect();
	assert.equal(complete.truncated, false, "a last page at exactly the budget is still complete");
});

test("collector enforces serialized event/view byte budget within a page and keeps the most recent events", async () => {
	const recent = user(3, "recent 🙂");
	const previous = user(2, "previous 🙂");
	const maxEventBytes = Buffer.byteLength(JSON.stringify(recent), "utf8") + Buffer.byteLength(JSON.stringify(previous), "utf8");
	const collection = await collectorFixture([page([user(1, "oldest"), previous, recent])], { maxEventBytes }).collect();
	assert.equal(collection.truncated, true);
	assert.deepEqual(
		Array.from(collection.messages, (message) => message.text),
		["previous 🙂", "recent 🙂"],
	);
	const complete = await collectorFixture([page([previous, recent])], { maxEventBytes }).collect();
	assert.equal(complete.truncated, false);
	const oversizedView = entry(4, "user/message", { content: [{ type: "text", text: "small text" }] }, { text: "x".repeat(maxEventBytes) });
	const noFit = await collectorFixture([page([oversizedView])], { maxEventBytes }).collect();
	assert.equal(noFit.messages.length, 0);
	assert.equal(noFit.truncated, true, "even a newest event that cannot fit is explicitly marked");
});

test("collector bounds projected messages and crops only the oldest messages", async () => {
	const collection = await collectorFixture([page([user(4, "recent"), user(5, "newest")], true), page([user(1, "oldest"), user(2, "older"), user(3, "old")])], { maxMessages: 2 }).collect();
	assert.equal(collection.truncated, true);
	assert.deepEqual(
		Array.from(collection.messages, (message) => message.text),
		["recent", "newest"],
	);
	const complete = await collectorFixture([page([user(4, "recent"), user(5, "newest")])], { maxMessages: 2 }).collect();
	assert.equal(complete.truncated, false);
});

test("the projected-message budget is applied after complete replay so an older assistant skeleton is not replaced by a newer duplicate", async () => {
	const fixture = collectorFixture(
		[page([user(3, "newer user message"), entry(4, "assistant/message", { message: { content: [{ type: "text", text: "finalized older assistant" }] } })], true), page([user(1, "older user"), entry(2, "assistant/chunk", { chunk: { type: "text-delta", text: "older assistant stream" } })])],
		{ maxMessages: 1 },
	);
	const collection = await fixture.collect();
	assert.equal(collection.truncated, true);
	assert.equal(collection.messages.length, 1);
	assert.equal(collection.messages[0].id, "dsh:3");
	assert.equal(collection.messages[0].text, "newer user message");
});

test("collector rejects invalid budgets and unserializable history with stable codes", async () => {
	for (const limits of [{ maxPages: 0 }, { maxMessages: -1 }, { maxEventBytes: Number.POSITIVE_INFINITY }, { pageSize: 1.5 }]) {
		const fixture = collectorFixture([page([])], limits);
		await assert.rejects(fixture.collect(), { code: "DSH_EXPORT_LIMITS_INVALID" });
		assert.equal(fixture.calls.length, 0);
	}
	const circular = user(1, "fixture");
	circular.view = circular;
	await assert.rejects(collectorFixture([page([circular])]).collect(), { code: "DSH_EXPORT_PAGE_INVALID" });
});

test("readSessionExportMessages preserves full tool results for the later sharing whitelist", async () => {
	const fullText = `fixture full tool output ${"x".repeat(4000)}`;
	const fixture = managerFixture([page([entry(3, "tool/result", { message: { source: { callId: "fixture-call" }, content: [{ type: "text", text: fullText }] } })], true), page([entry(1, "tool/call", { callId: "fixture-call", toolName: "read", arguments: '{"path":"fixture.txt"}' })])]);
	const collection = await fixture.manager.readSessionExportMessages("fixture-session", { includeImages: false });
	assert.equal(collection.messages[0].meta.fullText, fullText);
	assert.equal(collection.messages[0].meta.truncated, true);
	assert.equal(collection.truncated, false, "tool display truncation is not export history truncation");
});

test("readSessionExportMessages ensures a client and hydrates canonical image refs only when requested", async () => {
	for (const includeImages of [false, true]) {
		const imageEntry = entry(1, "user/message", {
			content: [
				{ type: "text", text: "fixture image" },
				{ type: "image", attachment: { attachmentId: "fixture-image", mediaType: "image/png" } },
			],
		});
		const fixture = managerFixture([page([imageEntry])]);
		const collection = await fixture.manager.readSessionExportMessages("fixture-session", { includeImages });
		assert.equal(fixture.calls.started, 1);
		assert.equal(collection.truncated, false);
		assert.equal(collection.messages[0].meta.dshImageRefs[0].attachmentId, "fixture-image");
		assert.equal(fixture.calls.attachment.length, includeImages ? 1 : 0);
		assert.equal(collection.messages[0].images?.[0]?.data, includeImages ? "aGVsbG8=" : undefined);
		if (includeImages) assert.equal(fixture.calls.attachment[0].sessionId, "fixture-session");
	}
});

test("a client startup failure is a stable export read failure", async () => {
	const fixture = managerFixture([]);
	fixture.host.ensureStarted = async () => {
		throw new Error("private fixture startup details");
	};
	await assert.rejects(fixture.manager.readSessionExportMessages("fixture-session", { includeImages: false }), { code: "DSH_EXPORT_READ_FAILED", message: "DSH_EXPORT_READ_FAILED" });
	assert.equal(fixture.calls.history.length, 0);
});

test("full history HTML export includes hydrated images by default and keeps the existing footer", async () => {
	const fixture = managerFixture([page([entry(1, "user/message", { content: [{ type: "image", attachment: { attachmentId: "fixture-image", mediaType: "image/png" } }] })])]);
	const result = await fixture.manager.exportSessionHtml("fixture-session", "fixture title", "/fixture/workspace");
	assert.equal(result.truncated, false);
	assert.equal(fixture.calls.attachment.length, 1);
	assert.ok(fixture.writes[0].content.includes("data:image/png;base64,aGVsbG8="));
	assert.ok(fixture.writes[0].content.includes("Exported from PiDeck (DeepSeek Harness session)"));
});

test("truncated HTML export preserves the flag and visibly renders the injected localized partial notice", async () => {
	const fixture = managerFixture([], "fixture partial <history> notice");
	fixture.manager.readSessionExportMessages = async (sessionId, options) => {
		assert.equal(sessionId, "fixture-session");
		assert.equal(options.includeImages, true);
		return { messages: [{ id: "m1", agentId: "dsh:fixture-session", role: "user", text: "recent", timestamp: 1_700_000_000_000 }], truncated: true };
	};
	const result = await fixture.manager.exportSessionHtml("fixture-session", "fixture title");
	assert.equal(result.truncated, true);
	assert.ok(fixture.writes[0].content.includes('<div class="partial-notice">fixture partial &lt;history&gt; notice</div>'));
	assert.ok(fixture.writes[0].content.includes("Exported from PiDeck (DeepSeek Harness session)"));
});

test("truncated HTML export cannot write an unlabeled partial file when localized notice is missing", async () => {
	const fixture = managerFixture([], "");
	fixture.manager.readSessionExportMessages = async () => ({ messages: [], truncated: true });
	await assert.rejects(fixture.manager.exportSessionHtml("fixture-session", "fixture title"), { message: "DSH_EXPORT_PARTIAL_NOTICE_UNAVAILABLE" });
	assert.equal(fixture.writes.length, 0);
});

test("session search reuses the collector without changing its public result or fetching attachments", async () => {
	const fixture = managerFixture([page([user(4, "recent without match")], true), page([user(1, "older needle outside runtime tail")])]);
	const result = await fixture.manager.searchSessionMessages("fixture-session", "needle");
	assert.equal(result.hitCount, 1);
	assert.equal(result.matches[0].messageId, "dsh:1");
	assert.equal(fixture.calls.attachment.length, 0);
});
