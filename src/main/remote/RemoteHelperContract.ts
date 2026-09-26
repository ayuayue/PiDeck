/**
 * Shared vocabulary for the remote helper protocol (plan §7) and the bootstrap contract (§168).
 * Types and limits only — parsing, framing and validation live in the modules that own them, so this
 * file stays the single place both sides agree on.
 *
 * The read-only workspace batch (`fs.stat`, `fs.list`, `fs.read`) is declared here in the same spirit:
 * the method name, the exact result fields and every bound are literals in this file, and the frozen
 * helper body — which cannot import anything — repeats those literals under test (§7.1). A result shape
 * that is not stated here is not part of the protocol, and a bound that is not stated here is not
 * enforced on both sides.
 */

/** Wire protocol version. A helper with a different version must not be used (structured refusal). */
export const REMOTE_HELPER_PROTOCOL_VERSION = 1;

/** One NDJSON frame, UTF-8 encoded. Anything larger is a protocol error, never a truncation. */
export const REMOTE_HELPER_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Field bounds both sides enforce. A mismatch turns a rejection into a silent timeout. */
export const REMOTE_HELPER_MAX_HOST_ID_LENGTH = 64;
export const REMOTE_HELPER_MAX_ID_LENGTH = 128;
export const REMOTE_HELPER_MAX_METHOD_LENGTH = 64;
export const REMOTE_HELPER_MAX_ECHO_TEXT_LENGTH = 4096;
/** Ceiling for the assembled remote command: the producer must not emit what the argv boundary refuses. */
export const REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH = 8192;
/**
 * File bodies travel in chunks; the base64 form still has to fit the frame limit. One chunk is 1 MiB of
 * bytes, which base64-encodes to at most `4 * ceil(1048576 / 3) = 1398104` characters: with the frame
 * fields and a 128 character request id the worst-case `fs.read` line is under 1.4 MB, so the chunk
 * ceiling sits an order of magnitude below REMOTE_HELPER_MAX_FRAME_BYTES and the frame cap stays what it
 * is — a fatal ingest bound, not the limit a normal answer is sized against.
 */
export const REMOTE_HELPER_MAX_CHUNK_BYTES = 1024 * 1024;
/** Bounded concurrency: long transfers must not head-of-line block short requests. */
export const REMOTE_HELPER_MAX_CONCURRENT_REQUESTS = 4;
export const REMOTE_HELPER_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const REMOTE_HELPER_MAX_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Stable helper error codes. Free text never travels as a code (diagnostics stay redacted).
 *
 * The filesystem half of the list is a closed set on purpose: one code per condition the caller can act
 * on, and `IO_ERROR` for every errno nobody predicted, so a raw platform code or message is never
 * relayed. `PATH_OUTSIDE_ROOT` is a refusal before the operation (nothing outside the root is opened) and
 * is also the answer of every filesystem method in a host-only session, which is a helper started without
 * a `--root` at all: that is a legal state, not a misconfiguration, because probing and the handshake need
 * no file access. `RESULT_TOO_LARGE` is a bounded result that is refused instead of truncated, `ROOT_INVALID`
 * is the fatal startup answer of a helper whose `--root` argument is present but unusable (empty, relative,
 * `/`, not a directory or unreadable), and `NOT_A_FILE` covers both a directory and a non-regular entry
 * handed to `fs.read`.
 */
export const REMOTE_HELPER_ERROR_CODES = [
	"METHOD_NOT_FOUND",
	"REQUEST_CANCELLED",
	"REQUEST_TIMEOUT",
	"RESULT_TOO_LARGE",
	"PATH_OUTSIDE_ROOT",
	"PATH_NOT_FOUND",
	"NOT_A_DIRECTORY",
	"NOT_A_FILE",
	"PERMISSION_DENIED",
	"IO_ERROR",
	"ROOT_INVALID",
	"PROTOCOL_INVALID",
	"HELPER_INTERNAL",
	"REMOTE_CONNECTION_LOST",
	"TOO_MANY_REQUESTS",
] as const;
export type RemoteHelperErrorCode = (typeof REMOTE_HELPER_ERROR_CODES)[number];

