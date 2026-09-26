/**
 * Reference-source registry for the cross-store host transaction design
 * (`docs/remote-host-cross-store-design.md` §4.1).
 *
 * Why this exists: `RemoteHostStore.retire` hard-deletes a profile once the reference set looks
 * empty, and a reference source that cannot be read must never be mistaken for "no references".
 * A bare `RemoteHostReferences` provider cannot express that, so every persistent `hostId` field
 * has to be registered here and the scan result has to carry `complete`.
 *
 * Failure semantics (stable codes, this module's whole vocabulary):
 * - a source that throws, reports `complete: false`, or returns a malformed scan makes the scan
 *   `complete: false` and lands in `unavailable`; `scan()` itself never throws for that;
 * - `asStoreReferences()` turns `complete: false` into `REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE`
 *   (fail closed) so `retire`/`updateDraft` refuse instead of deleting a referenced host;
 * - an empty registry refuses with `REMOTE_HOST_REFERENCE_SOURCE_MISSING`: "no source registered"
 *   is not the same statement as "nothing is referenced".
 */
import type { RemoteHostReferences } from "./RemoteHostStore";

/** Reference source classification; only used for diagnosis and audit. */
export type RemoteHostReferenceSource = "projects" | "sessions" | "host-profiles" | "runtime";

export type RemoteHostReferenceHit = {
	readonly source: RemoteHostReferenceSource;
	/** Record id (projectId / sessionId / hostId); report and per-record CAS only, never a path. */
	readonly recordId: string;
};

export type RemoteHostReferenceScan = {
	/** Every referenced hostId (conservative superset: over-reporting is safe, under-reporting is not). */
	readonly referencedHostIds: ReadonlySet<string>;
	/** Hit details for rebind record sets and repair reports. */
	readonly hits: readonly RemoteHostReferenceHit[];
	/**
	 * false = at least one source could not be read completely (corrupt file, needs-repair, timeout,
	 * unknown schema). Callers MUST treat that as "may still be referenced".
	 */
	readonly complete: boolean;
	/** Sources that could not be read, for stable codes and diagnostics. */
	readonly unavailable: readonly RemoteHostReferenceSource[];
};

export type RemoteHostReferenceProvider = {
	scan(): Promise<RemoteHostReferenceScan>;
	/** A source may declare that it structurally cannot hold references (e.g. ProjectStore pre-Phase 3). */
	readonly capability?: { readonly canHoldHostReferences: boolean };
};

/** Every source value the registry accepts; a new persistent hostId field must register one of these. */
export const HOST_REFERENCE_SOURCES: readonly RemoteHostReferenceSource[] = ["projects", "sessions", "host-profiles", "runtime"];

/** Stable codes owned by this module. Nothing else may leave it (no errno, no free text). */
export const HOST_REFERENCE_REGISTRY_CODES = ["REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE", "REMOTE_HOST_REFERENCE_SOURCE_MISSING", "REMOTE_HOST_REFERENCE_SOURCE_INVALID", "REMOTE_HOST_REFERENCE_SOURCE_DUPLICATE", "REMOTE_HOST_REFERENCE_SCAN_INVALID"] as const;

export type HostReferenceRegistryCode = (typeof HOST_REFERENCE_REGISTRY_CODES)[number];

const HOST_REFERENCE_CODE_SET: ReadonlySet<string> = new Set(HOST_REFERENCE_REGISTRY_CODES);
const HOST_REFERENCE_SOURCE_SET: ReadonlySet<string> = new Set(HOST_REFERENCE_SOURCES);

export function isHostReferenceRegistryCode(code: string): code is HostReferenceRegistryCode {
	return HOST_REFERENCE_CODE_SET.has(code);
}

const MAX_RECORD_ID_CHARS = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvider(value: unknown): value is RemoteHostReferenceProvider {
	return isRecord(value) && typeof value.scan === "function";
}

function isReferenceSource(value: unknown): value is RemoteHostReferenceSource {
	return typeof value === "string" && HOST_REFERENCE_SOURCE_SET.has(value);
}

function isRecordId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_RECORD_ID_CHARS && !/[\x00-\x1f\x7f]/.test(value);
}

/**
 * Read a `ReadonlySet<string>` without `instanceof`: the Node test harness loads this module into a
 * separate VM realm, where a `Set` built by a provider is not an instance of this realm's `Set`.
 * `size` is cross-checked after iteration so a set-like object that silently drops entries is treated
 * as unreadable instead of as an empty (i.e. "nothing is referenced") answer. Exported because the
 * rebind journal validates the same shape from its host port.
 */
export function readHostIdSet(value: unknown): Set<string> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	if (!("has" in value) || !("size" in value) || !("forEach" in value)) return undefined;
	if (typeof value.has !== "function" || typeof value.size !== "number" || typeof value.forEach !== "function") return undefined;
	const ids = new Set<string>();
	let malformed = false;
	value.forEach((entry: unknown) => {
		if (typeof entry !== "string" || entry.length === 0) malformed = true;
		else ids.add(entry);
	});
	if (malformed || ids.size !== value.size) return undefined;
	return ids;
}

type SourceScan = { readonly referencedHostIds: ReadonlySet<string>; readonly recordIds: readonly string[]; readonly complete: boolean };

