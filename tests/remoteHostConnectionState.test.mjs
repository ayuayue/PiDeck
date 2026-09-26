import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SSH_RECONNECT_BACKOFF_MS } = loadTsCommonJs("src/main/remote/RemoteHostConnectionTypes.ts");
const { createConnectionMachine, isConnectionMachineShutdown, reconnectBackoffDelayMs, reduceConnectionEvent } = loadTsCommonJs("src/main/remote/RemoteHostConnectionState.ts");

const HOST = "01234567-89ab-4def-8123-456789abcdef";
const NOW = 1_700_000_000_000;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

/** Pinned clock and randomness: the reducer must be reproducible, so tests never read the real ones. */
const deps = (randomValue = 0, nowValue = NOW) => ({ now: () => nowValue, random: () => randomValue });
/** Production objects live in another VM realm, so deep comparisons are normalised through JSON. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const begin = () => ({ type: "begin-attempt" });
const phase = (generation, name) => ({ type: "phase-entered", generation, phase: name });
const connected = (generation) => ({ type: "connected", generation });
const degraded = (generation, code = "SSH_CONTROL_LATENCY_HIGH") => ({ type: "degraded", generation, code });
const lost = (generation, code = "SSH_CONTROL_CHANNEL_LOST") => ({ type: "disconnected", generation, code });
const due = (generation) => ({ type: "reconnect-due", generation });
const offline = (code) => (code === undefined ? { type: "offline" } : { type: "offline", code });
const fatal = (generation, code = "SSH_AUTH_DENIED") => ({ type: "needs-attention", generation, code });
const userRetry = () => ({ type: "user-retry" });
const shutdown = () => ({ type: "shutdown" });

const step = (state, event, reduceDeps = deps()) => reduceConnectionEvent(state, event, reduceDeps);
const apply = (state, event, reduceDeps = deps()) => step(state, event, reduceDeps).state;
/** Array.from keeps the result in this realm, so deep comparisons against local literals hold. */
const kinds = (effects) => Array.from(effects, (effect) => effect.kind);
const schedule = (effects) => effects.find((effect) => effect.kind === "schedule-reconnect");

/** The attempt stages the machine walks before it can become ready. */
function inFlight() {
	return apply(createConnectionMachine(HOST), begin());
}

function reachReady() {
	let state = inFlight();
	state = apply(state, phase(state.generation, "openssh"));
	state = apply(state, phase(state.generation, "platform"));
	state = apply(state, phase(state.generation, "helper"));
	return apply(state, connected(state.generation));
}

function reachDegraded() {
	const state = reachReady();
	return apply(state, degraded(state.generation));
}

function reachNeedsAttention() {
	const state = inFlight();
	return apply(state, fatal(state.generation));
}

/** Reconnecting with `retries` counted retries already started, all failed with a transient loss. */
function reachReconnecting(retries = 0) {
	let state = reachReady();
	state = apply(state, lost(state.generation));
	for (let index = 0; index < retries; index += 1) {
		state = apply(state, due(state.generation));
		state = apply(state, lost(state.generation));
	}
	return state;
}

function reachOffline() {
	const state = reachReconnecting();
	return apply(state, offline("SSH_HOST_DISABLED"));
}

test("creates an idle disconnected machine with a stable host id and code", () => {
	const state = createConnectionMachine(HOST);
	assert.deepEqual(plain(state), { hostId: HOST, generation: 0, state: "disconnected", attempts: 0, lastCode: "SSH_CONNECTION_IDLE", latched: false });
	assert.equal(isConnectionMachineShutdown(state), false);
});