/** `hello` and `cancel` are mandatory; only optional behaviour is negotiated through capabilities. */
export const REMOTE_HELPER_METHOD_HELLO = "hello";
export const REMOTE_HELPER_METHOD_ECHO = "echo";
export const REMOTE_HELPER_METHOD_CANCEL = "cancel";
/** Read-only workspace methods: the first batch of helpers that actually touches the remote filesystem. */
export const REMOTE_HELPER_METHOD_FS_STAT = "fs.stat";
export const REMOTE_HELPER_METHOD_FS_LIST = "fs.list";
export const REMOTE_HELPER_METHOD_FS_READ = "fs.read";
export const REMOTE_HELPER_CAPABILITIES = ["echo", "fs.stat", "fs.list", "fs.read"] as const;
export type RemoteHelperCapability = (typeof REMOTE_HELPER_CAPABILITIES)[number];
/**
 * Ceiling for one requested relative path. It is applied to the raw string before any filesystem access,
 * so an over-long path is a PROTOCOL_INVALID refusal rather than an ENAMETOOLONG round trip.
 */
export const REMOTE_HELPER_MAX_PATH_LENGTH = 4096;
/**
 * `fs.list` answers in one frame, so the entry count is capped instead of paged: past the cap the whole
 * call is refused with RESULT_TOO_LARGE, never truncated into a listing that silently looks complete.
 * 4096 entries of at most 255 byte names stay below the 8 MiB frame cap with room to spare.
 */
export const REMOTE_HELPER_MAX_LIST_ENTRIES = 4096;
/** Bounded concurrency plus a bounded waiting room: past both, a request is refused, never buffered. */
export const REMOTE_HELPER_MAX_QUEUED_REQUESTS = 64;
/**
 * Upper bound for the optional delay of `echo`. The delay exists so a connection self-test can hold a
 * few requests open and observe the concurrency bound instead of only the steady state.
 */
export const REMOTE_HELPER_MAX_ECHO_DELAY_MS = 5_000;

export type RemoteHelperHelloResult = RemoteHelperHandshake & { helperVersion: string; nodeVersion: string; pid: number };

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

/**
 * How an entry is classified by `fs.stat` and by every `fs.list` entry. `other` is everything that is not
 * a regular file or a directory — a symlink above all: both methods answer with lstat semantics, so a link
 * is never followed for the classification and its target's size is never reported as its own.
 */
export type RemoteHelperPathKind = "file" | "directory" | "other";

/**
 * `path` is a relative POSIX path inside the helper's root; an absolute path, a backslash, a drive
 * prefix, a percent-encoded separator or dot, and any `..` segment are refused as PATH_OUTSIDE_ROOT
 * before the filesystem is touched, and so is a path whose resolved form leaves the root (a symlink that
 * points outside included). `.` names the root itself.
 */
export type RemoteHelperStatParams = { path: string };
/** `bytes` is the entry's own size (the link's size for a symlink) and `mtimeMs` its modification time. */
export type RemoteHelperStatResult = { kind: RemoteHelperPathKind; bytes: number; mtimeMs: number };

export type RemoteHelperListParams = { path: string };
/** `bytes` is present for regular files only; a symlink is `other` and is never followed. */
export type RemoteHelperListEntry = { name: string; kind: RemoteHelperPathKind; bytes?: number };
/** Entries are sorted by name in code-unit order and capped by REMOTE_HELPER_MAX_LIST_ENTRIES. */
export type RemoteHelperListResult = { entries: readonly RemoteHelperListEntry[] };

/**
 * `offset` and `bytes` are safe non-negative integers; `bytes` is at most REMOTE_HELPER_MAX_CHUNK_BYTES,
 * so exactly one frame is needed per chunk and a longer request is refused (PROTOCOL_INVALID) rather than
 * silently shortened.
 */
export type RemoteHelperReadParams = { path: string; offset: number; bytes: number };
/**
 * `chunk` is base64 of the bytes that were actually read, `bytes` their count (0 at or past EOF) and `eof`
 * the fact that this chunk reached the size observed while reading — a client reads until `eof` instead of
 * trusting a total from an earlier `fs.stat`, because the file may change between the two calls.
 */
export type RemoteHelperReadResult = { chunk: string; bytes: number; eof: boolean };

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
