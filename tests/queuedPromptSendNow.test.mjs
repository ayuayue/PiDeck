import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { promotePrompt } from "../src/renderer/src/utils/queuedPromptQueue.ts";
import { queuedPrompt, queuedPromptHarness } from "./helpers/queuedPromptHarness.mjs";

// ---------------------------------------------------------------------------
// promotePrompt
// ---------------------------------------------------------------------------

test("promotePrompt moves the chosen prompt to the head and keeps the rest in order", () => {
	const before = {
		a: [queuedPrompt("one"), queuedPrompt("two"), queuedPrompt("three")],
	};
	const after = promotePrompt(before, "a", "three");
	assert.deepEqual(
		after.a.map((prompt) => prompt.id),
		["three", "one", "two"],
	);
	assert.deepEqual(
		before.a.map((prompt) => prompt.id),
		["one", "two", "three"],
		"source queue is not mutated",
	);
});

test("promotePrompt revives a failed prompt so it can be dispatched again", () => {
	const before = { a: [queuedPrompt("one"), { ...queuedPrompt("two"), status: "failed", error: "boom" }] };
	const after = promotePrompt(before, "a", "two");
	assert.equal(after.a[0].id, "two");
	assert.equal(after.a[0].status, "pending");
	assert.equal(after.a[0].error, undefined);
});

test("promotePrompt leaves queues untouched for unknown prompts", () => {
	const before = { a: [queuedPrompt("one")] };
	assert.equal(promotePrompt(before, "a", "missing").a, before.a);
	assert.equal(promotePrompt(before, "other", "one").other, undefined);
});

// ---------------------------------------------------------------------------
// sendQueuedPromptNow
// ---------------------------------------------------------------------------

test("send now dispatches the chosen prompt immediately when the session is idle", () => {
	const h = queuedPromptHarness({ status: "idle" });
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("first"));
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("second"));
	h.queue.sendQueuedPromptNow("A", "second");
	assert.equal(h.submissions.length, 1, "one dispatch, without waiting for the head");
	assert.equal(h.submissions[0][1], "expanded:second");
	assert.equal(h.queue.queuedPromptsRef.current.A[0].id, "second");
	assert.equal(h.queue.queuedPromptsRef.current.A[0].status, "sending", "the promoted prompt is claimed before the untouched head");
	h.unmount();
});

test("send now clears the auto-drain suppression left behind by a stopped turn", () => {
	const h = queuedPromptHarness({ status: "running" });
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("held"));
	h.queue.suppressSessionQueueAutoDrain("A");
	h.setRuntime("A", "idle");
	assert.equal(h.queue.canFlushQueuedPrompt("A"), false, "a stopped turn keeps automatic sends paused");
	h.queue.sendQueuedPromptNow("A", "held");
	assert.equal(h.submissions.length, 1, "an explicit send must not stay blocked by the pause");
	assert.equal(h.submissions[0][1], "expanded:held");
	h.unmount();
});

test("send now on a busy ACP session only promotes: the turn it cannot steer into is stopped first", () => {
	const h = queuedPromptHarness({ status: "idle" });
	h.addSession("C", "running", 1, "acp");
	h.setRuntime("C", "running", 1, { isTurnActive: true });
	h.queue.enqueueQueuedPrompt("C", queuedPrompt("other"));
	h.queue.enqueueQueuedPrompt("C", queuedPrompt("wanted"));
	h.queue.sendQueuedPromptNow("C", "wanted");
	assert.equal(h.submissions.length, 0, "ACP rejects prompts mid-turn, so nothing is dispatched yet");
	assert.deepEqual(
		[...h.queue.queuedPromptsRef.current.C].map((prompt) => prompt.displayText),
		["wanted", "other"],
		"the chosen prompt takes the head so the next turn sends it first",
	);
	h.setRuntime("C", "idle", 1, { isTurnActive: false });
	void h.queue.flushNextQueuedPrompt("C");
	assert.equal(h.submissions.length, 1);
	assert.equal(h.submissions[0][1], "expanded:wanted");
	h.unmount();
});

test("send now on a busy pi session inserts the prompt into the running turn as a steer", () => {
	const h = queuedPromptHarness({ status: "running" });
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("later"));
	h.queue.sendQueuedPromptNow("A", "later");
	assert.equal(h.submissions.length, 1);
	assert.equal(h.submissions[0][1], "expanded:later");
	assert.equal(h.submissions[0][3], "steer", "pi can steer, so no stop is needed");
	assert.equal(h.queue.queuedPromptsRef.current.A[0].behavior, "steer");
	h.unmount();
});

// ---------------------------------------------------------------------------
// 接线顺序：停止会同步置「停止后不自动投递」抑制，先发后停就永远发不出去
// ---------------------------------------------------------------------------

test("the row stops the turn before handing the prompt to send-now", () => {
	const row = readFileSync("src/renderer/src/components/session/ComposerPanels.tsx", "utf8");
	const stop = row.indexOf("props.onStopTurn?.(props.sessionId)");
	const send = row.indexOf("props.onSendNow(props.sessionId, props.prompt.id)");
	assert.ok(stop > 0 && send > 0, "both handlers are wired on the row");
	assert.ok(stop < send, "stop first: abortAgent sets the drain suppression synchronously");
	assert.match(row, /const stopsTurn = props\.agentBusy && !props\.steerSupported;/);
});

test("services and App expose the send-now path", () => {
	const services = readFileSync("src/renderer/src/components/session/SessionPaneServices.tsx", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(services, /queueSendNow: \(sessionId: string, promptId: string\) => void;/);
	assert.match(services, /queueStopTurn\?: \(sessionId: string\) => void;/);
	assert.match(app, /queueSendNow: queue\.sendQueuedPromptNow,/);
	assert.match(app, /queueStopTurn: \(sessionId: string\) => void runSessionControl\(sessionId, "abort"\),/);
});
