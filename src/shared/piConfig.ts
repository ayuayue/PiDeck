/**
 * Shared contract for the target-routed Pi config backend (Phase 5, plan §6.4.1).
 *
 * The local surface keeps its existing DTOs; this module adds only the pieces both the main process and a
 * later renderer batch need to name a target and branch on stable codes. No secret value ever travels in
 * these types: a remote snapshot carries secret positions as configured/missing plus a path list.
 */

/**
 * Which allowlisted agent file a request names. Never a path, never auth.json.
 *
 * trust.json 与 mcp.json 与 models/settings 走**同一条** sanitize/patch 通道：秘密键仍只回
 * configured/missing，补丁可以写入新值、但删不掉秘密键。auth.json 结构性不可达（凭据永不跨机回传），
 * 因此不在这张表里，也不该被渲染层当成「ssh 可编辑」的文件。
 */
export const PI_CONFIG_FILES = ["models", "settings", "trust", "mcp"] as const;
export type PiConfigFileKey = (typeof PI_CONFIG_FILES)[number];

/**
 * The WSL scope reads through the distribution's UNC path and writes inside the distribution, so the credential
 * file is editable there too (same trust level as the Windows HOME). The extra key exists only for this scope;
 * `PI_CONFIG_FILES` stays the ssh allowlist so `auth` can never be addressed over the helper.
 */
export const WSL_PI_CONFIG_FILES = ["models", "settings", "trust", "mcp", "auth"] as const;
export type WslPiConfigFileKey = (typeof WSL_PI_CONFIG_FILES)[number];

/** File key → the file name pi actually reads in `~/.pi/agent`. One table for the renderer source-file page. */
export const PI_CONFIG_FILE_NAMES: Record<WslPiConfigFileKey, string> = {
	models: "models.json",
	settings: "settings.json",
	trust: "trust.json",
	mcp: "mcp.json",
	auth: "auth.json",
};

/** true only for a file key the ssh helper may address (never auth). */
export function isPiConfigFileKey(value: unknown): value is PiConfigFileKey {
	return typeof value === "string" && (PI_CONFIG_FILES as readonly string[]).includes(value);
}

/** true only for a file key the WSL scope may address (includes auth). */
export function isWslPiConfigFileKey(value: unknown): value is WslPiConfigFileKey {
	return typeof value === "string" && (WSL_PI_CONFIG_FILES as readonly string[]).includes(value);
}

/** `models.json` → `models`; unknown names return undefined (never inferred). */
export function piConfigFileKeyFromName(name: unknown): WslPiConfigFileKey | undefined {
	if (typeof name !== "string") return undefined;
	for (const key of WSL_PI_CONFIG_FILES) {
		if (PI_CONFIG_FILE_NAMES[key] === name) return key;
	}
	return undefined;
}

/**
 * Where a config read/write should run. local is the default when the option is absent; ssh is usable only
 * for a host the host store has verified and the connection service has ready (the main backend enforces it);
 * wsl names a WslHostStore profile, whose distro/user resolve the config directory inside that distribution's
 * HOME (never the Windows HOME — a missing environment fails closed with a WSL_CONFIG_* code).
 */
export type PiConfigTarget = { kind: "local" } | { kind: "ssh"; hostId: string } | { kind: "wsl"; hostId: string };

/**
 * Which files a target can manage. The ssh helper's allowlist excludes auth.json; local and WSL read the real
 * directory (Windows HOME / distribution HOME) and therefore cover every file pi reads.
 */
export function piConfigFilesForTarget(target: PiConfigTarget): readonly WslPiConfigFileKey[] {
	return target.kind === "ssh" ? PI_CONFIG_FILES : WSL_PI_CONFIG_FILES;
}

/**
 * Which environment a **resource** surface (skills / prompts / extensions) reads and writes.
 *
 * Deliberately narrower than {@link PiConfigTarget}: remote (ssh) resource management is not supported in this
 * build, so an ssh target is not expressible here and the main-side validator refuses anything outside this union.
 * Absent target means local, the compatibility default every existing renderer call relies on.
 */
export type PiResourceTarget = { kind: "local" } | { kind: "wsl"; hostId: string };
export type PiResourceOptions = { target?: PiResourceTarget };

/**
 * Stable codes for a resource target (skills / prompts / extensions, W1). Same closed-vocabulary discipline as
 * REMOTE_CONFIG_* / WSL_CONFIG_*: main only answers with a code from this set, so the renderer branches on codes
 * instead of parsing prose, and a failed WSL scope can never be reported as "the local list is just empty".
 */