test("walks the documented path disconnected -> connecting -> probing -> bootstrapping -> ready", () => {
	const started = step(createConnectionMachine(HOST), begin());
	assert.equal(started.state.state, "connecting");
	assert.equal(started.state.generation, 1);
	assert.deepEqual(kinds(started.effects), ["start-attempt"]);
	assert.equal(started.effects[0].hostId, HOST);
	let state = started.state;
	for (const [name, expected] of [
		["openssh", "connecting"],
		["authenticate", "connecting"],
		["platform", "probing"],
		["node", "probing"],
		["helper", "bootstrapping"],
		["pi", "bootstrapping"],
	]) {
		state = apply(state, phase(state.generation, name));
		assert.equal(state.state, expected, name);
		assert.equal(state.generation, 1, name);
		assert.match(state.lastCode, CODE_PATTERN, name);
	}
	state = apply(state, connected(state.generation));
	assert.equal(state.state, "ready");
	assert.equal(state.generation, 1);
	assert.equal(state.attempts, 0);
	assert.equal(state.lastCode, "SSH_CONNECTION_READY");
});

test("records repeated phases without changing state or emitting effects", () => {
	const state = apply(inFlight(), phase(1, "authenticate"));
	const repeat = step(state, phase(1, "authenticate"));
	assert.equal(repeat.state, state);
	assert.equal(repeat.effects.length, 0);
});

test("rejects a phase report that moves backwards across attempt stages", () => {
	const probing = apply(inFlight(), phase(1, "platform"));
	const backwards = step(probing, phase(1, "openssh"));
	assert.equal(backwards.state, probing);
	assert.equal(backwards.effects.length, 0);
});

test("rejects phase reports outside an attempt", () => {
	for (const from of [createConnectionMachine(HOST), reachReady(), reachNeedsAttention(), reachOffline()]) {
		const result = step(from, phase(from.generation, "platform"));
		assert.equal(result.state, from);
		assert.equal(result.effects.length, 0);
	}
});

test("routes fatal failures from every attempt stage into the terminal needs-attention state", () => {
	let state = inFlight();
	for (const name of ["openssh", "platform", "helper"]) {
		state = apply(state, phase(state.generation, name));
		const result = step(state, fatal(state.generation, "SSH_PLATFORM_UNSUPPORTED"));
		assert.equal(result.state.state, "needs-attention", name);
		assert.equal(result.state.lastCode, "SSH_PLATFORM_UNSUPPORTED", name);
		assert.equal(result.effects.length, 0, name);
	}
});

test("keeps needs-attention terminal: no automatic recovery, only user-retry or shutdown", () => {
	const terminal = reachNeedsAttention();
	assert.equal(terminal.state, "needs-attention");
	assert.equal(terminal.attempts, 0);
	for (const event of [begin(), phase(terminal.generation, "platform"), connected(terminal.generation), degraded(terminal.generation), lost(terminal.generation), due(terminal.generation), offline(), fatal(terminal.generation)]) {
		const result = step(terminal, event);
		assert.equal(result.state, terminal, event.type);
		assert.equal(result.effects.length, 0, event.type);
	}
});

test("fences events from another generation on every fenced event type", () => {
	const state = inFlight();
	for (const make of [(generation) => phase(generation, "platform"), connected, degraded, lost, due, fatal]) {
		for (const generation of [0, 2]) {
			const result = step(state, make(generation));
			assert.equal(result.state, state);
			assert.equal(result.effects.length, 0);
		}
	}
	assert.equal(apply(state, connected(state.generation)).state, "ready");
});

test("drops a stale failure and a stale timer once a new attempt has started", () => {
	const waiting = reachReconnecting();
	const retried = apply(waiting, userRetry());
	assert.equal(retried.state, "connecting");
	assert.equal(retried.generation, waiting.generation + 1);
	for (const stale of [lost(waiting.generation), due(waiting.generation), connected(waiting.generation), degraded(waiting.generation), fatal(waiting.generation), phase(waiting.generation, "platform")]) {
		const result = step(retried, stale);
		assert.equal(result.state, retried, JSON.stringify(stale));
		assert.equal(result.effects.length, 0, JSON.stringify(stale));
	}
});

