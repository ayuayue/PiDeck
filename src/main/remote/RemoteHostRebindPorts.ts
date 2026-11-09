/**
 * Production adapters for the rebind transaction ports (`HostRebindJournal.ts` §4.4).
 *
 * The journal/convergence modules deliberately know nothing about `RemoteHostStore`,
 * `SshHostPinStore` or the reference registry; they only call these port methods. This module is the
 * one place that maps their vocabulary onto the real stores:
 *
 * - `readHostState` projects the host snapshot into ids + booleans (no labels, no endpoints);
 * - `verifyTargetAnchor` re-reads the target pin from disk (INV-3) and never falls back to the source;
 * - `disableSource` / `retireSource` are idempotent and answer with the *re-read* revision, so a
 *   throw-after-commit inside the store is visible to the convergence roll-forward;
 * - `scanReferences` is the same registry scan the retire gate uses (single owner of "is it referenced");
 * - `listHostRecords` attributes registry hits to a source hostId (the planner needs records, not just ids).
 *
 * Every failure that leaves this module is a stable code from the journal / store / registry sets;
 * the convergence module folds anything else into `REMOTE_HOST_REBIND_UNKNOWN_OUTCOME`.
 */
import type { HostRebindHostPort, HostRebindHostState, HostRebindStorePort } from "./HostRebindJournal";
import type { RebindHostRecords } from "./HostRebindCoordinator";
import type { RemoteHostStoreState } from "./RemoteHostStore";
import type { RemoteHostProfile } from "./RemoteHostStoreCodec";
import type { SshHostPinStore } from "./SshHostPinStore";
import type { RemoteHostReferenceRegistry, RemoteHostReferenceSource } from "./RemoteHostReferenceRegistry";

type HostStoreView = {
	getSnapshot(): HostStoreStateView;
	disable(hostId: string, expectedRevision: number): Promise<unknown>;
	retire(hostId: string, expectedRevision: number): Promise<string>;
};

/**
 * The store surface this adapter needs, kept structural so tests can use a plain object. It is a
 * subset of `RemoteHostStore` and `RemoteHostStoreState`; no second truth is introduced.
 */
type HostStoreStateView = {
	readonly revision: number;
	readonly profiles: readonly Pick<RemoteHostProfile, "id" | "verifiedEndpoint" | "disabledAt">[];
	readonly retiredHostIds: readonly string[];
};

type PinStoreView = Pick<SshHostPinStore, "readPin">;
type RegistryView = Pick<RemoteHostReferenceRegistry, "scan" | "recordsOf">;

export type RemoteHostRebindPortDeps = {
	readonly store: HostStoreView;
	readonly pinStore: PinStoreView;
	readonly registry: RegistryView;
	readonly projects?: HostRebindStorePort;
	readonly sessions?: HostRebindStorePort;
};

export type RemoteHostRebindPorts = {
	readonly host: HostRebindHostPort;
	readonly projects?: HostRebindStorePort;
	readonly sessions?: HostRebindStorePort;
	/** Registry projection: only projects/sessions hits are migratable stores. */
	listHostRecords(hostId: string): Promise<RebindHostRecords>;
};

const MIGRATABLE_SOURCES: ReadonlySet<RemoteHostReferenceSource> = new Set(["projects", "sessions"]);

export function createRemoteHostRebindPorts(deps: RemoteHostRebindPortDeps): RemoteHostRebindPorts {
	const host: HostRebindHostPort = {
		async readHostState(): Promise<HostRebindHostState> {
			const snapshot = deps.store.getSnapshot();
			return {
				revision: snapshot.revision,
				profiles: snapshot.profiles.map((profile) => ({
					hostId: profile.id,
					// `disabled` is the tombstone flag; `verified` is the confirmed endpoint, not "recently used".
					disabled: profile.disabledAt !== undefined,
					verified: profile.verifiedEndpoint !== undefined,
				})),
				retiredHostIds: [...snapshot.retiredHostIds],
			};
		},

		async verifyTargetAnchor(hostId: string): Promise<void> {
			const profile = deps.store.getSnapshot().profiles.find((candidate) => candidate.id === hostId);
			if (profile === undefined) throw new Error("REMOTE_HOST_REBIND_TARGET_MISSING");
			if (profile.verifiedEndpoint === undefined) throw new Error("REMOTE_HOST_REBIND_TARGET_UNVERIFIED");
			// readPin re-hashes the file and compares it with the recorded endpoint; a mismatch is
			// `SSH_HOST_PIN_INVALID`, which convergence folds into TARGET_ANCHOR_UNREADABLE.
			await deps.pinStore.readPin(hostId, profile.verifiedEndpoint);
		},

		async disableSource(hostId: string, expectedRevision: number): Promise<number> {
			const snapshot = deps.store.getSnapshot();
			const profile = snapshot.profiles.find((candidate) => candidate.id === hostId);
			if (profile === undefined) {
				if (snapshot.retiredHostIds.includes(hostId)) return snapshot.revision;
				throw new Error("REMOTE_HOST_REBIND_SOURCE_MISSING");
			}
			if (profile.disabledAt !== undefined) return snapshot.revision;
			await deps.store.disable(hostId, expectedRevision);
			return deps.store.getSnapshot().revision;
		},

		async retireSource(hostId: string, expectedRevision: number): Promise<number> {
			await deps.store.retire(hostId, expectedRevision);
			return deps.store.getSnapshot().revision;
		},

		async scanReferences(): Promise<{ readonly complete: boolean; readonly referencedHostIds: ReadonlySet<string> }> {
			const scan = await deps.registry.scan();
			return { complete: scan.complete, referencedHostIds: scan.referencedHostIds };
		},
	};

	return {
		host,
		...(deps.projects === undefined ? {} : { projects: deps.projects }),
		...(deps.sessions === undefined ? {} : { sessions: deps.sessions }),
		async listHostRecords(hostId: string): Promise<RebindHostRecords> {
			const { complete, records } = await deps.registry.recordsOf(hostId);
			return {
				complete,
				records: records.filter((record) => MIGRATABLE_SOURCES.has(record.source)).map((record) => ({ store: record.source as "projects" | "sessions", recordId: record.recordId })),
			};
		},
	};
}

/** The store state shape stays in one owner (`RemoteHostStore`); this alias makes the subset explicit. */
export type RemoteHostRebindStoreSnapshot = Pick<RemoteHostStoreState, "revision" | "profiles" | "retiredHostIds">;
