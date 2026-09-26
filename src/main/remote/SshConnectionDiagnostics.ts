import type { RemoteHostConnectionState, SshConnectionDiagnostic, SshConnectionPhase } from "./RemoteHostConnectionTypes";

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Diagnostics are only allowed to carry stable, enumerable codes; free text is never persisted.
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATES: readonly RemoteHostConnectionState[] = ["disconnected", "connecting", "probing", "bootstrapping", "ready", "degraded", "reconnecting", "offline", "needs-attention"];
const PHASES: readonly SshConnectionPhase[] = ["openssh", "authenticate", "platform", "node", "helper", "pi"];
const DEFAULT_HISTORY_LIMIT = 200;
const MAX_HISTORY_LIMIT = 2000;

function invalidDiagnostic(): never {
	throw new Error("SSH_DIAGNOSTIC_INVALID");
}

/** `toISOString` throws on an out-of-range date, so normalize that into the module's own error. */
function canonicalIso(value: string): boolean {
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

/**
 * Build a redacted diagnostic record. Anything that is not an enumerable state/phase/code pair is
 * rejected outright, so command lines, identity paths, ProxyCommand text and response bodies can
 * never be smuggled into the history through a mis-typed field.
 */
export function createConnectionDiagnostic(input: SshConnectionDiagnostic): SshConnectionDiagnostic {
	if (!input || typeof input !== "object") invalidDiagnostic();
	if (typeof input.hostId !== "string" || !HOST_ID.test(input.hostId)) invalidDiagnostic();
	if (!Number.isSafeInteger(input.generation) || input.generation < 0) invalidDiagnostic();
	if (!STATES.includes(input.state)) invalidDiagnostic();
	if (!PHASES.includes(input.phase)) invalidDiagnostic();
	if (typeof input.code !== "string" || !CODE.test(input.code)) invalidDiagnostic();
	if (typeof input.at !== "string" || !ISO.test(input.at) || !canonicalIso(input.at)) invalidDiagnostic();
	if (input.exitCode !== undefined && (!Number.isSafeInteger(input.exitCode) || input.exitCode < -1 || input.exitCode > 255)) invalidDiagnostic();
	return { hostId: input.hostId, generation: input.generation, state: input.state, phase: input.phase, code: input.code, at: input.at, ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}) };
}

/**
 * Map an arbitrary thrown value to a diagnostic code. Unknown text is collapsed to a generic code
 * so a stray error message (which may embed a path or a command line) cannot reach the log.
 */
export function diagnosticCodeFromError(error: unknown): string {
	// Duck-typed instead of `instanceof Error`: errors can cross realm boundaries, where instanceof
	// silently fails and would degrade every code to the generic fallback.
	const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
	return typeof message === "string" && CODE.test(message) ? message : "SSH_CONNECTION_FAILED";
}

/** Bounded, per-host diagnostic history; the oldest entry is dropped once the limit is reached. */
export function createDiagnosticHistory(options: { limit?: number } = {}): { record(input: SshConnectionDiagnostic): void; list(hostId?: string): SshConnectionDiagnostic[]; clear(): void } {
	const limit = Math.min(Math.max(options.limit ?? DEFAULT_HISTORY_LIMIT, 1), MAX_HISTORY_LIMIT);
	const entries: SshConnectionDiagnostic[] = [];
	return {
		record(input) {
			entries.push(createConnectionDiagnostic(input));
			// Keep the newest `limit` records; older history is intentionally discarded, never truncated
			// in place, so a partially written record can never be observed.
			while (entries.length > limit) entries.shift();
		},
		list(hostId) {
			const filtered = hostId === undefined ? entries : entries.filter((entry) => entry.hostId === hostId);
			return filtered.map((entry) => ({ ...entry }));
		},
		clear() {
			entries.length = 0;
		},
	};
}

/** Compact single line for main-process logs; contains only ids, phases and codes. */
export function formatConnectionDiagnostic(entry: SshConnectionDiagnostic): string {
	const diagnostic = createConnectionDiagnostic(entry);
	const exit = diagnostic.exitCode === undefined ? "" : ` exit=${diagnostic.exitCode}`;
	return `ssh host=${diagnostic.hostId} gen=${diagnostic.generation} phase=${diagnostic.phase} state=${diagnostic.state} code=${diagnostic.code}${exit} at=${diagnostic.at}`;
}
