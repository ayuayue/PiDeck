import assert from "node:assert/strict";
import test from "node:test";

import { acknowledgeUnknownPrompt, claimIdleHead, claimNextSteerPrompt, claimPrompt, enqueuePrompt, getQueuedPromptView, QUEUED_PROMPT_LIMIT, replaceSessionQueue, resolveClaimedPrompt, retractPrompt, retryFailedPrompt } from "../src/renderer/src/utils/queuedPromptQueue.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prompt(id, behavior = "followUp", status = "pending") {
	return {
		id,
		message: `expanded:${id}`,
		displayText: id,
		behavior,
		agentMode: "normal",
		timestamp: 1,
		status,
	};
}

function q(...items) {
	// Accept either strings (for shorthand) or full prompt objects.
	return items.map((item) => (typeof item === "string" ? prompt(item) : item));
}

// ---------------------------------------------------------------------------
// replaceSessionQueue
// ---------------------------------------------------------------------------

test("replaceSessionQueue creates a new Session key when none exists", () => {
	const result = replaceSessionQueue({}, "a", () => q("a1"));
	assert.deepEqual(
		result.a.map((p) => p.id),
		["a1"],
	);
});

test("replaceSessionQueue updates an existing Session key", () => {
	let queues = { a: q("a1") };
	queues = replaceSessionQueue(queues, "a", (queue) => [...queue, prompt("a2")]);
	assert.deepEqual(
		queues.a.map((p) => p.id),
		["a1", "a2"],
	);
});

test("replaceSessionQueue removes the Session key when queue becomes empty", () => {
	let queues = { a: q("a1"), b: q("b1") };
	queues = replaceSessionQueue(queues, "a", () => []);
	assert.equal(queues.a, undefined);
	assert.deepEqual(
		queues.b.map((p) => p.id),
		["b1"],
	);
});

test("replaceSessionQueue keeps other Session queues isolated", () => {
	let queues = { a: q("a1", "a2"), b: q("b1") };
	queues = replaceSessionQueue(queues, "a", () => q("a3"));
	assert.deepEqual(
		queues.a.map((p) => p.id),
		["a3"],
	);
	assert.deepEqual(
		queues.b.map((p) => p.id),
		["b1"],
	);
});

// ---------------------------------------------------------------------------
// enqueuePrompt — custom limit and boundary
// ---------------------------------------------------------------------------

test("enqueuePrompt respects a custom limit lower than the default", () => {
	let queues = {};
	for (let i = 0; i < 3; i += 1) {
		queues = enqueuePrompt(queues, "a", prompt(`p${i}`), 3);
	}
	assert.equal(queues.a.length, 3);
	const blocked = enqueuePrompt(queues, "a", prompt("overflow"), 3);
	assert.equal(blocked.a.length, 3);
	assert.equal(
		blocked.a.some((p) => p.id === "overflow"),
		false,
	);
});

test("enqueuePrompt returns identical map when limit is reached", () => {
	let queues = {};
	for (let i = 0; i < QUEUED_PROMPT_LIMIT; i += 1) {
		queues = enqueuePrompt(queues, "a", prompt(`p${i}`));
	}
	const blocked = enqueuePrompt(queues, "a", prompt("overflow"));
	// Must be the same object reference — no unnecessary copy.
	assert.strictEqual(blocked, queues);
});

test("enqueuePrompt with limit=0 rejects all items", () => {
	const queues = enqueuePrompt({}, "a", prompt("a1"), 0);
	assert.equal(queues.a, undefined);
});

test("enqueuePrompt always resets status to pending and clears error", () => {
	const dirty = { ...prompt("a1"), status: "failed", error: "prev-error" };
	const queues = enqueuePrompt({}, "a", dirty);
	const stored = queues.a[0];
	assert.equal(stored.status, "pending");
	assert.equal(stored.error, undefined);
});

