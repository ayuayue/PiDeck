import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { createSshLauncherOutput, type SshLauncherStreamName } from "./SshLauncherOutput";
import type { SshLauncherHandle, SshLauncherRequest, SshProcessExit, SshProcessExitKind, SshProcessLauncher } from "./RemoteHostConnectionTypes";
import type { PinnedSshInvocation } from "./SshVerifiedConnection";

/**
 * Main-only launcher for the freshly preflighted pinned OpenSSH invocation (plan §10).
 *
 * This module is the only place that turns a PinnedSshInvocation into a process: it always passes the
 * absolute executable plus an argv array with `shell: false`, so nothing derived from a user profile
 * (host name, identity path, ProxyCommand) can be re-interpreted as shell syntax. stdin is opened only when
 * the request asks for it and then accepts single-line frames only, every request carries a deadline, and
 * stop() is idempotent so a shutdown/abort race cannot leak a live ssh process.
 *
 * The read side is not owned here: decoding, line splitting, the per-line/per-stream byte bounds and the
 * bounded holding area for lines that arrive before the first subscriber all live in
 * `SshLauncherOutput`; this module only decides what an overflow means (kill and report).
 */

/**
 * Terminal report of one launched process. SshProcessExit stays the shared contract; launcher-level
 * failures add a stable `errorCode` because `code`/`signal` alone cannot name reasons such as a bounded
 * output overflow. Only stable codes travel here - never a command line, executable path, environment
 * value or response body.
 */
export type SshLauncherExit = SshProcessExit & { readonly errorCode?: string };

export const SSH_LAUNCHER_DEFAULT_TIMEOUT_MS = 30_000;
export const SSH_LAUNCHER_MAX_TIMEOUT_MS = 120_000;
export const SSH_LAUNCHER_DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
/**
 * Ceiling for the *unconsumed* byte gauge (stdout and stderr are measured separately). Invariant: it must
 * stay >= SSH_LAUNCHER_MAX_LINE_BYTES, otherwise a frame the per-line bound still accepts could be killed
 * by the total budget before the caller ever sees it.
 */
export const SSH_LAUNCHER_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const SSH_LAUNCHER_DEFAULT_KILL_TIMEOUT_MS = 2_000;
/** Longest single line (protocol frame) accepted per stream before the process is killed. */
export const SSH_LAUNCHER_DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Also the cap for one outgoing write() frame, so the two directions stay symmetric. */
export const SSH_LAUNCHER_MAX_LINE_BYTES = 16 * 1024 * 1024;
/**
 * Stable write() failures. Every one of them is a bare code: a caller-supplied frame, a command line, a
 * path, an environment value or a stream error message must never reach the error text.
 */
export const SSH_LAUNCHER_STDIN_UNAVAILABLE = "SSH_LAUNCHER_STDIN_UNAVAILABLE";
export const SSH_LAUNCHER_STDIN_LINE_INVALID = "SSH_LAUNCHER_STDIN_LINE_INVALID";
export const SSH_LAUNCHER_STDIN_LINE_TOO_LARGE = "SSH_LAUNCHER_STDIN_LINE_TOO_LARGE";
export const SSH_LAUNCHER_STDIN_WRITE_FAILED = "SSH_LAUNCHER_STDIN_WRITE_FAILED";

/**
 * How long start() waits for a child that reports neither "spawn" nor "error". The real spawner always
 * reports one of them on the next tick, so this ceiling only keeps an injected spawner from suspending a
 * caller forever.
 */
const STARTUP_CONFIRMATION_GRACE_MS = 250;
const MAX_EXECUTABLE_LENGTH = 1024;
/** uv_spawn failures that mean "the pinned client cannot be executed at all". */
const UNAVAILABLE_SPAWN_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR"]);

type TerminationCause = "stopped" | "timeout" | "output-too-large" | "line-too-large";

/** Validated launch input: exactly the values spawn() receives. */
type LaunchTarget = { executable: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The offending value is never echoed: an invalid request may still contain a path or credentials. */
function invalidRequest(): Error {
	return new Error("SSH_LAUNCHER_REQUEST_INVALID");
}

function assertExecutable(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_EXECUTABLE_LENGTH || /[\x00-\x1f\x7f]/.test(value)) throw invalidRequest();
}

