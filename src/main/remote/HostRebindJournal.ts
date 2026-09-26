/**
 * Durable journal + crash-convergence entry point for the cross-store host rebind transaction
 * (`docs/remote-host-cross-store-design.md` §4.3, §5.1, §5.4).
 *
 * The journal is a write-ahead hint, not the source of truth: the authoritative progress signal is
 * the per-record `beforeLocator` / `afterLocator` comparison against what the stores actually hold,
 * so a stale or missing `stage` can never cause a wrong action (design §4.3). That comparison and the
 * rest of the phased algorithm live in `HostRebindConvergence.ts`; the tx lock lives in
 * `HostRebindTxLock.ts`. This module is the facade: contracts, stable-code vocabulary, file I/O and
 * `resume()`.
 *
 * Failure semantics (stable codes): every failure leaves this module as one of `HOST_REBIND_CODES`,
 * a pass-through code from `REMOTE_HOST_STORE_CODES` / `HOST_REFERENCE_REGISTRY_CODES` /
 * `HOST_REBIND_STORE_PORT_CODES`, or `REMOTE_HOST_REBIND_UNKNOWN_OUTCOME`. Anything else (errno,
 * port text, stack messages) is folded into a stable code: nothing else may escape. The folding
 * itself is done by the convergence module, which receives `isStableJournalCode` below — the code
 * lists stay defined here, once.
 */
import { lstat, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { convergeRebindJournal, isRebindLocator, isRebindRecordId } from "./HostRebindConvergence";
import { REBIND_TX_LOCK_UNWRITABLE, acquireRebindTxLock, currentBootId, defaultIsProcessAlive } from "./HostRebindTxLock";
import { writeDurableJsonFile } from "../persistence/durableJsonStore";

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
	REBIND_TX_LOCK_UNWRITABLE,
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

/** The vocabulary the convergence module folds failures into: this module's codes, defined once here. */
function isStableJournalCode(code: string): boolean {
	return isHostRebindCode(code) || isHostRebindStorePortCode(code);
}

function isRebindStage(value: unknown): value is RebindStage {
	return typeof value === "string" && REBIND_STAGE_SET.has(value);
}

const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 10_000;

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
 * Canonical JSON of a locator (port contract, §4.4). Keys are emitted in sorted order and `undefined`
 * fields are dropped, so the same locator always yields the same bytes no matter which writer built
 * the object. This matters because both the journal's per-record comparison (`classifyRebindRecord` in
 * `HostRebindConvergence.ts`) and every store port's CAS compare these strings byte-wise: a planner
 * that encodes `beforeLocator` / `afterLocator` differently would turn every record into `changed`
 * (stale plan), never into a write.
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

/** One record id of the shape the journal decoder accepts (`isRebindRecordId`), for port callers. */
export function isHostRebindRecordId(value: unknown): value is string {
	return isRebindRecordId(value);
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

function invalidJournal(): never {
	throw new Error("REMOTE_HOST_REBIND_JOURNAL_INVALID");
}

/** Strict decode: an unreadable journal is never guessed at and never deleted (design §5.4 step 2). */
export function decodeRebindJournal(value: unknown): RebindJournal {
	if (!isRecord(value)) invalidJournal();
	for (const key of Object.keys(value)) if (!["schemaVersion", "txId", "createdAt", "stage", "source", "target", "expectedHostRevision", "records", "referenceScan"].includes(key)) invalidJournal();
	if (value.schemaVersion !== 1 || !isRebindRecordId(value.txId) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) invalidJournal();
	if (!isRebindStage(value.stage)) invalidJournal();
	const source = value.source;
	const target = value.target;
	if (!isRecord(source) || !isRecord(target)) invalidJournal();
	if (!isRebindRecordId(source.hostId) || typeof source.endpointDigest !== "string" || typeof source.disabled !== "boolean") invalidJournal();
	if (!isRebindRecordId(target.hostId) || typeof target.endpointDigest !== "string" || typeof target.knownHostsSha256 !== "string") invalidJournal();
	if (!Number.isSafeInteger(value.expectedHostRevision) || Number(value.expectedHostRevision) < 0) invalidJournal();
	if (!Array.isArray(value.records) || value.records.length > MAX_RECORDS) invalidJournal();
	const records: RebindRecordPlan[] = [];
	for (const record of value.records) {
		if (!isRecord(record)) invalidJournal();
		if (record.store !== "projects" && record.store !== "sessions") invalidJournal();
		if (!isRebindRecordId(record.recordId) || !isRebindLocator(record.beforeLocator) || !isRebindLocator(record.afterLocator)) invalidJournal();
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

/**
 * Journal file plus the lock-guarded convergence entry point. The path layout and the durable file live
 * here; the tx lock (`HostRebindTxLock.ts`) and the algorithm (`HostRebindConvergence.ts`) do not.
 * This class structurally satisfies the convergence module's `RebindJournalIo` (`write` / `remove`).
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
		const lock = await acquireRebindTxLock({ userDataDir: this.userDataDir, lockPath: this.lockPath, bootId: this.bootId, now: this.now, isProcessAlive: this.isProcessAlive });
		if (lock === undefined) return undefined;
		try {
			return await convergeRebindJournal(this, journal, ports, isStableJournalCode);
		} finally {
			await lock.release();
		}
	}
}
