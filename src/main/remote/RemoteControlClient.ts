import { REMOTE_HELPER_DEFAULT_REQUEST_TIMEOUT_MS, REMOTE_HELPER_MAX_FRAME_BYTES, REMOTE_HELPER_MAX_REQUEST_TIMEOUT_MS, REMOTE_HELPER_PROTOCOL_VERSION, type RemoteHelperCancelParams, type RemoteHelperCancelResult, type RemoteHelperErrorBody, type RemoteHelperRequestFrame } from "./RemoteHelperContract";

/**
 * Main-side client for helper protocol v1 (plan §7.1). It owns framing, host/generation fencing, the
 * local deadline and the pending table, and nothing else: it never learns what moves the bytes.
 * Outbound frames leave through the injected `send(line)` (exactly one JSON object per call, no
 * trailing newline — the transport owns line termination); inbound frames arrive through
 * `handleLine(line)`. That is what keeps every behaviour here testable offline.
 *
 * Two invariants hold on every path: a request settles exactly once (helper response, local deadline
 * or connection close — first one wins), and a thrown/observed failure carries only a stable code, so
 * a helper body, path or command line can never reach a log line. §7.1 leaves bounded concurrency to
 * the helper, so requests are not queued here.
 */

/** Ids are minted locally, so their exact shape can be required in both directions; a remote id is never free text. */
const ID_PATTERN = /^req-\d{1,18}$/;
/** Method names travel as opaque strings (the helper owns the method table) but never as whitespace/control bytes. */
const METHOD_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*$/;
/** Stable codes only: §7.1 forbids free text as a code, so nothing else may be thrown or diagnosed. */
const STABLE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_HOST_ID_LENGTH = 128;
const MAX_METHOD_LENGTH = 128;
/** An error body's message is relayed only when it is bounded; a huge body is not echoed anywhere. */
const MAX_REMOTE_MESSAGE_LENGTH = 4096;
/** Lower bound for an injected frame limit, so a nonsensical value cannot make the client unusable. */
const MIN_FRAME_BYTES = 128;
/** Bounded memory for "which ids already settled"; overflow only downgrades a duplicate to an unknown id. */
const SETTLED_ID_LIMIT = 256;
/** Early-wake re-arms are bounded so a scheduler that always fires early cannot spin the event loop. */
const MAX_DEADLINE_REARMS = 2;

/** Why a frame went nowhere: callers always get a contract code, these name the discard reason. */
export const REMOTE_FRAME_DIAGNOSTIC_CODES = {
	invalid: "REMOTE_FRAME_INVALID",
	tooLarge: "REMOTE_FRAME_TOO_LARGE",
	staleGeneration: "REMOTE_FRAME_STALE_GENERATION",
	wrongHost: "REMOTE_FRAME_WRONG_HOST",
	unknownId: "REMOTE_FRAME_UNKNOWN_ID",
	duplicateResponse: "REMOTE_FRAME_DUPLICATE_RESPONSE",
	sendFailed: "REMOTE_FRAME_SEND_FAILED",
} as const;
export type RemoteFrameDiagnosticCode = (typeof REMOTE_FRAME_DIAGNOSTIC_CODES)[keyof typeof REMOTE_FRAME_DIAGNOSTIC_CODES];

/**
 * Redacted diagnostic record: ids, the generation the client was on and a stable code, never content.
 */
export type RemoteControlDiagnosticEntry = {
	hostId: string;
	connectionGeneration: number;
	code: string;
	id?: string;
};