function assertArgv(value: unknown): asserts value is string[] {
	if (!Array.isArray(value)) throw invalidRequest();
	for (const arg of value) {
		// NUL cannot be carried through argv; every other byte stays one literal argument (no shell).
		if (typeof arg !== "string" || arg.includes("\0")) throw invalidRequest();
	}
}

function assertProcessEnv(value: unknown): asserts value is NodeJS.ProcessEnv {
	if (!isRecord(value)) throw invalidRequest();
	for (const [key, rawValue] of Object.entries(value)) {
		// "=" or NUL inside a name would reshape the child environment block.
		if (key.length === 0 || key.includes("=") || key.includes("\0")) throw invalidRequest();
		if (rawValue === undefined) continue;
		if (typeof rawValue !== "string" || rawValue.includes("\0")) throw invalidRequest();
	}
}

/**
 * Re-check the pinned invocation at the launcher boundary. Absoluteness and pinning stay owned by
 * SshVerifiedConnection; this guard only rejects shapes that could smuggle data past argv/env handling
 * (NUL bytes, non-string members, malformed variable names).
 */
function readLaunchTarget(invocation: PinnedSshInvocation): LaunchTarget {
	const raw: unknown = invocation;
	if (!isRecord(raw)) throw invalidRequest();
	const executable = raw.executable;
	const args = raw.args;
	const env = raw.env;
	const cwd = raw.cwd;
	assertExecutable(executable);
	assertArgv(args);
	assertProcessEnv(env);
	return { executable, args, env, ...(readCwd(cwd) === undefined ? {} : { cwd: readCwd(cwd) as string }) };
}

/**
 * A transfer (scp) needs a working directory so its source operands can stay bare file names: an
 * absolute Windows path would otherwise read as "host:path" to scp's colon detection.
 */
function readCwd(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_EXECUTABLE_LENGTH || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw invalidRequest();
	return value;
}

function spawnFailureCode(error: unknown): string {
	if (isRecord(error)) {
		const code = error.code;
		if (typeof code === "string" && UNAVAILABLE_SPAWN_CODES.has(code)) return "SSH_CLIENT_UNAVAILABLE";
	}
	// Anything else (EMFILE, ENOMEM, a non-error throw) fails with a stable code too. The original error
	// carries path/spawnargs/syscall fields and must not be attached as a cause.
	return "SSH_LAUNCHER_SPAWN_FAILED";
}

function readBoundedDuration(value: unknown, fallback: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.max(1, Math.min(Math.floor(value), max));
}

