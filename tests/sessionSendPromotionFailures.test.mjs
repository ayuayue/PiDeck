import assert from "node:assert/strict";
import test from "node:test";
import { BOOTSTRAP_ID, SESSION_ID, createDeferred, createSendHarness } from "./helpers/sessionSendHarness.mjs";

function emptyTemplate() {
	return { name: "empty", path: "/prompts/empty.md", description: "empty template", content: "---\ndescription: empty template\n---\n" };
}

/** 引用 id 使用真实 token 形态，让重试断言验证全文展开而不是只比较标记。 */
function quoteSnippet(id = "q1234abcd", text = "original quoted context") {
	return { id, text, messageId: `message-${id}`, createdAt: 1 };
}

const originalQuote = quoteSnippet();
const nextQuote = quoteSnippet("q5678abcd", "new quoted context");
const quotedDraft = `explain #${originalQuote.id}`;
const nextDraft = `also #${nextQuote.id}`;
const originalImage = { type: "image", data: "original", mimeType: "image/png" };
const nextImage = { type: "image", data: "next", mimeType: "image/png" };

test("preparation failure after promotion settles the real Session and preserves new input for retry", async () => {
	const preparation = createDeferred();
	const preparationStarted = createDeferred();
	let preparationCalls = 0;
	const harness = createSendHarness({
		draft: quotedDraft,
		attachments: [originalImage],
		quotes: { [originalQuote.id]: originalQuote },
		prepareMessage: async (message) => {
			preparationCalls += 1;
			preparationStarted.resolve();
			return preparationCalls === 1 ? preparation.promise : message;
		},
	});
	const { store, atoms } = harness;
	const pending = harness.send();
	// 按真实预处理入口同步，不假设跨 VM promise 只需一个 microtask。
	await preparationStarted.promise;
	assert.equal(preparationCalls, 1);
	assert.equal(store.get(atoms.currentSessionSendStateAtom).status, "activating");
	assert.equal(store.get(atoms.sessionSendStateByIdAtom)[BOOTSTRAP_ID], undefined);
	store.set(atoms.setSessionDraftAtom, { sessionId: SESSION_ID, value: nextDraft });
	store.set(atoms.setSessionAttachmentsAtom, { sessionId: SESSION_ID, value: [nextImage] });
	store.set(atoms.setSessionQuotesAtom, { sessionId: SESSION_ID, value: { [nextQuote.id]: nextQuote } });
	preparation.reject(new Error("reference unavailable"));
	await pending;

	assert.equal(store.get(atoms.currentSessionSendStateAtom).status, "error", "the visible Session must not remain activating");
	assert.equal(store.get(atoms.currentSessionSendStateAtom).requestId, "request-1");
	assert.equal(store.get(atoms.sessionSendStateByIdAtom)[BOOTSTRAP_ID], undefined, "the retired bootstrap identity must stay empty");
	assert.equal(store.get(atoms.sessionDraftByIdAtom)[SESSION_ID], `${quotedDraft}\n\n${nextDraft}`);
	assert.deepEqual([...store.get(atoms.sessionAttachmentsByIdAtom)[SESSION_ID]], [originalImage, nextImage]);
	assert.equal(store.get(atoms.sessionQuotesByIdAtom)[SESSION_ID]?.[originalQuote.id], originalQuote);
	assert.equal(store.get(atoms.sessionQuotesByIdAtom)[SESSION_ID]?.[nextQuote.id], nextQuote);
	assert.equal(store.get(atoms.sessionDraftByIdAtom)["unrelated-session"], "leave this draft alone");
	assert.equal(harness.submissions.length, 0);
	assert.deepEqual(harness.errors, ["reference unavailable"]);

	await harness.render(SESSION_ID)();
	assert.equal(harness.submissions.length, 1, "the promoted Composer must allow retry");
	assert.equal(harness.submissions[0].sessionId, SESSION_ID);
	assert.ok(harness.submissions[0].message.includes(originalQuote.text), "retry must contain the original quote, not an orphan token");
	assert.ok(harness.submissions[0].message.includes(nextQuote.text));
	assert.equal(store.get(atoms.currentSessionSendStateAtom).status, "idle");
});

