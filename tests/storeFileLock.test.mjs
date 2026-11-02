import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { acquireStoreFileLock, classifyStoreFileLockOwner, isAbandonedUnreadableLockFile } = loadTsCommonJs("src/main/persistence/StoreFileLock.ts");

const BOOT_ID = "boot-1";
const OWN_PID = process.pid;
const OTHER_PID = OWN_PID + 1;
const NOW = Date.UTC(2026, 10, 1, 8, 0, 0);
/** Older than the 10s unreadable-lock grace window the acquire path uses. */
const ABANDONED_AGE_MS = 60_000;

function optionsOf(lockPath, { bootId = BOOT_ID, alive = false, now = NOW } = {}) {
	return {
		rootDir: dirname(lockPath),
		lockPath,
		unwritableCode: "TEST_STORE_LOCK_UNWRITABLE",
		bootId,
		isProcessAlive: () => alive,
		now: () => now,
	};
}

/** Plant a lock file the way a crashed writer would leave it: content as given, mtime aged back. */
async function plantLock(lockPath, text, { ageMs }) {
	await writeFile(lockPath, text, "utf8");
	if (ageMs === undefined) return;
	const at = new Date(NOW - ageMs);
	await utimes(lockPath, at, at);
}

async function withLockDir(run) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-store-file-lock-"));
	const lockPath = join(directory, "store.lock");
	try {
		await run(lockPath);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("a 0-byte lock file left by a killed writer is reclaimed instead of failing forever", async () => {
	// The reported bug: `open(wx)` publishes the lock empty and the owner JSON lands in the next
	// write, so quit-and-install can leave a 0-byte file behind. It parses as no owner, and a
	// restart cannot help while that file reads as "live".
	await withLockDir(async (lockPath) => {
		await plantLock(lockPath, "", { ageMs: ABANDONED_AGE_MS });
		const lock = await acquireStoreFileLock(optionsOf(lockPath));
		assert.notEqual(lock, undefined);
		const written = JSON.parse(await readFile(lockPath, "utf8"));
		assert.equal(written.pid, OWN_PID);
		assert.equal(written.bootId, BOOT_ID);
		await lock.release();
		await assert.rejects(stat(lockPath), { code: "ENOENT" });
	});
});

test("an unreadable lock file that is still fresh is treated as a mid-write lock", async () => {
	// A lock created microseconds ago may belong to a writer that is about to fill it in; stealing
	// it would hand two writers the same store.
	await withLockDir(async (lockPath) => {
		await plantLock(lockPath, "", { ageMs: 0 });
		assert.equal(await acquireStoreFileLock(optionsOf(lockPath)), undefined);
		assert.equal(await readFile(lockPath, "utf8"), "");
	});
});

test("unparseable and oversized lock files follow the same age rule", async () => {
	await withLockDir(async (lockPath) => {
		for (const text of ['{"pid":', '{"pid":"x","bootId":"b","startedAt":"t"}', "x".repeat(5000)]) {
			await plantLock(lockPath, text, { ageMs: ABANDONED_AGE_MS });
			const lock = await acquireStoreFileLock(optionsOf(lockPath));
			assert.notEqual(lock, undefined, `abandoned lock ${JSON.stringify(text.slice(0, 16))} must be reclaimed`);
			await lock.release();
		}
	});
});

test("a live owner's lock is never stolen", async () => {
	await withLockDir(async (lockPath) => {
		for (const owner of [
			{ pid: OTHER_PID, bootId: BOOT_ID, startedAt: "2026-11-01T07:00:00.000Z" },
			{ pid: OWN_PID, bootId: BOOT_ID, startedAt: "2026-11-01T07:00:00.000Z" },
		]) {
			await plantLock(lockPath, JSON.stringify(owner), { ageMs: ABANDONED_AGE_MS });
			assert.equal(await acquireStoreFileLock(optionsOf(lockPath, { alive: true })), undefined);
			assert.equal(await readFile(lockPath, "utf8"), JSON.stringify(owner));
		}
	});
});

test("a dead owner or a foreign boot id is reclaimed even when the file is old", async () => {
	await withLockDir(async (lockPath) => {
		const dead = JSON.stringify({ pid: OTHER_PID, bootId: BOOT_ID, startedAt: "2026-11-01T07:00:00.000Z" });
		await plantLock(lockPath, dead, { ageMs: ABANDONED_AGE_MS });
		const lock = await acquireStoreFileLock(optionsOf(lockPath, { alive: false }));
		assert.notEqual(lock, undefined);
		await lock.release();

		const reusedPid = JSON.stringify({ pid: OTHER_PID, bootId: "boot-0", startedAt: "2026-11-01T07:00:00.000Z" });
		await plantLock(lockPath, reusedPid, { ageMs: 0 });
		const reclaimed = await acquireStoreFileLock(optionsOf(lockPath, { alive: true }));
		assert.notEqual(reclaimed, undefined);
		await reclaimed.release();
	});
});

test("release is idempotent and a vanished lock does not look like contention", async () => {
	await withLockDir(async (lockPath) => {
		const lock = await acquireStoreFileLock(optionsOf(lockPath));
		assert.notEqual(lock, undefined);
		await lock.release();
		await lock.release();
		// No lock file at all: the next acquire must succeed rather than report busy.
		const again = await acquireStoreFileLock(optionsOf(lockPath));
		assert.notEqual(again, undefined);
		await again.release();
	});
});

test("a store mutation takes over an abandoned 0-byte lock instead of reporting its busy code", async () => {
	// The reported symptom: `sessions:catalog-create-draft` fails with SESSION_CATALOG_BUSY forever
	// because the leftover lock file outlives the crash. It must heal on the next mutation.
	const { withStoreFileCas } = loadTsCommonJs("src/main/persistence/storeFileCas.ts");
	await withLockDir(async (lockPath) => {
		const options = {
			rootDir: dirname(lockPath),
			lockPath,
			unwritableCode: "TEST_STORE_LOCK_UNWRITABLE",
			busyCode: "SESSION_CATALOG_BUSY",
			conflictCode: "TEST_STORE_CONFLICT",
			readFresh: async () => ({ state: { n: 0 }, revision: 0 }),
			mutate: (state) => ({ state: { n: state.n + 1 }, changed: true, value: "committed" }),
			write: async () => {},
			bootId: BOOT_ID,
			isProcessAlive: () => false,
			now: () => NOW,
		};

		await plantLock(lockPath, "", { ageMs: ABANDONED_AGE_MS });
		assert.equal(await withStoreFileCas(options), "committed");
		await assert.rejects(stat(lockPath), { code: "ENOENT" });

		await plantLock(lockPath, "", { ageMs: 0 });
		await assert.rejects(withStoreFileCas(options), { message: "SESSION_CATALOG_BUSY" });
	});
});

test("the age rule only reclaims what is older than the write window, and never guesses", () => {
	assert.equal(isAbandonedUnreadableLockFile(undefined, NOW), false);
	assert.equal(isAbandonedUnreadableLockFile(NOW - 500, NOW), false);
	assert.equal(isAbandonedUnreadableLockFile(NOW - 9_000, NOW), false);
	assert.equal(isAbandonedUnreadableLockFile(NOW - 10_000, NOW), true);
	assert.equal(isAbandonedUnreadableLockFile(NOW + 60_000, NOW), false);
	// The owner rule stays untouched: no owner metadata is still not proof of death.
	assert.equal(classifyStoreFileLockOwner(undefined, { pid: OWN_PID, bootId: BOOT_ID, isProcessAlive: () => false }), "live");
});
