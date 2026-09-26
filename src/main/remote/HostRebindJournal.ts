/**
 * Durable journal + crash convergence for the cross-store host rebind transaction
 * (`docs/remote-host-cross-store-design.md` §4.3, §5.1, §5.4).
 *
 * The journal is a write-ahead hint, not the source of truth: the authoritative progress signal is
 * the per-record `beforeLocator` / `afterLocator` comparison against what the stores actually hold,
 * so a stale or missing `stage` can never cause a wrong action (design §4.3).
 *
 * Failure semantics (stable codes): every failure leaves this module as one of `HOST_REBIND_CODES`,
 * a pass-through code from `REMOTE_HOST_STORE_CODES` / `HOST_REFERENCE_REGISTRY_CODES` /
 * `HOST_REBIND_STORE_PORT_CODES`, or `REMOTE_HOST_REBIND_UNKNOWN_OUTCOME`. Anything else (errno,
 * port text, stack messages) is folded into a stable code: nothing else may escape.
 */
import { uptime } from "node:os";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { writeDurableJsonFile } from "../persistence/durableJsonStore";
import { isHostReferenceRegistryCode, readHostIdSet } from "./RemoteHostReferenceRegistry";
import { isRemoteHostStoreCode } from "./RemoteHostStore";

export const REBIND_STAGES = ["prepared", "source-disabled", "projects-written", "sessions-written", "source-retired", "committed"] as const;
export type RebindStage = (typeof REBIND_STAGES)[number];

export type RebindRecordPlan = {
	readonly store: "projects" | "sessions";
	readonly recordId: string;
	/** Canonical JSON of the record's current locator; the per-record CAS expectation. */
	readonly beforeLocator: string;
	/** Canonical JSON after migration; must differ from before only in the hostId. */
	readonly afterLocator: string;
};

export type RebindJournal = {
	readonly schemaVersion: 1;
	readonly txId: string;
	readonly createdAt: string;
	/** Progress hint only; the authority is the per-record locator comparison. */
	readonly stage: RebindStage;
	readonly source: { readonly hostId: string; readonly endpointDigest: string; readonly disabled: boolean };
	readonly target: { readonly hostId: string; readonly endpointDigest: string; readonly knownHostsSha256: string };
	readonly expectedHostRevision: number;
	readonly records: readonly RebindRecordPlan[];
	readonly referenceScan: { readonly complete: boolean; readonly count: number };
};

export type HostRebindRecordPatch = { readonly recordId: string; readonly beforeLocator: string; readonly afterLocator: string };
export type HostRebindRecordOutcome = "applied" | "already-applied" | "missing" | "changed";
export type HostRebindRecordResult = { readonly recordId: string; readonly outcome: HostRebindRecordOutcome };
/** `locator === undefined` = the record no longer exists (INV-6). */
export type HostRebindRecordSnapshot = { readonly recordId: string; readonly locator?: string };

/** Store-side port (§4.4). Phase-1 stores implement it later; convergence only needs these two calls. */
export type HostRebindStorePort = {
	/**
	 * Whether the store can structurally hold an ssh locator at all (§4.4 / design Q6). Absent = yes.
	 * `false` (ProjectStore before Phase 3: `projectStoreCodec.ts:81` refuses ssh on read and `Project`
	 * carries no locator) means the port still answers reads with what the record really holds, but
	 * every patch is refused: no plan naming such a store can ever be migrated.
	 */
	readonly canHoldHostReferences?: boolean;
	/** Read the current locator of each requested record; a deleted record comes back without a locator. */
	readHostRecordLocators(recordIds: readonly string[]): Promise<readonly HostRebindRecordSnapshot[]>;
	/** All-or-nothing per-record CAS write; replaying an already-applied patch reports "already-applied". */
	applyHostRebind(txId: string, patches: readonly HostRebindRecordPatch[]): Promise<readonly HostRebindRecordResult[]>;
};

export type HostRebindHostSummary = { readonly hostId: string; readonly disabled: boolean; readonly verified: boolean };
export type HostRebindHostState = { readonly revision: number; readonly profiles: readonly HostRebindHostSummary[]; readonly retiredHostIds: readonly string[] };