export const PI_RESOURCE_CODES = {
	/** the target object shape/hostId is not a resource target this build accepts. */
	targetInvalid: "PI_RESOURCE_TARGET_INVALID",
	/** ssh is a valid config target, but remote resource management is not routed there in this build. */
	sshUnsupported: "PI_RESOURCE_SSH_UNSUPPORTED",
	/** the channel is a local-only resource write (skill/extension mutations, prompt create/delete/rename/toggle). */
	writeUnsupported: "PI_RESOURCE_WRITE_UNSUPPORTED",
	/** no WslHostStore profile carries that id (removed, or never created). */
	hostNotFound: "PI_RESOURCE_HOST_NOT_FOUND",
	/** the distribution's HOME could not be resolved (wsl.exe failure / distro unregistered). */
	distroUnavailable: "PI_RESOURCE_DISTRO_UNAVAILABLE",
	/** resolved, but the environment contradicts the profile (never fall back to the local HOME). */
	unavailable: "PI_RESOURCE_UNAVAILABLE",
} as const;
export type PiResourceCode = (typeof PI_RESOURCE_CODES)[keyof typeof PI_RESOURCE_CODES];
/** Closed-set helper: the main process only returns a code in this vocabulary. */
export const PI_RESOURCE_CODE_SET: ReadonlySet<string> = new Set(Object.values(PI_RESOURCE_CODES));

/** Extract the stable PI_RESOURCE_* code from a rejected IPC call (Electron prefixes its message). */
export function piResourceCodeFromError(error: unknown): string | undefined {
	const message = typeof error === "object" && error !== null && "message" in error ? String((error as { message?: unknown }).message ?? "") : String(error ?? "");
	const match = /(PI_RESOURCE_[A-Z_]+)/.exec(message);
	return match?.[1];
}

/** The closed set of stable codes the remote backend and its IPC surface may answer with. */
export const REMOTE_CONFIG_CODES = {
	/** target object shape/hostId shape is not a target this build accepts. */
	targetInvalid: "REMOTE_CONFIG_TARGET_INVALID",
	/** the ssh host is known but not connected/ready (or the connection was disposed). */
	hostNotReady: "REMOTE_CONFIG_HOST_NOT_READY",
	/** the remote feature switch is off / the backend or transport port was not assembled. */
	unavailable: "REMOTE_CONFIG_UNAVAILABLE",
	/** the deployed helper has no config scope (METHOD_NOT_FOUND from an older build). */
	unsupported: "REMOTE_CONFIG_UNSUPPORTED",
	/** malformed file content, unsupported path shape, or a helper reply that failed re-validation. */
	fileInvalid: "REMOTE_CONFIG_FILE_INVALID",
	/** expectedVersion did not match the current bytes; the caller must re-read before writing. */
	versionConflict: "REMOTE_CONFIG_VERSION_CONFLICT",
	/** the write may or may not have landed and its receipt was not trustworthy; never retried. */
	resultUnconfirmed: "REMOTE_CONFIG_RESULT_UNCONFIRMED",
	/** provider connection test / model catalog fetch / usage query is explicitly deferred for remote targets. */
	providerOperationUnsupported: "REMOTE_CONFIG_PROVIDER_OPERATION_UNSUPPORTED",
} as const;
export type RemoteConfigCode = (typeof REMOTE_CONFIG_CODES)[keyof typeof REMOTE_CONFIG_CODES];
/** Stable-code set helper: main only returns a code that is in this closed vocabulary. */
export const REMOTE_CONFIG_CODE_SET: ReadonlySet<string> = new Set(Object.values(REMOTE_CONFIG_CODES));

/** One redacted secret position; nothing else about the value crosses the process boundary. */
export type RemotePiConfigSecretEntry = { path: string; status: "configured" | "missing" };

/**
 * One sanitized remote file snapshot. version/sha256 are the sha256 hex of the raw bytes the helper read
 * (missing files use the canonical empty document's bytes), so a write can be guarded by expectedVersion.
 */
export type RemotePiConfigSnapshot = {
	kind: "remote";
	hostId: string;
	file: PiConfigFileKey;
	version: string;
	sha256: string;
	data: Record<string, unknown>;
	secrets: readonly RemotePiConfigSecretEntry[];
};

/** Read options: absent target means local (compatibility); ssh must name a host id. */
export type PiConfigReadOptions = { target?: PiConfigTarget };

/**
 * Write options for the existing save IPC. local ignores expectedVersion/patch (existing body-only callers
 * keep working); ssh requires both: patch is the RFC 7396 merge patch and expectedVersion is the version the
 * renderer last read.
 */
export type PiConfigWriteOptions = PiConfigReadOptions & { expectedVersion?: string; patch?: Record<string, unknown> };

