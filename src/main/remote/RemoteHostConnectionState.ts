import { SSH_RECONNECT_BACKOFF_MS, type RemoteHostConnectionState, type SshConnectionPhase } from "./RemoteHostConnectionTypes";

/**
 * Host connection state machine (plan §10). Main-only and pure: no clock reads, no timers, no I/O.
 * The caller owns setTimeout/clearTimeout and feeds the outcome back as events; time and randomness
 * arrive through ConnectionReduceDeps, which keeps every transition reproducible in tests.
 *
 * State graph (plan §10):
 *
 *   disconnected -> connecting -> probing -> bootstrapping -> ready
 *                        \____________ needs-attention
 *   ready -> degraded -> reconnecting -> ready | offline
 *
 * Rules layered on top of that graph:
 * - needs-attention is terminal and only an explicit `user-retry` may leave it. Fatal, actionable
 *   problems (auth denied, unsupported platform, missing node/helper) must never be retried
 *   silently, so a transient transport loss is reported as `disconnected` instead and arms the
 *   backoff.
 * - `generation` identifies one attempt. Every fenced event echoes the generation its attempt was
 *   started with, and anything else is dropped (original state, no effects) so a late failure or a
 *   stale timer from a previous attempt can never corrupt the current one.
 * - `attempts` counts retry attempts started since the host was last ready. It drives the backoff
 *   rung and the one-shot "retry now" allowance, so repeated retry clicks cannot become a
 *   zero-delay storm against the host.
 * - `shutdown` latches the machine: teardown clears the pending timer and every later event is
 *   ignored, so nothing can restart a torn-down connection.
 */
export type ConnectionMachineState = { hostId: string; generation: number; state: RemoteHostConnectionState; attempts: number; lastCode?: string; latched: boolean };

/**
 * Fenced events carry the generation of the attempt they report on. Intent events carry none,
 * because a user or coordinator action is not tied to an attempt that could be fenced away.
 *
 * `disconnected` vs `needs-attention` is the caller's classification of the same failure: the
 * former is transient (retry on the backoff schedule), the latter is actionable (stop and ask).
 */
export type ConnectionEvent =
	| { type: "begin-attempt" }
	| { type: "phase-entered"; generation: number; phase: SshConnectionPhase }
	| { type: "connected"; generation: number }
	| { type: "degraded"; generation: number; code: string }
	| { type: "disconnected"; generation: number; code: string }
	| { type: "reconnect-due"; generation: number }
	| { type: "offline"; code?: string }
	| { type: "needs-attention"; generation: number; code: string }
	| { type: "user-retry" }
	| { type: "shutdown" };

/** Injected effect ports: `now` timestamps the armed retry, `random` only feeds jitter. */
export type ConnectionReduceDeps = { now(): number; random(): number };

/**
 * Effects are plain data — never callbacks — so the reducer stays serialisable and the caller keeps
 * full ownership of timers and process lifecycle:
 * - start-attempt: launch one attempt; echo its generation on every later fenced event.
 * - schedule-reconnect: arm the caller's timer (cancelling an existing one first is idempotent).
 *   `retry` is the 1-based ordinal of the retry being armed, `dueAt` is for countdown display.
 * - cancel-reconnect / shutdown: teardown paths that must clear the pending timer.
 */
export type ConnectionEffect = { kind: "start-attempt"; hostId: string; generation: number } | { kind: "schedule-reconnect"; hostId: string; generation: number; retry: number; delayMs: number; dueAt: number } | { kind: "cancel-reconnect"; hostId: string; generation: number } | { kind: "shutdown"; hostId: string };

export type ConnectionReduceResult = { state: ConnectionMachineState; effects: ConnectionEffect[] };

