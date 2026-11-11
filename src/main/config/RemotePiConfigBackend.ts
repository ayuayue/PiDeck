/**
 * RemotePiConfigBackend (plan §6.4.1, Batch A): the only main-side code that talks to the helper config scope.
 *
 * What it promises:
 * - one allowlisted file per call (models/settings/trust/mcp; never auth), addressed only by a verified host id. The renderer never
 *   supplies a path, and this module never touches the local ConfigManager, so a remote failure cannot fall
 *   back to local files or local credentials;
 * - every helper reply is re-validated here as untrusted data: version/sha256 shape, bounded data, a recursive
 *   secret scan proving that no plaintext sits at a secret position, and a secrets list recomputed from the
 *   sanitized data. A reply that fails re-validation is REMOTE_CONFIG_FILE_INVALID, never passed through;
 * - helper error codes are mapped into the shared REMOTE_CONFIG_* closed set (an old helper without the config
 *   methods answers METHOD_NOT_FOUND and becomes REMOTE_CONFIG_UNSUPPORTED, never a local read);
 * - writes are guarded by expectedVersion in the request and return only a small receipt: a receipt loss is
 *   RESULT_UNCONFIRMED (never retried here); a content/version conflict is VERSION_CONFLICT.
 *
 * The transport port is injected by main/index.ts (RemoteHostConnectionService.request on a ready host). Tests
 * inject a fake port; no method in this module starts a process or reads a file.
 */

import { REMOTE_CONFIG_CODES, isPiConfigFileKey, type PiConfigFileKey, type RemotePiConfigSecretEntry, type RemotePiConfigSnapshot, type RemotePiConfigWriteReceipt } from "../../shared/piConfig";
import { REMOTE_CONFIG_MAX_DEPTH, REMOTE_CONFIG_MAX_FILE_BYTES, REMOTE_CONFIG_MAX_NODES, REMOTE_CONFIG_SECRET_KEY_PATTERN } from "../remote/RemoteHelperContract";
import { PROJECT_HOST_ID_PATTERN } from "../../shared/projectLocation";

export type RemotePiConfigTransportPort = {
	/** Send one helper request on an already-ready host; rethrows the transport's structured error. */
	request(hostId: string, method: string, params: unknown): Promise<unknown>;
};

export type RemotePiConfigBackend = {
	read(input: { hostId: string; file: PiConfigFileKey }): Promise<RemotePiConfigSnapshot>;
	patch(input: { hostId: string; file: PiConfigFileKey; expectedVersion: string; patch: Record<string, unknown> }): Promise<RemotePiConfigWriteReceipt>;
};

const HELPER_METHOD_READ = "config.read";
const HELPER_METHOD_PATCH = "config.patch";
const HEX64 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stable(code: string): Error {
	return new Error(code);
}

function errorCode(error: unknown): string | undefined {
	if (isRecord(error)) {
		if (typeof error.code === "string") return error.code;
		if (typeof error.message === "string") return error.message;
	}
	return undefined;
}

/**
 * Helper/transport code -> shared closed code. The connection layer's own stable codes are all retryable by
 * reconnecting, so they collapse to HOST_NOT_READY; an unknown helper failure stays UNAVAILABLE (never leaks
 * the raw code/message across IPC).
 */
function mapHelperCode(code: string | undefined): string {
	switch (code) {
		case "CONFIG_FILE_INVALID":
		case "CONFIG_FILE_TOO_LARGE":
		case "CONFIG_PATH_UNSUPPORTED":
			return REMOTE_CONFIG_CODES.fileInvalid;
		case "CONFIG_VERSION_CONFLICT":
			return REMOTE_CONFIG_CODES.versionConflict;
		case "CONFIG_RESULT_UNCONFIRMED":
			return REMOTE_CONFIG_CODES.resultUnconfirmed;
		case "CONFIG_UNAVAILABLE":
			return REMOTE_CONFIG_CODES.unavailable;
		case "METHOD_NOT_FOUND":
			return REMOTE_CONFIG_CODES.unsupported;
		case "SSH_HOST_NOT_READY":
		case "SSH_HOST_DISCONNECTED":
		case "REMOTE_CONNECTION_SERVICE_DISPOSED":
		case "REMOTE_CONNECTION_LOST":
		case "REQUEST_TIMEOUT":
		case "REQUEST_CANCELLED":
			return REMOTE_CONFIG_CODES.hostNotReady;
		default:
			return REMOTE_CONFIG_CODES.unavailable;
	}
}