test("starts the first reconnect wait on the first backoff rung", () => {
	const ready = reachReady();
	const result = step(ready, lost(ready.generation, "SSH_CONTROL_CHANNEL_LOST"));
	assert.equal(result.state.state, "reconnecting");
	assert.equal(result.state.lastCode, "SSH_CONTROL_CHANNEL_LOST");
	assert.equal(result.state.attempts, 0);
	assert.equal(result.state.generation, ready.generation, "no new attempt yet");
	assert.deepEqual(kinds(result.effects), ["schedule-reconnect"]);
	const armed = schedule(result.effects);
	assert.equal(armed.retry, 1);
	assert.equal(armed.delayMs, SSH_RECONNECT_BACKOFF_MS[0]);
	assert.equal(armed.dueAt, NOW + armed.delayMs);
	assert.equal(armed.generation, ready.generation);
});

test("escalates the reconnect wait to the 30s cap and keeps retrying at the cap", () => {
	let state = reachReady();
	const delays = [];
	for (let attempt = 0; attempt < 6; attempt += 1) {
		const dropped = step(state, lost(state.generation));
		delays.push(schedule(dropped.effects).delayMs);
		state = apply(dropped.state, due(dropped.state.generation));
		assert.equal(state.state, "connecting");
	}
	assert.deepEqual(delays, [1000, 2000, 5000, 10000, 30000, 30000]);
	assert.deepEqual(plain(delays), plain(SSH_RECONNECT_BACKOFF_MS).concat([30000]));
	assert.equal(state.attempts, 6);
	assert.equal(state.generation, 7);
});

test("counts every retry in attempts and resets the counter on a ready connection", () => {
	let state = reachReady();
	assert.equal(state.attempts, 0);
	state = apply(state, lost(state.generation));
	assert.equal(state.attempts, 0);
	state = apply(state, due(state.generation));
	assert.equal(state.attempts, 1);
	state = apply(state, lost(state.generation));
	state = apply(state, due(state.generation));
	assert.equal(state.attempts, 2);
	state = apply(state, connected(state.generation));
	assert.equal(state.state, "ready");
	assert.equal(state.attempts, 0);
});

test("bounds the jitter below the backoff rung for every rung and sample", () => {
	for (const randomValue of [0, 0.25, 0.5, 0.75, 0.99]) {
		for (const [index, base] of SSH_RECONNECT_BACKOFF_MS.entries()) {
			const delay = reconnectBackoffDelayMs(index + 1, randomValue);
			assert.ok(Number.isInteger(delay), `${index}:${randomValue}`);
			assert.ok(delay <= base, `${index}:${randomValue} exceeds the rung`);
			assert.ok(delay >= base * 0.8, `${index}:${randomValue} jitter out of bounds`);
		}
	}
	const dropped = step(reachReady(), lost(1), deps(0.5));
	assert.equal(schedule(dropped.effects).delayMs, 900, "jitter is deterministic for a pinned random source");
});

test("never emits a non-finite or negative delay for a hostile random source", () => {
	for (const randomValue of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5, 7]) {
		const delay = reconnectBackoffDelayMs(1, randomValue);
		assert.ok(Number.isFinite(delay), String(randomValue));
		assert.ok(delay > 0 && delay <= 1000, String(randomValue));
	}
});

test("maps retry ordinals onto the documented rung table with a 30s cap", () => {
	assert.deepEqual(plain(SSH_RECONNECT_BACKOFF_MS), [1000, 2000, 5000, 10000, 30000]);
	for (const [index, base] of SSH_RECONNECT_BACKOFF_MS.entries()) assert.equal(reconnectBackoffDelayMs(index + 1, 0), base);
	assert.equal(reconnectBackoffDelayMs(0, 0), 1000);
	assert.equal(reconnectBackoffDelayMs(-3, 0), 1000);
	assert.equal(reconnectBackoffDelayMs(1.9, 0), 1000);
	assert.equal(reconnectBackoffDelayMs(9, 0), 30000);
	assert.equal(reconnectBackoffDelayMs(Number.NaN, 0), 1000, "a corrupt counter falls back to the first rung");
	assert.equal(reconnectBackoffDelayMs(Number.POSITIVE_INFINITY, 0), 30000);
});

