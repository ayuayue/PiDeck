import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

import {
	acknowledgeUnknownPrompt,
	canDiscardQueuedPrompt,
	canRetractQueuedPromptToInput,
	claimIdleHead,
	claimNextSteerPrompt,
	canChangeQueuedPromptBehavior,
	claimPrompt,
	discardControlHint,
	enqueuePrompt,
	getQueuedPromptView,
	resolveClaimedPrompt,
	retractControlHint,
	retractPrompt,
	retryFailedPrompt,
	updateQueuedPromptBehavior,
} from "../src/renderer/src/utils/queuedPromptQueue.ts";
import { updateActiveToolCalls } from "../src/shared/toolRuntimeState.ts";

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

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

test("atomic claim allows one dispatch even when idle and tool-end race", async () => {
	let queues = { agentA: [prompt("one", "steer")] };
	const response = deferred();
	let submissions = 0;

	async function dispatchNextSteer() {
		const claim = claimNextSteerPrompt(queues, "agentA");
		queues = claim.queues;
		if (!claim.prompt) return false;
		submissions += 1;
		await response.promise;
		queues = resolveClaimedPrompt(queues, "agentA", claim.prompt.id, {
			type: "accepted",
		});
		return true;
	}

	const pendingDispatch = dispatchNextSteer();
	const idleClaim = claimIdleHead(queues, "agentA");
	queues = idleClaim.queues;

	assert.equal(submissions, 1);
	assert.equal(idleClaim.prompt, undefined);
	assert.equal(queues.agentA[0].status, "sending");

	response.resolve();
	await pendingDispatch;
	assert.deepEqual(queues, {});
});

test("idle drain claims only the head and blocks behind failed or unknown", () => {
	let queues = { agentA: [prompt("one"), prompt("two")] };
	const first = claimIdleHead(queues, "agentA");
	queues = first.queues;
	assert.equal(first.prompt.id, "one");
	assert.equal(queues.agentA[0].status, "sending");
	assert.equal(queues.agentA[1].status, "pending");

	queues = resolveClaimedPrompt(queues, "agentA", "one", {
		type: "failed",
		error: "rejected",
	});
	assert.equal(claimIdleHead(queues, "agentA").prompt, undefined);

	queues = retryFailedPrompt(queues, "agentA", "one");
	assert.equal(claimIdleHead(queues, "agentA").prompt.id, "one");

	queues = { agentA: [prompt("unknown", "followUp", "unknown"), prompt("later")] };
	assert.equal(claimIdleHead(queues, "agentA").prompt, undefined);
});

test("cancel and edit eligibility end at the atomic sending boundary", () => {
	let queues = { agentA: [prompt("pending")], agentB: [prompt("other")] };
	queues = retractPrompt(queues, "agentA", "pending");
	assert.equal(queues.agentA, undefined);
	assert.equal(queues.agentB.length, 1, "another agent queue must stay isolated");

	const sendingQueues = { agentA: [prompt("sending", "followUp", "sending")] };
	queues = retractPrompt(sendingQueues, "agentA", "sending");
	assert.deepEqual(queues, sendingQueues);

	const unknownQueues = { agentA: [prompt("unknown", "followUp", "unknown")] };
	queues = retractPrompt(unknownQueues, "agentA", "unknown");
	assert.deepEqual(queues, unknownQueues);
	queues = acknowledgeUnknownPrompt(queues, "agentA", "unknown");
	assert.deepEqual(queues, {});
});

test("control hints explain disabled state for retract and discard", () => {
	// 可撤回
	assert.deepEqual(retractControlHint("pending"), { disabled: false });
	assert.deepEqual(retractControlHint("failed"), { disabled: false });
	// sending/unknown 撤回被禁用并给出原因
	assert.deepEqual(retractControlHint("sending"), { disabled: true, reason: "sending" });
	assert.deepEqual(retractControlHint("unknown"), { disabled: true, reason: "unknown" });
	// 只有 sending 丢弃被禁用
	assert.deepEqual(discardControlHint("pending"), { disabled: false });
	assert.deepEqual(discardControlHint("unknown"), { disabled: false });
	assert.deepEqual(discardControlHint("sending"), { disabled: true, reason: "sending" });
	assert.equal(canChangeQueuedPromptBehavior("pending"), true);
	assert.equal(canChangeQueuedPromptBehavior("failed"), true);
	assert.equal(canChangeQueuedPromptBehavior("sending"), false);
	assert.equal(canChangeQueuedPromptBehavior("unknown"), false);
});