test("preparation failure without promotion remains scoped to the original Session", async () => {
	const harness = createSendHarness({
		sessionId: SESSION_ID,
		prepareMessage: async () => {
			throw new Error("reference unavailable");
		},
	});
	await harness.send();
	assert.equal(harness.store.get(harness.atoms.currentSessionSendStateAtom).status, "error");
	assert.equal(harness.store.get(harness.atoms.sessionDraftByIdAtom)[SESSION_ID], "read &reference");
	assert.equal(harness.submissions.length, 0);
});

test("an empty template is rejected on the promoted Session instead of reaching the transport", async () => {
	const templates = [emptyTemplate()];
	const draft = `/empty ${quotedDraft}`;
	const harness = createSendHarness({ draft, templates, quotes: { [originalQuote.id]: originalQuote } });
	await harness.send();
	assert.equal(harness.submissions.length, 0, "the real template expander preserves /empty, so blank-body detection must use its verdict");
	assert.equal(harness.store.get(harness.atoms.currentSessionSendStateAtom).status, "error");
	assert.equal(harness.store.get(harness.atoms.sessionSendStateByIdAtom)[BOOTSTRAP_ID], undefined);
	assert.equal(harness.store.get(harness.atoms.sessionDraftByIdAtom)[SESSION_ID], draft);
	assert.equal(harness.store.get(harness.atoms.sessionQuotesByIdAtom)[SESSION_ID]?.[originalQuote.id], originalQuote);
	assert.equal(harness.errors.length, 1);
	assert.match(harness.errors[0], /app\.promptTemplateEmptyBody.*empty/);

	templates[0].content = "A useful template";
	await harness.render(SESSION_ID)();
	assert.equal(harness.submissions.length, 1);
	assert.match(harness.submissions[0].message, /A useful template/);
});

test("failed Session creation restores consumed text, images and quotes without overwriting later input", async () => {
	const promotion = createDeferred();
	let attempts = 0;
	const harness = createSendHarness({
		draft: quotedDraft,
		attachments: [originalImage],
		quotes: { [originalQuote.id]: originalQuote },
		beforePromotion: () => (++attempts === 1 ? promotion.promise : undefined),
	});
	const { store, atoms } = harness;
	const pending = harness.send();
	assert.equal(store.get(atoms.sessionDraftByIdAtom)[BOOTSTRAP_ID], undefined);
	assert.equal(store.get(atoms.sessionAttachmentsByIdAtom)[BOOTSTRAP_ID], undefined);
	assert.equal(store.get(atoms.sessionQuotesByIdAtom)[BOOTSTRAP_ID], undefined);
	store.set(atoms.setSessionDraftAtom, { sessionId: BOOTSTRAP_ID, value: nextDraft });
	store.set(atoms.setSessionAttachmentsAtom, { sessionId: BOOTSTRAP_ID, value: [nextImage] });
	store.set(atoms.setSessionQuotesAtom, { sessionId: BOOTSTRAP_ID, value: { [nextQuote.id]: nextQuote } });
	store.set(atoms.currentSessionIdAtom, "unrelated-session");
	promotion.reject(new Error("create failed"));
	await pending;

	assert.equal(store.get(atoms.sessionDraftByIdAtom)[BOOTSTRAP_ID], `${quotedDraft}\n\n${nextDraft}`);
	assert.deepEqual([...store.get(atoms.sessionAttachmentsByIdAtom)[BOOTSTRAP_ID]], [originalImage, nextImage]);
	assert.equal(store.get(atoms.sessionQuotesByIdAtom)[BOOTSTRAP_ID]?.[originalQuote.id], originalQuote);
	assert.equal(store.get(atoms.sessionQuotesByIdAtom)[BOOTSTRAP_ID]?.[nextQuote.id], nextQuote);
	assert.equal(store.get(atoms.sessionDraftByIdAtom)["unrelated-session"], "leave this draft alone");
	assert.equal(store.get(atoms.currentSessionIdAtom), "unrelated-session");
	assert.equal(store.get(atoms.sessionSendStateByIdAtom)[BOOTSTRAP_ID].status, "error");
	assert.equal(harness.submissions.length, 0);
	assert.deepEqual(harness.errors, ["create failed"]);

	await harness.send();
	assert.equal(attempts, 2, "failed promotion must release the send lock");
	assert.equal(harness.submissions.length, 1);
	assert.equal(harness.submissions[0].sessionId, SESSION_ID);
	assert.ok(harness.submissions[0].message.includes(originalQuote.text));
	assert.ok(harness.submissions[0].message.includes(nextQuote.text));
	assert.deepEqual([...harness.submissions[0].images], [originalImage, nextImage]);
});