test("enqueuePrompt preserves non-status fields", () => {
	const p = {
		id: "custom",
		message: "hello",
		displayText: "hello",
		behavior: "steer",
		agentMode: "architect",
		templateDescription: "tpl",
		timestamp: 999,
		images: [{ type: "image", data: "..." }],
	};
	const queues = enqueuePrompt({}, "a", p);
	const stored = queues.a[0];
	assert.equal(stored.id, "custom");
	assert.equal(stored.behavior, "steer");
	assert.equal(stored.agentMode, "architect");
	assert.equal(stored.templateDescription, "tpl");
	assert.equal(stored.timestamp, 999);
	assert.ok(stored.images);
});

// ---------------------------------------------------------------------------
// getQueuedPromptView — boundary values
// ---------------------------------------------------------------------------

test("getQueuedPromptView returns empty for empty queue", () => {
	const view = getQueuedPromptView([], 3);
	assert.deepEqual(view.visible, []);
	assert.equal(view.hiddenCount, 0);
});

test("getQueuedPromptView with zero visibleLimit returns all hidden", () => {
	const queue = q("a", "b", "c");
	const view = getQueuedPromptView(queue, 0);
	assert.deepEqual(view.visible, []);
	assert.equal(view.hiddenCount, 3);
});

test("getQueuedPromptView with negative visibleLimit treats it as zero", () => {
	const queue = q("a", "b");
	const view = getQueuedPromptView(queue, -5);
	assert.deepEqual(view.visible, []);
	assert.equal(view.hiddenCount, 2);
});

test("getQueuedPromptView with exact match shows all with no hidden", () => {
	const queue = q("a", "b", "c");
	const view = getQueuedPromptView(queue, 3);
	assert.deepEqual(
		view.visible.map((p) => p.id),
		["a", "b", "c"],
	);
	assert.equal(view.hiddenCount, 0);
});

test("getQueuedPromptView with larger visibleLimit than queue shows all", () => {
	const queue = q("a");
	const view = getQueuedPromptView(queue, 5);
	assert.equal(view.visible.length, 1);
	assert.equal(view.hiddenCount, 0);
});

// ---------------------------------------------------------------------------
// retryFailedPrompt — edge cases
// ---------------------------------------------------------------------------

test("retryFailedPrompt does nothing for non-existent prompt", () => {
	const queues = { a: q("a1") };
	const result = retryFailedPrompt(queues, "a", "nonexistent");
	assert.deepEqual(
		result.a.map((p) => p.status),
		["pending"],
	);
});

test("retryFailedPrompt does nothing for a pending prompt", () => {
	const queues = { a: q("a1") };
	const result = retryFailedPrompt(queues, "a", "a1");
	assert.equal(result.a[0].status, "pending");
});

test("retryFailedPrompt does nothing for a sending prompt", () => {
	const queues = { a: [prompt("a1", "followUp", "sending")] };
	const result = retryFailedPrompt(queues, "a", "a1");
	assert.equal(result.a[0].status, "sending");
});

test("retryFailedPrompt does nothing for an unknown prompt", () => {
	const queues = { a: [prompt("a1", "followUp", "unknown")] };
	const result = retryFailedPrompt(queues, "a", "a1");
	assert.equal(result.a[0].status, "unknown");
});

test("retryFailedPrompt transitions only the matching failed item to pending", () => {
	const queues = {
		a: q(prompt("p1", "followUp", "failed"), prompt("p2", "followUp", "failed")),
	};
	const result = retryFailedPrompt(queues, "a", "p1");
	assert.equal(result.a[0].status, "pending");
	assert.equal(result.a[0].error, undefined);
	assert.equal(result.a[1].status, "failed");
});

test("retryFailedPrompt clears error when resetting", () => {
	const queues = {
		a: [{ ...prompt("a1"), status: "failed", error: "something broke" }],
	};
	const result = retryFailedPrompt(queues, "a", "a1");
	assert.equal(result.a[0].status, "pending");
	assert.equal(result.a[0].error, undefined);
});

// ---------------------------------------------------------------------------
// retractPrompt — ordering and boundary
// ---------------------------------------------------------------------------