/** Host-store port. Convergence never writes a profile itself: it only asks the host store to act. */
export type HostRebindHostPort = {
	readHostState(): Promise<HostRebindHostState>;
	/** Re-verify that the target is a verified profile whose pin is still readable (INV-3). */
	verifyTargetAnchor(hostId: string): Promise<void>;
	/** Idempotent: an already disabled tombstone is a no-op and returns the current revision. */
	disableSource(hostId: string, expectedRevision: number): Promise<number>;
	/** Idempotent retire. Must not be called for an id that is already retired (§5.4 step 7). */
	retireSource(hostId: string, expectedRevision: number): Promise<number>;
	/** Complete reference scan taken inside the tx lock (INV-2). */
	scanReferences(): Promise<{ readonly complete: boolean; readonly referencedHostIds: ReadonlySet<string> }>;
};

export type HostRebindPorts = { readonly host: HostRebindHostPort; readonly projects?: HostRebindStorePort; readonly sessions?: HostRebindStorePort };

export type RebindOutcomeCode = "REMOTE_HOST_REBIND_COMMITTED" | "REMOTE_HOST_REBIND_COMMITTED_WITH_WARNINGS";

export type RebindOutcome = {
	/** Terminal classification (INV-10): committed with or without non-fatal leftovers. */
	readonly code: RebindOutcomeCode;
	readonly txId: string;
	readonly stage: RebindStage;
	readonly migratedProjects: number;
	readonly migratedSessions: number;
	readonly sourceRetired: boolean;
	/** Non-fatal leftovers (stable tokens, see HOST_REBIND_WARNING_CODES). */
	readonly warnings: readonly string[];
};

/** Stable codes owned by this module (plus the pass-through code sets it accepts). */
export const HOST_REBIND_CODES = [
	"REMOTE_HOST_REBIND_JOURNAL_INVALID",
	"REMOTE_HOST_REBIND_JOURNAL_WRITE_FAILED",
	"REMOTE_HOST_REBIND_TX_BUSY",
	"REMOTE_HOST_REBIND_TX_LOCK_UNWRITABLE",
	"REMOTE_HOST_REBIND_JOURNAL_PRESENT",
	"REMOTE_HOST_REBIND_SAME_HOST",
	"REMOTE_HOST_REBIND_SOURCE_MISSING",
	"REMOTE_HOST_REBIND_TARGET_MISSING",
	"REMOTE_HOST_REBIND_TARGET_UNVERIFIED",
	"REMOTE_HOST_REBIND_TARGET_ANCHOR_UNREADABLE",
	"REMOTE_HOST_REBIND_REFERENCE_SCAN_INCOMPLETE",
	"REMOTE_HOST_REBIND_ORIGIN_CONFLICT",
	"REMOTE_HOST_REBIND_STALE_PLAN",
	"REMOTE_HOST_REBIND_RECORD_MISSING",
	"REMOTE_HOST_REBIND_STORE_PORT_MISSING",
	"REMOTE_HOST_REBIND_INCOMPLETE",
	"REMOTE_HOST_REBIND_UNKNOWN_OUTCOME",
	"REMOTE_HOST_REBIND_COMMITTED",
	"REMOTE_HOST_REBIND_COMMITTED_WITH_WARNINGS",
] as const;

export type HostRebindCode = (typeof HOST_REBIND_CODES)[number];

/** Non-fatal leftovers reported on a committed transaction. */
export const HOST_REBIND_WARNING_CODES = ["UNKNOWN_OUTCOME_ROLLED_FORWARD", "JOURNAL_REMOVE_FAILED"] as const;

/**
 * Store-port codes that keep their own meaning across the boundary (§4.4). "This store cannot be
 * written" and "this store cannot represent remote locators" are *known* fail-closed answers, so they
 * must not be folded into `REMOTE_HOST_REBIND_UNKNOWN_OUTCOME` (INV-10 keeps "nothing was written" /
 * "outcome unknown" / "validation failed" / "needs a human" distinguishable).
 */
export const HOST_REBIND_STORE_PORT_CODES = ["PROJECT_STORE_NEEDS_REPAIR", "PROJECT_STORE_REMOTE_UNSUPPORTED", "SESSION_CATALOG_NEEDS_REPAIR"] as const;

const HOST_REBIND_CODE_SET: ReadonlySet<string> = new Set(HOST_REBIND_CODES);
const HOST_REBIND_STORE_PORT_CODE_SET: ReadonlySet<string> = new Set(HOST_REBIND_STORE_PORT_CODES);
const REBIND_STAGE_SET: ReadonlySet<string> = new Set(REBIND_STAGES);

