import { createRemoteControlClient, type RemoteControlClient } from "./RemoteControlClient";
import { REMOTE_HELPER_MAX_FRAME_BYTES, REMOTE_HELPER_METHOD_HELLO, REMOTE_HELPER_PROTOCOL_VERSION } from "./RemoteHelperContract";
import { buildHelperRemoteCommand } from "./RemoteHelperCommand";
import { SSH_LAUNCHER_MAX_OUTPUT_BYTES, SSH_LAUNCHER_MAX_TIMEOUT_MS } from "./SshProcessLauncher";
import { buildPinnedSshInvocation } from "./SshVerifiedConnection";
import type { SshClientRuntime } from "./SshClientRuntime";
import type { SshConnectionPhase, SshLauncherHandle, SshProcessExit, SshProcessLauncher } from "./RemoteHostConnectionTypes";

/**
 * Lifecycle of one connection attempt on a pinned SSH session (plan §10/§11.1).
 *
 * This module owns exactly one attempt from "build the pinned invocation" to "the helper answered": it
 * builds the helper's remote command out of the verified bootstrap, runs the preflight, starts the pinned
 * process through the injected launcher, subscribes stdout/stderr/exit, opens the control client, drives
 * the staged phases (openssh -> authenticate -> helper), performs the `hello` handshake with its own local
 * deadline and releases the resources it owns - per attempt, so a late callback from a superseded attempt
 * can only ever release its own handle and client.
 *
 * It deliberately does not own the host: machine events, the phase vocabulary, the retry ladder, flap
 * accounting, diagnostics history and the public API all stay in `SshConnectionManager`, which implements
 * the `SshAttemptHost` port below. The port is the attempt's only way to reach host state, so an attempt
 * can never touch another attempt's or another host's state. Nothing here decides whether a failure is
 * fatal or transient either: a failed attempt is handed over as an error and classified by the host.
 */

/**
 * The verified bootstrap values one attempt launches with. The manager reads and validates its own
 * `SshHelperSession`; this module only consumes the strings, so the two shapes cannot drift into one
 * another's validation rules.
 */
export type SshAttemptBootstrap = {
	nodePath: string;
	deployRoot: string;
	bundleSha256: string;
	/** Verified workspace root; absent means the legal host-only session (`--root` is not sent at all). */
	root?: string;
};

/** Why an attempt's resources are being released; `lost` is the process that ended on its own. */
export type SshAttemptReleaseReason = "abort" | "shutdown" | "lost";

/**
 * The id of the frame one request call is writing. `method` is a fence: a capture only accepts a frame for
 * the request it was armed for, so a frame belonging to something else - the attempt's own handshake, a
 * cancel - can never be reported as this caller's request.
 */
export type RequestIdCapture = { method: string; id?: string };

/**
 * Resources owned by one attempt. Everything is released through the object itself, so a late callback
 * from a superseded attempt can only ever release its own handle and client - it can never tear down the
 * session that replaced it.
 */
export type SshConnectionAttempt = {
	handle: SshLauncherHandle;
	control?: RemoteControlClient;
	/**
	 * Armed for exactly the synchronous window in which the manager hands one method to the control client,
	 * so the id of the frame that client writes can be read back. It lives on the attempt because only that
	 * attempt's client can fill it.
	 */
	idCapture?: RequestIdCapture;
	unsubscribeExit?: () => void;
	unsubscribeStdout?: () => void;
	unsubscribeStderr?: () => void;
};

/** Stable inputs of every attempt of one host; the host supplies them once, the attempt never mutates them. */
export type SshAttemptDeps = {
	userDataDir: string;
	client: SshClientRuntime;
	launcher: SshProcessLauncher;
	/** How long a started session must stay alive before the handshake is attempted. */
	stabilityWindowMs: number;
	/** Local deadline of the handshake, already clamped by the host. */
	handshakeTimeoutMs: number;
	/** Wait on the host's injected timer port. */
	delay(delayMs: number): Promise<void>;
	/** Read the verified bootstrap per attempt: a caller-supplied value is never cached across attempts. */
	readBootstrap(): SshAttemptBootstrap | undefined;
	/** Forwarded to the control client verbatim; omitted means the client uses its own clock. */
	now?: () => number;
};

