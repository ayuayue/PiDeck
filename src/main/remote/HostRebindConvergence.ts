/**
 * Crash convergence for the cross-store host rebind transaction
 * (`docs/remote-host-cross-store-design.md` §4.3, §5.4, §5.1 R6).
 *
 * The journal is a write-ahead hint, not the source of truth: the authoritative progress signal is
 * the per-record `beforeLocator` / `afterLocator` comparison against what the stores actually hold,
 * so a stale or missing `stage` can never cause a wrong action (design §4.3).
 *
 * Owns:
 * - the phased algorithm `HostRebindJournal.resume()` runs while holding the tx lock: target anchor →
 *   disable source → per-store migration → reference scan → retire → commit, with each stage written
 *   *before* that step executes;
 * - the two per-record decisions as pure, directly testable functions: `classifyRebindRecord`
 *   (done / pending / missing / stale plan) and `classifyRebindResult` (applied / already-applied /
 *   missing / changed / unknown);
 * - the port-output boundary: the record-id and locator bounds (`isRebindRecordId` /
 *   `isRebindLocator`) and the decoding of what `readHostState` / `scanReferences` /
 *   `readHostRecordLocators` / `applyHostRebind` return.
 *
 * Does not own:
 * - the journal file itself: no atomic replace, no `.bak`, no path layout. The algorithm only calls
 *   the `RebindJournalIo` operations it is handed, and the tx lock is already held by the caller;
 * - the stable-code vocabulary: the journal module owns `HOST_REBIND_CODES` /
 *   `HOST_REBIND_STORE_PORT_CODES` and hands its predicate in, so this module carries no second copy
 *   of those lists (and no import cycle forms: the journal imports this module, never the reverse);
 * - what "disabled" / "retired" mean in the host store, and how a store writes a record. This module
 *   only asks the ports to act and re-reads the store to decide whether a thrown write actually landed.
 */
import { isHostReferenceRegistryCode, readHostIdSet } from "./RemoteHostReferenceRegistry";
import { isRemoteHostStoreCode } from "./RemoteHostStore";
import type { HostRebindHostState, HostRebindHostSummary, HostRebindPorts, HostRebindRecordPatch, HostRebindStorePort, RebindJournal, RebindOutcome, RebindRecordPlan, RebindStage } from "./HostRebindJournal";

const MAX_ID_CHARS = 128;
const MAX_LOCATOR_CHARS = 64 * 1024;

/**
 * A record that still needs its CAS write: the patch shape the store port consumes (§4.4). The journal
 * plan additionally carries `store`, which must not leak into the port call.
 */
type PendingPlan = HostRebindRecordPatch;

type ReferenceScanView = { readonly complete: boolean; readonly referencedHostIds: ReadonlySet<string> };

/** Journal operations the algorithm needs. `HostRebindJournal` itself satisfies this structurally. */
export type RebindJournalIo = {
	/** Atomic journal replace (WAL: the stage is written *before* that step executes, §4.3). */
	write(journal: RebindJournal): Promise<void>;
	/** Drop the journal once the commit point is passed; a failure is a warning, not a failure of the tx. */
	remove(): Promise<void>;
};

/**
 * Stable-code predicate for the codes the *journal* module owns: its own vocabulary plus the
 * store-port pass-through set (§4.4). Injected because folding a failure into a stable code is a
 * decision of the vocabulary owner, and importing the list would close an import cycle.
 */
export type RebindStableCodeGuard = (code: string) => boolean;

/** One convergence attempt: the injected journal I/O and vocabulary, the ports, and the leftovers. */
type Convergence = {
	readonly io: RebindJournalIo;
	readonly ports: HostRebindPorts;
	readonly isStableJournalCode: RebindStableCodeGuard;
	readonly warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `message` structurally instead of with `instanceof Error`: the Node test harness runs this
 * module in its own VM realm, where an error built by a port is not an instance of this realm's Error.
 */
function stableMessage(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("message" in error)) return undefined;
	return typeof error.message === "string" ? error.message : undefined;
}

/** Record-id bound of the port contract (§4.4); `HostRebindJournal` decodes its file with the same one. */
export function isRebindRecordId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS && !/[\x00-\x1f\x7f]/.test(value);
}

/**
 * Locator bound of the port contract (§4.4). Both the journal's per-record comparison and every store
 * port's CAS compare these strings byte-wise, so one bound has to cover both writers.
 */