test("retractPrompt removes from middle while preserving order", () => {
	const queues = { a: q("a1", "a2", "a3") };
	const result = retractPrompt(queues, "a", "a2");
	assert.deepEqual(
		result.a.map((p) => p.id),
		["a1", "a3"],
	);
});

test("retractPrompt removes the only item and deletes the agent key", () => {
	const queues = { a: q("a1"), b: q("b1") };
	const result = retractPrompt(queues, "a", "a1");
	assert.equal(result.a, undefined);
	assert.deepEqual(
		result.b.map((p) => p.id),
		["b1"],
	);
});

test("retractPrompt does nothing when agent has no queue", () => {
	const queues = { a: q("a1") };
	const result = retractPrompt(queues, "b", "any");
	assert.deepEqual(result, queues);
});

test("retractPrompt does nothing for a sending prompt", () => {
	const queues = { a: [prompt("a1", "followUp", "sending")] };
	const result = retractPrompt(queues, "a", "a1");
	assert.deepEqual(result.a[0].status, "sending");
});

test("retractPrompt does nothing for an unknown prompt", () => {
	const queues = { a: [prompt("a1", "followUp", "unknown")] };
	const result = retractPrompt(queues, "a", "a1");
	assert.deepEqual(result.a[0].status, "unknown");
});

// ---------------------------------------------------------------------------
// acknowledgeUnknownPrompt — edge cases
// ---------------------------------------------------------------------------

test("acknowledgeUnknownPrompt only removes unknown items; leaves others intact", () => {
	const queues = {
		a: [prompt("p1", "followUp", "pending"), prompt("p2", "followUp", "unknown"), prompt("p3", "followUp", "failed")],
	};
	const result = acknowledgeUnknownPrompt(queues, "a", "p2");
	assert.deepEqual(
		result.a.map((p) => p.id),
		["p1", "p3"],
	);
});

test("acknowledgeUnknownPrompt does not remove a non-unknown item with same id", () => {
	const queues = { a: [prompt("a1", "followUp", "failed")] };
	// Should NOT remove because status is not "unknown"
	const result = acknowledgeUnknownPrompt(queues, "a", "a1");
	assert.equal(result.a.length, 1);
	assert.equal(result.a[0].id, "a1");
});

test("acknowledgeUnknownPrompt removes agent key when queue becomes empty", () => {
	const queues = { a: [prompt("a1", "followUp", "unknown")] };
	const result = acknowledgeUnknownPrompt(queues, "a", "a1");
	assert.equal(result.a, undefined);
});

test("acknowledgeUnknownPrompt does nothing for non-existent prompt", () => {
	const queues = { a: q("a1") };
	const result = acknowledgeUnknownPrompt(queues, "a", "nonexistent");
	assert.deepEqual(result, queues);
});

// ---------------------------------------------------------------------------
// claimPrompt — non-pending status barrier
// ---------------------------------------------------------------------------

test("claimPrompt returns no prompt for non-existent id", () => {
	const queues = { a: q("a1") };
	const claim = claimPrompt(queues, "a", "nonexistent");
	assert.equal(claim.prompt, undefined);
	assert.deepEqual(claim.queues, queues);
});

test("claimPrompt returns no prompt when status is sending", () => {
	const queues = { a: [prompt("a1", "followUp", "sending")] };
	const claim = claimPrompt(queues, "a", "a1");
	assert.equal(claim.prompt, undefined);
});

test("claimPrompt returns no prompt when status is failed", () => {
	const queues = { a: [prompt("a1", "followUp", "failed")] };
	const claim = claimPrompt(queues, "a", "a1");
	assert.equal(claim.prompt, undefined);
});

test("claimPrompt returns no prompt when status is unknown", () => {
	const queues = { a: [prompt("a1", "followUp", "unknown")] };
	const claim = claimPrompt(queues, "a", "a1");
	assert.equal(claim.prompt, undefined);
});

test("claimPrompt transitions status to sending on successful claim", () => {
	const queues = { a: q("a1") };
	const claim = claimPrompt(queues, "a", "a1");
	assert.ok(claim.prompt);
	assert.equal(claim.prompt.id, "a1");
	assert.equal(claim.queues.a[0].status, "sending");
});