/**
 * One attempt's whole view of its host, created per attempt. The fences are the questions the attempt has
 * to ask before it may report anything, and every state change it causes goes through a named hand-back so
 * the host keeps owning the machine, the diagnostics and the retry budget.
 */
export type SshAttemptHost = {
	readonly hostId: string;
	readonly generation: number;
	/** Set the ambient phase of the diagnostics recorded until the next staged phase is entered. */
	setPhase(phase: SshConnectionPhase): void;
	/** Enter one staged phase: the ambient phase plus the machine's own `phase-entered` event. */
	enterPhase(phase: SshConnectionPhase): void;
	/** Stable-code diagnostic sink of this host and generation. */
	record(code: string, exitCode?: number): void;
	/** The verified handshake answered on this session: the host applies `connected` and stamps the time. */
	markReady(): void;
	/** True while the machine still runs this generation; a newer attempt fences this one off. */
	isCurrentGeneration(): boolean;
	/** True once the caller aborted, the host was torn down or a newer attempt took over. */
	isSuperseded(): boolean;
	/** The process is live: from here on the host owns the reference to it. */
	adopt(attempt: SshConnectionAttempt): void;
	/** True while this attempt is still the host's live one and its report is still the current one. */
	ownsLiveAttempt(): boolean;
	/** Release the adopted attempt's resources; the host drops its own reference inside this call. */
	releaseAttempt(reason: SshAttemptReleaseReason): void;
	/** The process ended: flap counting, the retry ladder and the machine event are the host's own. */
	absorbExit(exit: SshProcessExit): void;
	/** Terminal failure of this attempt: fatal vs transient, and the flap budget, are the host's own. */
	failAttempt(error: unknown): void;
};

/**
 * A control session must outlive a one-shot probe, so an attempt states its own deadline explicitly
 * instead of inheriting the launcher's 30s command default. The launcher cap is the hard bound.
 */
const SESSION_DEADLINE_MS = SSH_LAUNCHER_MAX_TIMEOUT_MS;
const SESSION_MAX_OUTPUT_BYTES = SSH_LAUNCHER_MAX_OUTPUT_BYTES;
/**
 * The shape `RemoteControlClient` mints for its request ids (`req-N`, bounded by the contract's id ceiling),
 * restated here because the client exports neither the pattern nor the id itself. Only a value that matches
 * it is ever reported to a caller, so a reported id is always one the client would accept for a withdraw.
 */
const REQUEST_ID_PATTERN = /^req-\d{1,18}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the request id out of a frame the control client just encoded. The client mints ids internally and
 * exposes cancellation only *by id*, so the line it hands to the transport is the single place that id exists
 * outside its own pending table; reading it there is what makes `onRequestId` possible without a second id
 * source. Every unusable line - not this client's JSON, another method's frame, an id that is not the minted
 * shape - leaves the capture empty, which is the fail-closed answer: a caller is never handed an id it could
 * not withdraw, and `SshConnectionManager.request` reports nothing when the capture stayed empty.
 */
function acceptFrameId(capture: RequestIdCapture | undefined, line: string): void {
	if (capture === undefined || capture.id !== undefined) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return;
	}
	if (!isRecord(parsed) || parsed.method !== capture.method) return;
	const id = parsed.id;
	if (typeof id !== "string" || !REQUEST_ID_PATTERN.test(id)) return;
	capture.id = id;
}

/**
 * Release one attempt's own resources: detach its subscriptions, reject its pending requests and stop its
 * process. `onDetached` runs after the detach and before the signal, which is where the host drops its
 * reference to the attempt - so a re-entrant teardown can never release the same attempt twice.
 *
 * `lost` does not signal the process: it already ended, and that is why this was called.
 */