export function isRebindLocator(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_LOCATOR_CHARS && !/[\x00-\x1f\x7f]/.test(value);
}

/**
 * Fold any non-stable failure into the journal's vocabulary. Ports and helpers may throw arbitrary
 * errors (errno text, provider messages); those must not reach the caller or an IPC boundary.
 */
function asStableError(error: unknown, isStableJournalCode: RebindStableCodeGuard): Error {
	const message = stableMessage(error);
	if (message !== undefined && (isStableJournalCode(message) || isRemoteHostStoreCode(message) || isHostReferenceRegistryCode(message))) return new Error(message);
	return new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
}

/**
 * The per-record authority (§4.3): what the store holds decides, never the recorded stage.
 * `missing` (INV-6) and `stale` (somebody else moved the record) are refusals, not retries; the caller
 * turns them into `REMOTE_HOST_REBIND_RECORD_MISSING` / `REMOTE_HOST_REBIND_STALE_PLAN` and leaves the
 * journal for a human. The order of the checks is the precedence of those failures: an unreadable
 * record outranks "already done", which outranks "needs a write".
 */
export type RebindRecordDisposition = { readonly kind: "done" } | { readonly kind: "pending"; readonly patch: HostRebindRecordPatch } | { readonly kind: "missing" } | { readonly kind: "stale" };

export function classifyRebindRecord(plan: RebindRecordPlan, locator: string | undefined): RebindRecordDisposition {
	if (locator === undefined) return { kind: "missing" };
	if (locator === plan.afterLocator) return { kind: "done" };
	if (locator === plan.beforeLocator) return { kind: "pending", patch: { recordId: plan.recordId, beforeLocator: plan.beforeLocator, afterLocator: plan.afterLocator } };
	return { kind: "stale" };
}

/**
 * Store-port answer for one patch. `missing`/`changed` keep their own stable codes, and anything
 * malformed or unrecognised is `unknown` — never "already applied", because a port that cannot be
 * interpreted must not let the transaction claim success (INV-10).
 */
export type RebindResultDisposition = { readonly kind: "applied" } | { readonly kind: "already-applied" } | { readonly kind: "missing" } | { readonly kind: "changed" } | { readonly kind: "unknown" };

export function classifyRebindResult(result: unknown): RebindResultDisposition {
	if (!isRecord(result) || !isRebindRecordId(result.recordId) || typeof result.outcome !== "string") return { kind: "unknown" };
	if (result.outcome === "missing") return { kind: "missing" };
	if (result.outcome === "changed") return { kind: "changed" };
	if (result.outcome === "applied") return { kind: "applied" };
	if (result.outcome === "already-applied") return { kind: "already-applied" };
	return { kind: "unknown" };
}

