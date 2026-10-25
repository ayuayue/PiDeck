import assert from "node:assert/strict";
import test from "node:test";
import { deferredQueueResult, queuedPrompt, queuedPromptHarness } from "./helpers/queuedPromptHarness.mjs";

for (const behavior of ["followUp", "steer"]) {
	const flush = (harness, sessionId = "A") => (behavior === "steer" ? harness.queue.flushQueuedSteerPrompts(sessionId) : harness.queue.flushNextQueuedPrompt(sessionId));
	const status = behavior === "steer" ? "running" : "idle";

	test(`${behavior}: unmount releases in-flight timeout and does not dispatch later messages`, async () => {
		const response = deferredQueueResult();
		const h = queuedPromptHarness({ status, dispatch: () => response.promise });
		h.queue.enqueueQueuedPrompt("A", queuedPrompt("one", behavior));
		h.queue.enqueueQueuedPrompt("A", queuedPrompt("two", behavior));
		const sending = flush(h);
		assert.equal(h.submissions.length, 1);
		h.unmount();
		response.resolve();
		await sending;
		h.fireTimers(150);
		assert.equal(h.submissions.length, 1, "unmounted queue cannot continue sending");
		assert.equal(h.notices.length, 0);
		assert.equal(h.timers.size, 0, "all queue timers must be released");
		assert.equal(h.queueFlushBySessionRef.current.size, 0);
	});

	test(`${behavior}: late rejection after unmount is silent`, async () => {
		const response = deferredQueueResult();
		const h = queuedPromptHarness({ status, dispatch: () => response.promise });
		h.queue.enqueueQueuedPrompt("A", queuedPrompt("one", behavior));
		const sending = flush(h);
		h.unmount();
		response.reject(new Error("old request failed"));
		await sending;
		assert.equal(h.notices.length, 0);
		assert.equal(h.timers.size, 0);
	});

	test(`${behavior}: deleted session releases its queue without a stale error`, async () => {
		const response = deferredQueueResult();
		const h = queuedPromptHarness({ status, dispatch: () => response.promise });
		h.queue.enqueueQueuedPrompt("A", queuedPrompt("one", behavior));
		h.queue.enqueueQueuedPrompt("B", queuedPrompt("other"));
		const sending = flush(h);
		h.removeSession("A");
		response.reject(new Error("session was removed"));
		await sending;
		assert.equal(h.queue.queuedPromptsRef.current.A, undefined);
		assert.equal(h.queue.queuedPromptsRef.current.B[0].id, "other");
		assert.equal(h.notices.length, 0);
		assert.equal(h.queueFlushBySessionRef.current.has("A"), false);
	});

	test(`${behavior}: runtime replacement cannot inherit old flush continuation`, async () => {
		const response = deferredQueueResult();
		const h = queuedPromptHarness({ status, dispatch: () => response.promise });
		h.queue.enqueueQueuedPrompt("A", queuedPrompt("one", behavior));
		h.queue.enqueueQueuedPrompt("A", queuedPrompt("two", behavior));
		const sending = flush(h);
		h.setRuntime("A", status, 2);
		response.resolve();
		await sending;
		h.fireTimers(150);
		assert.equal(h.submissions.length, 1, "only a fresh runtime event may start another drain");
		assert.equal(h.queue.queuedPromptsRef.current.A[0].id, "two");
		assert.equal(h.queue.queuedPromptsRef.current.A[0].status, "pending");
	});

	test(`${behavior}: focus changes do not redirect pending delivery`, async () => {
		const response = deferredQueueResult();
		const h = queuedPromptHarness({ status, dispatch: () => response.promise });
		h.queue.enqueueQueuedPrompt("A", queuedPrompt("one", behavior));
		const sending = flush(h);
		h.selectSession("B");
		response.resolve();
		await sending;
		assert.equal(h.submissions.length, 1);
		assert.equal(h.submissions[0][0], "A");
		assert.equal(h.queue.queuedPromptsRef.current.A, undefined);
		h.unmount();
	});
}

test("session removal clears a waiting queue even without an outstanding dispatch", () => {
	const h = queuedPromptHarness();
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("one"));
	h.removeSession("A");
	assert.equal(h.queue.queuedPromptsRef.current.A, undefined);
	assert.equal(h.queue.enqueueQueuedPrompt("A", queuedPrompt("stale")), false);
	h.unmount();
});

