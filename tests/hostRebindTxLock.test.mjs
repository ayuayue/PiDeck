import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { classifyRebindTxLockOwner } = loadTsCommonJs("src/main/remote/HostRebindTxLock.ts");

const OWN_PID = 4242;
const OTHER_PID = 5150;

/** A probe standing in for "this process": the three facts R6 compares a lock owner against. */
function probeOf({ bootId = "boot-1", alive = true } = {}) {
	return { pid: OWN_PID, bootId, isProcessAlive: () => alive };
}

function ownerOf(overrides = {}) {
	return { pid: OTHER_PID, bootId: "boot-1", startedAt: "2026-09-01T00:00:00.000Z", ...overrides };
}

test("a lock whose owner cannot be read is treated as live, never as stale", () => {
	// Fail closed (§5.4 step 2): no owner metadata is not proof of death, and there is no timeout
	// preemption — stealing an opaque lock would create two writers.
	for (const probe of [probeOf({ alive: false }), probeOf({ alive: true }), probeOf({ bootId: "boot-2", alive: false })]) {
		assert.equal(classifyRebindTxLockOwner(undefined, probe), "live");
	}
});

test("a lock recorded by our own pid is live even when the probe denies it", () => {
	// Our process obviously still runs; the probe and the boot id must not be consulted here.
	assert.equal(classifyRebindTxLockOwner(ownerOf({ pid: OWN_PID }), probeOf({ alive: false })), "live");
	assert.equal(classifyRebindTxLockOwner(ownerOf({ pid: OWN_PID, bootId: "boot-1" }), probeOf({ bootId: "boot-2", alive: false })), "live");
});

test("an owner from this boot is judged by the liveness probe", () => {
	assert.equal(classifyRebindTxLockOwner(ownerOf(), probeOf({ alive: true })), "live");
	assert.equal(classifyRebindTxLockOwner(ownerOf(), probeOf({ alive: false })), "stale");
});

test("a different boot id proves pid reuse, so the lock is stale without asking the probe", () => {
	// The recorded pid may well be alive — as somebody else's process. Consulting the probe here would
	// keep a crashed writer's lock forever.
	const probe = {
		pid: OWN_PID,
		bootId: "boot-2",
		isProcessAlive: () => {
			throw new Error("the probe must not be consulted once pid reuse is proven");
		},
	};
	assert.equal(classifyRebindTxLockOwner(ownerOf(), probe), "stale");
	assert.equal(classifyRebindTxLockOwner(ownerOf({ pid: 1, startedAt: "2020-01-01T00:00:00.000Z" }), probe), "stale");
});
