import { isAbsolute } from "node:path";
import type { RemoteProjectSession } from "./RemoteHostConnectionService";
import type { RemoteSftpCapabilityCache, RemoteSftpCapabilityKey, RemoteSftpProbeResult } from "./RemoteSftpCapabilityCache";
import { REMOTE_SFTP_PROTOCOL_VERSION, runRemoteSftpJob, type RemoteSftpJobInput, type RemoteSftpProbe } from "./RemoteSftpAdapter";

/**
 * One SFTP probe is only evidence for the exact helper connection and binary
 * identity on which it ran. The cache records positive results for that
 * generation and gives failures a short retry window.
 */

export const REMOTE_SFTP_CAPABILITY_PROBE_CODES = {
	inputInvalid: "REMOTE_SFTP_PROBE_INPUT_INVALID",
	subsystemUnavailable: "REMOTE_SFTP_SUBSYSTEM_UNAVAILABLE",
	probeInvalid: "REMOTE_SFTP_PROBE_INVALID",
	probeFailed: "REMOTE_SFTP_PROBE_FAILED",
} as const;

const CANCELLED = "SFTP_JOB_CANCELLED";
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const INVALID_SOURCE_CODES = new Set(["SFTP_PROTOCOL_VERSION_UNSUPPORTED", "SFTP_REQUEST_INVALID", "SFTP_REQUEST_WRITE_FAILED", "SFTP_RESULT_INVALID", "SFTP_OUTPUT_TOO_LARGE"]);

export type RemoteSftpProbeSession = Pick<RemoteProjectSession, "hostId" | "hostRevision" | "connectionId" | "withSftpInvocation">;

export type RemoteSftpCapabilityProbeInput = {
	/** The already-verified canonical project root; never renderer input. */
	readonly canonicalRoot: string;
	readonly binaryPath: string;
	readonly binaryIdentity: string;
	readonly session: RemoteSftpProbeSession;
	readonly cache: RemoteSftpCapabilityCache<RemoteSftpProbe>;
	readonly signal?: AbortSignal;
};

export type RemoteSftpCapabilityProbe = {
	ensureProbe(input: RemoteSftpCapabilityProbeInput): Promise<RemoteSftpProbeResult<RemoteSftpProbe>>;
};

export type RemoteSftpCapabilityProbeDependencies = {
	readonly adapter?: typeof runRemoteSftpJob;
};

type ValidInput = {
	readonly canonicalRoot: string;
	readonly binaryPath: string;
	readonly binaryIdentity: string;
	readonly session: RemoteSftpProbeSession;
	readonly cache: RemoteSftpCapabilityCache<RemoteSftpProbe>;
	readonly key: RemoteSftpCapabilityKey;
	readonly signal?: AbortSignal;
};

type InternalOutcome = { readonly kind: "result"; readonly result: RemoteSftpProbeResult<RemoteSftpProbe> };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maximum && !CONTROL.test(value);
}

