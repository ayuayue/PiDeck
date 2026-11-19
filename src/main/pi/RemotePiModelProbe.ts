/**
 * RemotePiModelProbe (Phase 5 row 819): host-executed, masked provider model catalog.
 *
 * v1 semantics: the catalog is the live remote pi runtime's own get_available_models answer. It runs on the
 * target host with the host's credentials and network, exactly like the host's model picker; the only thing
 * that crosses back is the masked allowlist below. The per-provider synthetic HTTP probe is explicitly NOT
 * part of v1 (arbitrary URL/header templates), so "connection test" means "a live remote pi answered".
 *
 * Trust boundary:
 * - renderer input is only hostId; a malformed host id returns TARGET_INVALID before any dependency call;
 * - host -> project ids comes from ProjectStore through an injected closure; project ids are never renderer
 *   supplied. The injected finder returns only an agentId for an already-live remote runtime; this module
 *   never enumerates or exposes runtimes, sessions, paths or process handles;
 * - exactly one bounded attempt (60s by default), no retry on any failure;
 * - every failure is one of the six closed codes; runtime/project errors never leak free text.
 */
import { REMOTE_MODEL_PROBE_CODES, REMOTE_MODEL_PROBE_MAX_MODELS, REMOTE_MODEL_PROBE_TIMEOUT_MS, type RemoteModelCatalogEntry, type RemoteModelProbeResult } from "../../shared/types/remoteModel";
import { PROJECT_HOST_ID_PATTERN } from "../../shared/projectLocation";

export type RemotePiModelProbeDeps = {
	/** Remote projects of one host, from ProjectStore (main-side authority; never renderer input). */
	projectIdsForHost: (hostId: string) => readonly string[];
	/** Narrow AgentManager finder: returns only the agentId of an already-live remote runtime. */
	findLiveAgentId: (projectIds: readonly string[]) => string | undefined;
	/** Existing AgentManager.getAvailableModels(agentId) RPC path (one bounded request internally). */
	getAvailableModels: (agentId: string) => Promise<unknown>;
	/** Clock injection for deterministic tests; defaults to Date.now. */
	now?: () => number;
	/** Test seam only; production keeps the frozen 60s budget. */
	timeoutMs?: number;
};

export type RemotePiModelProbe = { probe: (hostId: unknown) => Promise<RemoteModelProbeResult> };

const MAX_ID_LENGTH = 512;
const MAX_PROVIDER_LENGTH = 256;
const MAX_NAME_LENGTH = 512;
const MAX_TOKEN_NUMBER = 100_000_000;
const CONTROL = /[\u0000-\u001f\u007f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stable(code: string): Error {
	return new Error(code);
}

function readBoundedString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > maxLength || CONTROL.test(trimmed)) return undefined;
	return trimmed;
}

function readTokenCount(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_TOKEN_NUMBER) return undefined;
	return Math.floor(value);
}

function readInput(value: unknown): Array<"text" | "image"> | undefined {
	if (!Array.isArray(value)) return undefined;
	const result: Array<"text" | "image"> = [];
	for (const entry of value) {
		if (entry !== "text" && entry !== "image") return undefined;
		if (!result.includes(entry)) result.push(entry);
	}
	return result;
}

/** Allowlist mask: only the documented model-picker fields survive; unknown/secret fields are dropped. */
function maskEntry(raw: unknown): RemoteModelCatalogEntry | undefined {
	if (!isRecord(raw)) return undefined;
	const id = readBoundedString(raw.id, MAX_ID_LENGTH);
	const provider = readBoundedString(raw.provider, MAX_PROVIDER_LENGTH);
	if (id === undefined || provider === undefined) return undefined;
	const entry: RemoteModelCatalogEntry = { id, provider };
	const name = readBoundedString(raw.name, MAX_NAME_LENGTH);
	if (name !== undefined) entry.name = name;
	const contextWindow = readTokenCount(raw.contextWindow);
	if (contextWindow !== undefined) entry.contextWindow = contextWindow;
	const maxTokens = readTokenCount(raw.maxTokens);
	if (maxTokens !== undefined) entry.maxTokens = maxTokens;
	if (typeof raw.reasoning === "boolean") entry.reasoning = raw.reasoning;
	const input = readInput(raw.input);
	if (input !== undefined) entry.input = input;
	if (typeof raw.images === "boolean") entry.images = raw.images;
	return entry;
}

/** Both host CLI and live-runtime answers cross the same bounded allowlist. */
export function maskRemoteModelCatalog(hostId: string, raw: unknown, at = Date.now()): RemoteModelProbeResult {
	if (!Array.isArray(raw)) return { ok: false, code: REMOTE_MODEL_PROBE_CODES.failed };
	if (raw.length === 0) return { ok: false, code: REMOTE_MODEL_PROBE_CODES.empty };
	const unique = new Map<string, RemoteModelCatalogEntry>();
	for (const candidate of raw) {
		const entry = maskEntry(candidate);
		if (entry && !unique.has(`${entry.provider}\u0000${entry.id}`)) unique.set(`${entry.provider}\u0000${entry.id}`, entry);
		if (unique.size === REMOTE_MODEL_PROBE_MAX_MODELS) break;
	}
	const models = [...unique.values()].sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id));
	if (!models.length) return { ok: false, code: REMOTE_MODEL_PROBE_CODES.failed };
	return { ok: true, hostId, models, providers: [...new Set(models.map((model) => model.provider))].sort(), count: models.length, at };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(stable(REMOTE_MODEL_PROBE_CODES.failed)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export function createRemotePiModelProbe(deps: RemotePiModelProbeDeps): RemotePiModelProbe {
	const timeoutMs = deps.timeoutMs ?? REMOTE_MODEL_PROBE_TIMEOUT_MS;
	return {
		async probe(hostId: unknown): Promise<RemoteModelProbeResult> {
			// Boundary validation first: invalid input must perform zero project/agent/runtime work.
			if (typeof hostId !== "string" || hostId.length > 64 || !PROJECT_HOST_ID_PATTERN.test(hostId)) return { ok: false, code: REMOTE_MODEL_PROBE_CODES.targetInvalid };

			let projectIds: readonly string[];
			try {
				projectIds = deps.projectIdsForHost(hostId);
			} catch {
				return { ok: false, code: REMOTE_MODEL_PROBE_CODES.unavailable };
			}
			if (!Array.isArray(projectIds) || projectIds.length === 0) return { ok: false, code: REMOTE_MODEL_PROBE_CODES.noProject };

			const agentId = deps.findLiveAgentId(projectIds);
			if (typeof agentId !== "string" || agentId.length === 0) return { ok: false, code: REMOTE_MODEL_PROBE_CODES.noRuntime };

			let raw: unknown;
			try {
				raw = await withTimeout(deps.getAvailableModels(agentId), timeoutMs);
			} catch {
				// Single attempt, no retry: RPC error and timeout are both a definite probe failure.
				return { ok: false, code: REMOTE_MODEL_PROBE_CODES.failed };
			}
			return maskRemoteModelCatalog(hostId, raw, deps.now ? deps.now() : Date.now());
		},
	};
}