for (const kind of ["queue", "compact"]) {
	test(`failed Session creation before ${kind} does not duplicate an unconsumed draft`, async () => {
		const draft = kind === "compact" ? "/compact focus on decisions" : quotedDraft;
		const harness = createSendHarness({
			draft,
			attachments: [originalImage],
			quotes: { [originalQuote.id]: originalQuote },
			beforePromotion: async () => {
				throw new Error("create failed");
			},
			enqueue: () => assert.fail("creation must succeed before enqueue"),
		});
		await harness.send(kind === "queue" ? "followUp" : undefined);
		const { store, atoms } = harness;
		assert.equal(store.get(atoms.sessionDraftByIdAtom)[BOOTSTRAP_ID], draft);
		assert.deepEqual([...store.get(atoms.sessionAttachmentsByIdAtom)[BOOTSTRAP_ID]], [originalImage]);
		assert.equal(store.get(atoms.sessionQuotesByIdAtom)[BOOTSTRAP_ID][originalQuote.id], originalQuote);
		assert.equal(harness.submissions.length, 0);
	});
}

test("rejected delivery restores quote snapshots alongside new quotes and retries with both contexts", async () => {
	const delivery = createDeferred();
	const deliveryStarted = createDeferred();
	let attempts = 0;
	const harness = createSendHarness({
		sessionId: SESSION_ID,
		draft: quotedDraft,
		quotes: { [originalQuote.id]: originalQuote },
		sendPrompt: () => {
			deliveryStarted.resolve();
			return ++attempts === 1 ? delivery.promise : { accepted: true };
		},
	});
	const { store, atoms } = harness;
	const pending = harness.send();
	await deliveryStarted.promise;
	assert.ok(harness.submissions[0].message.includes(originalQuote.text));
	store.set(atoms.setSessionDraftAtom, { sessionId: SESSION_ID, value: nextDraft });
	store.set(atoms.setSessionQuotesAtom, { sessionId: SESSION_ID, value: { [nextQuote.id]: nextQuote } });
	delivery.resolve({ accepted: false, delivery: "rejected", error: "rejected" });
	await pending;
	assert.equal(store.get(atoms.sessionDraftByIdAtom)[SESSION_ID], `${quotedDraft}\n\n${nextDraft}`);
	assert.equal(store.get(atoms.sessionQuotesByIdAtom)[SESSION_ID]?.[originalQuote.id], originalQuote);
	assert.equal(store.get(atoms.sessionQuotesByIdAtom)[SESSION_ID]?.[nextQuote.id], nextQuote);
	await harness.send();
	assert.equal(harness.submissions.length, 2);
	assert.ok(harness.submissions[1].message.includes(originalQuote.text));
	assert.ok(harness.submissions[1].message.includes(nextQuote.text));
	assert.equal(store.get(atoms.sessionQuotesByIdAtom)[SESSION_ID], undefined, "an accepted retry consumes restored quotes");
});

for (const kind of ["unknown", "throw"]) {
	test(`${kind} delivery keeps its expanded quote snapshot without restoring or retrying the draft`, async () => {
		const delivery = createDeferred();
		const deliveryStarted = createDeferred();
		const harness = createSendHarness({
			sessionId: SESSION_ID,
			draft: quotedDraft,
			attachments: [originalImage],
			quotes: { [originalQuote.id]: originalQuote },
			sendPrompt: () => {
				deliveryStarted.resolve();
				return delivery.promise;
			},
		});
		const { store, atoms } = harness;
		const pending = harness.send();
		await deliveryStarted.promise;
		store.set(atoms.setSessionDraftAtom, { sessionId: SESSION_ID, value: nextDraft });
		store.set(atoms.setSessionQuotesAtom, { sessionId: SESSION_ID, value: { [nextQuote.id]: nextQuote } });
		if (kind === "throw") delivery.reject(new Error("transport disconnected"));
		else delivery.resolve({ accepted: false, delivery: "unknown", error: "timeout" });
		await pending;
		assert.equal(harness.submissions.length, 1);
		assert.equal(store.get(atoms.sessionDraftByIdAtom)[SESSION_ID], nextDraft);
		assert.equal(store.get(atoms.sessionAttachmentsByIdAtom)[SESSION_ID], undefined);
		assert.equal(store.get(atoms.sessionQuotesByIdAtom)[SESSION_ID][originalQuote.id], undefined);
		assert.equal(store.get(atoms.sessionQuotesByIdAtom)[SESSION_ID][nextQuote.id], nextQuote);
		const state = store.get(atoms.sessionSendStateByIdAtom)[SESSION_ID];
		assert.equal(state.status, "unknown");
		assert.ok(state.unknownSnapshot.message.includes(originalQuote.text));
		assert.deepEqual([...state.unknownSnapshot.images], [originalImage]);
	});
}

