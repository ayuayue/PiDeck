import { createSshProcessLauncher, SSH_LAUNCHER_MAX_TIMEOUT_MS } from "./SshProcessLauncher";
import { createConnectionDiagnostic, createDiagnosticHistory, diagnosticCodeFromError } from "./SshConnectionDiagnostics";
import { type RemoteHelperCancelResult } from "./RemoteHelperContract";
import type { SshClientRuntime } from "./SshClientRuntime";
import { createConnectionMachine, isConnectionMachineShutdown, reduceConnectionEvent, type ConnectionEffect, type ConnectionEvent, type ConnectionMachineState } from "./RemoteHostConnectionState";
import { SSH_RECONNECT_BACKOFF_MS, type SshConnectionDiagnostic, type SshConnectionPhase, type SshProcessExit, type SshProcessLauncher } from "./RemoteHostConnectionTypes";
import { releaseSshAttempt, runSshConnectionAttempt, type RequestIdCapture, type SshAttemptDeps, type SshAttemptHost, type SshAttemptReleaseReason, type SshConnectionAttempt } from "./SshConnectionAttempt";

/** Injectable timer port so reconnect schedules stay observable and testable. */
export type SshConnectionTimers = {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
};

/**
 * Verified bootstrap result of one host: the node binary the connection probe found, plus the deploy
 * root and bundle address the bootstrap ready frame reported. The manager never guesses a remote HOME,
 * so this is the only place the helper's remote location comes from.
 */
export type SshHelperSession = {
	nodePath: string;
	deployRoot: string;
	bundleSha256: string;
	/**
	 * Verified workspace root the helper confines every `fs.*` method to. The caller takes it from the
	 * workspace path the connection already verified and injects it at wiring time: the manager never
	 * guesses a root, never defaults to a remote HOME and never expands `~`. Omitting it is the legal
	 * host-only session (`hello`/`echo`/`cancel` are served, every `fs.*` answers PATH_OUTSIDE_ROOT), not
	 * an error. When it *is* present it has to be a non-empty string — anything else is a local wiring
	 * fault, while the path semantics (absolute, no trailing slash, not `/`, length, control characters)
	 * stay in `buildHelperRemoteCommand` so the two places cannot drift apart.
	 */
	root?: string;
};

export type SshConnectionManagerOptions = {
	userDataDir: string;
	client: SshClientRuntime;
	launcher?: SshProcessLauncher;
	/** How long a started SSH session must stay alive before it counts as connected. */
	stabilityWindowMs?: number;
	/**
	 * Verified helper bootstrap of this host. There is no fallback: without it an attempt fails closed
	 * with `SSH_HELPER_NOT_BOOTSTRAPPED`, because `ready` must never mean less than "the activated
	 * helper answered on this session". Its optional `root` is forwarded verbatim into the launched
	 * command; the manager itself neither validates nor invents one.
	 */
	helperSession?: SshHelperSession;
	/** Local deadline for that handshake. Clamped to the launcher cap; a nonsensical value uses the default. */
	handshakeTimeoutMs?: number;
	timers?: SshConnectionTimers;
	now?: () => number;
	random?: () => number;
	onDiagnostic?: (entry: SshConnectionDiagnostic) => void;
	/** 变更事件（helper 1.24.0）：无 id 帧的出口，带上 hostId 以区分同进程内的多台主机。 */
	onEvent?: (hostId: string, event: { watchId: string; paths: readonly string[] }) => void;
	/**
	 * Called on every state transition, after the machine has advanced.
	 *
	 * `connect()` only returns the state it reached, so without this a caller has no way to learn about
	 * anything that happens afterwards — a later degradation, a reconnect, or the shutdown that follows a
	 * successful `ready`. The UI showed "offline" right after a connection that had actually reached
	 * ready, purely because it only ever saw the return value.
	 */
	onStateChange?: (entry: { hostId: string; state: ConnectionMachineState }) => void;
};

/**
 * Per-call options of `request`. `onRequestId` is what makes a request withdrawable at all: the control
 * client mints the id itself and only cancels *by id*, so the id has to travel back to the caller.
 */
export type SshConnectionRequestOptions = {
	/** Local deadline of the request, forwarded to the control client's own contract bounds. */
	timeoutMs?: number;
	/**
	 * Called once, after the frame carrying the request has left the transport, with the id that frame was
	 * sent under — the only name `cancel` accepts for it. A request that was refused before anything was
	 * written (not ready, an unusable method, a frame that could not be encoded or written) reports no id
	 * at all, because there is no request the caller could withdraw.
	 */
	onRequestId?: (requestId: string) => void;
	/**
	 * Optional project-relative repository scope for this one request (the Git read batch only); it is a frame
	 * field, not a client concern like `onRequestId`, so it is forwarded to the control client verbatim.
	 */
	repo?: string;
};