function readHostState(value: unknown): HostRebindHostState {
	if (!isRecord(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !Array.isArray(value.profiles) || !Array.isArray(value.retiredHostIds)) throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
	const profiles: HostRebindHostSummary[] = [];
	for (const profile of value.profiles) {
		if (!isRecord(profile) || !isRebindRecordId(profile.hostId) || typeof profile.disabled !== "boolean" || typeof profile.verified !== "boolean") throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
		profiles.push({ hostId: profile.hostId, disabled: profile.disabled, verified: profile.verified });
	}
	const retiredHostIds: string[] = [];
	for (const hostId of value.retiredHostIds) {
		if (typeof hostId !== "string" || hostId.length === 0) throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
		retiredHostIds.push(hostId);
	}
	return { revision: Number(value.revision), profiles, retiredHostIds };
}

function assertStorePort(port: HostRebindStorePort | undefined): HostRebindStorePort {
	if (!port || typeof port.readHostRecordLocators !== "function" || typeof port.applyHostRebind !== "function") throw new Error("REMOTE_HOST_REBIND_STORE_PORT_MISSING");
	return port;
}

/**
 * Idempotent convergence (§5.4): the body of `HostRebindJournal.resume()` after the tx lock is held.
 * Safe to repeat — already-applied records are recognised by content, an already retired source is
 * recognised through `retiredHostIds`, and a retired id is never retired twice.
 */
export async function convergeRebindJournal(io: RebindJournalIo, journal: RebindJournal, ports: HostRebindPorts, isStableJournalCode: RebindStableCodeGuard): Promise<RebindOutcome> {
	const convergence: Convergence = { io, ports, isStableJournalCode, warnings: [] };
	if (journal.stage === "committed") {
		// The commit point already happened; the only remaining work is dropping the journal.
		await dropJournal(convergence);
		return outcome(journal, "committed", 0, 0, true, convergence.warnings);
	}
	// Step 4: the target anchor is re-verified from disk; the source anchor is never a substitute (INV-3).
	await verifyTarget(convergence, journal.target.hostId);
	// Step 5: authoritative per-record classification, before any host write (INV-6 / stale plan).
	const pendingProjects = await classify(convergence, journal, assertStorePort(ports.projects), "projects");
	const pendingSessions = await classify(convergence, journal, assertStorePort(ports.sessions), "sessions");
	const sourceId = journal.source.hostId;
	let state = await hostState(convergence);
	const retired = state.retiredHostIds.includes(sourceId);
	if (!retired && !state.profiles.some((profile) => profile.hostId === sourceId)) throw new Error("REMOTE_HOST_REBIND_SOURCE_MISSING");
	// Step 6a: disable first, so the source cannot be picked for new sessions while its refs move.
	if (!retired && state.profiles.some((profile) => profile.hostId === sourceId && !profile.disabled)) {
		await advance(convergence, journal, "source-disabled");
		state = await disableSource(convergence, sourceId, state);
	}
	let migratedProjects = 0;
	let migratedSessions = 0;
	if (pendingProjects.length) {
		await advance(convergence, journal, "projects-written");
		migratedProjects = await applyStore(convergence, journal.txId, assertStorePort(ports.projects), pendingProjects);
	}
	if (pendingSessions.length) {
		await advance(convergence, journal, "sessions-written");
		migratedSessions = await applyStore(convergence, journal.txId, assertStorePort(ports.sessions), pendingSessions);
	}
	// Step 7/8: re-read before the terminal decision; the retire revision comes from disk, never from
	// the journal, and an id that is already retired means the retire stage already happened.
	const finalState = await hostState(convergence);
	if (!finalState.retiredHostIds.includes(sourceId)) {
		await advance(convergence, journal, "source-retired");
		const scan = await scanReferences(convergence);
		// An incomplete scan cannot prove "no references": not retiring is the only safe answer (INV-2).
		if (!scan.complete) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE");
		if (scan.referencedHostIds.has(sourceId)) throw new Error("REMOTE_HOST_REBIND_INCOMPLETE");
		await retireSource(convergence, sourceId, finalState);
	}
	const committed = await advance(convergence, journal, "committed");
	await dropJournal(convergence);
	return outcome(committed, "committed", migratedProjects, migratedSessions, true, convergence.warnings);
}

/** Rewrite the stage *before* executing that step (WAL semantics, §4.3). */
async function advance(convergence: Convergence, journal: RebindJournal, stage: RebindStage): Promise<RebindJournal> {
	const next: RebindJournal = { ...journal, stage };
	await convergence.io.write(next);
	return next;
}

async function verifyTarget(convergence: Convergence, hostId: string): Promise<void> {
	try {
		await convergence.ports.host.verifyTargetAnchor(hostId);
	} catch (error) {
		// Never fall back to the source anchor: a broken target must stop the tx (INV-3).
		const stable = asStableError(error, convergence.isStableJournalCode);
		if (stable.message === "REMOTE_HOST_REBIND_TARGET_UNVERIFIED" || stable.message === "REMOTE_HOST_REBIND_TARGET_MISSING") throw stable;
		throw new Error("REMOTE_HOST_REBIND_TARGET_ANCHOR_UNREADABLE");
	}
}

async function hostState(convergence: Convergence): Promise<HostRebindHostState> {
	let raw: unknown;
	try {
		raw = await convergence.ports.host.readHostState();
	} catch (error) {
		throw asStableError(error, convergence.isStableJournalCode);
	}
	return readHostState(raw);
}

async function scanReferences(convergence: Convergence): Promise<ReferenceScanView> {
	let raw: unknown;
	try {
		raw = await convergence.ports.host.scanReferences();
	} catch (error) {
		throw asStableError(error, convergence.isStableJournalCode);
	}
	if (!isRecord(raw) || typeof raw.complete !== "boolean") throw new Error("REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE");
	// A malformed set is an unreadable scan, never an empty ("nothing is referenced") one.
	const ids = readHostIdSet(raw.referencedHostIds);
	if (ids === undefined) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE");
	return { complete: raw.complete, referencedHostIds: ids };
}

/** Per-record authority: missing stops the tx (INV-6), changed stops it (stale plan), after = done. */
async function classify(convergence: Convergence, journal: RebindJournal, port: HostRebindStorePort, store: "projects" | "sessions"): Promise<readonly PendingPlan[]> {
	const plans = journal.records.filter((record) => record.store === store);
	if (plans.length === 0) return [];
	let snapshots: unknown;
	try {
		snapshots = await port.readHostRecordLocators(plans.map((plan) => plan.recordId));
	} catch (error) {
		throw asStableError(error, convergence.isStableJournalCode);
	}
	if (!Array.isArray(snapshots)) throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
	const locators = new Map<string, string | undefined>();
	for (const snapshot of snapshots) {
		if (!isRecord(snapshot) || !isRebindRecordId(snapshot.recordId)) throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
		if (snapshot.locator !== undefined && !isRebindLocator(snapshot.locator)) throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
		locators.set(snapshot.recordId, snapshot.locator);
	}
	const pending: PendingPlan[] = [];
	for (const plan of plans) {
		const disposition = classifyRebindRecord(plan, locators.get(plan.recordId));
		if (disposition.kind === "missing") throw new Error("REMOTE_HOST_REBIND_RECORD_MISSING");
		if (disposition.kind === "stale") throw new Error("REMOTE_HOST_REBIND_STALE_PLAN");
		if (disposition.kind === "pending") pending.push(disposition.patch);
	}
	return pending;
}

async function applyStore(convergence: Convergence, txId: string, port: HostRebindStorePort, pending: readonly PendingPlan[]): Promise<number> {
	let results: unknown;
	try {
		results = await port.applyHostRebind(txId, pending);
	} catch (error) {
		throw asStableError(error, convergence.isStableJournalCode);
	}
	// A port that reports fewer results than patches leaves the outcome unknown, not "applied".
	if (!Array.isArray(results) || results.length !== pending.length) throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
	let applied = 0;
	for (const result of results) {
		const disposition = classifyRebindResult(result);
		if (disposition.kind === "missing") throw new Error("REMOTE_HOST_REBIND_RECORD_MISSING");
		if (disposition.kind === "changed") throw new Error("REMOTE_HOST_REBIND_STALE_PLAN");
		if (disposition.kind === "unknown") throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
		if (disposition.kind === "applied") applied += 1;
	}
	return applied;
}

/**
 * A store write may have committed even when it threw (§1.5: the host store's unlock failure
 * happens after a successful commit). Re-read first, roll forward when the effect is present, and
 * only then treat the error as authoritative — an unknown error becomes `..._UNKNOWN_OUTCOME`.
 */
async function disableSource(convergence: Convergence, sourceId: string, state: HostRebindHostState): Promise<HostRebindHostState> {
	try {
		await convergence.ports.host.disableSource(sourceId, state.revision);
	} catch (error) {
		const after = await hostState(convergence);
		const disabled = after.retiredHostIds.includes(sourceId) || after.profiles.some((profile) => profile.hostId === sourceId && profile.disabled);
		if (!disabled) throw asStableError(error, convergence.isStableJournalCode);
		convergence.warnings.push("UNKNOWN_OUTCOME_ROLLED_FORWARD");
		return after;
	}
	return await hostState(convergence);
}

async function retireSource(convergence: Convergence, sourceId: string, state: HostRebindHostState): Promise<void> {
	try {
		await convergence.ports.host.retireSource(sourceId, state.revision);
	} catch (error) {
		const after = await hostState(convergence);
		if (!after.retiredHostIds.includes(sourceId)) throw asStableError(error, convergence.isStableJournalCode);
		convergence.warnings.push("UNKNOWN_OUTCOME_ROLLED_FORWARD");
	}
}

async function dropJournal(convergence: Convergence): Promise<void> {
	try {
		await convergence.io.remove();
	} catch {
		// A committed journal is only a hint; a failed delete is retried on the next resume.
		convergence.warnings.push("JOURNAL_REMOVE_FAILED");
	}
}

function outcome(journal: RebindJournal, stage: RebindStage, migratedProjects: number, migratedSessions: number, sourceRetired: boolean, warnings: readonly string[]): RebindOutcome {
	return {
		code: warnings.length ? "REMOTE_HOST_REBIND_COMMITTED_WITH_WARNINGS" : "REMOTE_HOST_REBIND_COMMITTED",
		txId: journal.txId,
		stage,
		migratedProjects,
		migratedSessions,
		sourceRetired,
		warnings: [...warnings],
	};
}