export function isHostRebindCode(code: string): code is HostRebindCode {
	return HOST_REBIND_CODE_SET.has(code);
}

/** A store-port code the journal surfaces unchanged instead of folding it into an unknown outcome. */
export function isHostRebindStorePortCode(code: string): boolean {
	return HOST_REBIND_STORE_PORT_CODE_SET.has(code);
}

function isRebindStage(value: unknown): value is RebindStage {
	return typeof value === "string" && REBIND_STAGE_SET.has(value);
}

const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const MAX_LOCATOR_CHARS = 64 * 1024;
const MAX_ID_CHARS = 128;
const MAX_LOCK_BYTES = 4096;

type LockOwner = { readonly pid: number; readonly bootId: string; readonly startedAt: string };
type PendingPlan = { readonly recordId: string; readonly beforeLocator: string; readonly afterLocator: string };
type ReferenceScanView = { readonly complete: boolean; readonly referencedHostIds: ReadonlySet<string> };

export type HostRebindJournalOptions = {
	userDataDir: string;
	/** Injectable process liveness probe (§5.1 R6); defaults to a `kill(pid, 0)`-based check. */
	isProcessAlive?: (pid: number) => boolean;
	/** Injectable boot identity; a differing value proves pid reuse after a reboot (§5.1 R6). */
	bootId?: string;
	now?: () => number;
};

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

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

function isBoundedId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS && !/[\x00-\x1f\x7f]/.test(value);
}

function isLocator(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_LOCATOR_CHARS && !/[\x00-\x1f\x7f]/.test(value);
}

/**
 * Fold any non-stable failure into this module's vocabulary. Ports and helpers may throw arbitrary
 * errors (errno text, provider messages); those must not reach the caller or an IPC boundary.
 */
function asStableError(error: unknown): Error {
	const message = stableMessage(error);
	if (message !== undefined && (isHostRebindCode(message) || isRemoteHostStoreCode(message) || isHostReferenceRegistryCode(message) || isHostRebindStorePortCode(message))) return new Error(message);
	return new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
}

/**
 * Canonical JSON of a locator (port contract, §4.4). Keys are emitted in sorted order and `undefined`
 * fields are dropped, so the same locator always yields the same bytes no matter which writer built
 * the object. This matters because both the journal's per-record comparison (`classify`) and every
 * store port's CAS compare these strings byte-wise: a planner that encodes `beforeLocator` /
 * `afterLocator` differently would turn every record into `changed` (stale plan), never into a write.
 */
export function canonicalHostLocatorJson(value: object): string {
	const encode = (input: unknown): unknown => {
		if (Array.isArray(input)) return input.map(encode);
		if (!isRecord(input)) return input;
		return Object.fromEntries(
			Object.keys(input)
				.sort()
				.filter((key) => input[key] !== undefined)
				.map((key) => [key, encode(input[key])]),
		);
	};
	return JSON.stringify(encode(value));
}

/** One record id of the shape the journal decoder accepts (`isBoundedId`), for port callers. */
export function isHostRebindRecordId(value: unknown): value is string {
	return isBoundedId(value);
}

/**
 * Port-side input guard (§4.4): a store port is also callable directly, so both ports accept exactly
 * the batch shape the journal produces — a bounded list of bounded ids, one snapshot per id. A request
 * the port cannot even interpret is reported as an unknown outcome (fail closed, nothing written).
 */
export function assertHostRebindRecordIds(recordIds: readonly string[]): void {
	if (!Array.isArray(recordIds) || recordIds.length > MAX_RECORDS) throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
	for (const recordId of recordIds) if (!isHostRebindRecordId(recordId)) throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
}

/** Boot identity without /proc: two processes on the same boot derive the same value. */
export function currentBootId(): string {
	return String(Math.round((Date.now() - uptime() * 1000) / 1000));
}

function defaultIsProcessAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM still proves the pid exists; only ESRCH proves it is gone.
		return errorCode(error) !== "ESRCH";
	}
}

function invalidJournal(): never {
	throw new Error("REMOTE_HOST_REBIND_JOURNAL_INVALID");
}