export type SshConnectionManager = {
	getState(hostId: string): ConnectionMachineState;
	listDiagnostics(hostId?: string): SshConnectionDiagnostic[];
	connect(hostId: string): Promise<ConnectionMachineState>;
	retry(hostId: string): Promise<ConnectionMachineState>;
	/** Send one helper request on the live session of a ready host. */
	request(hostId: string, method: string, params?: unknown, options?: SshConnectionRequestOptions): Promise<unknown>;
	/**
	 * Withdraw one helper request by the id `request` reported, on the live session of a ready host. The
	 * answer is the control client's own: `{cancelled:true}` means the helper aborted work that had not
	 * started, and `{cancelled:false, reason:"already-settled"}` means the withdraw did **not** take effect —
	 * the request had already started or already finished — so it is never a rollback and says nothing about
	 * the request's own outcome.
	 */
	cancel(hostId: string, requestId: string, options?: { timeoutMs?: number }): Promise<RemoteHelperCancelResult>;
	/**
	 * Report an externally verified fatal condition about this host - a project root that no longer
	 * canonicalizes to itself, for instance. Unlike a failed attempt this report is not tied to an attempt,
	 * so it may arrive while nothing is in flight (disconnected/offline) and the host enters the terminal
	 * needs-attention state from there; the same actionability rules apply (only user-retry leaves it,
	 * generation fencing and the shutdown latch stay intact).
	 *
	 * A code that is not a stable enumerable code is collapsed to SSH_CONNECTION_NEEDS_ATTENTION: the code
	 * usually comes from a remote probe, and free text must never reach diagnostics or the renderer. An
	 * unknown host id gets an entry exactly like getState/connect does; a torn-down machine ignores it.
	 */
	reportNeedsAttention(hostId: string, code: string): void;
	/**
	 * The remote HOME a successful handshake reported for this host, or undefined while this host never
	 * handshook (or its session was released). Only a usable absolute POSIX path is ever stored, but the
	 * value still comes from the remote: callers must re-validate it before use (see
	 * RemoteHostConnectionService.remoteHome).
	 */
	getHome(hostId: string): string | undefined;
	/**
	 * Capability names the last successful handshake declared for this host, or undefined while no live
	 * session proves any. Read-only like getHome: asking never creates an entry, connects or probes.
	 */
	getCapabilities(hostId: string): readonly string[] | undefined;
	disconnect(hostId: string, reason: "abort" | "shutdown"): Promise<void>;
	dispose(): Promise<void>;
};

type HostEntry = {
	hostId: string;
	machine: ConnectionMachineState;
	timer?: unknown;
	/** Generation whose attempt is currently in flight; guards against double-driving one attempt. */
	runningGeneration?: number;
	/**
	 * Bumped by every disconnect. An attempt captures it before awaiting the spawn, so a process that
	 * finishes starting after the caller already aborted is stopped instead of being adopted by a
	 * caller that has moved on.
	 */
	epoch: number;
	/** In-flight attempt for this host, so teardown can wait for it instead of racing the spawn. */
	attempt?: Promise<void>;
	/**
	 * Resources owned by the *current* attempt, handed over by `SshConnectionAttempt`. Everything is
	 * released through that object, so a late callback from a superseded attempt can only ever release
	 * its own handle and client — it can never tear down the session that replaced it.
	 */
	live?: SshConnectionAttempt;
	/** Short-lived sessions seen so far; a session that lives long enough resets the counter. */
	flaps: number;
	/** Timestamp the current session became ready, used to tell a flap from a healthy session. */
	readyAt?: number;
	/** Codes already recorded for the current generation, so remote noise cannot flush the history. */
	recordedCodes: Set<string>;
	latestPhase: SshConnectionPhase;
	/**
	 * Remote HOME reported by the last successful handshake of this entry. Kept per host, not per attempt,
	 * because the session root a reader derives from it (home + ".pi/agent/sessions") outlives one attempt;
	 * cleared when the session is released so a dead session cannot keep naming a home that was never
	 * proven usably reachable. Only a value that passes readRemoteHome is stored.
	 */
	home?: string;
	/**
	 * Capability names the same handshake declared. Kept next to home for the same reason: a project read
	 * surface negotiates optional work (content search) from this list without opening a second session, and
	 * a released session must not keep advertising what it once could do. Cleared with home on release.
	 */
	capabilities?: readonly string[];
};