test("claimPrompt clears error on successful claim", () => {
	const queues = { a: [{ ...prompt("a1"), error: "stale" }] };
	const claim = claimPrompt(queues, "a", "a1");
	assert.equal(claim.queues.a[0].error, undefined);
});

// ---------------------------------------------------------------------------
// claimIdleHead — empty / barrier scenarios
// ---------------------------------------------------------------------------

test("claimIdleHead returns undefined for empty queue", () => {
	const queues = { a: [] };
	const claim = claimIdleHead(queues, "a");
	assert.equal(claim.prompt, undefined);
});

test("claimIdleHead returns undefined when agent has no entries", () => {
	const claim = claimIdleHead({}, "a");
	assert.equal(claim.prompt, undefined);
});

test("claimIdleHead claims the head even if later items are failed", () => {
	const queues = { a: [prompt("p1"), prompt("p2", "followUp", "failed")] };
	const claim = claimIdleHead(queues, "a");
	assert.equal(claim.prompt.id, "p1");
	assert.equal(claim.queues.a[0].status, "sending");
});

// ---------------------------------------------------------------------------
// resolveClaimedPrompt — non-sending and boundary
// ---------------------------------------------------------------------------

test("resolveClaimedPrompt with accepted removes the item", () => {
	let queues = { a: [prompt("a1", "followUp", "sending")] };
	queues = resolveClaimedPrompt(queues, "a", "a1", { type: "accepted" });
	assert.equal(queues.a, undefined);
});

test("resolveClaimedPrompt with failed sets status to failed", () => {
	let queues = { a: [prompt("a1", "followUp", "sending")] };
	queues = resolveClaimedPrompt(queues, "a", "a1", {
		type: "failed",
		error: "boom",
	});
	assert.equal(queues.a[0].status, "failed");
	assert.equal(queues.a[0].error, "boom");
});

test("resolveClaimedPrompt with unknown sets status to unknown", () => {
	let queues = { a: [prompt("a1", "followUp", "sending")] };
	queues = resolveClaimedPrompt(queues, "a", "a1", {
		type: "unknown",
		error: "timeout",
	});
	assert.equal(queues.a[0].status, "unknown");
	assert.equal(queues.a[0].error, "timeout");
});

test("resolveClaimedPrompt does nothing when prompt is not sending", () => {
	let queues = { a: [prompt("a1", "followUp", "pending")] };
	queues = resolveClaimedPrompt(queues, "a", "a1", { type: "accepted" });
	assert.equal(queues.a.length, 1);
	assert.equal(queues.a[0].status, "pending");
});

test("resolveClaimedPrompt does nothing for non-existent prompt", () => {
	let queues = { a: q("a1") };
	queues = resolveClaimedPrompt(queues, "a", "nonexistent", { type: "accepted" });
	assert.deepEqual(
		queues.a.map((p) => p.id),
		["a1"],
	);
});

test("resolveClaimedPrompt only removes matching item; preserves others", () => {
	let queues = {
		a: [prompt("p1", "followUp", "sending"), prompt("p2", "followUp", "pending"), prompt("p3", "followUp", "sending")],
	};
	queues = resolveClaimedPrompt(queues, "a", "p1", { type: "accepted" });
	assert.deepEqual(
		queues.a.map((p) => p.id),
		["p2", "p3"],
	);
	assert.equal(queues.a[1].status, "sending");
});

// ---------------------------------------------------------------------------
// claimNextSteerPrompt — ordering barriers and mixed modes
// ---------------------------------------------------------------------------

test("claimNextSteerPrompt skips pending followUp to claim a later steer", () => {
	const queues = {
		a: [prompt("f1", "followUp"), prompt("s1", "steer")],
	};
	const claim = claimNextSteerPrompt(queues, "a");
	assert.equal(claim.prompt.id, "s1");
	assert.equal(claim.queues.a[0].status, "pending"); // f1 untouched
	assert.equal(claim.queues.a[1].status, "sending");
});

