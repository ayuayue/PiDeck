/**
 * Generic cross-process file lock for the persisted stores (`projects.json`, `session-catalog.json`,
 * `remote-hosts.json`) and the host-rebind transaction.
 *
 * Owns:
 * - the lock owner shape `{ pid, bootId, startedAt }` and the boot identity it is compared against
 *   (`currentBootId` derives it from uptime, so no `/proc` and no platform branch is needed);
 * - the liveness decision, exposed as the pure `classifyStoreFileLockOwner` so "may this lock be
 *   reclaimed?" can be tested without a filesystem and without a second process, plus the age rule
 *   (`isAbandonedUnreadableLockFile`) that keeps an unreadable lock file from blocking forever;
 * - create / reclaim / release of one `<root>/<name>.lock` file.
 *
 * Does not own: what the lock protects, how long the holder keeps it, or what happens when the
 * acquisition fails. Each caller passes its own stable codes so a refusal stays attributable
 * (`PROJECT_STORE_BUSY` cannot be mistaken for `REMOTE_HOST_REBIND_TX_LOCK_UNWRITABLE`).
 *
 * Why one shared implementation: the owner/reclaim rules are the safety argument ("only a provably
 * dead owner may be preempted"). A second copy of them would drift, and the copy that drifts is the
 * one that hands two writers the same file.
 */
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { uptime } from "node:os";

const MAX_LOCK_BYTES = 4096;

/**
 * How long a lock file whose owner cannot be read must sit unchanged before it may be reclaimed.
 *
 * `open(..., "wx")` publishes the lock file empty and the owner JSON lands in the very next write, so
 * a holder killed in between (quit-and-install, task-manager kill) leaves a 0-byte file that parses
 * as nothing. Without an age bound that residue reads as "live" forever: every later mutation fails
 * with the store's busy code and a restart cannot help, because the file survives the restart. A
 * *fresh* unreadable file is still treated as live — it may belong to a writer that is about to fill
 * it in, and stealing it would hand two writers the same store. Owner metadata is written within a
 * few microseconds of the create, so anything unreadable for this long is abandoned.
 */
const UNREADABLE_LOCK_GRACE_MS = 10_000;

export type StoreFileLockOwner = { readonly pid: number; readonly bootId: string; readonly startedAt: string };

/** What "this owner is still alive" is judged against: our own pid, our boot id, and the liveness probe. */
export type StoreFileLockProbe = {
	/** The observing process: a lock owned by this pid is always live, because it is us. */
	readonly pid: number;
	readonly bootId: string;
	/** Injectable process liveness probe; defaults to a `kill(pid, 0)`-based check. */
	readonly isProcessAlive: (pid: number) => boolean;
};

export type StoreFileLock = { release(): Promise<void> };

export type StoreFileLockOptions = {
	/** Directory that must exist before the lock file can be created. */
	readonly rootDir: string;
	/** The lock file itself; passed in so the path layout stays defined in one place per domain. */
	readonly lockPath: string;
	/** Stable code thrown when the lock directory cannot be written (that is not contention). */
	readonly unwritableCode: string;
	/** The injected boot identity of the acquiring process. */
	readonly bootId: string;
	readonly isProcessAlive: (pid: number) => boolean;
	readonly now: () => number;
};

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Boot identity without /proc: two processes on the same boot derive the same value. */
export function currentBootId(): string {
	return String(Math.round((Date.now() - uptime() * 1000) / 1000));
}

export function defaultIsProcessAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM still proves the pid exists; only ESRCH proves it is gone.
		return errorCode(error) !== "ESRCH";
	}
}

/**
 * Only a provably dead owner may be preempted, and "unreadable" is not "dead" — an opaque or
 * half-written lock could still belong to a live writer, and stealing it would create two writers.
 * A different boot id proves the recorded pid belongs to some other process now, so that owner is
 * stale even if a process with that pid exists.
 */
export function classifyStoreFileLockOwner(owner: StoreFileLockOwner | undefined, probe: StoreFileLockProbe): "live" | "stale" {
	if (owner === undefined) return "live";
	// Our own pid always holds the lock: re-entering here would mean a bug, never a reclaim.
	if (owner.pid === probe.pid) return "live";
	if (owner.bootId !== probe.bootId) return "stale";
	return probe.isProcessAlive(owner.pid) ? "live" : "stale";
}