test("lets a user retry bypass the pending wait exactly once", () => {
	const waiting = reachReconnecting();
	const result = step(waiting, userRetry());
	assert.equal(result.state.state, "connecting");
	assert.equal(result.state.generation, waiting.generation + 1);
	assert.equal(result.state.attempts, 1);
	assert.equal(result.state.lastCode, "SSH_CONNECTION_USER_RETRY");
	assert.deepEqual(kinds(result.effects), ["cancel-reconnect", "start-attempt"]);
	assert.equal(schedule(result.effects), undefined);
});

test("takes the second consecutive user retry back to the normal backoff", () => {
	const waiting = reachReconnecting();
	const first = step(waiting, userRetry());
	const failed = step(first.state, lost(first.state.generation));
	assert.equal(failed.state.state, "reconnecting");
	assert.equal(schedule(failed.effects).delayMs, 2000, "the immediate retry consumed the first rung");
	for (const attempt of [1, 2]) {
		const next = step(failed.state, userRetry());
		assert.equal(next.state.state, "reconnecting", `retry ${attempt} must not start an attempt`);
		assert.equal(next.state.lastCode, "SSH_CONNECTION_USER_RETRY_DEFERRED");
		assert.deepEqual(kinds(next.effects), ["cancel-reconnect", "schedule-reconnect"]);
		assert.equal(schedule(next.effects).delayMs, 2000, `retry ${attempt} keeps the normal rung`);
		assert.equal(kinds(next.effects).includes("start-attempt"), false);
	}
});

test("leaves needs-attention on user-retry and consumes the immediate allowance", () => {
	const terminal = reachNeedsAttention();
	const retried = step(terminal, userRetry());
	assert.equal(retried.state.state, "connecting");
	assert.equal(retried.state.generation, terminal.generation + 1);
	assert.equal(retried.state.attempts, 1);
	assert.deepEqual(kinds(retried.effects), ["start-attempt"]);
	const failed = step(retried.state, lost(retried.state.generation));
	assert.equal(schedule(failed.effects).delayMs, 2000);
	const again = step(failed.state, userRetry());
	assert.equal(again.state.state, "reconnecting", "second consecutive retry waits for the backoff");
	assert.deepEqual(kinds(again.effects), ["cancel-reconnect", "schedule-reconnect"]);
});

test("rejects user-retry while an attempt is live or a connection is healthy", () => {
	for (const from of [inFlight(), apply(inFlight(), phase(1, "platform")), reachReady()]) {
		const result = step(from, userRetry());
		assert.equal(result.state, from, from.state);
		assert.equal(result.effects.length, 0, from.state);
	}
});

test("retries a transient loss during an attempt instead of asking the user", () => {
	const probing = apply(inFlight(), phase(1, "node"));
	assert.equal(probing.state, "probing");
	const transient = step(probing, lost(probing.generation));
	assert.equal(transient.state.state, "reconnecting");
	assert.equal(schedule(transient.effects).delayMs, 1000);
	const actionable = step(probing, fatal(probing.generation, "SSH_NODE_NOT_FOUND"));
	assert.equal(actionable.state.state, "needs-attention");
	assert.equal(actionable.state.lastCode, "SSH_NODE_NOT_FOUND");
});

test("degrades only a live connection and recovers with connected", () => {
	let state = reachDegraded();
	assert.equal(state.lastCode, "SSH_CONTROL_LATENCY_HIGH");
	assert.equal(state.attempts, 0);
	const updated = step(state, degraded(state.generation, "SSH_HELPER_SLOW"));
	assert.equal(updated.state.state, "degraded");
	assert.equal(updated.state.lastCode, "SSH_HELPER_SLOW");
	const repeat = step(updated.state, degraded(updated.state.generation, "SSH_HELPER_SLOW"));
	assert.equal(repeat.state, updated.state);
	assert.equal(repeat.effects.length, 0);
	state = apply(updated.state, connected(updated.state.generation));
	assert.equal(state.state, "ready");
	assert.equal(state.lastCode, "SSH_CONNECTION_READY");
});