test("claimNextSteerPrompt returns undefined when all entries are followUp", () => {
	const queues = { a: q(prompt("f1"), prompt("f2")) };
	const claim = claimNextSteerPrompt(queues, "a");
	assert.equal(claim.prompt, undefined);
});

test("claimNextSteerPrompt returns undefined for empty agent queue", () => {
	const claim = claimNextSteerPrompt({}, "a");
	assert.equal(claim.prompt, undefined);
});

test("claimNextSteerPrompt blocks on a sending predecessor regardless of mode", () => {
	const queues = {
		a: [prompt("f1", "followUp", "sending"), prompt("s1", "steer")],
	};
	const claim = claimNextSteerPrompt(queues, "a");
	assert.equal(claim.prompt, undefined);
});

test("claimNextSteerPrompt blocks on a failed predecessor regardless of mode", () => {
	const queues = {
		a: [prompt("f1", "followUp", "failed"), prompt("s1", "steer")],
	};
	const claim = claimNextSteerPrompt(queues, "a");
	assert.equal(claim.prompt, undefined);
});

test("claimNextSteerPrompt blocks on an unknown predecessor regardless of mode", () => {
	const queues = {
		a: [prompt("f1", "followUp", "unknown"), prompt("s1", "steer")],
	};
	const claim = claimNextSteerPrompt(queues, "a");
	assert.equal(claim.prompt, undefined);
});

// ---------------------------------------------------------------------------
// Cross-Session isolation
// ---------------------------------------------------------------------------

test("operations on one agent never affect another agent's queue", () => {
	let queues = {
		a: q("a1", "a2"),
		b: q("b1", "b2"),
	};

	// Enqueue on a.
	queues = enqueuePrompt(queues, "a", prompt("a3"));
	assert.equal(queues.a.length, 3);
	assert.equal(queues.b.length, 2);

	// Retract from b.
	queues = retractPrompt(queues, "b", "b1");
	assert.equal(queues.a.length, 3);
	assert.equal(queues.b.length, 1);

	// Claim idle on a.
	const claim = claimIdleHead(queues, "a");
	assert.equal(claim.prompt.id, "a1");
	assert.equal(claim.queues.b.length, 1);
	assert.equal(claim.queues.b[0].id, "b2");
});

// ---------------------------------------------------------------------------
// FIFO ordering integrity
// ---------------------------------------------------------------------------

test("enqueue preserves FIFO order within a single agent queue", () => {
	let queues = {};
	const ids = [];
	for (let i = 0; i < 5; i += 1) {
		const id = `p${i}`;
		ids.push(id);
		queues = enqueuePrompt(queues, "a", prompt(id));
	}
	assert.deepEqual(
		queues.a.map((p) => p.id),
		ids,
	);
});

test("drain claims head in FIFO order across successive idle-head claims", () => {
	let queues = { a: q("p1", "p2", "p3") };

	// Claim first.
	let claim = claimIdleHead(queues, "a");
	queues = claim.queues;
	assert.equal(claim.prompt.id, "p1");
	assert.equal(queues.a[0].status, "sending");

	// Resolve first as accepted.
	queues = resolveClaimedPrompt(queues, "a", "p1", { type: "accepted" });
	assert.equal(queues.a.length, 2);
	assert.equal(queues.a[0].id, "p2");

	// Claim second.
	claim = claimIdleHead(queues, "a");
	assert.equal(claim.prompt.id, "p2");

	// Resolve second as accepted.
	queues = resolveClaimedPrompt(claim.queues, "a", "p2", { type: "accepted" });

	// Claim third.
	claim = claimIdleHead(queues, "a");
	assert.equal(claim.prompt.id, "p3");
});

// ---------------------------------------------------------------------------
// Status lifecycle: pending → sending → (accepted | failed | unknown)
// ---------------------------------------------------------------------------