function validCanonicalRoot(value: unknown): value is string {
	if (!validText(value, 4096) || !value.startsWith("/")) return false;
	if (value === "/") return true;
	return value
		.slice(1)
		.split("/")
		.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function validIdentity(value: unknown): value is string {
	return validText(value, 512);
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function readInput(value: unknown): ValidInput | undefined {
	if (!isRecord(value)) return undefined;
	const session = value.session;
	const cache = value.cache;
	if (!isRecord(session) || typeof session.withSftpInvocation !== "function") return undefined;
	if (!isRecord(cache) || typeof cache.get !== "function" || typeof cache.set !== "function") return undefined;
	if (!validText(session.hostId, 128) || !Number.isSafeInteger(session.hostRevision) || (session.hostRevision as number) < 0 || !validText(session.connectionId, 512)) return undefined;
	if (!validCanonicalRoot(value.canonicalRoot) || !validIdentity(value.binaryIdentity)) return undefined;
	if (typeof value.binaryPath !== "string" || !isAbsolute(value.binaryPath)) return undefined;
	if (value.signal !== undefined && !isRecord(value.signal)) return undefined;
	const signal = value.signal as AbortSignal | undefined;
	if (signal !== undefined && (typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) return undefined;
	return {
		canonicalRoot: value.canonicalRoot,
		binaryPath: value.binaryPath,
		binaryIdentity: value.binaryIdentity,
		session: session as RemoteSftpProbeSession,
		cache: cache as RemoteSftpCapabilityCache<RemoteSftpProbe>,
		key: {
			hostId: session.hostId,
			canonicalRoot: value.canonicalRoot,
			connectionId: session.connectionId,
			hostRevision: session.hostRevision as number,
			binaryIdentity: value.binaryIdentity,
		},
		...(signal === undefined ? {} : { signal }),
	};
}

function stableCodeOf(error: unknown): string | undefined {
	if (!isRecord(error) && !(error instanceof Error)) return undefined;
	const attached = isRecord(error) && typeof error.code === "string" && STABLE_CODE.test(error.code) ? error.code : undefined;
	if (attached !== undefined) return attached;
	if (!(error instanceof Error)) return undefined;
	const message = error.message.trim();
	return STABLE_CODE.test(message) ? message : undefined;
}

function normalizeFailureCode(code: unknown): string {
	if (typeof code !== "string") return REMOTE_SFTP_CAPABILITY_PROBE_CODES.probeInvalid;
	if (code === "SFTP_SUBSYSTEM_UNAVAILABLE") return REMOTE_SFTP_CAPABILITY_PROBE_CODES.subsystemUnavailable;
	if (INVALID_SOURCE_CODES.has(code)) return REMOTE_SFTP_CAPABILITY_PROBE_CODES.probeInvalid;
	return STABLE_CODE.test(code) ? code : REMOTE_SFTP_CAPABILITY_PROBE_CODES.probeInvalid;
}

function readProbe(value: unknown, expectedRoot: string): RemoteSftpProbe | undefined {
	if (!isRecord(value) || value.protocolVersion !== REMOTE_SFTP_PROTOCOL_VERSION || value.root !== expectedRoot || !isRecord(value.extensions)) return undefined;
	const extensions: Record<string, string> = {};
	for (const [key, item] of Object.entries(value.extensions)) {
		if (!validText(key, 256) || !validText(item, 256)) return undefined;
		extensions[key] = item;
	}
	if (value.home !== undefined && !validText(value.home, 4096)) return undefined;
	return {
		protocolVersion: value.protocolVersion,
		root: expectedRoot,
		extensions,
		...(value.home === undefined ? {} : { home: value.home }),
	};
}

function readCachedOutcome(input: ValidInput): RemoteSftpProbeResult<RemoteSftpProbe> | undefined {
	let hit: ReturnType<RemoteSftpCapabilityCache<RemoteSftpProbe>["get"]>;
	try {
		hit = input.cache.get(input.key);
	} catch {
		return undefined;
	}
	if (hit === undefined) return undefined;
	if (hit.kind === "positive") {
		const value = readProbe(hit.value, input.canonicalRoot);
		return value === undefined ? undefined : { ok: true, value };
	}
	if (!STABLE_CODE.test(hit.code) || hit.code === CANCELLED) return undefined;
	return { ok: false, code: normalizeFailureCode(hit.code) };
}

function writeCache(input: ValidInput, result: RemoteSftpProbeResult<RemoteSftpProbe>): void {
	try {
		input.cache.set(input.key, result);
	} catch {
		// Cache failure changes latency, never the proof produced by this probe.
	}
}

function finishFailure(input: ValidInput, code: string): InternalOutcome {
	if (code !== CANCELLED) writeCache(input, { ok: false, code });
	return { kind: "result", result: { ok: false, code } };
}

function finishProbeResult(input: ValidInput, raw: unknown): InternalOutcome {
	if (!isRecord(raw)) return finishFailure(input, REMOTE_SFTP_CAPABILITY_PROBE_CODES.probeInvalid);
	if (raw.ok === false) {
		if (typeof raw.code !== "string" || !STABLE_CODE.test(raw.code)) return finishFailure(input, REMOTE_SFTP_CAPABILITY_PROBE_CODES.probeInvalid);
		return finishFailure(input, normalizeFailureCode(raw.code));
	}
	if (raw.ok !== true || raw.operation !== "probe") return finishFailure(input, REMOTE_SFTP_CAPABILITY_PROBE_CODES.probeInvalid);
	const value = readProbe(raw.value, input.canonicalRoot);
	if (value === undefined) return finishFailure(input, REMOTE_SFTP_CAPABILITY_PROBE_CODES.probeInvalid);
	const result: RemoteSftpProbeResult<RemoteSftpProbe> = { ok: true, value };
	writeCache(input, result);
	return { kind: "result", result };
}

export function createRemoteSftpCapabilityProbe(dependencies: RemoteSftpCapabilityProbeDependencies = {}): RemoteSftpCapabilityProbe {
	const adapter = dependencies.adapter ?? runRemoteSftpJob;
	return {
		async ensureProbe(rawInput): Promise<RemoteSftpProbeResult<RemoteSftpProbe>> {
			const input = readInput(rawInput);
			if (input === undefined) return { ok: false, code: REMOTE_SFTP_CAPABILITY_PROBE_CODES.inputInvalid };
			const cached = readCachedOutcome(input);
			if (cached !== undefined) return cached;
			if (isAborted(input.signal)) return { ok: false, code: CANCELLED };

			let outcome: InternalOutcome;
			try {
				outcome = await input.session.withSftpInvocation(async (invocation, assertCurrent): Promise<InternalOutcome> => {
					await assertCurrent();
					if (isAborted(input.signal)) return { kind: "result", result: { ok: false, code: CANCELLED } };
					const job: RemoteSftpJobInput = {
						operation: "probe",
						invocation,
						root: input.canonicalRoot,
					};
					let rawResult: unknown;
					let adapterError: unknown;
					let threw = false;
					try {
						rawResult = await adapter(input.binaryPath, job, input.signal === undefined ? {} : { signal: input.signal });
					} catch (error) {
						threw = true;
						adapterError = error;
					}
					// The generation is rechecked even for a malformed result or a thrown adapter:
					// a probe that crossed a reconnect is not evidence for either generation.
					await assertCurrent();
					if (isAborted(input.signal)) return { kind: "result", result: { ok: false, code: CANCELLED } };
					if (threw) return finishFailure(input, normalizeFailureCode(stableCodeOf(adapterError) ?? REMOTE_SFTP_CAPABILITY_PROBE_CODES.probeFailed));
					return finishProbeResult(input, rawResult);
				});
			} catch (error) {
				const code = stableCodeOf(error);
				if (code !== undefined) return { ok: false, code: normalizeFailureCode(code) };
				return { ok: false, code: REMOTE_SFTP_CAPABILITY_PROBE_CODES.probeFailed };
			}
			return outcome.result;
		},
	};
}