/** Strict decode: an unreadable journal is never guessed at and never deleted (design §5.4 step 2). */
export function decodeRebindJournal(value: unknown): RebindJournal {
	if (!isRecord(value)) invalidJournal();
	for (const key of Object.keys(value)) if (!["schemaVersion", "txId", "createdAt", "stage", "source", "target", "expectedHostRevision", "records", "referenceScan"].includes(key)) invalidJournal();
	if (value.schemaVersion !== 1 || !isBoundedId(value.txId) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) invalidJournal();
	if (!isRebindStage(value.stage)) invalidJournal();
	const source = value.source;
	const target = value.target;
	if (!isRecord(source) || !isRecord(target)) invalidJournal();
	if (!isBoundedId(source.hostId) || typeof source.endpointDigest !== "string" || typeof source.disabled !== "boolean") invalidJournal();
	if (!isBoundedId(target.hostId) || typeof target.endpointDigest !== "string" || typeof target.knownHostsSha256 !== "string") invalidJournal();
	if (!Number.isSafeInteger(value.expectedHostRevision) || Number(value.expectedHostRevision) < 0) invalidJournal();
	if (!Array.isArray(value.records) || value.records.length > MAX_RECORDS) invalidJournal();
	const records: RebindRecordPlan[] = [];
	for (const record of value.records) {
		if (!isRecord(record)) invalidJournal();
		if (record.store !== "projects" && record.store !== "sessions") invalidJournal();
		if (!isBoundedId(record.recordId) || !isLocator(record.beforeLocator) || !isLocator(record.afterLocator)) invalidJournal();
		// A no-op patch would make "is this record done?" undecidable.
		if (record.beforeLocator === record.afterLocator) invalidJournal();
		records.push({ store: record.store, recordId: record.recordId, beforeLocator: record.beforeLocator, afterLocator: record.afterLocator });
	}
	if (!isRecord(value.referenceScan) || typeof value.referenceScan.complete !== "boolean" || !Number.isSafeInteger(value.referenceScan.count) || Number(value.referenceScan.count) < 0) invalidJournal();
	return {
		schemaVersion: 1,
		txId: value.txId,
		createdAt: value.createdAt,
		stage: value.stage,
		source: { hostId: source.hostId, endpointDigest: source.endpointDigest, disabled: source.disabled },
		target: { hostId: target.hostId, endpointDigest: target.endpointDigest, knownHostsSha256: target.knownHostsSha256 },
		expectedHostRevision: Number(value.expectedHostRevision),
		records,
		referenceScan: { complete: value.referenceScan.complete, count: Number(value.referenceScan.count) },
	};
}

function encodeRebindJournal(journal: RebindJournal): RebindJournal {
	// Round-trip through the decoder so a journal can never be persisted in a shape we cannot read back.
	return decodeRebindJournal(JSON.parse(JSON.stringify(journal)));
}