test("pending queue items can switch between steer and followUp", () => {
	let queues = { agentA: [prompt("one", "followUp"), prompt("two", "steer")] };
	queues = updateQueuedPromptBehavior(queues, "agentA", "one", "steer");
	assert.equal(queues.agentA[0].behavior, "steer");
	assert.equal(queues.agentA[1].behavior, "steer");

	const sending = { agentA: [prompt("live", "followUp", "sending")] };
	assert.deepEqual(updateQueuedPromptBehavior(sending, "agentA", "live", "steer"), sending);
	const unknown = { agentA: [prompt("lost", "followUp", "unknown")] };
	assert.deepEqual(updateQueuedPromptBehavior(unknown, "agentA", "lost", "steer"), unknown);
});

test("unknown delivery cannot be reclaimed or retried after a deferred response fails", async () => {
	let queues = { agentA: [prompt("one")] };
	const claim = claimPrompt(queues, "agentA", "one");
	queues = claim.queues;
	const response = deferred();
	let submissions = 1;

	const completion = response.promise.catch((error) => {
		queues = resolveClaimedPrompt(queues, "agentA", "one", {
			type: "unknown",
			error: error.message,
		});
	});
	response.reject(new Error("RPC response timed out after stdin write"));
	await completion;

	assert.equal(queues.agentA[0].status, "unknown");
	queues = retryFailedPrompt(queues, "agentA", "one");
	const retry = claimPrompt(queues, "agentA", "one");
	if (retry.prompt) submissions += 1;
	assert.equal(retry.prompt, undefined);
	assert.equal(submissions, 1, "indeterminate delivery must never submit twice");
});

test("steer claims exactly one item and treats failed or unknown as an ordering barrier", () => {
	let queues = {
		agentA: [prompt("steer-1", "steer"), prompt("follow", "followUp"), prompt("steer-2", "steer")],
	};
	let claimed = claimNextSteerPrompt(queues, "agentA");
	queues = claimed.queues;
	assert.equal(claimed.prompt.id, "steer-1");
	assert.deepEqual(
		queues.agentA.map((item) => item.status),
		["sending", "pending", "pending"],
	);
	assert.equal(claimNextSteerPrompt(queues, "agentA").prompt, undefined);

	queues = resolveClaimedPrompt(queues, "agentA", "steer-1", {
		type: "failed",
		error: "rejected",
	});
	claimed = claimNextSteerPrompt(queues, "agentA");
	assert.equal(claimed.prompt, undefined, "later steer must not overtake a failed predecessor");

	queues = { agentA: [prompt("failed-followup", "followUp", "failed"), prompt("later", "steer")] };
	assert.equal(claimNextSteerPrompt(queues, "agentA").prompt, undefined, "a failed predecessor of either mode must block later steer delivery");

	queues = { agentA: [prompt("unknown", "steer", "unknown"), prompt("later", "steer")] };
	assert.equal(claimNextSteerPrompt(queues, "agentA").prompt, undefined);
});

test("the second steer RPC cannot begin before the first is accepted", async () => {
	let queues = { agentA: [prompt("first", "steer"), prompt("second", "steer")] };
	const firstResponse = deferred();
	const sent = [];

	async function drainOne(response) {
		const claimed = claimNextSteerPrompt(queues, "agentA");
		queues = claimed.queues;
		if (!claimed.prompt) return;
		sent.push(claimed.prompt.id);
		await response;
		queues = resolveClaimedPrompt(queues, "agentA", claimed.prompt.id, {
			type: "accepted",
		});
	}

	const first = drainOne(firstResponse.promise);
	assert.deepEqual(sent, ["first"]);
	assert.equal(claimNextSteerPrompt(queues, "agentA").prompt, undefined);
	firstResponse.resolve();
	await first;
	await drainOne(Promise.resolve());
	assert.deepEqual(sent, ["first", "second"]);
});

test("parallel tools complete only after the final toolCallId ends", () => {
	let calls = new Map();
	let state = updateActiveToolCalls(calls, {
		type: "start",
		toolCallId: "a",
		toolName: "read",
	});
	calls = state.calls;
	assert.equal(state.isExecutingTool, true);
	assert.equal(state.completedBatch, false);

	state = updateActiveToolCalls(calls, {
		type: "start",
		toolCallId: "b",
		toolName: "bash",
	});
	calls = state.calls;
	assert.equal(state.executingToolName, "bash");

	state = updateActiveToolCalls(calls, { type: "end", toolCallId: "a" });
	calls = state.calls;
	assert.equal(state.isExecutingTool, true);
	assert.equal(state.completedBatch, false);

	state = updateActiveToolCalls(calls, { type: "end", toolCallId: "b" });
	assert.equal(state.isExecutingTool, false);
	assert.equal(state.completedBatch, true);
});

