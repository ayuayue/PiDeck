/** Remote session history byte bounds and stable error codes. */

/** Single-window bound; it accommodates the largest measured JSONL row while keeping each SSH read finite. */
export const REMOTE_SESSION_HISTORY_WINDOW_BYTES = 2 * 1024 * 1024;

/** SSH exec output ceiling, kept above the bounded payload and its metadata. */
export const REMOTE_SESSION_HISTORY_TRANSPORT_BYTES = 4 * 1024 * 1024;

/** Maximum consecutive windows a page may cross without a complete entry. */
export const REMOTE_SESSION_HISTORY_WINDOW_SKIPS = 4;

/** Stable remote history failure codes. */
export const REMOTE_SESSION_HISTORY_CODES = {
	/** hostId is not a usable diagnostic identity or transport key. */
	hostIdInvalid: "REMOTE_SESSION_HISTORY_HOST_ID_INVALID",
	/** locator is not a valid SSH identity, including an oversized remote path. */
	locatorInvalid: "REMOTE_SESSION_HISTORY_LOCATOR_INVALID",
	/** No absolute path is available and the session root cannot be resolved. */
	pathUnresolved: "REMOTE_SESSION_HISTORY_PATH_UNRESOLVED",
	/** The remote path is not safe to include in the bounded command. */
	pathInvalid: "REMOTE_SESSION_HISTORY_PATH_INVALID",
	/** The pinned SSH transport failed without a stable error code. */
	transportFailed: "REMOTE_SESSION_HISTORY_TRANSPORT_FAILED",
	/** The remote command exited unsuccessfully. */
	commandFailed: "REMOTE_SESSION_HISTORY_COMMAND_FAILED",
	/** The stdout window does not contain this request's marker. */
	markerMissing: "REMOTE_SESSION_HISTORY_MARKER_MISSING",
	/** The marked file-generation metadata is malformed. */
	metadataInvalid: "REMOTE_SESSION_HISTORY_METADATA_INVALID",
	/** The file kept changing after the single permitted retry. */
	stale: "REMOTE_SESSION_HISTORY_STALE",
	/** The IPC stack did not provide a history reader. */
	readerUnavailable: "REMOTE_SESSION_HISTORY_UNAVAILABLE",
} as const;

/** Invalid construction options are rejected before the first read. */
export const REMOTE_SESSION_HISTORY_READER_OPTIONS_INVALID = "REMOTE_SESSION_HISTORY_READER_OPTIONS_INVALID";
