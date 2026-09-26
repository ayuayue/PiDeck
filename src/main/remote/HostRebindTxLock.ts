/**
 * Transaction lock + boot identity for the cross-store host rebind transaction
 * (`docs/remote-host-cross-store-design.md` §5.1 R1/R4/R6).
 *
 * Owns:
 * - the lock owner shape `{ pid, bootId, startedAt }` and the boot identity it is compared against
 *   (`currentBootId` derives it from uptime, so no `/proc` and no platform branch is needed);
 * - the R6 liveness decision, exposed as the pure `classifyRebindTxLockOwner` so "may this lock be
 *   reclaimed?" can be tested without a filesystem and without a second process;
 * - create / reclaim / release of `<userDataDir>/remote-host-rebind.lock`.
 *
 * Does not own:
 * - the journal file, its decode rules and the convergence algorithm (`HostRebindJournal.ts`): this
 *   module never reads or writes the journal, and it answers "give up this recovery" (returns
 *   `undefined`) instead of deciding what recovery should do;
 * - the journal's `<userDataDir>` validation and path layout (the journal constructor owns those,
 *   this module receives an already validated directory plus the exact lock path);
 * - the stable-code vocabulary: the single code thrown here is exported so `HOST_REBIND_CODES` can
 *   reference it, which keeps one authoritative list instead of two literals that could drift.
 *
 * Dependency note: this module deliberately imports nothing from `./*`. Both `HostRebindJournal` and
 * `RemoteHostRepair` need the boot identity, so a home on either side would have created a cycle.
 */
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { uptime } from "node:os";

/** The one stable code this module throws; `HOST_REBIND_CODES` references it. */
export const REBIND_TX_LOCK_UNWRITABLE = "REMOTE_HOST_REBIND_TX_LOCK_UNWRITABLE";

const MAX_LOCK_BYTES = 4096;

export type HostRebindTxLockOwner = { readonly pid: number; readonly bootId: string; readonly startedAt: string };

/** What "this owner is still alive" is judged against: our own pid, our boot id, and the liveness probe. */
export type HostRebindTxLockProbe = {
	/** The observing process: a lock owned by this pid is always live, because it is us. */
	readonly pid: number;
	readonly bootId: string;
	/** Injectable process liveness probe (§5.1 R6); defaults to a `kill(pid, 0)`-based check. */
	readonly isProcessAlive: (pid: number) => boolean;
};

export type HostRebindTxLock = { release(): Promise<void> };

export type HostRebindTxLockOptions = {
	readonly userDataDir: string;
	/** `<userDataDir>/remote-host-rebind.lock`; passed in so the path layout stays defined in one place. */
	readonly lockPath: string;
	/** The injected boot identity of the acquiring process (§5.1 R6). */
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
 * R6: only a provably dead owner may be preempted, and "unreadable" is not "dead" — an opaque or
 * half-written lock could still belong to a live writer, and stealing it would create two writers
 * (§5.4 step 2 fails closed the same way). A different boot id proves the recorded pid belongs to
 * some other process now, so that owner is stale even if a process with that pid exists.
 */
export function classifyRebindTxLockOwner(owner: HostRebindTxLockOwner | undefined, probe: HostRebindTxLockProbe): "live" | "stale" {
	if (owner === undefined) return "live";
	// Our own pid always holds the lock: re-entering here would mean a bug, never a reclaim.
	if (owner.pid === probe.pid) return "live";
	if (owner.bootId !== probe.bootId) return "stale";
	return probe.isProcessAlive(owner.pid) ? "live" : "stale";
}

/** Owner metadata read fail-closed: unreadable, garbage or mis-sized all mean "cannot be judged". */
async function readLockOwner(lockPath: string): Promise<HostRebindTxLockOwner | undefined> {
	let text: string;
	try {
		const stats = await lstat(lockPath);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0 || stats.size > MAX_LOCK_BYTES) return undefined;
		text = await readFile(lockPath, "utf8");
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

/**
 * Acquire the tx mutex, or `undefined` when another live process holds it (R4: give up this recovery
 * instead of waiting). The file is created with "wx" so it is a real cross-process mutex, and a
 * provably stale owner is reclaimed at most once (one retry, then give up). `release` is idempotent:
 * a lock that is already gone is exactly the released state.
 */
export async function acquireRebindTxLock(options: HostRebindTxLockOptions): Promise<HostRebindTxLock | undefined> {
	await mkdir(options.userDataDir, { recursive: true });
	const owner: HostRebindTxLockOwner = { pid: process.pid, bootId: options.bootId, startedAt: new Date(options.now()).toISOString() };
	const probe: HostRebindTxLockProbe = { pid: process.pid, bootId: options.bootId, isProcessAlive: options.isProcessAlive };
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
			if (errorCode(error) !== "EEXIST") throw new Error(REBIND_TX_LOCK_UNWRITABLE);
			const existing = await readLockOwner(options.lockPath);
			if (classifyRebindTxLockOwner(existing, probe) === "live") return undefined;
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