const DEFAULT_STABILITY_WINDOW_MS = 750;
const MAX_STABILITY_WINDOW_MS = 10_000;
/**
 * A handshake that never completes must fail the attempt instead of suspending it: the helper answers in
 * milliseconds, so this budget only covers a slow link plus one process start.
 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Stable diagnostic codes only; anything else is collapsed before it reaches the redaction layer. */
const DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
/** Fallback when a caller-supplied fatal code is not a stable enumerable one (see reportNeedsAttention). */
const CODE_NEEDS_ATTENTION = "SSH_CONNECTION_NEEDS_ATTENTION";
/** Control bytes must never survive in a path handed on to another module. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Upper bound of a stored remote HOME, matching the helper's own MAX_HOME ceiling. */
const REMOTE_HOME_MAX_LENGTH = 4096;
/** A session that dies before this uptime is a flap, not a working connection. */
const MIN_HEALTHY_UPTIME_MS = 30_000;
/** Flaps tolerated (across ready cycles) before the manager stops retrying and asks the user. */
const MAX_FLAPS = SSH_RECONNECT_BACKOFF_MS.length;
/** Distinct diagnostic codes kept per host before the dedupe set is recycled. */
const MAX_RECORDED_CODES = 256;

/** `exitCode` from a crashed Windows process (e.g. 0xC0000005) is not in the diagnostic domain. */
function normalizeExitCode(exitCode: number | null | undefined): number | undefined {
	return typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode >= -1 && exitCode <= 255 ? exitCode : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the verified bootstrap session. An unusable value is reported exactly like a missing one: a
 * relative path or a bad bundle address is a local wiring fault, and retrying the command builder's
 * refusal five times would only delay the `needs-attention` the caller has to see.
 *
 * `root` is optional — a host-only session is a legal state, not a defect — but a root that *is* there
 * and is not a non-empty string is a wiring fault of exactly the same kind, so it fails closed here
 * instead of entering the retry ladder. Only presence is decided here; the path rules (absolute, no
 * trailing slash, not `/`, length, control characters) stay in `buildHelperRemoteCommand` so a second
 * copy of them cannot drift away from the one the command is actually built with.
 */
function readHelperSession(value: unknown): SshHelperSession | undefined {
	if (!isRecord(value)) return undefined;
	const { nodePath, deployRoot, bundleSha256, root } = value;
	if (typeof nodePath !== "string" || typeof deployRoot !== "string" || typeof bundleSha256 !== "string") return undefined;
	if (root === undefined) return { nodePath, deployRoot, bundleSha256 };
	if (typeof root !== "string" || root.length === 0) return undefined;
	return { nodePath, deployRoot, bundleSha256, root };
}

/**
 * A remote HOME is only storable when it is a non-empty absolute POSIX path without control bytes and
 * within the helper's own ceiling. The attempt already proved the handshake carried a string, but that is
 * a type fact about a value that came from the far side: anything else is dropped here instead of being
 * kept as a path another module could later join into a session location.
 */
function readRemoteHome(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > REMOTE_HOME_MAX_LENGTH) return undefined;
	if (value.charAt(0) !== "/" || CONTROL_CHARS.test(value)) return undefined;
	return value;
}

/** A missing or nonsensical handshake budget falls back to the default; the deadline is never disabled. */
function readHandshakeTimeoutMs(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_HANDSHAKE_TIMEOUT_MS;
	return Math.max(1, Math.min(Math.floor(value), SSH_LAUNCHER_MAX_TIMEOUT_MS));
}

/**
 * Hand one reported id to the caller's observer. It runs after the frame left, inside the caller's own call,
 * and a broken observer is swallowed exactly like a broken diagnostic sink: an observer must never be able to
 * fail a request that is already on the wire.
 */
function reportRequestId(options: SshConnectionRequestOptions | undefined, requestId: string): void {
	const onRequestId = options?.onRequestId;
	if (typeof onRequestId !== "function") return;
	try {
		onRequestId(requestId);
	} catch {
		// Observer side channel; see above.
	}
}

/**
 * The control client's own per-call options. `onRequestId` belongs to this layer and is deliberately not
 * forwarded, so the two option surfaces cannot drift into one another; `repo` is a wire field and is forwarded.
 */