/** Read the ordered secret list out of sanitized data, rejecting any value that is neither status string. */
function collectSecrets(data: Record<string, unknown>): RemotePiConfigSecretEntry[] {
	const secrets: RemotePiConfigSecretEntry[] = [];
	const budget = { nodes: 0 };
	function walk(value: unknown, prefix: string, depth: number): void {
		if (depth > REMOTE_CONFIG_MAX_DEPTH) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
		budget.nodes += 1;
		if (budget.nodes > REMOTE_CONFIG_MAX_NODES) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
		if (Array.isArray(value)) {
			value.forEach((entry, index) => walk(entry, prefix === "" ? String(index) : prefix + "." + index, depth + 1));
			return;
		}
		if (!isRecord(value)) return;
		for (const key of Object.keys(value)) {
			const child = prefix === "" ? key : prefix + "." + key;
			if (REMOTE_CONFIG_SECRET_KEY_PATTERN.test(key)) {
				if (value[key] !== "configured" && value[key] !== "missing") throw stable(REMOTE_CONFIG_CODES.fileInvalid);
				secrets.push({ path: child, status: value[key] });
				continue;
			}
			walk(value[key], child, depth + 1);
		}
	}
	walk(data, "", 0);
	secrets.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	return secrets;
}

function validateSnapshot(file: PiConfigFileKey, hostId: string, result: unknown): RemotePiConfigSnapshot {
	if (!isRecord(result)) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
	const version = result.version;
	const sha256 = result.sha256;
	if (typeof version !== "string" || !HEX64.test(version) || typeof sha256 !== "string" || !HEX64.test(sha256) || version !== sha256) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
	const data = result.data;
	if (!isRecord(data)) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
	const serialized = JSON.stringify(data);
	if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > REMOTE_CONFIG_MAX_FILE_BYTES) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
	if (file === "models" && !isRecord(data.providers)) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
	// Same shape rule the frozen scope enforces before it activates a write: an array/string mcpServers breaks pi.
	if (file === "mcp" && data.mcpServers !== undefined && !isRecord(data.mcpServers)) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
	const secrets = collectSecrets(data);
	const supplied = result.secrets;
	if (!Array.isArray(supplied)) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
	const normalized = supplied.map((entry) => {
		if (!isRecord(entry) || typeof entry.path !== "string" || (entry.status !== "configured" && entry.status !== "missing")) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
		return { path: entry.path, status: entry.status };
	});
	if (JSON.stringify(normalized) !== JSON.stringify(secrets)) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
	return { kind: "remote", hostId, file, version, sha256, data, secrets };
}

const MAX_PATCH_NODES = REMOTE_CONFIG_MAX_NODES;

/** Main-side patch bounds checked before the request; the helper repeats them as its own literal set. */
function validatePatch(patch: Record<string, unknown>): void {
	let nodes = 0;
	function walk(value: unknown, depth: number): void {
		if (depth > REMOTE_CONFIG_MAX_DEPTH) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
		nodes += 1;
		if (nodes > MAX_PATCH_NODES) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
		if (Array.isArray(value)) {
			for (const entry of value) walk(entry, depth + 1);
			return;
		}
		if (!isRecord(value)) return;
		for (const key of Object.keys(value)) {
			// Prototype pollution defense in depth: the helper refuses these too, but the host round-trip is not
			// the right place to discover it.
			if (key === "__proto__" || key === "constructor" || key === "prototype") throw stable(REMOTE_CONFIG_CODES.fileInvalid);
			walk(value[key], depth + 1);
		}
	}
	walk(patch, 0);
	const serialized = JSON.stringify(patch);
	if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > REMOTE_CONFIG_MAX_FILE_BYTES) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
}

export function createRemotePiConfigBackend(transport: RemotePiConfigTransportPort): RemotePiConfigBackend {
	if (!isRecord(transport) || typeof transport.request !== "function") throw stable(REMOTE_CONFIG_CODES.unavailable);

	async function call(hostId: string, method: string, params: unknown): Promise<unknown> {
		if (typeof hostId !== "string" || !PROJECT_HOST_ID_PATTERN.test(hostId)) throw stable(REMOTE_CONFIG_CODES.targetInvalid);
		try {
			return await transport.request(hostId, method, params);
		} catch (error) {
			throw stable(mapHelperCode(errorCode(error)));
		}
	}

	return {
		async read(input) {
			if (!isPiConfigFileKey(input.file)) throw stable(REMOTE_CONFIG_CODES.targetInvalid);
			return validateSnapshot(input.file, input.hostId, await call(input.hostId, HELPER_METHOD_READ, { file: input.file }));
		},
		async patch(input) {
			if (!isPiConfigFileKey(input.file)) throw stable(REMOTE_CONFIG_CODES.targetInvalid);
			if (typeof input.expectedVersion !== "string" || !HEX64.test(input.expectedVersion)) throw stable(REMOTE_CONFIG_CODES.versionConflict);
			if (!isRecord(input.patch)) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
			validatePatch(input.patch);
			const result = await call(input.hostId, HELPER_METHOD_PATCH, { file: input.file, expectedVersion: input.expectedVersion, patch: input.patch });
			const snapshot = validateSnapshot(input.file, input.hostId, result);
			return { kind: "remote", hostId: snapshot.hostId, file: snapshot.file, version: snapshot.version, sha256: snapshot.sha256 };
		},
	};
}