export function releaseSshAttempt(attempt: SshConnectionAttempt, reason: SshAttemptReleaseReason, onDetached: () => void): void {
	attempt.unsubscribeExit?.();
	attempt.unsubscribeExit = undefined;
	attempt.unsubscribeStdout?.();
	attempt.unsubscribeStdout = undefined;
	attempt.unsubscribeStderr?.();
	attempt.unsubscribeStderr = undefined;
	try {
		attempt.control?.closeConnection(reason === "abort" ? "REQUEST_CANCELLED" : "REMOTE_CONNECTION_LOST");
	} catch {
		// Teardown runs from exit and timer callbacks; it must never throw into the event loop.
	}
	onDetached();
	if (reason !== "lost") void attempt.handle.stop(reason).catch(() => undefined);
}

/**
 * `ready` may only mean "the remote helper answered a v1 handshake" (plan §10/§11.1). The pinned ssh
 * session is the transport, so the handshake is the one piece of evidence that the *activated bundle* -
 * not a login shell, not another version of the helper - is on the other end.
 *
 * A released attempt is not a handshake failure: abort, shutdown and a lost session have already recorded
 * their own outcome, so their pending request ends as SUPERSEDED and the caller's failure path skips the
 * attempt instead of reporting it twice.
 */
async function assertHelperHandshake(host: SshAttemptHost, deps: SshAttemptDeps, control: RemoteControlClient): Promise<void> {
	let result: unknown;
	try {
		// `hello` takes no params; the deadline is the attempt's own, so a silent helper fails the attempt
		// instead of holding it open until the launcher's session deadline.
		result = await control.request(REMOTE_HELPER_METHOD_HELLO, undefined, { timeoutMs: deps.handshakeTimeoutMs });
	} catch (error) {
		if (!host.ownsLiveAttempt()) throw new Error("SSH_HELPER_HANDSHAKE_SUPERSEDED");
		throw error;
	}
	if (!host.ownsLiveAttempt()) throw new Error("SSH_HELPER_HANDSHAKE_SUPERSEDED");
	if (!isRecord(result)) throw new Error("SSH_HELPER_HANDSHAKE_INVALID");
	// Version first: a bundle that answers another version may still look well-formed, and it is the one
	// mismatch a retry cannot fix, so it has to be the cause the caller sees.
	if (result.protocolVersion !== REMOTE_HELPER_PROTOCOL_VERSION) {
		host.record("SSH_HELPER_PROTOCOL_MISMATCH");
		throw new Error("SSH_HELPER_PROTOCOL_MISMATCH");
	}
	if (typeof result.platform !== "string" || typeof result.arch !== "string" || typeof result.home !== "string" || !Array.isArray(result.capabilities)) throw new Error("SSH_HELPER_HANDSHAKE_INVALID");
	// `helperVersion`/`nodeVersion`/`pid` are identity for the UI, not evidence of compatibility, so a
	// helper that omits them is still a working helper.
	host.record("SSH_HELPER_HANDSHAKE_OK");
}

/** Build the helper command from the verified bootstrap; an unusable value fails closed like a missing one. */
function buildRemoteCommand(session: SshAttemptBootstrap): string {
	try {
		// Two distinct input objects on purpose: a host-only session must reach the builder with the key
		// *absent*, because that is what drops the whole `--root` pair and selects the legal host-only mode,
		// while the rooted shape carries the verified value. The key is never spelled as `root: undefined`:
		// "no root" and "unusable root" have to stay two different states from here to the helper, and one
		// spread object would leave that difference to the builder's own reading of `undefined` instead of
		// stating it where the two shapes are decided.
		return session.root === undefined ? buildHelperRemoteCommand({ nodePath: session.nodePath, deployRoot: session.deployRoot, bundleSha256: session.bundleSha256 }) : buildHelperRemoteCommand({ nodePath: session.nodePath, deployRoot: session.deployRoot, bundleSha256: session.bundleSha256, root: session.root });
	} catch {
		// The template builder refuses a relative/trailing-slash path, `/` and a bad bundle address. Those are
		// the caller's own wiring, so they share the fail-closed code instead of entering the ladder as five
		// transient failures of an attempt that cannot be fixed by retrying.
		throw new Error("SSH_HELPER_NOT_BOOTSTRAPPED");
	}
}