function clientRequestOptions(options: SshConnectionRequestOptions | undefined): { timeoutMs?: number; repo?: string } | undefined {
	if (options?.timeoutMs === undefined && options?.repo === undefined) return undefined;
	return { ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.repo === undefined ? {} : { repo: options.repo }) };
}

/**
 * Failures that a retry cannot fix: the profile, pin, route or client itself is wrong, so the user
 * has to act. Everything else is treated as transient and retried on the backoff schedule.
 */
const FATAL_CODES = new Set([
	"SSH_HOST_NOT_READY",
	"SSH_HOST_ROUTE_CHANGED",
	"SSH_HOST_PIN_INVALID",
	"SSH_HOST_CANDIDATE_INVALID",
	"SSH_HOST_IDENTITY_UNAVAILABLE",
	"SSH_HOST_CLIENT_CONTEXT_REQUIRED",
	"SSH_CLIENT_UNAVAILABLE",
	"SSH_CLIENT_SCRIPT_SHIM",
	"SSH_CLIENT_UNSUPPORTED_PLATFORM",
	"SSH_CLIENT_VERSION_UNSUPPORTED",
	"SSH_CLIENT_MISSING",
	"SSH_CLIENT_NOT_REGULAR_FILE",
	"SSH_CLIENT_UNREADABLE",
	"SSH_CLIENT_PATH_INVALID",
	"SSH_CLIENT_CONTEXT_REQUIRED",
	"INVALID_SSH_HOST",
	"INVALID_SSH_ROUTE",
	"SSH_HOST_STRICT_CONFIG_INVALID",
	"INVALID_SSH_USER",
	"INVALID_SSH_PORT",
	"INVALID_SSH_PROXY_JUMP",
	"INVALID_SSH_PIN_ALIAS",
	"INVALID_SSH_LOCAL_PATH",
	"INVALID_SSH_VERIFIED_TARGET",
	"INVALID_SSH_CONNECT_TIMEOUT",
	"INVALID_SSH_COMMAND_KIND",
	// A bundle that answers another protocol version and an attempt without a verified bootstrap result
	// are both unfixable by retrying: only a fresh bootstrap or a corrected caller can change them.
	"SSH_HELPER_PROTOCOL_MISMATCH",
	// A helper that cannot serve a required operation was deployed from a verified content-addressed bundle,
	// so reconnecting answers the same build with the same gap: the fix is a redeploy/upgrade, not a retry.
	"SSH_HELPER_CAPABILITY_MISSING",
	// A root mismatch is fixed per session: the helper resolved its boundary once at startup, so retrying
	// the same session would produce the same answer. The user has to act (re-confirm the browse root).
	"SSH_HELPER_ROOT_MISMATCH",
	"SSH_HELPER_NOT_BOOTSTRAPPED",
]);

function isFatalCode(code: string): boolean {
	return FATAL_CODES.has(code) || code.startsWith("REMOTE_HOST_");
}

/**
 * Owns the lifecycle of one pinned SSH connection per host: it drives the pure state machine, performs
 * the preflight, starts the pinned ssh process through the injected launcher, asks the remote helper to
 * identify itself and records redacted diagnostics.
 *
 * `ready` means "the helper answered a v1 handshake on this session" — never merely "a process is
 * alive". That is why a verified `helperSession` is mandatory: without one an attempt fails closed
 * with `SSH_HELPER_NOT_BOOTSTRAPPED` instead of reporting a connection that was never proven usable.
 *
 * This module keeps the host-level half of that work only: the machine events, the phase vocabulary, the
 * backoff ladder and flap budget, the diagnostics history and the public API. One attempt's own
 * lifecycle — pinned invocation, process, subscriptions, control client, handshake and its per-attempt
 * release — lives in `SshConnectionAttempt`, which reaches this host exclusively through `SshAttemptHost`.
 */
