import { REMOTE_CONFIG_CODES, isPiConfigFileKey, type PiConfigFileKey, type RemotePiConfigSnapshot, type RemotePiConfigWriteReceipt } from "../../../shared/piConfig";

/**
 * Batch B pure model for the remote Pi config panel: JSON formatting/parsing of the explicit merge patch,
 * the dirty rule, the closed-code -> copy mapping, and the panel state machine.
 *
 * The important semantics are intentionally in pure functions so they can be unit-tested without React:
 * - a write must always carry the version that was read; a conflict keeps the user's patch text and only the
 *   explicit reload may replace the baseline snapshot;
 * - RESULT_UNCONFIRMED blocks a second save until an explicit reload (never auto-retry a possibly-applied write);
 * - remote snapshots are only accepted when their file/hostId echo the request (never inferred from local data).
 */

export type RemoteConfigErrorKey =
	| "remoteConfig.errorTargetInvalid"
	| "remoteConfig.errorHostNotReady"
	| "remoteConfig.errorUnavailable"
	| "remoteConfig.errorUnsupported"
	| "remoteConfig.errorFileInvalid"
	| "remoteConfig.errorVersionConflict"
	| "remoteConfig.errorResultUnconfirmed"
	| "remoteConfig.errorProviderUnsupported";

export type RemoteConfigPanelPhase = "loading" | "ready" | "saving" | "conflict" | "unconfirmed" | "failed" | "unsupported";

export type RemoteConfigPanelState = {
	phase: RemoteConfigPanelPhase;
	snapshot?: RemotePiConfigSnapshot;
	patchText: string;
	code?: string;
};

export const initialRemoteConfigPanelState: RemoteConfigPanelState = { phase: "loading", patchText: "" };

export type RemoteConfigAction =
	| { type: "loaded"; snapshot: RemotePiConfigSnapshot }
	| { type: "loadFailed"; code: string }
	| { type: "unsupported" }
	| { type: "patchChanged"; text: string }
	| { type: "saveStarted" }
	| { type: "saved" }
	| { type: "conflict"; code: string }
	| { type: "saveFailed"; code: string }
	| { type: "unconfirmed"; code: string }
	| { type: "reloadStarted" }
	| { type: "resetPatch" };

/** Pretty document for the read-only data pane. */
export function formatConfigDocument(data: Record<string, unknown>): string {
	return JSON.stringify(data, null, 2);
}

/** Short, copy-paste-friendly digest display half; full value stays in the title attribute. */
export function shortConfigDigest(value: string | undefined): string {
	if (typeof value !== "string" || value.length === 0) return "";
	return value.length <= 12 ? value : value.slice(0, 12) + "…";
}

export type MergePatchParseResult = { ok: true; patch: Record<string, unknown> } | { ok: false; reason: "empty" | "syntax" | "not-object" | "reserved-key" };

/**
 * Reserved keys can mutate an object's prototype chain during an RFC 7396 merge (security addendum A1:
 * an own "__proto__" key pollutes Object.prototype). Main and the frozen helper reject them as well; refusing
 * here keeps the invalid draft from ever becoming an IPC request and gives the user immediate copy.
 */
const RESERVED_PATCH_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function containsReservedPatchKey(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsReservedPatchKey);
	if (typeof value !== "object" || value === null) return false;
	for (const key of Object.keys(value)) {
		if (RESERVED_PATCH_KEYS.has(key)) return true;
		if (containsReservedPatchKey((value as Record<string, unknown>)[key])) return true;
	}
	return false;
}

/**
 * Parse the explicit patch text. The UI intentionally accepts only a JSON object: RFC 7396 merge patches are
 * objects; an array/scalar patch would be a silent full replacement and is refused before IPC. Reserved keys are
 * refused recursively for the same reason (they are never legitimate config data).
 */