/** Injected so tests can drive deadlines without waiting; production uses the global timers. */
export type RemoteControlScheduler = {
	setTimeout(handler: () => void, delayMs: number): ReturnType<typeof setTimeout>;
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

export type RemoteControlRequestOptions = { timeoutMs?: number };

export type RemoteControlClientOptions = {
	hostId: string;
	/** Hands one encoded frame line (no trailing newline) to the transport. */
	send: (line: string) => void | Promise<void>;
	now?: () => number;
	onDiagnostic?: (entry: RemoteControlDiagnosticEntry) => void;
	/** Defaults to the contract limit, which is also the ceiling: a caller may lower it, never raise it. */
	maxFrameBytes?: number;
	defaultTimeoutMs?: number;
	scheduler?: RemoteControlScheduler;
};

export type RemoteControlClient = {
	readonly hostId: string;
	readonly connectionGeneration: number;
	readonly open: boolean;
	/** Starts a new generation and returns it. An implicit close fails the previous generation's pending requests. */
	openConnection(): number;
	/** Fails every pending request of the current generation; nothing is re-sent on the next one. */
	closeConnection(reason?: string): void;
	/** Inbound frame entry point: one NDJSON line, with or without its transport terminator. */
	handleLine(line: string): void;
	/** Resolves with the helper's raw `result`; callers narrow it with their own per-method validators. */
	request(method: string, params?: unknown, options?: RemoteControlRequestOptions): Promise<unknown>;
	cancel(requestId: string, options?: RemoteControlRequestOptions): Promise<RemoteHelperCancelResult>;
	pendingCount(): number;
};

/**
 * Structured helper failure. `message` is always the stable code (encoding, parsing and timeout paths
 * may only throw codes). The helper's own error text is kept in `remoteMessage` and never diagnosed.
 */
export class RemoteControlError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly remoteMessage?: string;

	constructor(code: string, retryable: boolean, remoteMessage?: string) {
		super(code);
		this.name = "RemoteControlError";
		this.code = code;
		this.retryable = retryable;
		this.remoteMessage = remoteMessage;
	}
}

/** The only locally generated outcomes worth an automatic retry; a helper body may still override `retryable`. */
const RETRYABLE_CODES = new Set<string>(["REQUEST_TIMEOUT", "REMOTE_CONNECTION_LOST"]);

const DEFAULT_SCHEDULER: RemoteControlScheduler = {
	setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
	clearTimeout: (handle) => clearTimeout(handle),
};

type TimerHandle = ReturnType<typeof setTimeout>;

/** One in-flight request. Its outcome can only come from `settle`, which the pending table calls at most once. */
type PendingEntry = {
	id: string;
	/** Local deadline in `now()` terms: main holds its own clock instead of trusting two machines to agree. */
	deadlineAt: number;
	/** Counted early-wake re-arms, bounded by MAX_DEADLINE_REARMS. */
	rearms: number;
	timer: TimerHandle | undefined;
	settle(error: RemoteControlError | null, result: unknown): void;
};

/** Validated inbound frame, or the reason it cannot be used. Host/generation checks happen in the caller. */
type InboundRead = { kind: "invalid"; id?: string } | { kind: "ok"; hostId: string; generation: number; id: string; result: unknown } | { kind: "error"; hostId: string; generation: number; id: string; error: RemoteHelperErrorBody } | { kind: "error-body-invalid"; hostId: string; generation: number; id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is Promise<void> {
	if (typeof value !== "object" || value === null || !("then" in value)) return false;
	return typeof value.then === "function";
}

/** Free text is never echoed: an invalid host id may itself be a path or a credential. */
function invalidOptions(): Error {
	return new Error("REMOTE_CONTROL_OPTIONS_INVALID");
}

/** The contract value is the ceiling (§7.1): a caller may tighten the budget, never widen the protocol. */
function readFrameLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return REMOTE_HELPER_MAX_FRAME_BYTES;
	return Math.max(MIN_FRAME_BYTES, Math.min(Math.floor(value), REMOTE_HELPER_MAX_FRAME_BYTES));
}

/** Relative timeout clamped to the contract bounds: unusable input falls back, never disables the deadline. */
function readTimeoutMs(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.max(1, Math.min(Math.floor(value), REMOTE_HELPER_MAX_REQUEST_TIMEOUT_MS));
}

/** Some NDJSON splitters keep the terminator, others strip it; tolerate exactly one, then stay strict. */
function stripLineTerminator(line: string): string {
	if (line.endsWith("\r\n")) return line.slice(0, -2);
	if (line.endsWith("\n") || line.endsWith("\r")) return line.slice(0, -1);
	return line;
}

/** An id is only ever echoed when it has the exact shape this client mints. */
function readFrameId(record: Record<string, unknown>): string | undefined {
	const id = record.id;
	return typeof id === "string" && ID_PATTERN.test(id) ? id : undefined;
}