test("immediate unknown snapshots stay visible and acknowledgement-only", () => {
	const sessionSendSource = readFileSync("src/renderer/src/hooks/useSessionSend.ts", "utf8");
	const composerPanelsSource = readFileSync("src/renderer/src/components/session/ComposerPanels.tsx", "utf8");
	assert.match(sessionSendSource, /outcome === "unknown"/);
	assert.match(sessionSendSource, /status: "unknown"[\s\S]*?unknownSnapshot: \{[\s\S]*?message/);
	assert.match(composerPanelsSource, /function SessionDeliveryNotice/);
	assert.match(composerPanelsSource, /status !== "unknown"/);
	assert.match(composerPanelsSource, /onAcknowledge/);
	// Unknown rows stay in the compact panel; discard may clear them, but retract-to-input stays disabled.
	assert.match(composerPanelsSource, /status === "unknown"/);
	assert.match(composerPanelsSource, /canRetractQueuedPromptToInput\(status\)/);
	assert.match(composerPanelsSource, /canDiscardQueuedPrompt\(status\)/);
	assert.equal(canRetractQueuedPromptToInput("pending"), true);
	assert.equal(canRetractQueuedPromptToInput("failed"), true);
	assert.equal(canRetractQueuedPromptToInput("sending"), false);
	assert.equal(canRetractQueuedPromptToInput("unknown"), false);
	assert.equal(canDiscardQueuedPrompt("pending"), true);
	assert.equal(canDiscardQueuedPrompt("unknown"), true);
	assert.equal(canDiscardQueuedPrompt("sending"), false);
});

test("the Session composer leaves the legacy agent queue behind an explicit runtime slot", () => {
	const areaSource = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	const controllerSource = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
	assert.match(areaSource, /queuePanel\?: ReactNode/);
	assert.doesNotMatch(controllerSource, /enqueuePrompt|claimIdleHead|claimNextSteerPrompt/);
});

test("browser prompt returns the received SendPromptResult before background state refresh", () => {
	const browserApiSource = readFileSync("src/renderer/src/browserApi.ts", "utf8");
	assert.match(browserApiSource, /void refreshState\(\)\.catch\(\(\) => undefined\);\s*return response\.result;/);
	assert.doesNotMatch(browserApiSource, /prompt: async[\s\S]*?await refreshState\(\);[\s\S]*?return response\.result;/);
});

test("layout budget uses compact queue chrome and terminal still yields first", () => {
	const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
	const layoutSource = readFileSync("src/renderer/src/hooks/useSessionLayout.ts", "utf8");
	const queueStateSource = readFileSync("src/renderer/src/utils/queuedPromptQueue.ts", "utf8");
	// ResizeObserver now lives in useSessionLayout.
	assert.match(layoutSource, /observer\.observe\(/);
	assert.match(layoutSource, /terminalRowHeight = input\.terminalCollapsed/);
	// The root passes queue cardinality to the layout owner; queue constants stay with the queue state machine.
	assert.match(appSource, /queuedPromptCount: activeQueuedPrompts\.length/);
	assert.match(queueStateSource, /export const QUEUED_PROMPT_VISIBLE = 3/);
	assert.match(appSource, /const activeQueuedPrompts = currentSessionId/);
	const composerPanelsSrc = readFileSync("src/renderer/src/components/session/ComposerPanels.tsx", "utf8");
	assert.match(composerPanelsSrc, /max-h-\[180px\]/);
});

test("enqueue is per-agent and accepted resolution removes only the claimed ID", () => {
	let queues = {};
	queues = enqueuePrompt(queues, "a", prompt("a1"));
	queues = enqueuePrompt(queues, "b", prompt("b1"));
	const claim = claimIdleHead(queues, "a");
	queues = resolveClaimedPrompt(claim.queues, "a", "a1", { type: "accepted" });
	assert.equal(queues.a, undefined);
	assert.equal(queues.b[0].id, "b1");
});

test("enqueue enforces the per-agent queue limit", () => {
	let queues = {};
	for (let i = 0; i < 10; i += 1) {
		queues = enqueuePrompt(queues, "a", prompt(`p${i}`));
	}
	assert.equal(queues.a.length, 10);
	const blocked = enqueuePrompt(queues, "a", prompt("overflow"));
	assert.equal(blocked.a.length, 10);
	assert.equal(
		blocked.a.some((item) => item.id === "overflow"),
		false,
	);
});

test("queue view shows at most three rows and reports the rest as hidden", () => {
	const queue = [prompt("a"), prompt("b"), prompt("c"), prompt("d"), prompt("e")];
	const view = getQueuedPromptView(queue, 3);
	assert.deepEqual(
		view.visible.map((item) => item.id),
		["a", "b", "c"],
	);
	assert.equal(view.hiddenCount, 2);
	assert.deepEqual(getQueuedPromptView([], 3), {
		visible: [],
		hiddenCount: 0,
	});
});
