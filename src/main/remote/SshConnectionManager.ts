import { createSshProcessLauncher, SSH_LAUNCHER_MAX_OUTPUT_BYTES, SSH_LAUNCHER_MAX_TIMEOUT_MS } from "./SshProcessLauncher";
import { createConnectionDiagnostic, createDiagnosticHistory, diagnosticCodeFromError } from "./SshConnectionDiagnostics";
import { createRemoteControlClient, type RemoteControlClient } from "./RemoteControlClient";
import { REMOTE_HELPER_MAX_FRAME_BYTES } from "./RemoteHelperContract";
import { buildPinnedSshInvocation } from "./SshVerifiedConnection";
import type { SshClientRuntime } from "./SshClientRuntime";
import { createConnectionMachine, isConnectionMachineShutdown, reduceConnectionEvent, type ConnectionEffect, type ConnectionEvent, type ConnectionMachineState } from "./RemoteHostConnectionState";
import { SSH_RECONNECT_BACKOFF_MS, type SshConnectionDiagnostic, type SshConnectionPhase, type SshLauncherHandle, type SshProcessLauncher } from "./RemoteHostConnectionTypes";

/** Injectable timer port so reconnect schedules stay observable and testable. */
export type SshConnectionTimers = {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
};

export type SshConnectionManagerOptions = {
	userDataDir: string;
	client: SshClientRuntime;
	launcher?: SshProcessLauncher;
	/** How long a started SSH session must stay alive before it counts as connected. */
	stabilityWindowMs?: number;
	timers?: SshConnectionTimers;
	now?: () => number;
	random?: () => number;
	onDiagnostic?: (entry: SshConnectionDiagnostic) => void;
};

export type SshConnectionManager = {
	getState(hostId: string): ConnectionMachineState;
	listDiagnostics(hostId?: string): SshConnectionDiagnostic[];
	connect(hostId: string): Promise<ConnectionMachineState>;
	retry(hostId: string): Promise<ConnectionMachineState>;
	/** Send one helper request on the live session of a ready host. */
	request(hostId: string, method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
	disconnect(hostId: string, reason: "abort" | "shutdown"): Promise<void>;
	dispose(): Promise<void>;
};

type HostEntry = {
	hostId: string;
	machine: ConnectionMachineState;
	handle?: SshLauncherHandle;
	timer?: unknown;
	unsubscribeExit?: () => void;
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
	 * Resources owned by the *current* attempt. Everything is released through the object itself, so a
	 * late callback from a superseded attempt can only ever release its own handle and client — it can
	 * never tear down the session that replaced it.
	 */
	live?: LiveAttempt;
	/** Short-lived sessions seen so far; a session that lives long enough resets the counter. */
	flaps: number;
	/** Timestamp the current session became ready, used to tell a flap from a healthy session. */
	readyAt?: number;
	/** Codes already recorded for the current generation, so remote noise cannot flush the history. */
	recordedCodes: Set<string>;
	latestPhase: SshConnectionPhase;
};

type LiveAttempt = {
	handle: SshLauncherHandle;
	control?: RemoteControlClient;
	unsubscribeExit?: () => void;
	unsubscribeStdout?: () => void;
	unsubscribeStderr?: () => void;
};

const DEFAULT_STABILITY_WINDOW_MS = 750;
const MAX_STABILITY_WINDOW_MS = 10_000;
/** Stable diagnostic codes only; anything else is collapsed before it reaches the redaction layer. */
const DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
/**
 * A control session must outlive a one-shot probe, so the manager states its own deadline explicitly
 * instead of inheriting the launcher's 30s command default. The launcher cap is the hard bound.
 */
const SESSION_DEADLINE_MS = SSH_LAUNCHER_MAX_TIMEOUT_MS;
const SESSION_MAX_OUTPUT_BYTES = SSH_LAUNCHER_MAX_OUTPUT_BYTES;
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
]);

function isFatalCode(code: string): boolean {
	return FATAL_CODES.has(code) || code.startsWith("REMOTE_HOST_");
}

/**
 * Owns the local lifecycle of one pinned SSH connection per host: it drives the pure state machine,
 * performs the preflight, starts the process through the injected launcher and records redacted
 * diagnostics. It deliberately does not talk to the remote side beyond starting the pinned ssh
 * process, so `ready` means "the pinned session started and stayed alive" — never "helper verified".
 */