/** Successful remote write receipt: a new version the caller can use for the next patch. */
export type RemotePiConfigWriteReceipt = { kind: "remote"; hostId: string; file: PiConfigFileKey; version: string; sha256: string };

/**
 * Renderer-facing result shapes (Batch B). The existing local DTOs stay exactly as they were; a remote
 * answer carries an extra optional `remote` snapshot so no-argument callers keep compiling untouched.
 */
export type RemotePiConfigReadResult = { remote?: RemotePiConfigSnapshot };
export type RemotePiConfigSaveResult = { remote?: RemotePiConfigWriteReceipt };

/** true only for a remote snapshot produced by the target-routed backend (never inferred from local data). */
export function isRemotePiConfigSnapshot(value: unknown): value is RemotePiConfigSnapshot {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "remote";
}

/** true only for a remote write receipt (main returns {valid:true, remote:<receipt>}). */
export function isRemotePiConfigWriteReceipt(value: unknown): value is RemotePiConfigWriteReceipt {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "remote" && typeof (value as { version?: unknown }).version === "string";
}

/** Extract the stable REMOTE_CONFIG_* code from a rejected IPC call (Electron prefixes its message). */
export function remotePiConfigCodeFromError(error: unknown): string | undefined {
	const message = typeof error === "object" && error !== null && "message" in error ? String((error as { message?: unknown }).message ?? "") : String(error ?? "");
	const match = /(REMOTE_CONFIG_[A-Z_]+)/.exec(message);
	return match?.[1];
}

/**
 * Stable codes for a wsl target (P1-1). Same contract shape as REMOTE_CONFIG_*: a closed vocabulary the
 * main process may answer with, so the renderer branches on codes instead of parsing prose. The asymmetry is
 * deliberate — a WSL failure must never be reported as a local/ssh one, because the recovery differs.
 */
export const WSL_CONFIG_CODES = {
	/** target object/hostId is not a wsl target this build accepts. */
	targetInvalid: "WSL_CONFIG_TARGET_INVALID",
	/** no WslHostStore profile carries that id (removed, or never created). */
	hostNotFound: "WSL_CONFIG_HOST_NOT_FOUND",
	/** the distribution is not registered/reachable through its UNC share. */
	distroUnavailable: "WSL_CONFIG_DISTRO_UNAVAILABLE",
	/** the distribution is reachable but the profile's HOME (or .pi/agent) cannot be read/written. */
	pathUnreadable: "WSL_CONFIG_PATH_UNREADABLE",
	/** models.json/settings.json exists but is not a JSON object (never silently treated as empty). */
	fileInvalid: "WSL_CONFIG_FILE_INVALID",
	/** the key is a valid config file but not one this target can address (auth over ssh; unknown names). */
	unsupported: "WSL_CONFIG_UNSUPPORTED",
	/** the wsl config store was not assembled for this build. */
	unavailable: "WSL_CONFIG_UNAVAILABLE",
} as const;
export type WslConfigCode = (typeof WSL_CONFIG_CODES)[keyof typeof WSL_CONFIG_CODES];
/** Closed-set helper: main only returns a code in this vocabulary. */
export const WSL_CONFIG_CODE_SET: ReadonlySet<string> = new Set(Object.values(WSL_CONFIG_CODES));

/**
 * One wsl config snapshot. label/distro/user are provenance (which profile produced these bytes); the path
 * stays in the main process because configGetDir is the single local directory, not a per-target path.
 */
export type WslPiConfigSnapshot = {
	kind: "wsl";
	hostId: string;
	file: WslPiConfigFileKey;
	label: string;
	distro: string;
	user: string;
	/** Parsed object exactly as pi would read it (missing file = the canonical empty document). */
	data: Record<string, unknown>;
	/** Source text of the file (missing file = the canonical empty document's text); the raw page edits this. */
	raw: string;
};

/** Successful wsl write receipt: whole-file write under the resolved distribution HOME. */
export type WslPiConfigWriteReceipt = { kind: "wsl"; hostId: string; file: WslPiConfigFileKey };

/** true only for a snapshot the wsl store produced (never inferred from local data). */
export function isWslPiConfigSnapshot(value: unknown): value is WslPiConfigSnapshot {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "wsl" && typeof (value as { hostId?: unknown }).hostId === "string";
}

/** Extract the stable WSL_CONFIG_* code from a rejected IPC call (Electron prefixes its message). */
export function wslPiConfigCodeFromError(error: unknown): string | undefined {
	const message = typeof error === "object" && error !== null && "message" in error ? String((error as { message?: unknown }).message ?? "") : String(error ?? "");
	const match = /(WSL_CONFIG_[A-Z_]+)/.exec(message);
	return match?.[1];
}