function invalidFrame(id: string | undefined): InboundRead {
	return id === undefined ? { kind: "invalid" } : { kind: "invalid", id };
}

/**
 * Strict frame validation (§7.1): non-objects, unknown `v`, missing/illegal fields and unbounded ids are
 * rejected. Unknown *extra* fields are ignored on purpose — forward compatibility is part of the contract.
 */
function readInboundFrame(value: unknown): InboundRead {
	if (!isRecord(value)) return { kind: "invalid" };
	const id = readFrameId(value);
	if (value.v !== REMOTE_HELPER_PROTOCOL_VERSION) return invalidFrame(id);
	const hostId = value.hostId;
	if (typeof hostId !== "string" || hostId.length === 0 || hostId.length > MAX_HOST_ID_LENGTH || CONTROL_CHARS.test(hostId)) return invalidFrame(id);
	const generation = value.generation;
	if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) return invalidFrame(id);
	if (id === undefined) return { kind: "invalid" };
	const ok = value.ok;
	if (typeof ok !== "boolean") return invalidFrame(id);
	if (ok) return { kind: "ok", hostId, generation, id, result: value.result };
	const body = value.error;
	if (!isRecord(body)) return { kind: "error-body-invalid", hostId, generation, id };
	const code = body.code;
	// A code that is free text means the helper broke §7.1; relaying it would leak the very text the
	// stable-code rule exists to keep out of logs.
	if (typeof code !== "string" || !STABLE_CODE_PATTERN.test(code)) return { kind: "error-body-invalid", hostId, generation, id };
	const message = body.message;
	const retryable = body.retryable;
	return {
		kind: "error",
		hostId,
		generation,
		id,
		error: { code, ...(typeof message === "string" && message.length > 0 && message.length <= MAX_REMOTE_MESSAGE_LENGTH ? { message } : {}), ...(typeof retryable === "boolean" ? { retryable } : {}) },
	};
}

/** Only the two documented reasons are relayed; any other text is dropped instead of echoed to a caller. */
function readCancelResult(value: unknown): RemoteHelperCancelResult | null {
	if (!isRecord(value) || typeof value.cancelled !== "boolean") return null;
	if (value.cancelled) {
		// `cancelled: true` already means the helper aborted the target, so a refusal reason cannot apply.
		return { cancelled: true };
	}
	const reason = value.reason;
	return reason === "already-settled" || reason === "commit-started" ? { cancelled: false, reason } : { cancelled: false };
}