function readHostState(value: unknown): HostRebindHostState {
	if (!isRecord(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !Array.isArray(value.profiles) || !Array.isArray(value.retiredHostIds)) throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
	const profiles: HostRebindHostSummary[] = [];
	for (const profile of value.profiles) {
		if (!isRecord(profile) || !isBoundedId(profile.hostId) || typeof profile.disabled !== "boolean" || typeof profile.verified !== "boolean") throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
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
 * Journal file plus the crash convergence algorithm. The transaction lock lives here too because
 * `resume` is the only writer that needs it today (§5.1 R1/R4/R6).
 */
export class HostRebindJournal {
	private readonly userDataDir: string;
	private readonly filePath: string;
	private readonly lockPath: string;
	private readonly isProcessAlive: (pid: number) => boolean;
	private readonly bootId: string;
	private readonly now: () => number;

	constructor(options: HostRebindJournalOptions) {
		if (typeof options?.userDataDir !== "string" || !isAbsolute(options.userDataDir) || /[\x00-\x1f\x7f]/.test(options.userDataDir)) throw new Error("REMOTE_HOST_REBIND_JOURNAL_INVALID");
		this.userDataDir = options.userDataDir;
		this.filePath = join(options.userDataDir, "remote-host-rebind.json");
		this.lockPath = join(options.userDataDir, "remote-host-rebind.lock");
		this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
		this.bootId = options.bootId ?? currentBootId();
		this.now = options.now ?? Date.now;
	}

	path(): string {
		return this.filePath;
	}

	lockFilePath(): string {
		return this.lockPath;
	}

	/** `undefined` = no journal. A malformed journal throws: never guess, never delete (§5.4 step 2). */
	async read(): Promise<RebindJournal | undefined> {
		let size: number;
		try {
			const stats = await lstat(this.filePath);
			if (!stats.isFile() || stats.isSymbolicLink()) invalidJournal();
			size = stats.size;
		} catch (error) {
			if (errorCode(error) === "ENOENT") return undefined;
			throw new Error("REMOTE_HOST_REBIND_JOURNAL_INVALID");
		}
		if (size === 0 || size > MAX_JOURNAL_BYTES) invalidJournal();
		let text: string;
		try {
			text = await readFile(this.filePath, "utf8");
		} catch {
			throw new Error("REMOTE_HOST_REBIND_JOURNAL_INVALID");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error("REMOTE_HOST_REBIND_JOURNAL_INVALID");
		}
		return decodeRebindJournal(parsed);
	}

	/**
	 * Atomic replace through `writeDurableJsonFile`. No `.bak` on purpose (design Q8): a backup would
	 * make "which journal is authoritative" a second CAS problem, and a lost journal only degrades to
	 * a legal half-migrated state that the same (source,target) pair can roll forward.
	 */
	async write(journal: RebindJournal): Promise<void> {
		const encoded = encodeRebindJournal(journal);
		try {
			await writeDurableJsonFile(this.filePath, `${JSON.stringify(encoded, null, 2)}\n`);
		} catch {
			throw new Error("REMOTE_HOST_REBIND_JOURNAL_WRITE_FAILED");
		}
	}

	async remove(): Promise<void> {
		try {
			await unlink(this.filePath);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw new Error("REMOTE_HOST_REBIND_JOURNAL_WRITE_FAILED");
		}
	}

	/**
	 * Idempotent convergence (§5.4). Safe to call repeatedly: already-applied records are recognised
	 * by content, an already retired source is recognised through `retiredHostIds`, and a retired id is
	 * never retired twice. Returns `undefined` when there is no journal, or when another live process
	 * holds the transaction lock (R4: give up this recovery instead of waiting).
	 */
	async resume(ports: HostRebindPorts): Promise<RebindOutcome | undefined> {
		const journal = await this.read();
		if (journal === undefined) return undefined;
		const lock = await this.acquireLock();
		if (lock === undefined) return undefined;
		try {
			return await this.converge(journal, ports);
		} finally {
			await lock.release();
		}
	}

	private async converge(journal: RebindJournal, ports: HostRebindPorts): Promise<RebindOutcome> {
		const warnings: string[] = [];
		if (journal.stage === "committed") {
			// The commit point already happened; the only remaining work is dropping the journal.
			await this.dropJournal(warnings);
			return this.outcome(journal, "committed", 0, 0, true, warnings);
		}
		// Step 4: the target anchor is re-verified from disk; the source anchor is never a substitute (INV-3).
		await this.verifyTarget(ports, journal.target.hostId);
		// Step 5: authoritative per-record classification, before any host write (INV-6 / stale plan).
		const pendingProjects = await this.classify(journal, assertStorePort(ports.projects), "projects");
		const pendingSessions = await this.classify(journal, assertStorePort(ports.sessions), "sessions");
		const sourceId = journal.source.hostId;
		let state = await this.state(ports);
		const retired = state.retiredHostIds.includes(sourceId);
		if (!retired && !state.profiles.some((profile) => profile.hostId === sourceId)) throw new Error("REMOTE_HOST_REBIND_SOURCE_MISSING");
		// Step 6a: disable first, so the source cannot be picked for new sessions while its refs move.
		if (!retired && state.profiles.some((profile) => profile.hostId === sourceId && !profile.disabled)) {
			await this.advance(journal, "source-disabled");
			state = await this.disableSource(ports, sourceId, state, warnings);
		}
		let migratedProjects = 0;
		let migratedSessions = 0;
		if (pendingProjects.length) {
			await this.advance(journal, "projects-written");
			migratedProjects = await this.applyStore(journal.txId, assertStorePort(ports.projects), pendingProjects);
		}
		if (pendingSessions.length) {
			await this.advance(journal, "sessions-written");
			migratedSessions = await this.applyStore(journal.txId, assertStorePort(ports.sessions), pendingSessions);
		}
		// Step 7/8: re-read before the terminal decision; the retire revision comes from disk, never from
		// the journal, and an id that is already retired means the retire stage already happened.
		const finalState = await this.state(ports);
		if (!finalState.retiredHostIds.includes(sourceId)) {
			await this.advance(journal, "source-retired");
			const scan = await this.scanReferences(ports);
			// An incomplete scan cannot prove "no references": not retiring is the only safe answer (INV-2).
			if (!scan.complete) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE");
			if (scan.referencedHostIds.has(sourceId)) throw new Error("REMOTE_HOST_REBIND_INCOMPLETE");
			await this.retireSource(ports, sourceId, finalState, warnings);
		}
		const committed = await this.advance(journal, "committed");
		await this.dropJournal(warnings);
		return this.outcome(committed, "committed", migratedProjects, migratedSessions, true, warnings);
	}

	/** Rewrite the stage *before* executing that step (WAL semantics, §4.3). */
	private async advance(journal: RebindJournal, stage: RebindStage): Promise<RebindJournal> {
		const next: RebindJournal = { ...journal, stage };
		await this.write(next);
		return next;
	}

	private async verifyTarget(ports: HostRebindPorts, hostId: string): Promise<void> {
		try {
			await ports.host.verifyTargetAnchor(hostId);
		} catch (error) {
			// Never fall back to the source anchor: a broken target must stop the tx (INV-3).
			const stable = asStableError(error);
			if (stable.message === "REMOTE_HOST_REBIND_TARGET_UNVERIFIED" || stable.message === "REMOTE_HOST_REBIND_TARGET_MISSING") throw stable;
			throw new Error("REMOTE_HOST_REBIND_TARGET_ANCHOR_UNREADABLE");
		}
	}

	private async state(ports: HostRebindPorts): Promise<HostRebindHostState> {
		let raw: unknown;
		try {
			raw = await ports.host.readHostState();
		} catch (error) {
			throw asStableError(error);
		}
		return readHostState(raw);
	}

	private async scanReferences(ports: HostRebindPorts): Promise<ReferenceScanView> {
		let raw: unknown;
		try {
			raw = await ports.host.scanReferences();
		} catch (error) {
			throw asStableError(error);
		}
		if (!isRecord(raw) || typeof raw.complete !== "boolean") throw new Error("REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE");
		// A malformed set is an unreadable scan, never an empty ("nothing is referenced") one.
		const ids = readHostIdSet(raw.referencedHostIds);
		if (ids === undefined) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE");
		return { complete: raw.complete, referencedHostIds: ids };
	}

	/** Per-record authority: missing stops the tx (INV-6), changed stops it (stale plan), after = done. */
	private async classify(journal: RebindJournal, port: HostRebindStorePort, store: "projects" | "sessions"): Promise<readonly PendingPlan[]> {
		const plans = journal.records.filter((record) => record.store === store);
		if (plans.length === 0) return [];
		let snapshots: unknown;
		try {
			snapshots = await port.readHostRecordLocators(plans.map((plan) => plan.recordId));
		} catch (error) {
			throw asStableError(error);
		}
		if (!Array.isArray(snapshots)) throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
		const locators = new Map<string, string | undefined>();
		for (const snapshot of snapshots) {
			if (!isRecord(snapshot) || !isBoundedId(snapshot.recordId)) throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
			if (snapshot.locator !== undefined && !isLocator(snapshot.locator)) throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
			locators.set(snapshot.recordId, snapshot.locator);
		}
		const pending: PendingPlan[] = [];
		for (const plan of plans) {
			const locator = locators.get(plan.recordId);
			if (locator === undefined) throw new Error("REMOTE_HOST_REBIND_RECORD_MISSING");
			if (locator === plan.afterLocator) continue;
			if (locator === plan.beforeLocator) {
				pending.push({ recordId: plan.recordId, beforeLocator: plan.beforeLocator, afterLocator: plan.afterLocator });
				continue;
			}
			throw new Error("REMOTE_HOST_REBIND_STALE_PLAN");
		}
		return pending;
	}

	private async applyStore(txId: string, port: HostRebindStorePort, pending: readonly PendingPlan[]): Promise<number> {
		let results: unknown;
		try {
			results = await port.applyHostRebind(txId, pending);
		} catch (error) {
			throw asStableError(error);
		}
		// A port that reports fewer results than patches leaves the outcome unknown, not "applied".
		if (!Array.isArray(results) || results.length !== pending.length) throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
		let applied = 0;
		for (const result of results) {
			if (!isRecord(result) || !isBoundedId(result.recordId) || typeof result.outcome !== "string") throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
			if (result.outcome === "missing") throw new Error("REMOTE_HOST_REBIND_RECORD_MISSING");
			if (result.outcome === "changed") throw new Error("REMOTE_HOST_REBIND_STALE_PLAN");
			if (result.outcome !== "applied" && result.outcome !== "already-applied") throw new Error("REMOTE_HOST_REBIND_UNKNOWN_OUTCOME");
			if (result.outcome === "applied") applied += 1;
		}
		return applied;
	}

	/**
	 * A store write may have committed even when it threw (§1.5: the host store's unlock failure
	 * happens after a successful commit). Re-read first, roll forward when the effect is present, and
	 * only then treat the error as authoritative — an unknown error becomes `..._UNKNOWN_OUTCOME`.
	 */
	private async disableSource(ports: HostRebindPorts, sourceId: string, state: HostRebindHostState, warnings: string[]): Promise<HostRebindHostState> {
		try {
			await ports.host.disableSource(sourceId, state.revision);
		} catch (error) {
			const after = await this.state(ports);
			const disabled = after.retiredHostIds.includes(sourceId) || after.profiles.some((profile) => profile.hostId === sourceId && profile.disabled);
			if (!disabled) throw asStableError(error);
			warnings.push("UNKNOWN_OUTCOME_ROLLED_FORWARD");
			return after;
		}
		return await this.state(ports);
	}

	private async retireSource(ports: HostRebindPorts, sourceId: string, state: HostRebindHostState, warnings: string[]): Promise<void> {
		try {
			await ports.host.retireSource(sourceId, state.revision);
		} catch (error) {
			const after = await this.state(ports);
			if (!after.retiredHostIds.includes(sourceId)) throw asStableError(error);
			warnings.push("UNKNOWN_OUTCOME_ROLLED_FORWARD");
		}
	}

	private async dropJournal(warnings: string[]): Promise<void> {
		try {
			await this.remove();
		} catch {
			// A committed journal is only a hint; a failed delete is retried on the next resume.
			warnings.push("JOURNAL_REMOVE_FAILED");
		}
	}

	private outcome(journal: RebindJournal, stage: RebindStage, migratedProjects: number, migratedSessions: number, sourceRetired: boolean, warnings: readonly string[]): RebindOutcome {
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

	/**
	 * Tx lock (§5.1): created with "wx" so it is a real cross-process mutex, carrying owner metadata
	 * so a crash can be told apart from a live writer. R6: only a provably dead owner (missing pid, or
	 * pid reuse proven by a different boot id) may be preempted; an unreadable owner is treated as live.
	 */
	private async acquireLock(): Promise<{ release(): Promise<void> } | undefined> {
		await mkdir(this.userDataDir, { recursive: true });
		const owner: LockOwner = { pid: process.pid, bootId: this.bootId, startedAt: new Date(this.now()).toISOString() };
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const handle = await open(this.lockPath, "wx", 0o600);
				try {
					await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
				} finally {
					await handle.close();
				}
				return {
					release: async () => {
						try {
							await unlink(this.lockPath);
						} catch {
							// Already gone: that is the released state.
						}
					},
				};
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw new Error("REMOTE_HOST_REBIND_TX_LOCK_UNWRITABLE");
				const existing = await this.readLockOwner();
				if (existing === undefined || this.isLiveOwner(existing)) return undefined;
				try {
					await unlink(this.lockPath);
				} catch {
					return undefined;
				}
			}
		}
		return undefined;
	}

	private isLiveOwner(owner: LockOwner): boolean {
		if (owner.pid === process.pid) return true;
		// A different boot id proves the pid belongs to some other process now.
		if (owner.bootId !== this.bootId) return false;
		return this.isProcessAlive(owner.pid);
	}

	private async readLockOwner(): Promise<LockOwner | undefined> {
		let text: string;
		try {
			const stats = await lstat(this.lockPath);
			if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0 || stats.size > MAX_LOCK_BYTES) return undefined;
			text = await readFile(this.lockPath, "utf8");
		} catch {
			return undefined;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return undefined;
		}
		if (!isRecord(parsed) || !Number.isSafeInteger(parsed.pid) || Number(parsed.pid) < 1 || typeof parsed.bootId !== "string" || typeof parsed.startedAt !== "string") return undefined;
		return { pid: Number(parsed.pid), bootId: parsed.bootId, startedAt: parsed.startedAt };
	}
}