/** Only stable enumerable codes may be persisted, matching the diagnostic record contract. */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const CODE_IDLE = "SSH_CONNECTION_IDLE";
const CODE_ATTEMPT_STARTED = "SSH_CONNECTION_ATTEMPT_STARTED";
const CODE_USER_RETRY = "SSH_CONNECTION_USER_RETRY";
const CODE_USER_RETRY_DEFERRED = "SSH_CONNECTION_USER_RETRY_DEFERRED";
const CODE_RECONNECT_STARTED = "SSH_CONNECTION_RECONNECT_STARTED";
const CODE_READY = "SSH_CONNECTION_READY";
const CODE_DEGRADED = "SSH_CONNECTION_DEGRADED";
const CODE_LOST = "SSH_CONNECTION_LOST";
const CODE_OFFLINE = "SSH_CONNECTION_OFFLINE";
const CODE_NEEDS_ATTENTION = "SSH_CONNECTION_NEEDS_ATTENTION";
const CODE_SHUTDOWN = "SSH_CONNECTION_SHUTDOWN";

/** Jitter is bounded to a fraction of the rung and only ever subtracted, never added. */
const JITTER_FRACTION = 0.2;

type AttemptStage = "connecting" | "probing" | "bootstrapping";

const ATTEMPT_RANK: Record<AttemptStage, number> = { connecting: 0, probing: 1, bootstrapping: 2 };
const STAGE_FOR_PHASE: Record<SshConnectionPhase, AttemptStage> = { openssh: "connecting", authenticate: "connecting", platform: "probing", node: "probing", helper: "bootstrapping", pi: "bootstrapping" };

function attemptRank(state: RemoteHostConnectionState): number | undefined {
	return state === "connecting" || state === "probing" || state === "bootstrapping" ? ATTEMPT_RANK[state] : undefined;
}

function nextState(state: ConnectionMachineState, patch: { state: RemoteHostConnectionState; lastCode: string; generation?: number; attempts?: number; latched?: boolean }): ConnectionMachineState {
	return { hostId: state.hostId, generation: patch.generation ?? state.generation, state: patch.state, attempts: patch.attempts ?? state.attempts, lastCode: patch.lastCode, latched: patch.latched ?? state.latched };
}

/**
 * Caller-supplied codes are the only place free text could reach diagnostics, so anything that is
 * not a stable enumerable code (a shell error line, a path, a response body) collapses to the
 * generic fallback instead of being stored.
 */
function normalizeCode(code: string | undefined, fallback: string): string {
	return typeof code === "string" && CODE_PATTERN.test(code) ? code : fallback;
}

/** Illegal or fenced-off event: the very same state object comes back, so nothing re-renders. */
function reject(state: ConnectionMachineState): ConnectionReduceResult {
	return { state, effects: [] };
}

function cancelReconnect(state: ConnectionMachineState): ConnectionEffect {
	return { kind: "cancel-reconnect", hostId: state.hostId, generation: state.generation };
}

/**
 * Arm the next retry. The rung follows the retries already started, so retry ordinal
 * `attempts + 1` waits SSH_RECONNECT_BACKOFF_MS[attempts] (30s cap) plus bounded jitter.
 */
function scheduleReconnect(state: ConnectionMachineState, deps: ConnectionReduceDeps): ConnectionEffect {
	const retry = state.attempts + 1;
	const delayMs = reconnectBackoffDelayMs(retry, deps.random());
	return { kind: "schedule-reconnect", hostId: state.hostId, generation: state.generation, retry, delayMs, dueAt: deps.now() + delayMs };
}

/**
 * Start one attempt: always a fresh generation, so everything reported from now on is fenced to it.
 * `countRetry` distinguishes a retry (counts against the backoff rung and the immediate-retry
 * allowance) from the first connect of an idle/episode-restart host.
 */
function startAttempt(state: ConnectionMachineState, options: { code: string; countRetry: boolean; cancelWait?: boolean }): ConnectionReduceResult {
	const generation = state.generation + 1;
	const effects: ConnectionEffect[] = options.cancelWait === true ? [cancelReconnect(state)] : [];
	effects.push({ kind: "start-attempt", hostId: state.hostId, generation });
	return { state: nextState(state, { state: "connecting", generation, attempts: options.countRetry ? state.attempts + 1 : state.attempts, lastCode: options.code }), effects };
}