test("catalog source switch keeps the queue dormant while the runtime binding survives", async () => {
	const h = queuedPromptHarness();
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("one"));
	// 目录刷新把记录移除（源切换/扫描滞后），runtime 绑定仍在：队列保留休眠，不投递。
	h.store.set(h.atoms.replaceProjectSessionsAtom, { projectId: "project", sessions: [h.store.get(h.atoms.sessionRecordsAtom).B] });
	await h.queue.flushNextQueuedPrompt("A");
	assert.equal(h.submissions.length, 0);
	assert.equal(h.queue.queuedPromptsRef.current.A[0].id, "one");
	// runtime 绑定也解绑（真正删除）：队列立即清空。
	h.store.set(h.atoms.sessionRuntimeByIdAtom, (current) => {
		const next = { ...current };
		delete next.A;
		return next;
	});
	assert.equal(h.queue.queuedPromptsRef.current.A, undefined);
	h.unmount();
});

test("successful dispatch clears its send timeout and unmount cancels idle continuation", async () => {
	const h = queuedPromptHarness();
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("one"));
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("two"));
	await h.queue.flushNextQueuedPrompt("A");
	assert.equal([...h.timers.values()].filter((timer) => timer.delay === 30_000).length, 0);
	assert.equal([...h.timers.values()].filter((timer) => timer.delay === 150).length, 1);
	h.unmount();
	assert.equal(h.timers.size, 0);
	h.fireTimers(150);
	assert.equal(h.submissions.length, 1);
});

test("late settlement cannot release a newer flush after deleting and recreating a session", async () => {
	const oldResponse = deferredQueueResult();
	const newResponse = deferredQueueResult();
	const h = queuedPromptHarness({ dispatch: (_sessionId, message) => (message === "expanded:old" ? oldResponse.promise : newResponse.promise) });
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("old"));
	const oldSending = h.queue.flushNextQueuedPrompt("A");
	h.removeSession("A");
	h.addSession("A", "idle", 2);
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("new"));
	const newSending = h.queue.flushNextQueuedPrompt("A");
	assert.equal(h.submissions.length, 2, "removed session must release only its old lock");
	oldResponse.resolve();
	await oldSending;
	assert.equal(h.queueFlushBySessionRef.current.has("A"), true);
	assert.equal(h.queue.queuedPromptsRef.current.A[0].id, "new");
	assert.equal(h.queue.queuedPromptsRef.current.A[0].status, "sending");
	newResponse.resolve();
	await newSending;
	assert.equal(h.queue.queuedPromptsRef.current.A, undefined);
	h.unmount();
});

test("idle continuation scheduled before a runtime replacement does not send to the replacement", async () => {
	const h = queuedPromptHarness();
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("one"));
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("two"));
	await h.queue.flushNextQueuedPrompt("A");
	h.setRuntime("A", "idle", 2);
	h.fireTimers(150);
	assert.equal(h.submissions.length, 1);
	assert.equal(h.queue.queuedPromptsRef.current.A[0].status, "pending");
	await h.queue.flushNextQueuedPrompt("A");
	assert.equal(h.submissions.length, 2, "a fresh drain can still send the unsent message");
	h.unmount();
});

test("timeout is unknown and late acceptance never retries or removes the warning", async () => {
	const response = deferredQueueResult();
	const h = queuedPromptHarness({ dispatch: () => response.promise });
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("one"));
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("two"));
	const sending = h.queue.flushNextQueuedPrompt("A");
	h.fireTimers(30_000);
	await sending;
	assert.equal(h.queue.queuedPromptsRef.current.A[0].status, "unknown");
	assert.equal(h.notices[0][0], "delivery unknown");
	response.resolve();
	await response.promise;
	h.fireTimers(150);
	await h.queue.flushNextQueuedPrompt("A");
	assert.equal(h.submissions.length, 1);
	assert.equal(h.queue.queuedPromptsRef.current.A[0].status, "unknown");
	h.unmount();
});

test("retract-to-edit does not focus a newly selected session on the next frame", () => {
	const h = queuedPromptHarness();
	const prompt = queuedPrompt("one");
	h.queue.enqueueQueuedPrompt("A", prompt);
	h.queue.retractQueuedPromptForEdit("A", prompt);
	h.selectSession("B");
	h.fireFrames();
	assert.equal(h.store.get(h.atoms.sessionDraftByIdAtom).A, "one");
	assert.equal(h.store.get(h.atoms.sessionDraftByIdAtom).B, undefined);
	assert.deepEqual(h.focused, []);
	h.unmount();
});

test("retract-to-edit frame is cancelled on unmount", () => {
	const h = queuedPromptHarness();
	const prompt = queuedPrompt("one");
	h.queue.enqueueQueuedPrompt("A", prompt);
	h.queue.retractQueuedPromptForEdit("A", prompt);
	h.unmount();
	h.fireFrames();
	assert.deepEqual(h.focused, []);
	assert.equal(h.frames.size, 0);
});
