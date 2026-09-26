import { decodeBundleManifest } from "./RemoteBootstrapContract";
import { REMOTE_BOOTSTRAP_MAX_FRAME_BYTES, REMOTE_BOOTSTRAP_PROTOCOL_VERSION, type RemoteBootstrapFileMode, type RemoteBootstrapInboundFrame, type RemoteBundleManifest } from "./RemoteHelperContract";

/** A bootstrap staging session: frames out through write(), results in through the stdout lines. */
export type BootstrapSession = {
	write(line: string): void;
	onStdoutLine(listener: (line: string) => void): () => void;
};

export type BootstrapTimers = {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
};

export type BootstrapFinalizeOutcome = { status: "finalized"; active: string; files: number } | { status: "aborted"; reason: "requested" | "eof" } | { status: "error"; code: string } | { status: "timeout" };

/** Validated `ready` payload: the upload step needs these values to place the bundle. */
export type BootstrapReadyFrame = { op: "ready"; protocolVersion: number; bundleSha256: string; nonce: string; deployRoot: string; staging: string };

export type BootstrapFinalizeOptions = {
	/** Files that must land mode 0700; everything else is uploaded as 0600. */
	executableNames?: readonly string[];
	timeoutMs?: number;
	timers?: BootstrapTimers;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const SHA256 = /^[0-9a-f]{64}$/;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const ACTIVE = /^\.\/bundles\/[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function invalid(): never {
	throw new Error("BOOTSTRAP_INPUT_INVALID");
}

function onlyKeys(frame: Record<string, unknown>, keys: readonly string[]): boolean {
	const own = Object.keys(frame);
	return own.length === keys.length && own.every((key) => keys.includes(key));
}

/**
 * Map an arbitrary thrown value to a stable code. Duck-typed rather than `instanceof Error` because
 * errors can cross realm boundaries, and whitelisted so a transport error carrying a path or frame
 * text can never surface as this function's message.
 */
function toStableError(error: unknown): Error {
	const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
	return new Error(typeof message === "string" && CODE.test(message) ? message : "BOOTSTRAP_INPUT_INVALID");
}

function modeFor(name: string, executableNames: readonly string[]): RemoteBootstrapFileMode {
	return executableNames.includes(name) ? "0700" : "0600";
}

/**
 * Build the ordered inbound frames for one finalize run. The entry caps a line at 4096 bytes, so the
 * manifest travels per file; a frame that would exceed the cap is refused here rather than truncated
 * by the remote side. Frames are returned without the trailing newline the transport appends.
 */
export function buildFinalizeFrames(manifest: RemoteBundleManifest, options: { executableNames?: readonly string[] } = {}): string[] {
	// Decoding first proves the manifest is well-formed before anything is put on the wire.
	const decoded = decodeBundleManifest(manifest);
	const executableNames = options.executableNames ?? [];
	if (!Array.isArray(executableNames) || executableNames.some((name) => typeof name !== "string")) invalid();
	// The same rule the manifest-side contract applies: an unknown or repeated name would silently
	// downgrade the entry point to 0600, which only fails much later at exec time.
	const declaredNames = new Set(decoded.files.map((file) => file.name));
	if (new Set(executableNames).size !== executableNames.length || executableNames.some((name) => !declaredNames.has(name))) invalid();
	const frames: RemoteBootstrapInboundFrame[] = [{ v: REMOTE_BOOTSTRAP_PROTOCOL_VERSION, op: "finalize-begin", files: decoded.files.length, bundleSha256: decoded.bundleSha256 }];
	for (const file of decoded.files) {
		frames.push({ v: REMOTE_BOOTSTRAP_PROTOCOL_VERSION, op: "finalize-file", name: file.name, sha256: file.sha256, bytes: file.bytes, mode: modeFor(file.name, executableNames) });
	}
	frames.push({ v: REMOTE_BOOTSTRAP_PROTOCOL_VERSION, op: "finalize-commit" });
	return frames.map((frame) => {
		const line = JSON.stringify(frame);
		if (Buffer.byteLength(line, "utf8") > REMOTE_BOOTSTRAP_MAX_FRAME_BYTES) throw new Error("BOOTSTRAP_INPUT_INVALID");
		return line;
	});
}

/** Strictly decode one result frame; unknown or malformed lines return null so they can be ignored. */
export function decodeBootstrapResult(line: string): BootstrapReadyFrame | { op: "finalized"; active: string; files: number } | { op: "aborted"; reason: "requested" | "eof" } | { op: "error"; code: string } | null {
	if (typeof line !== "string" || line.length === 0) return null;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const frame = value as Record<string, unknown>;
	if (frame.v !== REMOTE_BOOTSTRAP_PROTOCOL_VERSION || typeof frame.op !== "string") return null;
	if (frame.op === "ready") {
		// The upload step is told where to put the bytes, so this payload is validated instead of dropped.
		if (!onlyKeys(frame, ["v", "op", "protocolVersion", "bundleSha256", "nonce", "deployRoot", "staging", "stagingMode"])) return null;
		if (frame.protocolVersion !== REMOTE_BOOTSTRAP_PROTOCOL_VERSION || frame.stagingMode !== "0700") return null;
		if (typeof frame.bundleSha256 !== "string" || !SHA256.test(frame.bundleSha256)) return null;
		if (typeof frame.nonce !== "string" || !NONCE.test(frame.nonce)) return null;
		if (typeof frame.deployRoot !== "string" || !frame.deployRoot.startsWith("/") || frame.deployRoot.length > 4096 || CONTROL.test(frame.deployRoot)) return null;
		if (frame.staging !== `.staging-${frame.nonce}`) return null;
		return { op: "ready", protocolVersion: frame.protocolVersion, bundleSha256: frame.bundleSha256, nonce: frame.nonce, deployRoot: frame.deployRoot, staging: frame.staging };
	}
	if (frame.op === "error") {
		if (!onlyKeys(frame, ["v", "op", "code"])) return null;
		return typeof frame.code === "string" && CODE.test(frame.code) ? { op: "error", code: frame.code } : null;
	}
	if (frame.op === "aborted") {
		if (!onlyKeys(frame, ["v", "op", "reason"])) return null;
		return frame.reason === "requested" || frame.reason === "eof" ? { op: "aborted", reason: frame.reason } : null;
	}
	if (frame.op === "finalized") {
		// The active path is bound to the pinned content-addressed shape; a free-form string from the
		// remote must never become the path PiDeck records or later execs.
		if (!onlyKeys(frame, ["v", "op", "active", "files"])) return null;
		if (typeof frame.active !== "string" || !ACTIVE.test(frame.active)) return null;
		if (typeof frame.files !== "number" || !Number.isSafeInteger(frame.files) || frame.files < 0) return null;
		return { op: "finalized", active: frame.active, files: frame.files };
	}
	return null;
}

/**
 * Drive one finalize run over an existing staging session: send the frames in order and wait for the
 * entry's single terminal frame. The subscription is always released, including on timeout.
 */
export function runBootstrapFinalize(session: BootstrapSession, manifest: RemoteBundleManifest, options: BootstrapFinalizeOptions = {}): Promise<BootstrapFinalizeOutcome> {
	if (typeof session?.write !== "function" || typeof session?.onStdoutLine !== "function") return Promise.reject(new Error("BOOTSTRAP_INPUT_INVALID"));
	let frames: string[];
	try {
		frames = buildFinalizeFrames(manifest, options);
	} catch (error) {
		return Promise.reject(toStableError(error));
	}
	const timeoutMs = Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs as number) > 0 ? Math.min(options.timeoutMs as number, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
	const timers: BootstrapTimers = options.timers ?? { setTimeout: (handler, delayMs) => setTimeout(handler, delayMs), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) };
	return new Promise<BootstrapFinalizeOutcome>((resolve, reject) => {
		let settled = false;
		let timer: unknown;
		let unsubscribe: (() => void) | undefined;
		const release = (): void => {
			if (timer !== undefined) timers.clearTimeout(timer);
			unsubscribe?.();
			unsubscribe = undefined;
		};
		const finish = (outcome: BootstrapFinalizeOutcome): void => {
			if (settled) return;
			settled = true;
			release();
			resolve(outcome);
		};
		const abort = (error: unknown): void => {
			if (settled) return;
			settled = true;
			release();
			reject(toStableError(error));
		};
		// The deadline is armed before subscribing, so a session that answers synchronously still gets
		// its timer cleared instead of leaving one armed for two minutes.
		timer = timers.setTimeout(() => finish({ status: "timeout" }), timeoutMs);
		try {
			unsubscribe = session.onStdoutLine((line) => {
				const frame = decodeBootstrapResult(line);
				if (frame === null || frame.op === "ready") return;
				if (frame.op === "aborted") return finish({ status: "aborted", reason: frame.reason });
				if (frame.op === "error") return finish({ status: "error", code: frame.code });
				// Bind the terminal frame to the manifest we just sent: the remote must not be able to name
				// another active path or claim a different file count.
				if (frame.active !== `./bundles/${manifest.bundleSha256}`) return finish({ status: "error", code: "BOOTSTRAP_ACTIVE_CONFLICT" });
				if (frame.files !== manifest.files.length) return finish({ status: "error", code: "BOOTSTRAP_FINALIZE_INCOMPLETE" });
				finish({ status: "finalized", active: frame.active, files: frame.files });
			});
		} catch (error) {
			abort(error);
			return;
		}
		try {
			for (const line of frames) session.write(line);
		} catch (error) {
			// The transport refused a frame (session already gone): report it once and drop the listener.
			abort(error);
		}
	});
}