export function createSshConnectionManager(options: SshConnectionManagerOptions): SshConnectionManager {
	if (typeof options?.userDataDir !== "string" || typeof options.client?.run !== "function") throw new Error("SSH_CONNECTION_MANAGER_OPTIONS_INVALID");
	const launcher = options.launcher ?? createSshProcessLauncher();
	const timers: SshConnectionTimers = options.timers ?? { setTimeout: (handler, delayMs) => setTimeout(handler, delayMs), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) };
	const now = options.now ?? (() => Date.now());
	const random = options.random ?? (() => Math.random());
	const stabilityWindowMs = Math.min(Math.max(options.stabilityWindowMs ?? DEFAULT_STABILITY_WINDOW_MS, 0), MAX_STABILITY_WINDOW_MS);
	const history = createDiagnosticHistory();
	const hosts = new Map<string, HostEntry>();
	let disposed = false;

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
	 * Release one attempt's own resources: detach its subscriptions, reject its pending requests and
	 * stop its process. Everything is scoped to the attempt, so releasing a superseded attempt can
	 * never disturb the session that replaced it.
	 */
	function releaseAttempt(entry: HostEntry, live: LiveAttempt, reason: "abort" | "shutdown" | "lost"): void {
		live.unsubscribeExit?.();
		live.unsubscribeExit = undefined;
		live.unsubscribeStdout?.();
		live.unsubscribeStdout = undefined;
		live.unsubscribeStderr?.();
		live.unsubscribeStderr = undefined;
		try {
			live.control?.closeConnection(reason === "lost" ? "REMOTE_CONNECTION_LOST" : reason === "abort" ? "REQUEST_CANCELLED" : "REMOTE_CONNECTION_LOST");
		} catch {
			// Teardown runs from exit and timer callbacks; it must never throw into the event loop.
		}
		if (entry.live === live) entry.live = undefined;
		if (reason !== "lost") void live.handle.stop(reason).catch(() => undefined);
	}

	/** Stop whatever this host currently runs; used by the failure paths of a running attempt. */
	function stopHandle(entry: HostEntry): void {
		const live = entry.live;
		if (live) releaseAttempt(entry, live, "shutdown");
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

	async function runAttempt(entry: HostEntry, generation: number): Promise<void> {
		if (disposed || isConnectionMachineShutdown(entry.machine) || entry.runningGeneration === generation) return;
		entry.runningGeneration = generation;
		const epoch = entry.epoch;
		try {
			entry.latestPhase = "openssh";
			record(entry, "SSH_CONNECTION_PREFLIGHT");
			const invocation = await buildPinnedSshInvocation(options.userDataDir, entry.hostId, "ssh-batch", { client: options.client });
			if (entry.machine.generation !== generation) return;
			entry.latestPhase = "authenticate";
			apply(entry, { type: "phase-entered", generation, phase: "authenticate" });
			const handle = await launcher.start({ hostId: entry.hostId, generation, invocation, timeoutMs: SESSION_DEADLINE_MS, maxOutputBytes: SESSION_MAX_OUTPUT_BYTES, maxLineBytes: REMOTE_HELPER_MAX_FRAME_BYTES, stdin: true });
			if (disposed || entry.epoch !== epoch || entry.machine.generation !== generation) {
				// The attempt was superseded, aborted or torn down while spawning: the process must not
				// survive it, even though start() already produced a live handle.
				await handle.stop("abort").catch(() => undefined);
				return;
			}
			const live: LiveAttempt = { handle };
			entry.live = live;
			live.unsubscribeExit = handle.onExit((exit) => onExit(entry, generation, epoch, live, exit));
			const control = createRemoteControlClient({
				hostId: entry.hostId,
				send: (line) => handle.write(line),
				...(options.now === undefined ? {} : { now: options.now }),
				onDiagnostic: (diagnostic) => record(entry, diagnostic.code),
			});
			control.openConnection();
			live.control = control;
			// stdout carries protocol frames only; stderr is diagnostics, so its text is never recorded
			// (only the fact that the helper complained).
			live.unsubscribeStdout = handle.onStdoutLine((line) => {
				try {
					control.handleLine(line);
				} catch {
					record(entry, "SSH_HELPER_FRAME_DROPPED");
				}
			});
			live.unsubscribeStderr = handle.onStderrLine(() => record(entry, "SSH_HELPER_STDERR"));
			await delay(stabilityWindowMs);
			if (entry.machine.generation !== generation || isConnectionMachineShutdown(entry.machine)) return;
			if (entry.live !== live) return; // already released during the window
			apply(entry, { type: "connected", generation });
			entry.readyAt = now();
			record(entry, "SSH_CONNECTION_READY");
		} catch (error) {
			if (entry.machine.generation === generation && !isConnectionMachineShutdown(entry.machine)) {
				stopHandle(entry);
				fail(entry, generation, error);
			}
		} finally {
			if (entry.runningGeneration === generation) entry.runningGeneration = undefined;
		}
	}

	function onExit(entry: HostEntry, generation: number, epoch: number, live: LiveAttempt, exit: { kind: string; code: number | null; signal: NodeJS.Signals | null; errorCode?: string }): void {
		// Release this attempt's own resources first: its pending requests must settle even when the exit
		// is fenced away, but nothing here may touch a session that already replaced this attempt.
		releaseAttempt(entry, live, "lost");
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
		if (live) await releaseAttempt(entry, live, reason);
		entry.readyAt = undefined;
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
		async disconnect(hostId, reason) {
			return disconnectHost(entryFor(hostId), reason);
		},
		request(hostId, method, params, requestOptions) {
			// Only a ready session with a live protocol client may carry requests; anything else must be
			// refused instead of queueing work behind a connection that does not exist yet.
			if (disposed) return Promise.reject(new Error("SSH_CONNECTION_MANAGER_DISPOSED"));
			const entry = entryFor(hostId);
			const control = entry.live?.control;
			if (entry.machine.state !== "ready" || control === undefined) return Promise.reject(new Error("SSH_CONNECTION_NOT_READY"));
			return control.request(method, params, requestOptions);
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			const entries = [...hosts.values()];
			await Promise.all(entries.map((entry) => disconnectHost(entry, "shutdown")));
			// A spawn already in flight when teardown started still resolves; the epoch change makes the
			// attempt stop the process it produced, so teardown must wait for that to finish.
			await Promise.all(entries.map((entry) => entry.attempt?.catch(() => undefined)));
			hosts.clear();
		},
	};
}