/**
 * Strictly decode one source result. A provider that returns something else is not "empty", it is
 * unreadable: that must degrade to `complete: false` (fail closed), never to an empty reference set.
 */
function readProviderScan(value: unknown): SourceScan {
	if (!isRecord(value) || !Array.isArray(value.hits) || typeof value.complete !== "boolean") throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
	const referencedHostIds = readHostIdSet(value.referencedHostIds);
	if (referencedHostIds === undefined) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
	const recordIds: string[] = [];
	for (const hit of value.hits) {
		if (!isRecord(hit) || !isRecordId(hit.recordId)) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
		recordIds.push(hit.recordId);
	}
	return { referencedHostIds, recordIds, complete: value.complete };
}

type SourceOutcome = { readonly source: RemoteHostReferenceSource } & ({ readonly skipped: true } | { readonly failed: true } | { readonly scan: SourceScan });

/**
 * Aggregates every registered reference source. Registration is explicit: a persistent `hostId`
 * field that nobody registered is invisible here, which is why the design pairs this module with a
 * contract scan over the typed persistent structures.
 */
export class RemoteHostReferenceRegistry {
	private readonly providers = new Map<RemoteHostReferenceSource, RemoteHostReferenceProvider>();

	register(source: RemoteHostReferenceSource, provider: RemoteHostReferenceProvider): void {
		if (!isReferenceSource(source) || !isProvider(provider)) throw new Error("REMOTE_HOST_REFERENCE_SOURCE_INVALID");
		// Replacing a provider would silently drop the previous source's references.
		if (this.providers.has(source)) throw new Error("REMOTE_HOST_REFERENCE_SOURCE_DUPLICATE");
		this.providers.set(source, provider);
	}

	registeredSources(): readonly RemoteHostReferenceSource[] {
		return [...this.providers.keys()];
	}

	/**
	 * Scan all sources concurrently. A source that declares `canHoldHostReferences: false` is skipped
	 * entirely and does not affect `complete` (design §4.1 / Q6). A source that throws, or whose own
	 * scan is incomplete, marks the result incomplete but still contributes the ids it did report:
	 * a partial answer stays a conservative superset.
	 */
	async scan(): Promise<RemoteHostReferenceScan> {
		const entries = [...this.providers.entries()];
		const outcomes = await Promise.all(
			entries.map(async ([source, provider]): Promise<SourceOutcome> => {
				if (provider.capability?.canHoldHostReferences === false) return { source, skipped: true };
				try {
					return { source, scan: readProviderScan(await provider.scan()) };
				} catch {
					return { source, failed: true };
				}
			}),
		);
		const referencedHostIds = new Set<string>();
		const hits = new Map<string, RemoteHostReferenceHit>();
		const unavailable: RemoteHostReferenceSource[] = [];
		for (const outcome of outcomes) {
			if ("skipped" in outcome) continue;
			if ("failed" in outcome) {
				unavailable.push(outcome.source);
				continue;
			}
			for (const hostId of outcome.scan.referencedHostIds) referencedHostIds.add(hostId);
			for (const recordId of outcome.scan.recordIds) {
				// The registration is authoritative for the source label; a provider cannot re-label itself.
				hits.set(`${outcome.source}\u0000${recordId}`, { source: outcome.source, recordId });
			}
			if (!outcome.scan.complete) unavailable.push(outcome.source);
		}
		return {
			referencedHostIds,
			hits: [...hits.values()].sort(compareHits),
			// No registered source means nothing was proven, which is not the same as "nothing exists".
			complete: entries.length > 0 && unavailable.length === 0,
			unavailable,
		};
	}

	/**
	 * Single-host verdict. An incomplete scan reports `referenced: true` together with
	 * `complete: false`, because the design requires `complete: false` to be handled as "may still be
	 * referenced" — the safe answer must not be lost by a caller that only looks at `referenced`.
	 */
	async isReferenced(hostId: string): Promise<{ readonly referenced: boolean; readonly complete: boolean }> {
		const scan = await this.scan();
		return { referenced: !scan.complete || scan.referencedHostIds.has(hostId), complete: scan.complete };
	}

	/**
	 * Compatibility view for `RemoteHostStore`: the store keeps its narrow `RemoteHostReferences`
	 * shape, and every "we could not prove there is no reference" case surfaces as a hard failure.
	 */
	asStoreReferences(): RemoteHostReferences {
		if (this.providers.size === 0) throw new Error("REMOTE_HOST_REFERENCE_SOURCE_MISSING");
		return {
			referencedHostIds: async () => {
				// The store may hold this view for its whole lifetime, so re-check registration here too.
				if (this.providers.size === 0) throw new Error("REMOTE_HOST_REFERENCE_SOURCE_MISSING");
				const scan = await this.scan();
				if (!scan.complete) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE");
				return scan.referencedHostIds;
			},
		};
	}
}

function compareHits(left: RemoteHostReferenceHit, right: RemoteHostReferenceHit): number {
	const bySource = HOST_REFERENCE_SOURCES.indexOf(left.source) - HOST_REFERENCE_SOURCES.indexOf(right.source);
	if (bySource !== 0) return bySource;
	return left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0;
}