/** One process that ended is first released, then handed to the host, which owns everything after the fence. */
function onAttemptExit(host: SshAttemptHost, exit: SshProcessExit): void {
	// Release this attempt's own resources first: its pending requests must settle even when the exit is
	// fenced away, but nothing here may touch a session that already replaced this attempt.
	host.releaseAttempt("lost");
	host.absorbExit(exit);
}

/**
 * Run one attempt to its terminal state. The returned promise always resolves: every outcome - ready, a
 * superseded attempt, a failure - has been reported to the host through the port by then, and the host
 * decides what it means for the machine and the retry budget.
 */
export async function runSshConnectionAttempt(host: SshAttemptHost, deps: SshAttemptDeps): Promise<void> {
	try {
		host.setPhase("openssh");
		// Fail closed before touching the remote: the helper's location comes from the verified bootstrap
		// result, so without one there is nothing to launch and nothing to handshake with.
		const session = deps.readBootstrap();
		if (session === undefined) throw new Error("SSH_HELPER_NOT_BOOTSTRAPPED");
		const remoteCommand = buildRemoteCommand(session);
		host.record("SSH_CONNECTION_PREFLIGHT");
		const invocation = await buildPinnedSshInvocation(deps.userDataDir, host.hostId, "ssh-batch", { client: deps.client, remoteCommand });
		if (!host.isCurrentGeneration()) return;
		host.enterPhase("authenticate");
		const handle = await deps.launcher.start({ hostId: host.hostId, generation: host.generation, invocation, timeoutMs: SESSION_DEADLINE_MS, maxOutputBytes: SESSION_MAX_OUTPUT_BYTES, maxLineBytes: REMOTE_HELPER_MAX_FRAME_BYTES, stdin: true });
		if (host.isSuperseded()) {
			// The attempt was superseded, aborted or torn down while spawning: the process must not
			// survive it, even though start() already produced a live handle.
			await handle.stop("abort").catch(() => undefined);
			return;
		}
		const attempt: SshConnectionAttempt = { handle };
		host.adopt(attempt);
		attempt.unsubscribeExit = handle.onExit((exit) => onAttemptExit(host, exit));
		const control = createRemoteControlClient({
			hostId: host.hostId,
			// The capture is filled here, and only after the write returned: a frame that never left the
			// transport cannot be withdrawn, so it must not be reported to a caller either.
			send: (line) => {
				handle.write(line);
				acceptFrameId(attempt.idCapture, line);
			},
			...(deps.now === undefined ? {} : { now: deps.now }),
			onDiagnostic: (diagnostic) => host.record(diagnostic.code),
		});
		control.openConnection();
		attempt.control = control;
		// stdout carries protocol frames only; stderr is diagnostics, so its text is never recorded
		// (only the fact that the helper complained).
		attempt.unsubscribeStdout = handle.onStdoutLine((line) => {
			try {
				control.handleLine(line);
			} catch {
				host.record("SSH_HELPER_FRAME_DROPPED");
			}
		});
		attempt.unsubscribeStderr = handle.onStderrLine(() => host.record("SSH_HELPER_STDERR"));
		await deps.delay(deps.stabilityWindowMs);
		if (!host.ownsLiveAttempt()) return;
		// Staged progress with real evidence (plan §11.1): the machine reports `bootstrapping` while the
		// activated bundle is asked to identify itself, and `ready` is applied only after it answered.
		host.enterPhase("helper");
		await assertHelperHandshake(host, deps, control);
		// The handshake is another await on this path: abort, shutdown or a lost session may have released
		// the attempt while the helper was answering, and only a live attempt may become ready.
		if (!host.ownsLiveAttempt()) return;
		host.markReady();
	} catch (error) {
		// The attempt is handed over unconditionally: the host applies its own ownership fence, so a caller
		// abort and an already released attempt are skipped there instead of being reported twice here.
		host.failAttempt(error);
	}
}
