/**
 * Rebind coordinator: the only place that turns "rebind source → target" into a journal and runs it
 * (`docs/rebind-ui-design.md` §3.2 / §4, design `remote-host-cross-store-design.md` §5.4).
 *
 * Why this module exists separately from `HostRebindJournal`:
 * - the journal owns the file, the lock-guarded `resume()` and the stable-code vocabulary;
 * - `HostRebindConvergence` owns the phased algorithm and the per-record authority;
 * - this module owns the **only** other piece: deciding *what* the transaction is. That means
 *   validating the pair, enumerating the records that actually point at the source (from the
 *   reference registry, which is also the retire gate), computing canonical before/after locators,
 *   and writing the journal before any host write (WAL).
 *
 * Everything here is main-only. The renderer never receives record ids, paths or pin bytes: `plan()`
 * returns counts and stable codes, `describePending()` returns stage + counts.
 */
import { randomUUID } from "node:crypto";
import { canonicalHostLocatorJson, isHostRebindCode, isHostRebindStorePortCode, type HostRebindHostPort, type HostRebindPorts, type HostRebindStorePort, type RebindJournal, type RebindOutcome, type RebindRecordPlan, type RebindStage } from "./HostRebindJournal";
import { convergeRebindJournal } from "./HostRebindConvergence";

/** Store names the journal accepts; a registry hit from any other source is not migratable. */
type RebindStoreName = "projects" | "sessions";

const STORE_NAMES: readonly RebindStoreName[] = ["projects", "sessions"];

/** Tx state the wizard shows in step ② (§4.3). Never carries pid / bootId / timestamps. */
export type RebindTxState = "idle" | "journal-present" | "busy" | "lock-unreadable";

/** Record list for one hostId, projected from the reference registry (never a second scan). */
export type RebindHostRecords = {
	readonly complete: boolean;
	readonly records: readonly { readonly store: RebindStoreName; readonly recordId: string }[];
};

/** What `plan()` may return to the caller (IPC-safe: counts and stable codes only). */
export type RebindPlanSummary = {
	readonly source: { readonly hostId: string; readonly disabled: boolean; readonly verified: boolean };
	readonly target: { readonly hostId: string; readonly disabled: boolean; readonly verified: boolean };
	readonly records: { readonly projects: number; readonly sessions: number };
	readonly referenceScan: { readonly complete: boolean; readonly count: number };
	readonly warnings: readonly string[];
	readonly tx: RebindTxState;
};

export type RebindPlanResult = { readonly summary: RebindPlanSummary; readonly journal: RebindJournal };

/** What the repair banner needs when a journal is left behind (§4.3). */
export type RebindPendingDescription =
	| { readonly present: false; readonly tx: RebindTxState }
	| {
			readonly present: true;
			readonly txId: string;
			readonly stage: RebindStage;
			readonly sourceHostId: string;
			readonly targetHostId: string;
			readonly records: { readonly projects: number; readonly sessions: number };
			readonly referenceScan: { readonly complete: boolean; readonly count: number };
			readonly tx: RebindTxState;
	  };

export type HostRebindCoordinatorDeps = {
	readonly host: HostRebindHostPort;
	readonly projects?: HostRebindStorePort;
	readonly sessions?: HostRebindStorePort;
	/** `RemoteHostReferenceRegistry.recordsOf` projection; only projects/sessions hits are returned. */
	listHostRecords(hostId: string): Promise<RebindHostRecords>;
	/** Tx lock acquisition; `undefined` means another live owner holds it (R4: give up, never wait). */
	acquireLock(): Promise<{ release(): Promise<void> } | undefined>;
	/** Current lock state, judged by the same rules as acquisition (StoreFileLock). */
	lockState(): Promise<"missing" | "live" | "stale" | "unreadable">;
	/** Journal file I/O, atomic replace (the coordinator writes the WAL). */
	readJournal(): Promise<RebindJournal | undefined>;
	writeJournal(journal: RebindJournal): Promise<void>;
	/** Drop the journal after the commit point; `resumePending` owns the same operation. */
	removeJournal(): Promise<void>;
	/** Resume path: journal read + lock + convergence (already implemented by the journal). */
	resumePending(ports: HostRebindPorts): Promise<RebindOutcome | undefined>;
	now?: () => number;
	newTxId?: () => string;
};