export function createSshConnectionManager(options: SshConnectionManagerOptions): SshConnectionManager {
	if (typeof options?.userDataDir !== "string" || typeof options.client?.run !== "function") throw new Error("SSH_CONNECTION_MANAGER_OPTIONS_INVALID");
	const launcher = options.launcher ?? createSshProcessLauncher();
	const timers: SshConnectionTimers = options.timers ?? { setTimeout: (handler, delayMs) => setTimeout(handler, delayMs), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) };
	const now = options.now ?? (() => Date.now());
	const random = options.random ?? (() => Math.random());
	const stabilityWindowMs = Math.min(Math.max(options.stabilityWindowMs ?? DEFAULT_STABILITY_WINDOW_MS, 0), MAX_STABILITY_WINDOW_MS);
	const handshakeTimeoutMs = readHandshakeTimeoutMs(options.handshakeTimeoutMs);
	const history = createDiagnosticHistory();
	const hosts = new Map<string, HostEntry>();
	/** Stable inputs of every attempt; only the bootstrap is read per attempt, never cached. */
	const attemptDeps: SshAttemptDeps = {
		userDataDir: options.userDataDir,
		client: options.client,
		launcher,
		stabilityWindowMs,
		handshakeTimeoutMs,
		delay,
		readBootstrap: () => readHelperSession(options.helperSession),
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
	};
	let disposed = false;
	let disposing: Promise<void> | undefined;

	function entryFor(hostId: string): HostEntry {
		let entry = hosts.get(hostId);
		if (!entry) {
			entry = { hostId, machine: createConnectionMachine(hostId), epoch: 0, flaps: 0, recordedCodes: new Set(), latestPhase: "openssh" };
			hosts.set(hostId, entry);
		}
		return entry;
	}

	function record(entry: HostEntry, code: string, exitCode?: number): void {
		const stableCode = DIAGNOSTIC_CODE.test(code) ? code : "SSH_CONNECTION_FAILED";
		// One entry per code per generation: a helper that logs every frame must not be able to push the
		// connection history out of the bounded ring with noise from the far side.
		const key = `${entry.machine.generation}:${stableCode}`;
		if (entry.recordedCodes.has(key)) return;
		entry.recordedCodes.add(key);
		if (entry.recordedCodes.size > MAX_RECORDED_CODES) entry.recordedCodes.clear();
		// Diagnostics are emitted from process-exit and timer callbacks: a throw here would escape into
		// the main process event loop, so a rejected record is dropped instead of crashing the app.
		try {
			const diagnostic = createConnectionDiagnostic({
				hostId: entry.hostId,
				generation: entry.machine.generation,
				phase: entry.latestPhase,
				state: entry.machine.state,
				code: stableCode,
				at: new Date(now()).toISOString(),
				...(normalizeExitCode(exitCode) !== undefined ? { exitCode: normalizeExitCode(exitCode) } : {}),
			});
			history.record(diagnostic);
			options.onDiagnostic?.(diagnostic);
		} catch {
			// Intentionally ignored; see the comment above.
		}
	}

	/** Reduce one event, apply its effects and record the resulting state change. */
	function apply(entry: HostEntry, event: ConnectionEvent): { state: ConnectionMachineState; startGeneration?: number } {
		const before = entry.machine;
		const reduced = reduceConnectionEvent(before, event, { now, random });
		if (reduced.state === before && reduced.effects.length === 0) return { state: before };
		entry.machine = reduced.state;
		let startGeneration: number | undefined;
		for (const effect of reduced.effects) applyEffect(entry, effect, (generation) => (startGeneration = generation));
		if (reduced.state !== before && reduced.state.lastCode !== undefined) record(entry, reduced.state.lastCode);
		// Emitted for every transition, including the ones no diagnostic is recorded for (they are not all
		// failures). The sink is called last so a listener that throws cannot corrupt the machine.
		if (reduced.state !== before) {
			try {
				options.onStateChange?.({ hostId: entry.hostId, state: entry.machine });
			} catch {
				// A listener failure must not take down a connection.
			}
		}
		return { state: entry.machine, ...(startGeneration !== undefined ? { startGeneration } : {}) };
	}

	function applyEffect(entry: HostEntry, effect: ConnectionEffect, onStart: (generation: number) => void): void {
		switch (effect.kind) {
			case "start-attempt":
				onStart(effect.generation);
				return;
			case "schedule-reconnect":
				clearTimer(entry);
				entry.timer = timers.setTimeout(() => {
					entry.timer = undefined;
					// The timer is fenced by generation: a schedule that a newer attempt replaced is dropped
					// by the reducer instead of starting a second parallel attempt.
					const applied = apply(entry, { type: "reconnect-due", generation: effect.generation });
					kickOff(entry, applied.startGeneration);
				}, effect.delayMs);
				return;
			case "cancel-reconnect":
				clearTimer(entry);
				return;
			case "shutdown":
				clearTimer(entry);
				stopHandle(entry);
				return;
		}
	}

	function clearTimer(entry: HostEntry): void {
		if (entry.timer === undefined) return;
		timers.clearTimeout(entry.timer);
		entry.timer = undefined;
	}

	/**
	 * Release one attempt's own resources through `SshConnectionAttempt` and drop this host's reference to
	 * it. The reference is cleared between the detach and the signal, so a re-entrant teardown can never
	 * release the same attempt twice.
	 */
	function releaseLive(entry: HostEntry, attempt: SshConnectionAttempt, reason: SshAttemptReleaseReason): void {
		releaseSshAttempt(attempt, reason, () => {
			if (entry.live === attempt) entry.live = undefined;
		});
	}

	/** Stop whatever this host currently runs; used by the failure paths of a running attempt. */
	function stopHandle(entry: HostEntry): void {
		const live = entry.live;
		if (live) releaseLive(entry, live, "shutdown");
	}

	function delay(delayMs: number): Promise<void> {
		if (delayMs <= 0) return Promise.resolve();
		return new Promise((resolve) => {
			timers.setTimeout(() => resolve(), delayMs);
		});
	}

	function fail(entry: HostEntry, generation: number, error: unknown): void {
		const code = diagnosticCodeFromError(error);
		record(entry, code);
		if (isFatalCode(code)) {
			apply(entry, { type: "needs-attention", generation, code });
			return;
		}
		// Never reached ready: count it as a flap too, so a host that only ever fails short is bounded.
		entry.flaps += 1;
		if (escalateIfExhausted(entry, generation)) return;
		apply(entry, { type: "disconnected", generation, code });
	}

	/**
	 * Stops retrying once the ladder or the flap budget is spent. Without the flap budget a session
	 * that is killed and restarted would reset the ladder on every success and retry forever.
	 */
	function escalateIfExhausted(entry: HostEntry, generation: number): boolean {
		if (entry.machine.attempts >= SSH_RECONNECT_BACKOFF_MS.length) {
			apply(entry, { type: "needs-attention", generation, code: "SSH_CONNECTION_RETRIES_EXHAUSTED" });
			return true;
		}
		if (entry.flaps > MAX_FLAPS) {
			apply(entry, { type: "needs-attention", generation, code: "SSH_CONNECTION_UNSTABLE" });
			return true;
		}
		return false;
	}

	/**
	 * Terminal exit of one process. `SshConnectionAttempt` has already released the attempt's own resources
	 * and hands the closed process over here; flap counting, the retry ladder and the resulting machine
	 * event are this host's own.
	 */
	function onProcessExit(entry: HostEntry, generation: number, epoch: number, exit: SshProcessExit): void {
		// An abort keeps the generation (so the fence stays monotonic), which is why the epoch matters
		// here: without it a late exit from an aborted attempt would still be recorded and counted.
		if (disposed || entry.epoch !== epoch || isConnectionMachineShutdown(entry.machine) || entry.machine.generation !== generation) return;
		if (exit.kind === "stopped") return;
		// A launcher-level cause (e.g. bounded-output overflow) is more specific than a lost session.
		const code = exit.errorCode ?? (exit.kind === "timeout" ? "SSH_CONNECTION_TIMEOUT" : "SSH_CONNECTION_LOST");
		record(entry, code, exit.code ?? undefined);
		// A session that only lives briefly is a flap: the retry ladder alone cannot see this, because a
		// successful connect resets it — that is how a killed session looped forever at the first rung.
		const uptime = entry.readyAt === undefined ? undefined : now() - entry.readyAt;
		entry.readyAt = undefined;
		if (uptime !== undefined && uptime >= MIN_HEALTHY_UPTIME_MS) entry.flaps = 0;
		else entry.flaps += 1;
		if (escalateIfExhausted(entry, generation)) return;
		const applied = apply(entry, { type: "disconnected", generation, code });
		if (applied.state.state === "reconnecting") entry.latestPhase = "openssh";
	}

	/**
	 * One attempt's whole view of this host: the phase/diagnostic sinks, the ownership fences and the two
	 * hand-backs (a closed process, a failed attempt). Everything an attempt may do to this host goes
	 * through this object, so it can never reach another host's or another generation's state.
	 */
	function createAttemptHost(entry: HostEntry, generation: number): SshAttemptHost {
		const epoch = entry.epoch;
		/** The attempt this port handed over; `entry.live` holds the same object once it was adopted. */
		let attempt: SshConnectionAttempt | undefined;

		/**
		 * True while this attempt is still the host's live one and the machine still accepts its report.
		 * Before adoption both sides are `undefined`, which is the pre-flight state of an attempt that may
		 * still fail closed without having touched a process at all.
		 */
		function ownsLiveAttempt(): boolean {
			return entry.epoch === epoch && entry.live === attempt && entry.machine.generation === generation && !disposed && !isConnectionMachineShutdown(entry.machine);
		}

		return {
			hostId: entry.hostId,
			generation,
			setPhase(phase) {
				entry.latestPhase = phase;
			},
			enterPhase(phase) {
				entry.latestPhase = phase;
				apply(entry, { type: "phase-entered", generation, phase });
			},
			record(code, exitCode) {
				record(entry, code, exitCode);
			},
			markReady(home, capabilities) {
				apply(entry, { type: "connected", generation });
				entry.readyAt = now();
				// The handshake is the only place this host's remote HOME exists: the manager never guesses one,
				// so a value that cannot be used as a POSIX path is dropped rather than stored half-usable.
				entry.home = readRemoteHome(home);
				// Same fence for the optional vocabulary: only non-empty bounded strings are kept, and an empty
				// list is stored as an empty list (the helper answered) rather than as "unknown".
				entry.capabilities = Array.isArray(capabilities) ? capabilities.filter((value) => typeof value === "string" && value.length > 0 && value.length <= 64).slice(0, 256) : undefined;
				record(entry, "SSH_CONNECTION_READY");
			},
			isCurrentGeneration() {
				return entry.machine.generation === generation;
			},
			isSuperseded() {
				return disposed || entry.epoch !== epoch || entry.machine.generation !== generation;
			},
			adopt(next) {
				attempt = next;
				entry.live = next;
			},
			ownsLiveAttempt,
			releaseAttempt(reason) {
				if (attempt !== undefined) releaseLive(entry, attempt, reason);
			},
			absorbExit(exit) {
				onProcessExit(entry, generation, epoch, exit);
			},
			failAttempt(error) {
				// A caller abort (epoch) and an attempt that was already released have both had their
				// outcome recorded by the path that released them; failing them again would add a second
				// diagnostic and a flap for a session that is gone. Stale generations and a latched machine
				// are fenced the same way.
				if (!ownsLiveAttempt()) return;
				stopHandle(entry);
				fail(entry, generation, error);
			},
		};
	}

	async function runAttempt(entry: HostEntry, generation: number): Promise<void> {
		if (disposed || isConnectionMachineShutdown(entry.machine) || entry.runningGeneration === generation) return;
		entry.runningGeneration = generation;
		try {
			await runSshConnectionAttempt(createAttemptHost(entry, generation), attemptDeps);
		} finally {
			if (entry.runningGeneration === generation) entry.runningGeneration = undefined;
		}
	}

	function kickOff(entry: HostEntry, startGeneration: number | undefined): Promise<void> | undefined {
		if (startGeneration === undefined) return undefined;
		const attempt = runAttempt(entry, startGeneration);
		entry.attempt = attempt;
		// Automatic retries must not become unhandled rejections; explicit callers await the result.
		void attempt
			.catch(() => undefined)
			.finally(() => {
				if (entry.attempt === attempt) entry.attempt = undefined;
			});
		return attempt;
	}

	/** Single teardown path so a bare callback reference can never lose the cleanup (no `this` use). */
	async function disconnectHost(entry: HostEntry, reason: "abort" | "shutdown"): Promise<void> {
		// Invalidate any attempt that is still waiting on its spawn before touching the machine.
		entry.epoch += 1;
		clearTimer(entry);
		const live = entry.live;
		if (live) await releaseLive(entry, live, reason);
		entry.readyAt = undefined;
		// A released session must not keep naming a remote home or advertising its capabilities:
		// `remoteHome` answers "unknown" for a host that is not connected, and the next handshake records
		// the home and vocabulary of the session that actually ran.
		entry.home = undefined;
		entry.capabilities = undefined;
		if (reason === "shutdown") {
			// App exit latches the machine: no timer or retry may revive a torn-down connection.
			apply(entry, { type: "shutdown" });
		} else {
			// An abort returns the host to idle so the user can connect again, but the generation keeps
			// advancing so a late event or exit from the aborted attempt can never be accepted.
			const generation = entry.machine.generation;
			entry.machine = { ...createConnectionMachine(entry.hostId), generation };
			record(entry, "SSH_CONNECTION_ABORTED");
		}
	}

	return {
		getState(hostId) {
			return entryFor(hostId).machine;
		},
		listDiagnostics(hostId) {
			return history.list(hostId);
		},
		async connect(hostId) {
			// Refusing loudly beats leaving the caller with a host stuck in `connecting` forever.
			if (disposed) throw new Error("SSH_CONNECTION_MANAGER_DISPOSED");
			const entry = entryFor(hostId);
			// Await the attempt so callers observe the settled state, not the intermediate `connecting`.
			await kickOff(entry, apply(entry, { type: "begin-attempt" }).startGeneration);
			return entry.machine;
		},
		async retry(hostId) {
			if (disposed) throw new Error("SSH_CONNECTION_MANAGER_DISPOSED");
			const entry = entryFor(hostId);
			await kickOff(entry, apply(entry, { type: "user-retry" }).startGeneration);
			return entry.machine;
		},
		reportNeedsAttention(hostId, code) {
			// A malformed id is ignored instead of creating an unreachable entry keyed by garbage; a usable one
			// creates its host entry exactly like getState/connect does, so a verified condition can become
			// visible even before this host ever attempted a connection.
			if (disposed || typeof hostId !== "string" || hostId.length === 0) return;
			const entry = entryFor(hostId);
			// The reducer fences on generation because it normally speaks about one attempt. This report speaks
			// about the machine as it exists now, which is precisely the current generation - that is what lets an
			// external condition land on an idle host without inventing an attempt.
			apply(entry, { type: "needs-attention", generation: entry.machine.generation, code: DIAGNOSTIC_CODE.test(code) ? code : CODE_NEEDS_ATTENTION });
		},
		getHome(hostId) {
			// No entry is created here: asking about a home must not make an unknown host look known, and the
			// caller re-validates the shape anyway (this value came from the remote).
			return hosts.get(hostId)?.home;
		},
		getCapabilities(hostId) {
			// Same rule as getHome: no entry is created for an unknown host, and undefined means "never
			// proved on a live session", which a consumer must treat as unsupported rather than guess.
			return hosts.get(hostId)?.capabilities;
		},
		async disconnect(hostId, reason) {
			return disconnectHost(entryFor(hostId), reason);
		},
		request(hostId, method, params, requestOptions) {
			// Only a ready session with a live protocol client may carry requests; anything else must be
			// refused instead of queueing work behind a connection that does not exist yet.
			if (disposed) return Promise.reject(new Error("SSH_CONNECTION_MANAGER_DISPOSED"));
			const entry = entryFor(hostId);
			const live = entry.live;
			if (entry.machine.state !== "ready" || live === undefined || live.control === undefined) return Promise.reject(new Error("SSH_CONNECTION_NOT_READY"));
			const control = live.control;
			// Arm the capture for the synchronous window in which the client mints its id and writes the frame:
			// `control.request` runs that whole prologue before it returns its promise, so no second caller can
			// pick up this frame's id. The client's id is the only name a withdraw can use, which is why it has
			// to be read back out of the frame (see `acceptFrameId`).
			const capture: RequestIdCapture = { method };
			live.idCapture = capture;
			let started: Promise<unknown>;
			try {
				started = control.request(method, params, clientRequestOptions(requestOptions));
			} finally {
				// Disarmed on every path, including a refusal the client raised before writing anything.
				if (live.idCapture === capture) live.idCapture = undefined;
			}
			// Reported only once the capture holds an id, which only happens for a frame the transport took:
			// a refused, undeliverable or never-encoded request reports nothing at all.
			if (capture.id !== undefined) reportRequestId(requestOptions, capture.id);
			return started;
		},
		cancel(hostId, requestId, requestOptions) {
			// Same readiness rule as `request`: only the live generation of a ready host can be asked to
			// withdraw anything, and anything else fails closed instead of queueing behind a dead session.
			if (disposed) return Promise.reject(new Error("SSH_CONNECTION_MANAGER_DISPOSED"));
			const entry = entryFor(hostId);
			const control = entry.live?.control;
			if (entry.machine.state !== "ready" || control === undefined) return Promise.reject(new Error("SSH_CONNECTION_NOT_READY"));
			// The client owns the id shape, the pending table and the meaning of the answer, so this is a
			// pass-through on purpose: re-validating or reinterpreting them here could only disagree with the
			// side that actually decides whether the withdraw took effect.
			return control.cancel(requestId, clientRequestOptions(requestOptions));
		},
		dispose() {
			return (disposing ??= (async () => {
				disposed = true;
				const entries = [...hosts.values()];
				await Promise.all(entries.map((entry) => disconnectHost(entry, "shutdown")));
				await Promise.all(entries.map((entry) => entry.attempt?.catch(() => undefined)));
				hosts.clear();
			})());
		},
	};
}
