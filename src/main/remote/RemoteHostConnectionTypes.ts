import type { PinnedSshInvocation } from "./SshVerifiedConnection";

/**
 * Host-level connection state (plan §10). Deliberately separate from Agent/Runtime send state:
 * a ready host does not imply a ready Agent runtime, so these values must never be folded into
 * AgentStatus or reused as session transport state.
 */
export type RemoteHostConnectionState = "disconnected" | "connecting" | "probing" | "bootstrapping" | "ready" | "degraded" | "reconnecting" | "offline" | "needs-attention";

/** Staged progress of a "test connection" run (plan §11.1). */
export type SshConnectionPhase = "openssh" | "authenticate" | "platform" | "node" | "helper" | "pi";

/**
 * Redacted diagnostic record. Only stable codes, ids, phases and exit codes are kept; command
 * lines, identity paths, ProxyCommand text and response bodies must never reach this record.
 */
export type SshConnectionDiagnostic = {
	hostId: string;
	generation: number;
	phase: SshConnectionPhase;
	state: RemoteHostConnectionState;
	code: string;
	at: string;
	exitCode?: number;
};

export type SshProcessExitKind = "exited" | "failed" | "timeout" | "stopped";

export type SshProcessExit = {
	kind: SshProcessExitKind;
	code: number | null;
	signal: NodeJS.Signals | null;
	/** Stable launcher-level cause (e.g. bounded-output overflow) that code/signal cannot express. */
	errorCode?: string;
};

/**
 * A launch request always carries the freshly preflighted pinned invocation, so the process can
 * only use the absolute OpenSSH path and sanitized environment the route check approved.
 */
export type SshLauncherRequest = {
	hostId: string;
	generation: number;
	invocation: PinnedSshInvocation;
	timeoutMs?: number;
	/** Cap for *unconsumed* output: bytes handed to a line subscriber stop counting against it. */
	maxOutputBytes?: number;
	/** Longest single line a stream may accumulate without a newline before the process is killed. */
	maxLineBytes?: number;
	/** Open a writable stdin (helper protocol requests). Defaults to closed. */
	stdin?: boolean;
};

export type SshLauncherHandle = {
	readonly pid: number | undefined;
	onExit(listener: (exit: SshProcessExit) => void): () => void;
	/** Decoded stdout lines: the helper protocol frames, one line per frame. */
	onStdoutLine(listener: (line: string) => void): () => void;
	/** Decoded stderr lines, for redacted diagnostics only (never parsed as protocol data). */
	onStderrLine(listener: (line: string) => void): () => void;
	/** Write one protocol line; throws after the process settled or when stdin was not requested. */
	write(line: string): void;
	stop(reason: "abort" | "shutdown"): Promise<void>;
};

/** Injected in production with the real spawner; tests supply a fake child process. */
export type SshProcessLauncher = {
	start(request: SshLauncherRequest): Promise<SshLauncherHandle>;
};

/** Bounded backoff schedule from plan §10: 1s, 2s, 5s, 10s, 30s capped. */
export const SSH_RECONNECT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];
