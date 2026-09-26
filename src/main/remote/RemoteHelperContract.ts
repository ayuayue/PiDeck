/**
 * Shared vocabulary for the remote helper protocol (plan §7) and the bootstrap contract (§168).
 * Types and limits only — parsing, framing and validation live in the modules that own them, so this
 * file stays the single place both sides agree on.
 */

/** Wire protocol version. A helper with a different version must not be used (structured refusal). */
export const REMOTE_HELPER_PROTOCOL_VERSION = 1;

/** One NDJSON frame, UTF-8 encoded. Anything larger is a protocol error, never a truncation. */
export const REMOTE_HELPER_MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** File bodies travel in chunks; the base64 form still has to fit the frame limit. */
export const REMOTE_HELPER_MAX_CHUNK_BYTES = 1024 * 1024;
/** Bounded concurrency: long transfers must not head-of-line block short requests. */
export const REMOTE_HELPER_MAX_CONCURRENT_REQUESTS = 4;
export const REMOTE_HELPER_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const REMOTE_HELPER_MAX_REQUEST_TIMEOUT_MS = 300_000;

/** Stable helper error codes. Free text never travels as a code (diagnostics stay redacted). */
export const REMOTE_HELPER_ERROR_CODES = ["METHOD_NOT_FOUND", "REQUEST_CANCELLED", "REQUEST_TIMEOUT", "RESULT_TOO_LARGE", "PATH_OUTSIDE_ROOT", "PROTOCOL_INVALID", "HELPER_INTERNAL", "REMOTE_CONNECTION_LOST"] as const;
export type RemoteHelperErrorCode = (typeof REMOTE_HELPER_ERROR_CODES)[number];

export type RemoteHelperRequestFrame = {
	v: number;
	hostId: string;
	generation: number;
	id: string;
	method: string;
	timeoutMs?: number;
	params?: unknown;
};

export type RemoteHelperErrorBody = {
	code: string;
	message?: string;
	retryable?: boolean;
};

export type RemoteHelperResponseFrame = {
	v: number;
	hostId: string;
	generation: number;
	id: string;
	ok: boolean;
	result?: unknown;
	error?: RemoteHelperErrorBody;
};

/** Cancel is a first-class request: it carries its own id and names the target request. */
export type RemoteHelperCancelParams = { requestId: string };
export type RemoteHelperCancelResult = { cancelled: boolean; reason?: "already-settled" | "commit-started" };

/** Staged-connection phases a bootstrap run walks through (plan §11.1 test-connection stages). */
export type RemoteHelperHandshake = {
	protocolVersion: number;
	platform: string;
	arch: string;
	home: string;
	capabilities: readonly string[];
};

/** Bootstrap manifest entry: one immutable file of the uploaded bundle (§168). */
export type RemoteBundleFile = { name: string; sha256: string; bytes: number };

export type RemoteBundleManifest = {
	schemaVersion: number;
	bundleSha256: string;
	files: readonly RemoteBundleFile[];
};

export const REMOTE_BUNDLE_MANIFEST_SCHEMA_VERSION = 1;
/** Deployment roots and per-file caps stay explicit so a manifest cannot smuggle an unbounded set. */
export const REMOTE_BUNDLE_MAX_FILES = 256;
export const REMOTE_BUNDLE_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const REMOTE_BUNDLE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * Bootstrap staging-session frames (plan §168). The frozen entry caps an inbound line at 4096 bytes,
 * so the manifest travels as one small frame per file instead of a single document.
 */
export const REMOTE_BOOTSTRAP_PROTOCOL_VERSION = 1;
export const REMOTE_BOOTSTRAP_MAX_FRAME_BYTES = 4096;
/** Immutable, content-addressed activation target: `<deployRoot>/bundles/<bundleSha256>`. */
export const REMOTE_BOOTSTRAP_BUNDLE_DIR_NAME = "bundles";
/** File modes the entry accepts: regular files 0600, executables 0700. */
export const REMOTE_BOOTSTRAP_FILE_MODES = ["0600", "0700"] as const;
export type RemoteBootstrapFileMode = (typeof REMOTE_BOOTSTRAP_FILE_MODES)[number];

export type RemoteBootstrapFinalizeBeginFrame = { v: 1; op: "finalize-begin"; files: number; bundleSha256: string };
export type RemoteBootstrapFinalizeFileFrame = { v: 1; op: "finalize-file"; name: string; sha256: string; bytes: number; mode: RemoteBootstrapFileMode };
export type RemoteBootstrapFinalizeCommitFrame = { v: 1; op: "finalize-commit" };
export type RemoteBootstrapAbortFrame = { v: 1; op: "abort" };
export type RemoteBootstrapInboundFrame = RemoteBootstrapFinalizeBeginFrame | RemoteBootstrapFinalizeFileFrame | RemoteBootstrapFinalizeCommitFrame | RemoteBootstrapAbortFrame;

export type RemoteBootstrapReadyFrame = { v: 1; op: "ready"; protocolVersion: number; bundleSha256: string; nonce: string; deployRoot: string; staging: string; stagingMode: "0700" };
export type RemoteBootstrapFinalizedFrame = { v: 1; op: "finalized"; active: string; files: number };
export type RemoteBootstrapAbortedFrame = { v: 1; op: "aborted"; reason: "requested" | "eof" };
export type RemoteBootstrapErrorFrame = { v: 1; op: "error"; code: string };
export type RemoteBootstrapResultFrame = RemoteBootstrapReadyFrame | RemoteBootstrapFinalizedFrame | RemoteBootstrapAbortedFrame | RemoteBootstrapErrorFrame;

export const REMOTE_BOOTSTRAP_FINALIZE_ERROR_CODES = ["BOOTSTRAP_INPUT_INVALID", "BOOTSTRAP_ENTRY_OP_UNSUPPORTED", "BOOTSTRAP_FINALIZE_INCOMPLETE", "BOOTSTRAP_FILE_MISMATCH", "BOOTSTRAP_MODE_INVALID", "BOOTSTRAP_ACTIVE_CONFLICT", "BOOTSTRAP_INTERNAL"] as const;
export type RemoteBootstrapFinalizeErrorCode = (typeof REMOTE_BOOTSTRAP_FINALIZE_ERROR_CODES)[number];