/** Errors this module raises on top of the journal vocabulary: nothing else may escape. */
function assertStable(error: unknown): never {
	const message = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : "";
	throw new Error(isHostRebindCode(message) || isHostRebindStorePortCode(message) ? message : "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable-code guard handed to the convergence module (same set the journal owns). */
const stableGuard = (code: string): boolean => isHostRebindCode(code) || isHostRebindStorePortCode(code);

/** Read a store's canonical locators and build one before/after plan per record (§4.4). */
async function planStore(store: RebindStoreName, recordIds: readonly string[], sourceHostId: string, targetHostId: string, port: HostRebindStorePort | undefined): Promise<RebindRecordPlan[]> {
	if (recordIds.length === 0) return [];
	if (port === undefined) throw new Error("REMOTE_HOST_REBIND_STORE_PORT_MISSING");
	const snapshots = await port.readHostRecordLocators(recordIds);
	if (!Array.isArray(snapshots)) throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
	const locators = new Map<string, string | undefined>();
	for (const snapshot of snapshots) {
		if (!isRecord(snapshot) || typeof snapshot.recordId !== "string") throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
		if (snapshot.locator !== undefined && typeof snapshot.locator !== "string") throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
		locators.set(snapshot.recordId, snapshot.locator as string | undefined);
	}
	const plans: RebindRecordPlan[] = [];
	for (const recordId of recordIds) {
		const before = locators.get(recordId);
		// INV-6: a record the plan named but the store no longer has is a refusal, never a rebuild.
		if (before === undefined) throw new Error("REMOTE_HOST_REBIND_RECORD_MISSING");
		let parsed: unknown;
		try {
			parsed = JSON.parse(before);
		} catch {
			throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
		}
		// The registry attributes the record to the source; a different locator means the plan is stale
		// or the record was attributed twice. Both are refusals (§7.1 Q16: this code needs a producer).
		if (!isRecord(parsed) || parsed.kind !== "ssh" || parsed.hostId !== sourceHostId) throw new Error("REMOTE_HOST_REBIND_ORIGIN_CONFLICT");
		const after = canonicalHostLocatorJson({ ...parsed, hostId: targetHostId });
		// A no-op patch is undecidable for convergence: refuse it here instead of writing it.
		if (after === before) throw new Error("REMOTE_HOST_REBIND_SAME_HOST");
		plans.push({ store, recordId, beforeLocator: before, afterLocator: after });
	}
	return plans;
}

/** Validate the pair and enumerate records; shared by `plan()` and `rebind()` (rebind re-runs it under the lock). */
async function buildJournal(deps: HostRebindCoordinatorDeps, sourceHostId: string, targetHostId: string): Promise<RebindPlanResult> {
	if (sourceHostId === targetHostId) throw new Error("REMOTE_HOST_REBIND_SAME_HOST");
	// Both stores are required by convergence; refuse before the WAL write so a half-assembled app can
	// never leave a journal it cannot converge.
	if (deps.projects === undefined || deps.sessions === undefined) throw new Error("REMOTE_HOST_REBIND_STORE_PORT_MISSING");
	const state = await deps.host.readHostState();
	const sourceProfile = state.profiles.find((profile) => profile.hostId === sourceHostId);
	const sourceRetired = state.retiredHostIds.includes(sourceHostId);
	if (sourceProfile === undefined && !sourceRetired) throw new Error("REMOTE_HOST_REBIND_SOURCE_MISSING");
	if (state.retiredHostIds.includes(targetHostId)) throw new Error("REMOTE_HOST_REBIND_TARGET_MISSING");
	const targetProfile = state.profiles.find((profile) => profile.hostId === targetHostId);
	if (targetProfile === undefined) throw new Error("REMOTE_HOST_REBIND_TARGET_MISSING");
	if (!targetProfile.verified) throw new Error("REMOTE_HOST_REBIND_TARGET_UNVERIFIED");
	// INV-3: the target anchor is re-verified from disk before planning, never inferred from the source.
	try {
		await deps.host.verifyTargetAnchor(targetHostId);
	} catch (error) {
		const message = isRecord(error) && typeof error.message === "string" ? error.message : "";
		if (message === "REMOTE_HOST_REBIND_TARGET_UNVERIFIED" || message === "REMOTE_HOST_REBIND_TARGET_MISSING") throw new Error(message);
		throw new Error("REMOTE_HOST_REBIND_TARGET_ANCHOR_UNREADABLE");
	}
	// The scan is also the retire gate: a plan built on an incomplete scan could miss a record.
	const scan = await deps.host.scanReferences();
	if (!scan.complete) throw new Error("REMOTE_HOST_REBIND_REFERENCE_SCAN_INCOMPLETE");
	const listed = await deps.listHostRecords(sourceHostId);
	if (!listed.complete) throw new Error("REMOTE_HOST_REBIND_REFERENCE_SCAN_INCOMPLETE");
	const recordIds: Record<RebindStoreName, string[]> = { projects: [], sessions: [] };
	for (const record of listed.records) recordIds[record.store].push(record.recordId);
	const records: RebindRecordPlan[] = [];
	for (const store of STORE_NAMES) records.push(...(await planStore(store, recordIds[store], sourceHostId, targetHostId, deps[store])));
	const now = deps.now?.() ?? Date.now();
	const journal: RebindJournal = {
		schemaVersion: 1,
		txId: (deps.newTxId ?? (() => randomUUID()))(),
		createdAt: new Date(now).toISOString(),
		stage: "prepared",
		// The digest fields are audit metadata; convergence only ever reads the hostIds. They stay empty
		// here rather than being derived from a second copy of the endpoint hashing rule.
		source: { hostId: sourceHostId, endpointDigest: "", disabled: sourceProfile?.disabled ?? false },
		target: { hostId: targetHostId, endpointDigest: "", knownHostsSha256: "" },
		expectedHostRevision: state.revision,
		records,
		referenceScan: { complete: true, count: scan.referencedHostIds.size },
	};
	return {
		summary: {
			source: { hostId: sourceHostId, disabled: sourceProfile?.disabled ?? false, verified: sourceProfile?.verified ?? false },
			target: { hostId: targetHostId, disabled: targetProfile.disabled, verified: targetProfile.verified },
			records: { projects: recordIds.projects.length, sessions: recordIds.sessions.length },
			referenceScan: { complete: true, count: journal.referenceScan.count },
			warnings: [],
			tx: await txState(deps),
		},
		journal,
	};
}

/** §4.3 tx 判定：journal 是否存在 + 锁由谁持有；只回四种稳定值。 */
async function txState(deps: HostRebindCoordinatorDeps): Promise<RebindTxState> {
	const lock = await deps.lockState();
	if (lock === "unreadable") return "lock-unreadable";
	if (lock === "live") return "busy";
	if (lock === "stale") return "journal-present";
	return (await deps.readJournal()) === undefined ? "idle" : "journal-present";
}

export function createHostRebindCoordinator(deps: HostRebindCoordinatorDeps) {
	const ports = (): HostRebindPorts => ({ host: deps.host, ...(deps.projects === undefined ? {} : { projects: deps.projects }), ...(deps.sessions === undefined ? {} : { sessions: deps.sessions }) });

	return {
		/** Read-only pre-check (step ②): validates the pair, enumerates records, writes nothing. */
		async plan(sourceHostId: string, targetHostId: string): Promise<RebindPlanResult> {
			try {
				return await buildJournal(deps, sourceHostId, targetHostId);
			} catch (error) {
				return assertStable(error);
			}
		},

		/**
		 * Execute (step ④). The plan is rebuilt inside the tx lock, then the journal is written before any
		 * host write: a failure from here on leaves a journal for `resumePendingRebind`.
		 *
		 * There is no cancel path after this call starts (F2: the host store has no enable).
		 */
		async rebind(sourceHostId: string, targetHostId: string): Promise<RebindOutcome> {
			let lock: { release(): Promise<void> } | undefined;
			try {
				lock = await deps.acquireLock();
			} catch (error) {
				return assertStable(error);
			}
			if (lock === undefined) throw new Error("REMOTE_HOST_REBIND_TX_BUSY");
			try {
				const { journal } = await buildJournal(deps, sourceHostId, targetHostId);
				await deps.writeJournal(journal);
				return await convergeRebindJournal({ write: deps.writeJournal, remove: deps.removeJournal }, journal, ports(), stableGuard);
			} catch (error) {
				return assertStable(error);
			} finally {
				await lock.release();
			}
		},

		/** Startup / banner recovery: idempotent, and `undefined` when there is no journal or a live owner. */
		async resumePendingRebind(): Promise<RebindOutcome | undefined> {
			try {
				return await deps.resumePending(ports());
			} catch (error) {
				return assertStable(error);
			}
		},

		/** What the repair banner needs: presence, stage and counts only (never record ids / paths). */
		async describePending(): Promise<RebindPendingDescription> {
			try {
				const journal = await deps.readJournal();
				const tx = await txState(deps);
				if (journal === undefined) return { present: false, tx };
				return {
					present: true,
					txId: journal.txId,
					stage: journal.stage,
					sourceHostId: journal.source.hostId,
					targetHostId: journal.target.hostId,
					records: {
						projects: journal.records.filter((record) => record.store === "projects").length,
						sessions: journal.records.filter((record) => record.store === "sessions").length,
					},
					referenceScan: { complete: journal.referenceScan.complete, count: journal.referenceScan.count },
					tx,
				};
			} catch (error) {
				return assertStable(error);
			}
		},
	};
}

export type HostRebindCoordinator = ReturnType<typeof createHostRebindCoordinator>;