/**
 * What one look at the lock file found. `modifiedAtMs` is carried for the unreadable case only: the
 * owner cannot be judged, but the file's age still can, which is what tells a mid-write lock from
 * a crashed one. `undefined` means the age is unknown (e.g. `lstat` itself was refused), i.e. it
 * must not be reclaimed.
 */
type StoreFileLockState = { readonly kind: "missing" } | { readonly kind: "owner"; readonly owner: StoreFileLockOwner } | { readonly kind: "unreadable"; readonly modifiedAtMs: number | undefined };

/** Owner metadata read fail-closed: unreadable, garbage or mis-sized all mean "cannot be judged". */
async function readLockFileState(lockPath: string): Promise<StoreFileLockState> {
	let stats;
	try {
		stats = await lstat(lockPath);
	} catch (error) {
		// Gone is not unreadable: the holder released it, so the next exclusive create may succeed.
		return errorCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "unreadable", modifiedAtMs: undefined };
	}
	if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0 || stats.size > MAX_LOCK_BYTES) return { kind: "unreadable", modifiedAtMs: stats.mtimeMs };
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(lockPath, "utf8"));
	} catch {
		return { kind: "unreadable", modifiedAtMs: stats.mtimeMs };
	}
	if (!isRecord(parsed) || !Number.isSafeInteger(parsed.pid) || Number(parsed.pid) < 1 || typeof parsed.bootId !== "string" || typeof parsed.startedAt !== "string") {
		return { kind: "unreadable", modifiedAtMs: stats.mtimeMs };
	}
	return { kind: "owner", owner: { pid: Number(parsed.pid), bootId: parsed.bootId, startedAt: parsed.startedAt } };
}

/**
 * Whether an unreadable lock file is abandoned residue rather than a mid-write lock. Kept separate
 * from `classifyStoreFileLockOwner` so the owner rule stays a pure function of the recorded owner:
 * "no owner metadata" alone is still not proof of death, but an unreadable file that has not
 * changed for longer than the write window cannot belong to a writer that is still running.
 */
export function isAbandonedUnreadableLockFile(modifiedAtMs: number | undefined, now: number): boolean {
	if (modifiedAtMs === undefined) return false;
	// A future mtime (system clock moved back) is not evidence of age either.
	return now - modifiedAtMs >= UNREADABLE_LOCK_GRACE_MS;
}

/**
 * Acquire the mutex, or `undefined` when another live process holds it. Callers give up instead of
 * waiting (a store that blocks on another instance looks like a hang, not like a conflict). The file
 * is created with "wx" so it is a real cross-process mutex, and a stale owner — provably dead, or
 * unreadable and older than the write window — is reclaimed at most once (one retry, then give up).
 * `release` is idempotent: a lock that is already gone is exactly the released state.
 */
export async function acquireStoreFileLock(options: StoreFileLockOptions): Promise<StoreFileLock | undefined> {
	await mkdir(options.rootDir, { recursive: true });
	const owner: StoreFileLockOwner = { pid: process.pid, bootId: options.bootId, startedAt: new Date(options.now()).toISOString() };
	const probe: StoreFileLockProbe = { pid: process.pid, bootId: options.bootId, isProcessAlive: options.isProcessAlive };
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await open(options.lockPath, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
			} finally {
				await handle.close();
			}
			return {
				release: async () => {
					try {
						await unlink(options.lockPath);
					} catch {
						// Already gone: that is the released state.
					}
				},
			};
		} catch (error) {
			// Anything but "somebody else made it first" is an unwritable lock directory, not contention.
			if (errorCode(error) !== "EEXIST") throw new Error(options.unwritableCode);
			const existing = await readLockFileState(options.lockPath);
			// Released between our create attempt and this read: retry the exclusive create.
			if (existing.kind === "missing") continue;
			const reclaimable = existing.kind === "owner" ? classifyStoreFileLockOwner(existing.owner, probe) === "stale" : isAbandonedUnreadableLockFile(existing.modifiedAtMs, options.now());
			if (!reclaimable) return undefined;
			try {
				await unlink(options.lockPath);
			} catch {
				// The stale lock vanished under us (or cannot be removed): give up rather than spin.
				return undefined;
			}
		}
	}
	return undefined;
}