export function createRemoteControlClient(options: RemoteControlClientOptions): RemoteControlClient {
	const rawHostId: unknown = options?.hostId;
	if (typeof rawHostId !== "string" || rawHostId.length === 0 || rawHostId.length > MAX_HOST_ID_LENGTH || CONTROL_CHARS.test(rawHostId)) throw invalidOptions();
	const hostId = rawHostId;
	const send = options?.send;
	if (typeof send !== "function") throw invalidOptions();
	const onDiagnostic = options?.onDiagnostic;
	if (onDiagnostic !== undefined && typeof onDiagnostic !== "function") throw invalidOptions();
	const nowOption = options?.now;
	const now = typeof nowOption === "function" ? nowOption : () => Date.now();
	const scheduler = options?.scheduler ?? DEFAULT_SCHEDULER;
	const maxFrameBytes = readFrameLimit(options?.maxFrameBytes);
	const defaultTimeoutMs = readTimeoutMs(options?.defaultTimeoutMs, REMOTE_HELPER_DEFAULT_REQUEST_TIMEOUT_MS);

	let generation = 0;
	let open = false;
	let idCounter = 0;
	const pending = new Map<string, PendingEntry>();
	/** Bounded FIFO of ids that already produced a terminal outcome, so a repeat can be named as a duplicate. */
	const settled = new Map<string, "cancelled" | "settled">();

	/** Redacted, best-effort observability: a broken observer must never break framing or settlement. */
	function diagnose(code: string, id?: string): void {
		if (typeof onDiagnostic !== "function") return;
		// The invariant is enforced here rather than merely documented: an internal mistake must not be
		// able to push free text (a path, a command line) into the diagnostic stream.
		const safeCode = STABLE_CODE_PATTERN.test(code) ? code : REMOTE_FRAME_DIAGNOSTIC_CODES.invalid;
		const safeId = id !== undefined && ID_PATTERN.test(id) ? id : undefined;
		const entry: RemoteControlDiagnosticEntry = { hostId, connectionGeneration: generation, code: safeCode, ...(safeId === undefined ? {} : { id: safeId }) };
		try {
			onDiagnostic(entry);
		} catch {
			// Diagnostics are an observer side channel; swallowing a broken observer keeps the protocol usable.
		}
	}

	function protocolInvalid(): RemoteControlError {
		return new RemoteControlError("PROTOCOL_INVALID", false);
	}

	function requestCancelled(): RemoteControlError {
		return new RemoteControlError("REQUEST_CANCELLED", false);
	}

	function connectionLost(code = "REMOTE_CONNECTION_LOST"): RemoteControlError {
		return new RemoteControlError(code, RETRYABLE_CODES.has(code));
	}

	function mintId(): string {
		idCounter += 1;
		return `req-${idCounter}`;
	}

	function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: RemoteControlError) => void } {
		let resolveFn: (value: T) => void = () => {};
		let rejectFn: (error: RemoteControlError) => void = () => {};
		const promise = new Promise<T>((resolve, reject) => {
			resolveFn = resolve;
			rejectFn = reject;
		});
		return { promise, resolve: resolveFn, reject: rejectFn };
	}

	function rememberOutcome(id: string, outcome: "cancelled" | "settled"): void {
		settled.set(id, outcome);
		while (settled.size > SETTLED_ID_LIMIT) {
			const oldest = settled.keys().next().value;
			if (oldest === undefined) break;
			settled.delete(oldest);
		}
	}

	function clearEntryTimer(entry: PendingEntry): void {
		if (entry.timer === undefined) return;
		scheduler.clearTimeout(entry.timer);
		entry.timer = undefined;
	}

	/**
	 * The pending table is the single source of truth for "not settled yet": a response, the local
	 * deadline and closeConnection may race, but only the first one can reach `entry.settle`.
	 */
	function settlePending(entry: PendingEntry, error: RemoteControlError | null, result: unknown): void {
		if (pending.get(entry.id) !== entry) return;
		pending.delete(entry.id);
		clearEntryTimer(entry);
		rememberOutcome(entry.id, error !== null && error.code === "REQUEST_CANCELLED" ? "cancelled" : "settled");
		entry.settle(error, result);
	}

	function onDeadline(entry: PendingEntry): void {
		if (pending.get(entry.id) !== entry) return;
		const remaining = entry.deadlineAt - now();
		if (remaining > 0 && entry.rearms < MAX_DEADLINE_REARMS) {
			// A coarse scheduler can wake before the authoritative deadline; re-arm with the remaining
			// budget instead of failing a request that still has time. Bounded so a scheduler that always
			// fires early cannot spin the loop.
			entry.rearms += 1;
			armDeadline(entry, remaining);
			return;
		}
		diagnose("REQUEST_TIMEOUT", entry.id);
		settlePending(entry, new RemoteControlError("REQUEST_TIMEOUT", true), undefined);
	}

	function armDeadline(entry: PendingEntry, delayMs: number): void {
		entry.timer = scheduler.setTimeout(
			() => {
				entry.timer = undefined;
				onDeadline(entry);
			},
			Math.max(delayMs, 0),
		);
	}

	/** JSON.stringify escapes every control character, so the encoded frame is one line by construction. */
	function encodeFrame(frame: RemoteHelperRequestFrame): string {
		let line: string;
		try {
			line = JSON.stringify(frame);
		} catch {
			// Unserializable params (BigInt, cycles) are a caller error; the frame never reaches the wire.
			diagnose(REMOTE_FRAME_DIAGNOSTIC_CODES.invalid, frame.id);
			throw protocolInvalid();
		}
		if (Buffer.byteLength(line, "utf8") > maxFrameBytes) {
			// Over-limit frames are refused, never truncated (§7.1): a partial frame is worse than none.
			diagnose(REMOTE_FRAME_DIAGNOSTIC_CODES.invalid, frame.id);
			throw protocolInvalid();
		}
		return line;
	}

	function onSendFailure(entry: PendingEntry): void {
		diagnose(REMOTE_FRAME_DIAGNOSTIC_CODES.sendFailed, entry.id);
		// The frame never left, so the request cannot be answered; waiting for its deadline would only
		// delay a certain failure.
		settlePending(entry, connectionLost(), undefined);
	}

	function deliver(line: string, entry: PendingEntry): void {
		// A re-entrant scheduler may have settled the entry while it was being registered; sending then
		// would ask the helper for a request nobody awaits.
		if (pending.get(entry.id) !== entry) return;
		let outcome: void | Promise<void>;
		try {
			outcome = send(line);
		} catch {
			onSendFailure(entry);
			return;
		}
		if (isPromiseLike(outcome)) void outcome.then(undefined, () => onSendFailure(entry));
	}

	function createPending(id: string, timeoutMs: number, settle: (error: RemoteControlError | null, result: unknown) => void): PendingEntry {
		const entry: PendingEntry = { id, deadlineAt: now() + timeoutMs, rearms: 0, timer: undefined, settle };
		pending.set(id, entry);
		armDeadline(entry, timeoutMs);
		return entry;
	}

	function failPending(code: string): void {
		// Snapshot first: settling mutates the table, and a re-entrant observer must not extend the loop.
		for (const entry of [...pending.values()]) {
			diagnose(code, entry.id);
			settlePending(entry, connectionLost(code), undefined);
		}
		pending.clear();
	}

	function openConnection(): number {
		if (open) {
			// Opening over a live connection is a reconnect: the old generation's requests can never be
			// answered, and re-sending them under the new generation is forbidden (§7.1).
			open = false;
			failPending("REMOTE_CONNECTION_LOST");
		}
		generation += 1;
		open = true;
		settled.clear();
		return generation;
	}

	function closeConnection(reason?: string): void {
		// Only a stable code travels on; free text falls back to the contract code so a path or command
		// line passed as a reason can never reach a diagnostic.
		const code = typeof reason === "string" && STABLE_CODE_PATTERN.test(reason) ? reason : "REMOTE_CONNECTION_LOST";
		open = false;
		failPending(code);
	}

	function handleLine(line: string): void {
		if (typeof line !== "string") {
			// The transport is a trust boundary; a non-string is dropped, never coerced with String().
			diagnose(REMOTE_FRAME_DIAGNOSTIC_CODES.invalid);
			return;
		}
		const text = stripLineTerminator(line);
		if (text.length === 0 || CONTROL_CHARS.test(text)) {
			diagnose(REMOTE_FRAME_DIAGNOSTIC_CODES.invalid);
			return;
		}
		if (Buffer.byteLength(text, "utf8") > maxFrameBytes) {
			diagnose(REMOTE_FRAME_DIAGNOSTIC_CODES.tooLarge);
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			diagnose(REMOTE_FRAME_DIAGNOSTIC_CODES.invalid);
			return;
		}
		const read = readInboundFrame(parsed);
		if (read.kind === "invalid") {
			diagnose(REMOTE_FRAME_DIAGNOSTIC_CODES.invalid, read.id);
			return;
		}
		if (read.hostId !== hostId) {
			diagnose(REMOTE_FRAME_DIAGNOSTIC_CODES.wrongHost, read.id);
			return;
		}
		if (!open || read.generation !== generation) {
			// Frames of a closed connection and frames of a superseded generation are equally unusable and
			// must never touch the live generation's requests (§7.1 fencing rule).
			diagnose(REMOTE_FRAME_DIAGNOSTIC_CODES.staleGeneration, read.id);
			return;
		}
		const entry = pending.get(read.id);
		if (entry === undefined) {
			diagnose(settled.has(read.id) ? REMOTE_FRAME_DIAGNOSTIC_CODES.duplicateResponse : REMOTE_FRAME_DIAGNOSTIC_CODES.unknownId, read.id);
			return;
		}
		if (read.kind === "error-body-invalid") {
			// The frame names a live request but its error body cannot be trusted; failing that one request
			// is more truthful than letting it hang until the local deadline.
			diagnose(REMOTE_FRAME_DIAGNOSTIC_CODES.invalid, read.id);
			settlePending(entry, protocolInvalid(), undefined);
			return;
		}
		if (read.kind === "ok") {
			settlePending(entry, null, read.result);
			return;
		}
		const body = read.error;
		const retryable = typeof body.retryable === "boolean" ? body.retryable : RETRYABLE_CODES.has(body.code);
		settlePending(entry, new RemoteControlError(body.code, retryable, body.message), undefined);
	}

	async function request(method: string, params?: unknown, options?: RemoteControlRequestOptions): Promise<unknown> {
		if (typeof method !== "string" || method.length === 0 || method.length > MAX_METHOD_LENGTH || !METHOD_PATTERN.test(method)) throw protocolInvalid();
		if (!open) {
			// Generation 0 means "no connection": a request has nowhere to go and must not be written with a
			// stale generation. Fail closed instead of queueing silently.
			diagnose("REMOTE_CONNECTION_LOST");
			throw connectionLost();
		}
		const id = mintId();
		const timeoutMs = readTimeoutMs(options?.timeoutMs, defaultTimeoutMs);
		const frame: RemoteHelperRequestFrame = {
			v: REMOTE_HELPER_PROTOCOL_VERSION,
			hostId,
			generation,
			id,
			method,
			timeoutMs,
			...(params === undefined ? {} : { params }),
		};
		const line = encodeFrame(frame);
		const deferred = createDeferred<unknown>();
		const entry = createPending(id, timeoutMs, (error, result) => {
			if (error !== null) deferred.reject(error);
			else deferred.resolve(result);
		});
		deliver(line, entry);
		return deferred.promise;
	}

	async function cancel(requestId: string, options?: RemoteControlRequestOptions): Promise<RemoteHelperCancelResult> {
		if (typeof requestId !== "string" || !ID_PATTERN.test(requestId)) throw protocolInvalid();
		if (!open) {
			diagnose("REMOTE_CONNECTION_LOST");
			throw connectionLost();
		}
		if (!pending.has(requestId)) {
			// The request already has a delivered outcome, so a "rolled back" answer would be a lie
			// (§7.1: cancel must not fake a successful rollback).
			return { cancelled: false, reason: "already-settled" };
		}
		const id = mintId();
		const timeoutMs = readTimeoutMs(options?.timeoutMs, defaultTimeoutMs);
		const cancelParams: RemoteHelperCancelParams = { requestId };
		const frame: RemoteHelperRequestFrame = { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId, generation, id, method: "cancel", timeoutMs, params: cancelParams };
		const line = encodeFrame(frame);
		const deferred = createDeferred<RemoteHelperCancelResult>();
		const entry = createPending(id, timeoutMs, (error, result) => {
			if (error !== null) {
				deferred.reject(error);
				return;
			}
			const read = readCancelResult(result);
			if (read === null) {
				// An unreadable cancel result settles nothing: it must never be taken for a successful abort.
				diagnose(REMOTE_FRAME_DIAGNOSTIC_CODES.invalid, id);
				deferred.reject(protocolInvalid());
				return;
			}
			if (!read.cancelled) {
				// The helper declined (or is past its commit point); the target keeps its real result.
				deferred.resolve(read);
				return;
			}
			const target = pending.get(requestId);
			if (target !== undefined) {
				// The helper aborted the work, so the target's single terminal outcome is REQUEST_CANCELLED.
				// Settling it here keeps that guarantee even if the helper's own terminal frame is lost.
				settlePending(target, requestCancelled(), undefined);
				deferred.resolve({ cancelled: true });
				return;
			}
			// The target settled while the cancel was in flight. Its outcome stands; reporting the known
			// truth beats echoing an abort claim that no longer matches the delivered result.
			deferred.resolve(settled.get(requestId) === "cancelled" ? { cancelled: true } : { cancelled: false, reason: "already-settled" });
		});
		deliver(line, entry);
		return deferred.promise;
	}

	return {
		hostId,
		get connectionGeneration(): number {
			return generation;
		},
		get open(): boolean {
			return open;
		},
		openConnection,
		closeConnection,
		handleLine,
		request,
		cancel,
		pendingCount(): number {
			return pending.size;
		},
	};
}