/** Start the pinned executable without a shell; a failing uv_spawn is mapped to a stable code. */
function spawnPinnedChild(spawnProcess: typeof spawn, target: LaunchTarget, wantsStdin: boolean): ChildProcess {
	try {
		return spawnProcess(target.executable, target.args, {
			shell: false,
			windowsHide: true,
			env: target.env,
			...(target.cwd === undefined ? {} : { cwd: target.cwd }),
			// A closed stdin keeps a stray write from ever becoming remote input; a helper protocol that must
			// answer questions asks for the pipe explicitly.
			stdio: wantsStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		throw new Error(spawnFailureCode(error));
	}
}

/**
 * In production `options.spawn` is omitted and Node's spawner is used; tests inject an EventEmitter child
 * so no real ssh process is ever started.
 */
export function createSshProcessLauncher(options?: { spawn?: typeof import("node:child_process").spawn; killTimeoutMs?: number }): SshProcessLauncher {
	const spawnProcess = options?.spawn ?? spawn;
	const killTimeoutMs = readBoundedDuration(options?.killTimeoutMs, SSH_LAUNCHER_DEFAULT_KILL_TIMEOUT_MS, SSH_LAUNCHER_MAX_TIMEOUT_MS);

	return {
		async start(request: SshLauncherRequest): Promise<SshLauncherHandle> {
			const target = readLaunchTarget(request?.invocation);
			const timeoutMs = readBoundedDuration(request?.timeoutMs, SSH_LAUNCHER_DEFAULT_TIMEOUT_MS, SSH_LAUNCHER_MAX_TIMEOUT_MS);
			const maxOutputBytes = readBoundedDuration(request?.maxOutputBytes, SSH_LAUNCHER_DEFAULT_MAX_OUTPUT_BYTES, SSH_LAUNCHER_MAX_OUTPUT_BYTES);
			const maxLineBytes = readBoundedDuration(request?.maxLineBytes, SSH_LAUNCHER_DEFAULT_MAX_LINE_BYTES, SSH_LAUNCHER_MAX_LINE_BYTES);
			const wantsStdin = request?.stdin === true;
			const child = spawnPinnedChild(spawnProcess, target, wantsStdin);

			const listeners = new Set<(exit: SshProcessExit) => void>();
			const outputDetachers: Array<() => void> = [];
			// The read side owns its own bounds; an overflow is a terminal verdict here: a process that
			// broke either byte contract gets no second grace window.
			const output = createSshLauncherOutput({ maxOutputBytes, maxLineBytes, onOverflow: (cause) => terminate(cause, "force") });
			let settled: SshLauncherExit | null = null;
			let cause: TerminationCause | null = null;
			let startupConfirmed = false;
			let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
			let escalationTimer: ReturnType<typeof setTimeout> | undefined;
			let startupTimer: ReturnType<typeof setTimeout> | undefined;
			let stopPromise: Promise<void> | undefined;
			let resolveStop: (() => void) | undefined;
			let confirmStartup: (error?: Error) => void = () => {};
			const startup = new Promise<void>((resolve, reject) => {
				confirmStartup = (error?: Error): void => {
					if (error === undefined) resolve();
					else reject(error);
				};
			});

			function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): undefined {
				if (timer !== undefined) clearTimeout(timer);
				return undefined;
			}

			/** Pair every listener/timer registration with its removal; called exactly once, on settle. */
			function cleanup(): void {
				child.off("spawn", onChildSpawn);
				child.off("error", onChildError);
				child.off("exit", onChildExit);
				// Close stdin while the guarded error listener is still attached: a late pipe error must stay caught.
				endStdinQuietly();
				for (const detach of outputDetachers.splice(0)) detach();
				deadlineTimer = clearTimer(deadlineTimer);
				escalationTimer = clearTimer(escalationTimer);
				startupTimer = clearTimer(startupTimer);
			}

			function exitReport(code: number | null, signal: NodeJS.Signals | null): SshLauncherExit {
				const kind: SshProcessExitKind = cause === "stopped" ? "stopped" : cause === "timeout" ? "timeout" : cause === "output-too-large" || cause === "line-too-large" ? "failed" : code === 0 ? "exited" : "failed";
				if (cause === "output-too-large") return { kind, code, signal, errorCode: "SSH_LAUNCHER_OUTPUT_TOO_LARGE" };
				if (cause === "line-too-large") return { kind, code, signal, errorCode: "SSH_LAUNCHER_LINE_TOO_LARGE" };
				return { kind, code, signal };
			}

			function settle(exit: SshLauncherExit): void {
				if (settled !== null) return;
				// Published before the final flush: a subscriber reacting to its last line must not be able to
				// re-enter settle() and notify every listener a second time.
				settled = exit;
				// Whatever the process wrote before it ended still reaches its subscribers; a helper that dies
				// mid-frame would otherwise report nothing at all.
				output.flush();
				cleanup();
				const pending = [...listeners];
				listeners.clear();
				if (resolveStop !== undefined) {
					const resolve = resolveStop;
					resolveStop = undefined;
					resolve();
				}
				for (const listener of pending) listener(exit);
			}

			function killProcess(signal?: NodeJS.Signals): boolean {
				try {
					return signal === undefined ? child.kill() : child.kill(signal);
				} catch {
					// A child whose handle is already closed throws instead of returning false.
					return false;
				}
			}

			function terminate(nextCause: TerminationCause, mode: "graceful" | "force"): void {
				if (settled !== null) return;
				// First cause wins: whichever event ended the process is what the caller must see.
				cause ??= nextCause;
				if (mode === "force") {
					// Deadline and output-budget violations get no second grace window: kill immediately
					// (Windows has no signals, where kill() is already the forceful path) and report at once so
					// a process that already broke its contract cannot suspend the caller.
					killProcess("SIGKILL");
					settle(exitReport(null, null));
					return;
				}
				// Graceful first: SIGTERM on POSIX, immediate termination on Windows.
				if (!killProcess()) {
					// Nothing live to signal even though no exit event was seen: treat the process as gone.
					settle(exitReport(null, null));
					return;
				}
				escalationTimer = clearTimer(escalationTimer);
				escalationTimer = setTimeout(() => {
					escalationTimer = undefined;
					if (settled !== null) return;
					if (!killProcess("SIGKILL")) {
						settle(exitReport(null, null));
						return;
					}
					// SIGKILL was accepted but the child never reported exit: do not suspend shutdown on an
					// unconfirmed kill. POSIX promises TERM then KILL, Windows has no signal semantics at all,
					// so no stronger guarantee may be claimed here.
					escalationTimer = setTimeout(() => {
						escalationTimer = undefined;
						if (settled !== null) return;
						settle(exitReport(null, null));
					}, killTimeoutMs);
				}, killTimeoutMs);
			}

			function armDeadline(): void {
				if (settled !== null || deadlineTimer !== undefined) return;
				deadlineTimer = setTimeout(() => {
					deadlineTimer = undefined;
					if (settled !== null) return;
					terminate("timeout", "force");
				}, timeoutMs);
			}

			function confirmStartupOnce(): void {
				if (startupConfirmed) return;
				startupConfirmed = true;
				startupTimer = clearTimer(startupTimer);
				confirmStartup();
				armDeadline();
			}

			function onChildSpawn(): void {
				confirmStartupOnce();
			}

			function onChildError(error: unknown): void {
				const code = spawnFailureCode(error);
				if (!startupConfirmed) {
					// uv_spawn failed before a process existed: start() must reject rather than hand out a
					// handle that never had a process behind it.
					startupConfirmed = true;
					startupTimer = clearTimer(startupTimer);
					cleanup();
					confirmStartup(new Error(code));
					return;
				}
				if (settled !== null) return;
				// After startup a late error means the child is unusable; Node may never emit exit for it.
				settle({ kind: "failed", code: null, signal: null, errorCode: code });
			}

			function onChildExit(code: unknown, signal: NodeJS.Signals | null): void {
				// A child that reports exit without "spawn" (injected spawners) still counts as started,
				// otherwise start() could never resolve for it.
				confirmStartupOnce();
				if (settled !== null) return;
				const exitCode = typeof code === "number" && Number.isFinite(code) ? Math.trunc(code) : null;
				settle(exitReport(exitCode, signal ?? null));
			}

			function watchOutput(stream: NodeJS.ReadableStream | null | undefined, onData: (chunk: unknown) => void): void {
				if (stream === null || stream === undefined || typeof stream.on !== "function") return;
				// A read-side pipe error (Windows ECONNRESET, EIO) with no listener is an unhandled 'error'
				// event, which kills the whole main process; absorb it and report one stable code instead.
				const onError = (): void => {
					if (settled !== null) return;
					settle({ kind: "failed", code: null, signal: null, errorCode: "SSH_LAUNCHER_STREAM_FAILED" });
				};
				stream.on("data", onData);
				stream.on("error", onError);
				outputDetachers.push(() => {
					// An injected stream only has to implement what it uses; detaching stays best-effort so a
					// release never breaks the terminal notification path.
					if (typeof stream.off === "function") {
						stream.off("data", onData);
						stream.off("error", onError);
					}
				});
			}

			function outputReporter(name: SshLauncherStreamName): (chunk: unknown) => void {
				// The accumulator rejects everything that arrives after it was flushed, so a chunk from a
				// stream we are about to detach needs no second check here.
				return (chunk: unknown): void => output.feed(name, chunk);
			}

			/** A writable stdin exists only while the request asked for one and the child has not settled. */
			function writableStdin(): NonNullable<ChildProcess["stdin"]> {
				const stream = wantsStdin ? child.stdin : null;
				if (settled !== null || stream === null || stream === undefined || stream.destroyed || stream.writableEnded || typeof stream.write !== "function") throw new Error(SSH_LAUNCHER_STDIN_UNAVAILABLE);
				return stream;
			}

			/**
			 * Write one protocol frame. This is the only channel into the child's stdin, so the frame is
			 * validated here: text containing a NUL or a line break would be delivered as several frames, and
			 * an oversized frame is rejected rather than truncated into a half frame.
			 */
			function writeStdinLine(line: string): void {
				const stdin = writableStdin();
				if (typeof line !== "string" || line.includes("\0") || line.includes("\n") || line.includes("\r")) throw new Error(SSH_LAUNCHER_STDIN_LINE_INVALID);
				// An empty frame would put a bare newline on the wire; the inbound path treats blank lines as
				// noise, so the outbound path must not manufacture them.
				if (line.trim().length === 0) throw new Error(SSH_LAUNCHER_STDIN_LINE_INVALID);
				if (Buffer.byteLength(line, "utf8") > maxLineBytes) throw new Error(SSH_LAUNCHER_STDIN_LINE_TOO_LARGE);
				try {
					stdin.write(`${line}\n`);
				} catch {
					// EPIPE / ERR_STREAM_DESTROYED messages quote the failed payload and the original error may
					// carry path and write fields, so neither is attached: only the stable code travels.
					throw new Error(SSH_LAUNCHER_STDIN_WRITE_FAILED);
				}
			}

			/**
			 * An asynchronous pipe error (the far side closed stdin) cannot be reported through the synchronous
			 * write() contract, and an unhandled 'error' event would take the whole main process down instead.
			 */
			function watchStdinErrors(): void {
				const stream = wantsStdin ? child.stdin : null;
				if (stream === null || stream === undefined || typeof stream.on !== "function") return;
				const onError = (): void => {
					// Intentionally swallowed: write() has already returned, and the exit report stays the single
					// terminal signal for this process.
				};
				stream.on("error", onError);
				outputDetachers.push(() => {
					if (typeof stream.off === "function") stream.off("error", onError);
				});
			}

			/** Best-effort stdin close so a settled process cannot keep a writable pipe behind. */
			function endStdinQuietly(): void {
				const stream = wantsStdin ? child.stdin : null;
				if (stream === null || stream === undefined || stream.destroyed || stream.writableEnded || typeof stream.end !== "function") return;
				try {
					stream.end();
				} catch {
					// A pipe whose far end is already gone rejects the close; the process is gone either way.
				}
			}

			const handle: SshLauncherHandle = {
				get pid(): number | undefined {
					const value: unknown = child.pid;
					return typeof value === "number" ? value : undefined;
				},
				onExit(listener: (exit: SshProcessExit) => void): () => void {
					if (settled !== null) {
						// A process can end before the caller subscribes; replay once (asynchronously, to keep the
						// subscription free of re-entrancy) so a terminal state is never lost.
						const exit = settled;
						let active = true;
						queueMicrotask(() => {
							if (active) listener(exit);
						});
						return () => {
							active = false;
						};
					}
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				onStdoutLine(listener: (line: string) => void): () => void {
					return output.subscribe("stdout", listener);
				},
				onStderrLine(listener: (line: string) => void): () => void {
					return output.subscribe("stderr", listener);
				},
				write(line: string): void {
					writeStdinLine(line);
				},
				stop(reason: "abort" | "shutdown"): Promise<void> {
					// Both reasons tear the process down identically; callers keep the distinction for their own
					// diagnostics. One shared promise keeps repeated calls idempotent.
					void reason;
					if (settled !== null) return Promise.resolve();
					if (stopPromise !== undefined) return stopPromise;
					stopPromise = new Promise<void>((resolve) => {
						resolveStop = resolve;
					});
					terminate("stopped", "graceful");
					return stopPromise;
				},
			};

			child.on("spawn", onChildSpawn);
			child.on("error", onChildError);
			child.on("exit", onChildExit);
			watchOutput(child.stdout, outputReporter("stdout"));
			watchOutput(child.stderr, outputReporter("stderr"));
			watchStdinErrors();

			startupTimer = setTimeout(() => {
				startupTimer = undefined;
				// Safety net for injected spawners that report nothing; the real spawner confirms on the next
				// tick, so this never delays production startup.
				confirmStartupOnce();
			}, STARTUP_CONFIRMATION_GRACE_MS);

			await startup;
			return handle;
		},
	};
}
