import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_ID, createDeferred, createSendHarness } from "./helpers/sessionSendHarness.mjs";

/** 用真实删除 atoms 退休来源会话，同时确认其他会话完全不受影响。 */
function removeSession(harness) {
	const { store, atoms } = harness;
	store.set(atoms.removeSessionStateAtom, SESSION_ID);
	store.set(atoms.removeSessionComposerStateAtom, SESSION_ID);
}

/** 未知投递不能自动重试；已删除会话也不能留下孤儿发送态或缓存。 */
function assertSessionAbsent(harness) {
	const { store, atoms } = harness;
	for (const state of [atoms.sessionRecordsAtom, atoms.sessionRuntimeByIdAtom, atoms.sessionMessagesCacheAtom, atoms.sessionDraftByIdAtom, atoms.sessionAttachmentsByIdAtom, atoms.sessionQuotesByIdAtom, atoms.sessionSendStateByIdAtom]) {
		assert.equal(store.get(state)[SESSION_ID], undefined);
	}
	assert.equal(store.get(atoms.sessionDraftByIdAtom)["unrelated-session"], "leave this draft alone");
	assert.deepEqual(harness.errors, []);
	assert.deepEqual(harness.unknowns, []);
	assert.deepEqual(harness.history, []);
}

for (const remount of [false, true]) {
	test(`promotion keeps the in-flight send exclusive across ${remount ? "remount" : "rerender"}`, async () => {
		const delivery = createDeferred();
		const started = createDeferred();
		const harness = createSendHarness({
			sendPrompt: () => {
				started.resolve();
				return delivery.promise;
			},
		});
		const pending = harness.send();
		await started.promise;
		const { store, atoms } = harness;
		store.set(atoms.setSessionDraftAtom, { sessionId: SESSION_ID, value: "next question" });
		const send = remount ? harness.mount(SESSION_ID) : harness.render(SESSION_ID);
		const duplicate = send();
		delivery.resolve({ accepted: true });
		await Promise.all([pending, duplicate]);
		assert.equal(harness.submissions.length, 1, "promotion must not open a second dispatch window");
		assert.equal(store.get(atoms.sessionDraftByIdAtom)[SESSION_ID], "next question");
		await send();
		assert.equal(harness.submissions.length, 2, "settling the first request must release its real Session");
	});
}

for (const rejects of [false, true]) {
	test(`deletion during preparation prevents late ${rejects ? "failure recovery" : "dispatch"}`, async () => {
		const preparation = createDeferred();
		const started = createDeferred();
		const harness = createSendHarness({
			sessionId: SESSION_ID,
			prepareMessage: () => {
				started.resolve();
				return preparation.promise;
			},
		});
		const pending = harness.send();
		await started.promise;
		removeSession(harness);
		if (rejects) preparation.reject(new Error("reference read failed"));
		else preparation.resolve("prepared question");
		await pending;
		assert.equal(harness.submissions.length, 0, "a retired Session must never reach the transport");
		assertSessionAbsent(harness);
	});
}

for (const outcome of ["accepted", "rejected", "unknown", "throw"]) {
	test(`deleted Session stays absent after a late ${outcome} delivery`, async () => {
		const delivery = createDeferred();
		const started = createDeferred();
		const harness = createSendHarness({
			sessionId: SESSION_ID,
			sendPrompt: () => {
				started.resolve();
				return delivery.promise;
			},
		});
		const pending = harness.send();
		await started.promise;
		removeSession(harness);
		if (outcome === "throw") delivery.reject(new Error("transport failed"));
		else delivery.resolve({ accepted: outcome === "accepted", delivery: outcome, error: "delivery failed", agentId: "retired-agent", runtimeGeneration: 1, sessionPath: "/retired.jsonl" });
		await pending;
		assertSessionAbsent(harness);
	});
}

for (const outcome of ["accepted", "rejected", "throw"]) {
	test(`late ${outcome} delivery cannot overwrite a newer request`, async () => {
		const delivery = createDeferred();
		const started = createDeferred();
		const harness = createSendHarness({
			sessionId: SESSION_ID,
			sendPrompt: () => {
				started.resolve();
				return delivery.promise;
			},
		});
		const pending = harness.send();
		await started.promise;
		const { store, atoms } = harness;
		const newer = { status: "sending", requestId: "newer-request" };
		store.set(atoms.setSessionSendStateAtom, { sessionId: SESSION_ID, state: newer });
		store.set(atoms.setSessionDraftAtom, { sessionId: SESSION_ID, value: "new draft" });
		if (outcome === "throw") delivery.reject(new Error("transport failed"));
		else delivery.resolve({ accepted: outcome === "accepted", delivery: outcome, error: "delivery failed", agentId: "old-agent", runtimeGeneration: 1 });
		await pending;
		assert.equal(store.get(atoms.sessionSendStateByIdAtom)[SESSION_ID], newer);
		assert.equal(store.get(atoms.sessionDraftByIdAtom)[SESSION_ID], "new draft");
		assert.equal(store.get(atoms.sessionRuntimeByIdAtom)[SESSION_ID], undefined);
		assert.deepEqual(harness.errors, []);
		assert.deepEqual(harness.unknowns, []);
		assert.deepEqual(harness.history, []);
	});
}