export function parseMergePatchText(text: string): MergePatchParseResult {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { ok: false, reason: "empty" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { ok: false, reason: "syntax" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "not-object" };
	if (containsReservedPatchKey(parsed)) return { ok: false, reason: "reserved-key" };
	return { ok: true, patch: parsed as Record<string, unknown> };
}

/** A draft is dirty when the patch text asks for anything at all ("{}" is a no-op, not a draft). */
export function remoteConfigPatchDirty(patchText: string): boolean {
	const trimmed = patchText.trim();
	return trimmed.length > 0 && trimmed !== "{}";
}

/** false while a write may be in flight or a possibly-applied write is unconfirmed. */
export function remoteConfigCanEdit(state: RemoteConfigPanelState): boolean {
	return state.phase !== "loading" && state.phase !== "saving" && state.phase !== "unsupported";
}

/** Saving is allowed after a definite failure or a version conflict; never after RESULT_UNCONFIRMED. */
export function remoteConfigCanSave(state: RemoteConfigPanelState): boolean {
	return (state.phase === "ready" || state.phase === "conflict" || state.phase === "failed") && state.snapshot !== undefined;
}

export function reduceRemoteConfigPanel(state: RemoteConfigPanelState, action: RemoteConfigAction): RemoteConfigPanelState {
	switch (action.type) {
		case "loaded":
			// Keep the user's patch text across a reload so a conflict is resolved without losing the edit.
			return { phase: "ready", snapshot: action.snapshot, patchText: state.patchText };
		case "loadFailed":
			return { phase: "failed", snapshot: state.snapshot, patchText: state.patchText, code: action.code };
		case "unsupported":
			return { phase: "unsupported", snapshot: state.snapshot, patchText: state.patchText, code: REMOTE_CONFIG_CODES.unsupported };
		case "patchChanged":
			if (!remoteConfigCanEdit(state)) return state;
			return { ...state, patchText: action.text };
		case "saveStarted":
			if (!remoteConfigCanSave(state)) return state;
			return { ...state, phase: "saving" };
		case "saved":
			// The hook re-reads immediately after a successful patch; keep it in loading so the pane never shows
			// a version/data pair that disagrees with the receipt.
			return { phase: "loading", snapshot: state.snapshot, patchText: "" };
		case "conflict":
			if (state.phase !== "saving") return state;
			return { ...state, phase: "conflict", code: action.code };
		case "saveFailed":
			if (state.phase !== "saving") return state;
			return { ...state, phase: "failed", code: action.code };
		case "unconfirmed":
			if (state.phase !== "saving") return state;
			return { ...state, phase: "unconfirmed", code: action.code };
		case "reloadStarted":
			return { ...state, phase: "loading" };
		case "resetPatch":
			if (!remoteConfigCanEdit(state)) return state;
			return { ...state, patchText: "" };
		default:
			return state;
	}
}

/** Closed-code -> i18n key. Unknown codes fall back to the generic "failed ({code})" copy at the call site. */
export function remoteConfigErrorKey(code: string | undefined): RemoteConfigErrorKey | undefined {
	switch (code) {
		case REMOTE_CONFIG_CODES.targetInvalid:
			return "remoteConfig.errorTargetInvalid";
		case REMOTE_CONFIG_CODES.hostNotReady:
			return "remoteConfig.errorHostNotReady";
		case REMOTE_CONFIG_CODES.unavailable:
			return "remoteConfig.errorUnavailable";
		case REMOTE_CONFIG_CODES.unsupported:
			return "remoteConfig.errorUnsupported";
		case REMOTE_CONFIG_CODES.fileInvalid:
			return "remoteConfig.errorFileInvalid";
		case REMOTE_CONFIG_CODES.versionConflict:
			return "remoteConfig.errorVersionConflict";
		case REMOTE_CONFIG_CODES.resultUnconfirmed:
			return "remoteConfig.errorResultUnconfirmed";
		case REMOTE_CONFIG_CODES.providerOperationUnsupported:
			return "remoteConfig.errorProviderUnsupported";
		default:
			return undefined;
	}
}

/**
 * Validate the sanitized remote answer against the request. A plain local DTO without the remote marker means
 * the ssh target did not reach the remote backend (old build / disabled switch) and must be shown as unsupported.
 */
export function readRemoteConfigSnapshot(response: unknown, expected: { hostId: string; file: PiConfigFileKey }): RemotePiConfigSnapshot | "unsupported" | "invalid" {
	if (typeof response !== "object" || response === null) return "invalid";
	const remote = (response as { remote?: unknown }).remote;
	if (remote === undefined) return "unsupported";
	if (typeof remote !== "object" || remote === null) return "invalid";
	const snapshot = remote as Partial<RemotePiConfigSnapshot>;
	if (snapshot.kind !== "remote" || snapshot.file !== expected.file || snapshot.hostId !== expected.hostId) return "invalid";
	if (typeof snapshot.version !== "string" || typeof snapshot.sha256 !== "string" || typeof snapshot.data !== "object" || snapshot.data === null || !Array.isArray(snapshot.secrets)) return "invalid";
	return snapshot as RemotePiConfigSnapshot;
}

/** Extract the remote receipt from a save answer; a local DTO without remote means unsupported. */
export function readRemoteConfigWriteReceipt(response: unknown): RemotePiConfigWriteReceipt | "unsupported" | "invalid" {
	if (typeof response !== "object" || response === null) return "invalid";
	const remote = (response as { remote?: unknown }).remote;
	if (remote === undefined) return "unsupported";
	if (typeof remote !== "object" || remote === null) return "invalid";
	const receipt = remote as Partial<RemotePiConfigWriteReceipt>;
	if (receipt.kind !== "remote" || typeof receipt.version !== "string" || typeof receipt.sha256 !== "string" || typeof receipt.hostId !== "string" || !isPiConfigFileKey(receipt.file)) return "invalid";
	return receipt as RemotePiConfigWriteReceipt;
}
