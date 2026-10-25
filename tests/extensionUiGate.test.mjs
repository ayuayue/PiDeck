import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Deterministic timer handles expose retained callbacks without waiting for the 30-minute fallback. */
function createTimerClock() {
	const active = new Set();
	const scheduled = [];
	return {
		active,
		scheduled,
		setTimeout(callback, delay) {
			const timer = {
				callback,
				delay,
				unreferenced: false,
				unref() {
					this.unreferenced = true;
				},
			};
			scheduled.push(timer);
			active.add(timer);
			return timer;
		},
		clearTimeout(timer) {
			active.delete(timer);
		},
		fire(timer) {
			active.delete(timer);
			timer.callback();
		},
	};
}

/** Exercise the production UI gate with isolated protocol and timer sinks. */
function createHarness({ onUiRequest } = {}) {
	const clock = createTimerClock();
	const timers = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
	const { ExtensionUiGate } = loadTsCommonJs("src/main/pi/extensionUiGate.ts", {
		globals: timers,
		stubs: { "node:timers": timers },
	});
	const requests = [];
	const responses = [];
	const warnings = [];
	const aborted = [];
	const gate = new ExtensionUiGate({
		emitUiRequest(payload) {
			requests.push(payload);
			onUiRequest?.(payload, gate);
		},
		getRuntimeTab: () => undefined,
		getClient: (agentId) => ({ sendRaw: (payload) => responses.push({ agentId, payload }) }),
		markAbortedDuringAsk: (agentId) => aborted.push(agentId),
		warn: (message, data) => warnings.push({ message, data }),
	});
	return { gate, clock, requests, responses, warnings, aborted };
}

test("answer releases the fallback UI timeout while preserving the response protocol", () => {
	const { gate, clock, requests, responses } = createHarness();
	gate.handleUIRequest("agent-a", { id: "ask-1", method: "confirm", title: "Continue?" });
	assert.equal(clock.active.size, 1);
	assert.equal(clock.scheduled[0].delay, 30 * 60 * 1000);
	assert.equal(clock.scheduled[0].unreferenced, true);

	gate.sendUIResponse("agent-a", "ask-1", { confirmed: true });

	assert.equal(clock.active.size, 0, "answered requests must not retain their timeout callback");
	assert.equal(gate.hasPendingUIRequests("agent-a"), false);
	assert.equal(responses.length, 1);
	assert.equal(responses[0].payload.type, "extension_ui_response");
	assert.equal(responses[0].payload.confirmed, true);
	assert.equal(requests.at(-1).completed, true);
});

test("explicit cancellation releases only the answered UI timeout", () => {
	const { gate, clock, responses } = createHarness();
	gate.handleUIRequest("agent-a", { id: "ask-1", method: "input", timeout: 1_000 });
	gate.handleUIRequest("agent-a", { id: "ask-2", method: "input", timeout: 2_000 });
	const [first, second] = clock.scheduled;

	gate.sendUIResponse("agent-a", "ask-1", { cancelled: true });

	assert.equal(clock.active.has(first), false);
	assert.equal(clock.active.has(second), true, "another pending request keeps its deadline");
	assert.equal(gate.hasPendingUIRequests("agent-a"), true);
	assert.equal(responses[0].payload.cancelled, true);
});

test("abort cancellation releases every UI timeout for that agent without touching another agent", () => {
	const { gate, clock, requests, responses, aborted } = createHarness();
	gate.handleUIRequest("agent-a", { id: "ask-1", method: "input" });
	gate.handleUIRequest("agent-a", { id: "ask-2", method: "editor" });
	gate.handleUIRequest("agent-b", { id: "ask-1", method: "input" });
	const [first, second, other] = clock.scheduled;

	gate.cancelPendingUIRequests("agent-a");

	assert.equal(clock.active.has(first), false);
	assert.equal(clock.active.has(second), false);
	assert.equal(clock.active.has(other), true);
	assert.equal(gate.hasPendingUIRequests("agent-a"), false);
	assert.equal(gate.hasPendingUIRequests("agent-b"), true);
	assert.deepEqual(aborted, ["agent-a"]);
	assert.equal(responses.length, 2);
	assert.ok(responses.every(({ payload }) => payload.value === null));
	assert.equal(requests.filter((request) => request.completed && request.cancelled).length, 2);
});

test("agent cleanup releases pending UI timeouts even without sending protocol responses", () => {
	const { gate, clock, responses } = createHarness();
	gate.handleUIRequest("agent-a", { id: "ask-1", method: "input" });
	gate.handleUIRequest("agent-a", { id: "ask-2", method: "editor" });
	gate.handleUIRequest("agent-b", { id: "ask-1", method: "input" });
	const [first, second, other] = clock.scheduled;

	gate.clearAgent("agent-a");
	gate.clearAgent("agent-a");

	assert.equal(clock.active.has(first), false);
	assert.equal(clock.active.has(second), false);
	assert.equal(clock.active.has(other), true);
	assert.equal(gate.hasPendingUIRequests("agent-a"), false);
	assert.equal(responses.length, 0, "a destroyed runtime cannot receive cancellation packets");
});

test("a reused UI request id replaces its deadline and ignores the old timeout callback", () => {
	const { gate, clock, responses, warnings } = createHarness();
	gate.handleUIRequest("agent-a", { id: "ask-1", method: "input", timeout: 1_000 });
	const previous = clock.scheduled[0];
	gate.handleUIRequest("agent-a", { id: "ask-1", method: "input", timeout: 2_000 });
	const current = clock.scheduled[1];

	assert.equal(clock.active.has(previous), false, "replacement must release the previous request deadline");
	assert.equal(clock.active.has(current), true);
	clock.fire(previous);
	assert.equal(responses.length, 0, "a stale timeout must not cancel a newer request sharing the same id");
	assert.equal(warnings.length, 0);
	assert.equal(gate.hasPendingUIRequests("agent-a"), true);

	clock.fire(current);
	assert.equal(responses.length, 1);
	assert.equal(responses[0].payload.cancelled, true);
	assert.equal(warnings[0].data.timeoutMs, 2_000);
	assert.equal(clock.active.size, 0);
	assert.equal(gate.hasPendingUIRequests("agent-a"), false);
});

test("UI requests answered synchronously while being emitted do not retain a timeout", () => {
	const { gate, clock, responses } = createHarness({
		onUiRequest(payload, currentGate) {
			if (!payload.completed) currentGate.sendUIResponse(payload.agentId, payload.requestId, { cancelled: true });
		},
	});

	gate.handleUIRequest("agent-a", { id: "ask-1", method: "input" });

	assert.equal(gate.hasPendingUIRequests("agent-a"), false);
	assert.equal(responses.length, 1);
	assert.equal(clock.active.size, 0, "unbound UI may be cancelled during emit, before timeout scheduling");
});

test("a live UI deadline still cancels both protocol ends exactly once", () => {
	const { gate, clock, requests, responses, warnings } = createHarness();
	gate.handleUIRequest("agent-a", { id: "ask-1", method: "input", timeout: 1_234.9 });
	const timer = clock.scheduled[0];
	assert.equal(timer.delay, 1_234);

	clock.fire(timer);
	clock.fire(timer);

	assert.equal(clock.active.size, 0);
	assert.equal(gate.hasPendingUIRequests("agent-a"), false);
	assert.equal(responses.length, 1);
	assert.equal(responses[0].payload.cancelled, true);
	assert.equal(requests.at(-1).completed, true);
	assert.equal(requests.at(-1).cancelled, true);
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0].data.explicitTimeout, true);
});