function enterPhase(state: ConnectionMachineState, phase: SshConnectionPhase): ConnectionReduceResult {
	const rank = attemptRank(state.state);
	if (rank === undefined) return reject(state);
	const stage = STAGE_FOR_PHASE[phase];
	const stageRank = attemptRank(stage);
	// Phases only move forward inside one attempt (a helper/Pi failure never walks back to the
	// OpenSSH stage), and a phase report outside an attempt is a stale message from a finished one.
	if (stageRank === undefined || stageRank < rank) return reject(state);
	const lastCode = `SSH_PHASE_${phase.toUpperCase()}`;
	// Re-entering the phase we are already in changes nothing; keeping the identity avoids re-rendering
	// for duplicate progress reports.
	if (state.state === stage && state.lastCode === lastCode) return reject(state);
	return { state: nextState(state, { state: stage, lastCode }), effects: [] };
}

function userRetry(state: ConnectionMachineState, deps: ConnectionReduceDeps): ConnectionReduceResult {
	if (state.state === "reconnecting") {
		// Plan §10 allows the user to retry immediately once. That allowance exists only while no retry
		// has been counted yet (the first wait is pending); afterwards the click merely re-arms the
		// current rung, so hammering retry cannot loop at zero delay.
		if (state.attempts > 0) {
			const deferred = nextState(state, { state: "reconnecting", lastCode: CODE_USER_RETRY_DEFERRED });
			return { state: deferred, effects: [cancelReconnect(state), scheduleReconnect(deferred, deps)] };
		}
		return startAttempt(state, { code: CODE_USER_RETRY, countRetry: true, cancelWait: true });
	}
	// One of the states where nothing is in flight: the user can ask for a fresh attempt right away.
	if (state.state === "needs-attention" || state.state === "disconnected" || state.state === "offline" || state.state === "degraded") {
		return startAttempt(state, { code: CODE_USER_RETRY, countRetry: true });
	}
	// connecting/probing/bootstrapping/ready: an attempt is live or healthy, a retry would drop it.
	return reject(state);
}

/** Teardown target: needs-attention is preserved (rule 2), every other state becomes quiescent. */
function shutdownState(state: ConnectionMachineState): ConnectionMachineState {
	if (state.state === "needs-attention") return nextState(state, { state: "needs-attention", lastCode: CODE_SHUTDOWN, latched: true });
	return nextState(state, { state: "offline", attempts: 0, lastCode: CODE_SHUTDOWN, latched: true });
}

/** Fresh machine: idle, never attempted, with a diagnosable code so the UI has no "empty" reason. */
export function createConnectionMachine(hostId: string): ConnectionMachineState {
	return { hostId, generation: 0, state: "disconnected", attempts: 0, lastCode: CODE_IDLE, latched: false };
}

/**
 * True once `shutdown` latched the machine. The latch is its own field rather than a reused
 * `lastCode`, because `lastCode` also carries caller-supplied codes — a matching string would
 * otherwise be able to latch the machine permanently by accident.
 */
export function isConnectionMachineShutdown(state: ConnectionMachineState): boolean {
	return state.latched === true;
}

/**
 * Base rung from plan §10 (1s/2s/5s/10s/30s, 30s capped) minus jitter of at most JITTER_FRACTION.
 * Jitter is only subtracted, so a schedule can never exceed the documented cap, and a hostile
 * `random()` value cannot produce NaN or a negative delay — a NaN delay reaching setTimeout would
 * spin the reconnect loop with no wait at all.
 */
export function reconnectBackoffDelayMs(retry: number, randomValue: number): number {
	// A corrupt (NaN) retry counter must not fall through to SSH_RECONNECT_BACKOFF_MS[NaN] and hand
	// the caller a NaN delay; the first rung is the safe default. Huge ordinals still clamp to the cap.
	const rung = Number.isNaN(retry) ? 1 : Math.min(Math.max(Math.trunc(retry), 1), SSH_RECONNECT_BACKOFF_MS.length);
	const base = SSH_RECONNECT_BACKOFF_MS[rung - 1];
	const sample = Number.isFinite(randomValue) ? Math.min(Math.max(randomValue, 0), 1) : 0;
	return base - Math.floor(base * JITTER_FRACTION * sample);
}