test("pending → sending → accepted lifecycle removes the item", () => {
	let queues = enqueuePrompt({}, "a", prompt("msg"));
	assert.equal(queues.a[0].status, "pending");

	const claim = claimIdleHead(queues, "a");
	assert.equal(claim.queues.a[0].status, "sending");

	queues = resolveClaimedPrompt(claim.queues, "a", "msg", { type: "accepted" });
	assert.equal(queues.a, undefined);
});

test("pending → sending → failed lifecycle preserves item with failed status", () => {
	let queues = enqueuePrompt({}, "a", prompt("msg"));
	const claim = claimIdleHead(queues, "a");
	queues = resolveClaimedPrompt(claim.queues, "a", "msg", {
		type: "failed",
		error: "rejected",
	});
	assert.equal(queues.a[0].status, "failed");
	assert.equal(queues.a[0].error, "rejected");
});

test("pending → sending → unknown lifecycle preserves item with unknown status", () => {
	let queues = enqueuePrompt({}, "a", prompt("msg"));
	const claim = claimIdleHead(queues, "a");
	queues = resolveClaimedPrompt(claim.queues, "a", "msg", {
		type: "unknown",
		error: "RPC timeout",
	});
	assert.equal(queues.a[0].status, "unknown");
	assert.equal(queues.a[0].error, "RPC timeout");
});

test("failed → retry → pending → sending → accepted full recovery cycle", () => {
	// Enqueue
	let queues = enqueuePrompt({}, "a", prompt("msg"));

	// Claim and fail
	let claim = claimIdleHead(queues, "a");
	queues = resolveClaimedPrompt(claim.queues, "a", "msg", {
		type: "failed",
		error: "err",
	});
	assert.equal(queues.a[0].status, "failed");

	// Retry
	queues = retryFailedPrompt(queues, "a", "msg");
	assert.equal(queues.a[0].status, "pending");
	assert.equal(queues.a[0].error, undefined);

	// Claim and accept
	claim = claimIdleHead(queues, "a");
	assert.equal(claim.prompt.id, "msg");
	queues = resolveClaimedPrompt(claim.queues, "a", "msg", { type: "accepted" });
	assert.equal(queues.a, undefined);
});

// ---------------------------------------------------------------------------
// Unknown delivery barrier — comprehensive
// ---------------------------------------------------------------------------

test("unknown entry blocks idle head drain when it is at the front", () => {
	const queues = {
		a: [prompt("u1", "followUp", "unknown"), prompt("p1", "followUp", "pending")],
	};
	const claim = claimIdleHead(queues, "a");
	// claimIdleHead delegates to claimPrompt which blocks on non-pending.
	assert.equal(claim.prompt, undefined);
});

test("unknown entry blocks steer drain", () => {
	const queues = {
		a: [prompt("u1", "followUp", "unknown"), prompt("s1", "steer")],
	};
	const claim = claimNextSteerPrompt(queues, "a");
	assert.equal(claim.prompt, undefined);
});

test("after acknowledging unknown, subsequent entries become claimable", () => {
	let queues = {
		a: [prompt("u1", "followUp", "unknown"), prompt("s1", "steer")],
	};
	queues = acknowledgeUnknownPrompt(queues, "a", "u1");
	assert.equal(queues.a.length, 1);
	assert.equal(queues.a[0].id, "s1");

	const claim = claimNextSteerPrompt(queues, "a");
	assert.equal(claim.prompt.id, "s1");
});

test("unknown barrier prevents idle drain but not retract/discard of later items", () => {
	const queues = {
		a: [prompt("u1", "followUp", "unknown"), prompt("p1", "followUp", "pending"), prompt("p2", "followUp", "pending")],
	};
	// Cannot claim head.
	assert.equal(claimIdleHead(queues, "a").prompt, undefined);

	// But CAN retract later pending items.
	let result = retractPrompt(queues, "a", "p1");
	assert.deepEqual(
		result.a.map((p) => p.id),
		["u1", "p2"],
	);

	// And CAN discard the unknown item itself.
	result = acknowledgeUnknownPrompt(queues, "a", "u1");
	assert.deepEqual(
		result.a.map((p) => p.id),
		["p1", "p2"],
	);
});