for (const phase of ["creation", "delivery"]) {
	test(`quick-message ${phase} failure leaves the editing draft, images and quotes untouched`, async () => {
		const harness = createSendHarness({
			draft: quotedDraft,
			attachments: [originalImage],
			quotes: { [originalQuote.id]: originalQuote },
			beforePromotion: async () => {
				if (phase === "creation") throw new Error("create failed");
			},
			sendPrompt: () => ({ accepted: false, delivery: "rejected", error: "rejected" }),
		});
		await harness.send(undefined, "continue");
		const { store, atoms } = harness;
		const sessionId = phase === "creation" ? BOOTSTRAP_ID : SESSION_ID;
		assert.equal(store.get(atoms.sessionDraftByIdAtom)[sessionId], quotedDraft);
		assert.deepEqual([...store.get(atoms.sessionAttachmentsByIdAtom)[sessionId]], [originalImage]);
		assert.equal(store.get(atoms.sessionQuotesByIdAtom)[sessionId][originalQuote.id], originalQuote);
		if (phase === "delivery") assert.equal(store.get(atoms.sessionQuotesByIdAtom)[BOOTSTRAP_ID], undefined, "promotion must remove the retired quote owner");
		assert.equal(harness.submissions.length, phase === "creation" ? 0 : 1);
		if (phase === "delivery") {
			assert.equal(harness.submissions[0].message, "continue");
			assert.equal(harness.submissions[0].images, undefined);
		}
	});
}

test("failed activation can move the restored draft and quotes back to the bootstrap Composer", () => {
	const { store, atoms } = createSendHarness({ sessionId: SESSION_ID, draft: quotedDraft, quotes: { [originalQuote.id]: originalQuote } });
	store.set(atoms.setSessionQuotesAtom, { sessionId: "unrelated-session", value: { [nextQuote.id]: nextQuote } });
	store.set(atoms.promoteSessionComposerStateAtom, { fromSessionId: SESSION_ID, toSessionId: BOOTSTRAP_ID });
	assert.equal(store.get(atoms.sessionDraftByIdAtom)[BOOTSTRAP_ID], quotedDraft);
	assert.equal(store.get(atoms.sessionQuotesByIdAtom)[BOOTSTRAP_ID]?.[originalQuote.id], originalQuote);
	assert.equal(store.get(atoms.sessionDraftByIdAtom)[SESSION_ID], undefined);
	assert.equal(store.get(atoms.sessionQuotesByIdAtom)[SESSION_ID], undefined);
	assert.equal(store.get(atoms.sessionQuotesByIdAtom)["unrelated-session"][nextQuote.id], nextQuote);
});

test("an empty template cannot enter the local queue after Session promotion", async () => {
	const queued = [];
	const harness = createSendHarness({
		draft: "/empty",
		templates: [emptyTemplate()],
		enqueue: (sessionId, snapshot) => {
			queued.push({ sessionId, snapshot });
			return true;
		},
	});
	await harness.send("followUp");
	assert.equal(queued.length, 0, "a blank template must be rejected before enqueue");
	assert.equal(harness.submissions.length, 0);
	assert.equal(harness.store.get(harness.atoms.currentSessionSendStateAtom).status, "error");
	assert.equal(harness.store.get(harness.atoms.sessionSendStateByIdAtom)[BOOTSTRAP_ID], undefined);
	assert.equal(harness.store.get(harness.atoms.sessionDraftByIdAtom)[SESSION_ID], "/empty");
});