test("recovers straight from reconnecting to ready and cancels the timer", () => {
	const waiting = reachReconnecting(2);
	const result = step(waiting, connected(waiting.generation));
	assert.equal(result.state.state, "ready");
	assert.equal(result.state.generation, waiting.generation, "recovery without a new attempt keeps the generation");
	assert.equal(result.state.attempts, 0);
	assert.deepEqual(kinds(result.effects), ["cancel-reconnect"]);
});

test("goes offline with a timer cleanup and restarts only on an explicit intent", () => {
	const waiting = reachReconnecting(2);
	const result = step(waiting, offline("SSH_HOST_DISABLED"));
	assert.equal(result.state.state, "offline");
	assert.equal(result.state.lastCode, "SSH_HOST_DISABLED");
	assert.equal(result.state.attempts, 0, "offline ends the retry escalation");
	assert.deepEqual(kinds(result.effects), ["cancel-reconnect"]);
	const ignored = step(result.state, due(result.state.generation));
	assert.equal(ignored.state, result.state);
	assert.equal(ignored.effects.length, 0);
	const restarted = apply(result.state, begin());
	assert.equal(restarted.state, "connecting");
	assert.equal(restarted.generation, result.state.generation + 1);
	assert.equal(restarted.attempts, 0, "begin-attempt is a first connect, not a retry");
	const retried = apply(result.state, userRetry());
	assert.equal(retried.state, "connecting");
	assert.equal(retried.attempts, 1);
	assert.deepEqual(kinds(step(reachReady(), offline()).effects), [], "offline from a healthy connection has no timer to cancel");
});

test("shuts down from reconnecting: cancels the timer, stops retrying and latches the machine", () => {
	const waiting = reachReconnecting();
	const result = step(waiting, shutdown());
	assert.equal(result.state.state, "offline");
	assert.equal(isConnectionMachineShutdown(result.state), true);
	assert.deepEqual(kinds(result.effects), ["cancel-reconnect", "shutdown"]);
	assert.equal(result.effects.at(-1).hostId, HOST);
	for (const event of [due(waiting.generation), begin(), userRetry(), connected(waiting.generation), offline(), shutdown()]) {
		const after = step(result.state, event);
		assert.equal(after.state, result.state, event.type);
		assert.equal(after.effects.length, 0, event.type);
	}
});

test("keeps needs-attention when shut down from the terminal state", () => {
	const terminal = reachNeedsAttention();
	const result = step(terminal, shutdown());
	assert.equal(result.state.state, "needs-attention", "shutdown must not launder the terminal state away");
	assert.equal(isConnectionMachineShutdown(result.state), true);
	assert.deepEqual(kinds(result.effects), ["cancel-reconnect", "shutdown"]);
	assert.equal(step(result.state, userRetry()).effects.length, 0, "a torn-down machine cannot be revived");
});

test("shuts down a live or idle machine into the quiescent offline state", () => {
	for (const from of [createConnectionMachine(HOST), inFlight(), reachDegraded(), reachReady()]) {
		const result = step(from, shutdown());
		assert.equal(result.state.state, "offline", from.state);
		assert.equal(isConnectionMachineShutdown(result.state), true, from.state);
		assert.deepEqual(kinds(result.effects), ["cancel-reconnect", "shutdown"], from.state);
	}
});