for (const change of ["replacement", "detach", "same-generation-other-agent"]) {
	test(`a late accepted result cannot restore metadata after runtime ${change}`, async () => {
		const delivery = createDeferred();
		const started = createDeferred();
		const harness = createSendHarness({
			sessionId: SESSION_ID,
			sendPrompt: () => {
				started.resolve();
				return delivery.promise;
			},
		});
		const { store, atoms } = harness;
		store.set(atoms.bindSessionRuntimeAtom, { sessionId: SESSION_ID, agentId: "old-agent", runtimeGeneration: 1 });
		const pending = harness.send();
		await started.promise;
		if (change === "detach") {
			store.set(atoms.applySessionRuntimeEventAtom, { kind: "detach", sessionId: SESSION_ID, agentId: "old-agent", runtimeGeneration: 1, sourceChannel: "agents:closed", payload: {} });
		} else {
			store.set(atoms.bindSessionRuntimeAtom, { sessionId: SESSION_ID, agentId: "new-agent", runtimeGeneration: change === "replacement" ? 2 : 1 });
		}
		const record = store.get(atoms.sessionRecordsAtom)[SESSION_ID];
		const runtime = store.get(atoms.sessionRuntimeByIdAtom)[SESSION_ID];
		delivery.resolve({ accepted: true, agentId: "old-agent", runtimeGeneration: 1, sessionPath: "/old.jsonl" });
		await pending;
		assert.equal(store.get(atoms.sessionRecordsAtom)[SESSION_ID], record);
		assert.equal(store.get(atoms.sessionRuntimeByIdAtom)[SESSION_ID], runtime);
		assert.equal(store.get(atoms.sessionSendStateByIdAtom)[SESSION_ID], undefined, "the old request must settle without leaving the new runtime busy");
		assert.deepEqual(harness.history, []);
	});
}

for (const outcome of ["rejected", "unknown"]) {
	test(`runtime replacement preserves ${outcome} recovery without rebinding the old runtime`, async () => {
		const delivery = createDeferred();
		const started = createDeferred();
		const harness = createSendHarness({
			sessionId: SESSION_ID,
			sendPrompt: () => {
				started.resolve();
				return delivery.promise;
			},
		});
		const { store, atoms } = harness;
		store.set(atoms.bindSessionRuntimeAtom, { sessionId: SESSION_ID, agentId: "old-agent", runtimeGeneration: 1 });
		const pending = harness.send();
		await started.promise;
		store.set(atoms.bindSessionRuntimeAtom, { sessionId: SESSION_ID, agentId: "new-agent", runtimeGeneration: 2 });
		store.set(atoms.setSessionDraftAtom, { sessionId: SESSION_ID, value: "next question" });
		const runtime = store.get(atoms.sessionRuntimeByIdAtom)[SESSION_ID];
		delivery.resolve({ accepted: false, delivery: outcome, error: "delivery failed", agentId: "old-agent", runtimeGeneration: 1 });
		await pending;
		assert.equal(store.get(atoms.sessionRuntimeByIdAtom)[SESSION_ID], runtime);
		assert.equal(store.get(atoms.sessionDraftByIdAtom)[SESSION_ID], outcome === "rejected" ? "read &reference\n\nnext question" : "next question");
		const state = store.get(atoms.sessionSendStateByIdAtom)[SESSION_ID];
		assert.equal(state.status, outcome === "rejected" ? "error" : "unknown");
		if (outcome === "unknown") assert.equal(state.unknownSnapshot.message, "read &reference");
		assert.equal(harness.submissions.length, 1, "a retired runtime must never cause automatic resubmission");
	});
}

for (const outcome of ["accepted", "rejected", "unknown"]) {
	test(`only accepted delivery advances the conversation turn (${outcome})`, async () => {
		const harness = createSendHarness({
			sessionId: SESSION_ID,
			sendPrompt: () => ({ accepted: outcome === "accepted", delivery: outcome, error: "delivery failed" }),
		});
		const { store, atoms } = harness;
		const tickAtom = atoms.newTurnCollapseTickBySessionIdAtomFamily(SESSION_ID);
		const before = store.get(tickAtom);
		await harness.send();
		assert.equal(store.get(tickAtom), before + (outcome === "accepted" ? 1 : 0));
	});
}

test("switching focus does not cancel a valid send on its original Session", async () => {
	const delivery = createDeferred();
	const started = createDeferred();
	const harness = createSendHarness({
		sessionId: SESSION_ID,
		sendPrompt: () => {
			started.resolve();
			return delivery.promise;
		},
	});
	const pending = harness.send();
	await started.promise;
	const { store, atoms } = harness;
	store.set(atoms.currentSessionIdAtom, "unrelated-session");
	delivery.resolve({ accepted: true, agentId: "current-agent", runtimeGeneration: 1, sessionPath: "/current.jsonl" });
	await pending;
	assert.equal(store.get(atoms.currentSessionIdAtom), "unrelated-session");
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)[SESSION_ID].agentId, "current-agent");
	assert.equal(store.get(atoms.sessionRecordsAtom)[SESSION_ID].filePath, "/current.jsonl");
	assert.deepEqual(harness.history, [{ sessionId: SESSION_ID, message: "read &reference" }]);
	assert.equal(store.get(atoms.sessionDraftByIdAtom)["unrelated-session"], "leave this draft alone");
});