/**
 * Single transition function. Returns the next state plus the effects the caller must apply; an
 * illegal or fenced-off event returns the very same state object and no effects.
 */
export function reduceConnectionEvent(state: ConnectionMachineState, event: ConnectionEvent, deps: ConnectionReduceDeps): ConnectionReduceResult {
	// A torn-down machine is dead. shutdown stays idempotent instead of throwing because quit paths
	// legitimately run teardown more than once.
	if (isConnectionMachineShutdown(state)) return reject(state);
	// Fencing: an event from another generation belongs to an attempt that no longer exists.
	if ("generation" in event && event.generation !== state.generation) return reject(state);

	switch (event.type) {
		case "begin-attempt":
			// First connect of an idle host; not a retry, so `attempts` (the retry counter) is untouched.
			if (state.state === "disconnected" || state.state === "offline") return startAttempt(state, { code: CODE_ATTEMPT_STARTED, countRetry: false });
			return reject(state);
		case "phase-entered":
			return enterPhase(state, event.phase);
		case "connected": {
			if (state.state === "ready") return reject(state);
			const live = attemptRank(state.state) !== undefined;
			// A degraded connection recovering and a control channel that heals while the backoff timer is
			// pending both land here; anything else claiming to be connected is out of order.
			if (!live && state.state !== "reconnecting" && state.state !== "degraded") return reject(state);
			// Healing without a new attempt keeps the generation, so pending requests of that attempt stay
			// valid; the pending retry timer has to be cleared instead.
			const effects = state.state === "reconnecting" ? [cancelReconnect(state)] : [];
			return { state: nextState(state, { state: "ready", attempts: 0, lastCode: CODE_READY }), effects };
		}
		case "degraded": {
			if (state.state !== "ready" && state.state !== "degraded") return reject(state);
			const lastCode = normalizeCode(event.code, CODE_DEGRADED);
			// Staying degraded with a new cause is worth recording: diagnostics read lastCode.
			if (state.state === "degraded" && state.lastCode === lastCode) return reject(state);
			return { state: nextState(state, { state: "degraded", lastCode }), effects: [] };
		}
		case "disconnected": {
			const live = attemptRank(state.state) !== undefined;
			if (!live && state.state !== "ready" && state.state !== "degraded") return reject(state);
			// Transient loss: keep trying on the jittered schedule instead of bothering the user.
			const next = nextState(state, { state: "reconnecting", lastCode: normalizeCode(event.code, CODE_LOST) });
			return { state: next, effects: [scheduleReconnect(next, deps)] };
		}
		case "reconnect-due":
			// Only the armed timer may fire; the generation check above already dropped stale timers.
			if (state.state !== "reconnecting") return reject(state);
			return startAttempt(state, { code: CODE_RECONNECT_STARTED, countRetry: true });
		case "offline": {
			if (state.state === "disconnected" || state.state === "offline") return reject(state);
			// needs-attention is terminal (rule 2): marking the host offline must not launder it away.
			if (state.state === "needs-attention") return reject(state);
			const effects = state.state === "reconnecting" ? [cancelReconnect(state)] : [];
			return { state: nextState(state, { state: "offline", attempts: 0, lastCode: normalizeCode(event.code, CODE_OFFLINE) }), effects };
		}
		case "needs-attention": {
			const live = attemptRank(state.state) !== undefined;
			if (!live && state.state !== "ready" && state.state !== "degraded" && state.state !== "reconnecting") return reject(state);
			// Fatal and actionable: stop retrying, hand the problem to the user.
			const effects = state.state === "reconnecting" ? [cancelReconnect(state)] : [];
			return { state: nextState(state, { state: "needs-attention", attempts: 0, lastCode: normalizeCode(event.code, CODE_NEEDS_ATTENTION) }), effects };
		}
		case "user-retry":
			return userRetry(state, deps);
		case "shutdown":
			// Cancel unconditionally: a leftover timer firing after quit would start an attempt during
			// teardown, and a missing cancel costs a stale process.
			return { state: shutdownState(state), effects: [cancelReconnect(state), { kind: "shutdown", hostId: state.hostId }] };
	}
}