test("rejects every illegal transition with an identical state and no effects", () => {
	const cases = [
		["disconnected + connected", () => createConnectionMachine(HOST), (state) => connected(state.generation)],
		["disconnected + phase", () => createConnectionMachine(HOST), (state) => phase(state.generation, "openssh")],
		["disconnected + degraded", () => createConnectionMachine(HOST), (state) => degraded(state.generation)],
		["disconnected + disconnected", () => createConnectionMachine(HOST), (state) => lost(state.generation)],
		["disconnected + needs-attention", () => createConnectionMachine(HOST), (state) => fatal(state.generation)],
		["disconnected + reconnect-due", () => createConnectionMachine(HOST), (state) => due(state.generation)],
		["connecting + begin-attempt", inFlight, begin],
		["connecting + user-retry", inFlight, userRetry],
		["connecting + degraded", inFlight, (state) => degraded(state.generation)],
		["connecting + reconnect-due", inFlight, (state) => due(state.generation)],
		["probing + begin-attempt", () => apply(inFlight(), phase(1, "platform")), begin],
		["ready + begin-attempt", reachReady, begin],
		["ready + user-retry", reachReady, userRetry],
		["ready + phase", reachReady, (state) => phase(state.generation, "openssh")],
		["ready + reconnect-due", reachReady, (state) => due(state.generation)],
		["degraded + begin-attempt", reachDegraded, begin],
		["degraded + phase", reachDegraded, (state) => phase(state.generation, "openssh")],
		["degraded + reconnect-due", reachDegraded, (state) => due(state.generation)],
		["reconnecting + begin-attempt", reachReconnecting, begin],
		["reconnecting + phase", reachReconnecting, (state) => phase(state.generation, "openssh")],
		["reconnecting + degraded", reachReconnecting, (state) => degraded(state.generation)],
		["reconnecting + disconnected", reachReconnecting, (state) => lost(state.generation)],
		["reconnecting + reconnect-due", () => reachReconnecting(), (state) => due(state.generation + 1)],
		["offline + connected", reachOffline, (state) => connected(state.generation)],
		["offline + reconnect-due", reachOffline, (state) => due(state.generation)],
		["offline + needs-attention", reachOffline, (state) => fatal(state.generation)],
		["needs-attention + begin-attempt", reachNeedsAttention, begin],
		["needs-attention + offline", reachNeedsAttention, () => offline()],
	];
	for (const [label, from, make] of cases) {
		const state = from();
		const result = step(state, make(state));
		assert.equal(result.state, state, label);
		assert.equal(result.effects.length, 0, label);
	}
});

test("sanitizes caller codes so no free text can reach diagnostics", () => {
	const noisy = "ssh: connect to host 10.1.2.3 port 22: Connection refused";
	const dropped = step(reachReady(), lost(1, noisy));
	assert.equal(dropped.state.lastCode, "SSH_CONNECTION_LOST");
	assert.equal(JSON.stringify(plain(dropped.state)).includes("10.1.2.3"), false);
	assert.equal(JSON.stringify(plain(dropped.state)).includes("refused"), false);
	assert.equal(step(reachReady(), fatal(1, noisy)).state.lastCode, "SSH_CONNECTION_NEEDS_ATTENTION");
	assert.equal(step(reachReady(), degraded(1, noisy)).state.lastCode, "SSH_CONNECTION_DEGRADED");
	assert.equal(step(reachReady(), offline(noisy)).state.lastCode, "SSH_CONNECTION_OFFLINE");
	assert.equal(step(reachReady(), lost(1, "ssh_lowercase")).state.lastCode, "SSH_CONNECTION_LOST");
	assert.equal(step(reachReady(), lost(1, "SSH_HOST_KEY_CHANGED")).state.lastCode, "SSH_HOST_KEY_CHANGED");
});

test("is pure: no input mutation, deterministic for identical inputs", () => {
	const state = reachReconnecting(1);
	const snapshot = plain(state);
	const first = step(state, userRetry());
	const second = step(state, userRetry());
	assert.deepEqual(plain(state), snapshot);
	assert.deepEqual(plain(first.state), plain(second.state));
	assert.deepEqual(plain(first.effects), plain(second.effects));
	const rejected = step(state, begin());
	assert.equal(rejected.state, state, "rejections return the original object");
});

test("emits plain data effects without callbacks", () => {
	const result = step(reachReady(), lost(1));
	assert.equal(result.effects.length, 1);
	for (const value of Object.values(plain(result.effects[0]))) {
		assert.notEqual(typeof value, "function");
		assert.ok(value === null || ["string", "number"].includes(typeof value));
	}
	const teardown = step(reachReconnecting(), shutdown());
	for (const effect of plain(teardown.effects)) {
		for (const value of Object.values(effect)) assert.notEqual(typeof value, "function");
	}
});
