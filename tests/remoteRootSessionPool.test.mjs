import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRootSessionPool, ROOT_POOL_DEFAULT_POLICY } = loadTsCommonJs("src/main/remote/RemoteRootSessionPool.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const ROOT_A = "/srv/projects/a";
const ROOT_B = "/srv/projects/b";
const ROOT_C = "/srv/projects/c";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Build a pool whose establishment is observable; every established session gets an id. */
function harness(options = {}) {
	const established = [];
	const retired = [];
	const retiredEvents = [];
	let sequence = 0;
	const pool = createRootSessionPool({
		policy: { acquireTimeoutMs: 200, ...(options.policy ?? {}) },
		...(options.now === undefined ? {} : { now: options.now }),
		establish: async (key, signal) => {
			if (options.defer === true) await options.gate.promise;
			throwIfAborted(signal);
			sequence += 1;
			const value = { id: sequence, root: key.root };
			established.push({ key, value });
			return value;
		},
		retire: async (entry, reason) => {
			retired.push({ key: entry.key, id: entry.value.id, reason });
		},
		identity: (value) => value.id + ":" + value.root,
		onRetired: (event) => retiredEvents.push(event),
	});
	return { pool, established, retired, retiredEvents };
}

function throwIfAborted(signal) {
	if (signal?.aborted === true) throw new Error("REQUEST_CANCELLED");
}

test("the same root reuses one session and never re-establishes", async () => {
	const { pool, established } = harness();
	const first = await pool.acquire({ hostId: HOST, root: ROOT_A });
	const second = await pool.acquire({ hostId: HOST, root: ROOT_A });
	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal(established.length, 1, "a second lease on the same root must not build another helper");
	assert.equal(first.lease.value.id, second.lease.value.id);
	assert.equal(first.lease.connectionId, second.lease.connectionId);
	assert.equal(pool.stats().hits, 1);
	assert.equal(pool.stats().created, 1);
	first.lease.release();
	second.lease.release();
});

test("three projects on one host keep three independent sessions", async () => {
	const { pool, established } = harness();
	const leases = [];
	for (const root of [ROOT_A, ROOT_B, ROOT_C]) {
		const acquired = await pool.acquire({ hostId: HOST, root });
		assert.equal(acquired.ok, true);
		leases.push(acquired.lease);
	}
	assert.equal(established.length, 3);
	assert.deepEqual(
		leases.map((lease) => lease.value.root),
		[ROOT_A, ROOT_B, ROOT_C],
	);
	assert.equal(new Set(leases.map((lease) => lease.connectionId)).size, 3, "each root owns its own session identity");
	for (const lease of leases) {
		assert.equal(pool.peek(HOST, lease.root).value.id, lease.value.id, "peek must answer per root, never a sibling");
	}
	for (const lease of leases) lease.release();
	assert.equal(pool.stats().created, 3);
});

test("concurrent acquires of one root establish exactly once and all get leases", async () => {
	let resolveGate;
	const gate = new Promise((resolve) => {
		resolveGate = resolve;
	});
	const established = [];
	const pool = createRootSessionPool({
		establish: async (key) => {
			await gate;
			const value = { root: key.root };
			established.push(value);
			return value;
		},
		retire: () => undefined,
		identity: (value) => value.root,
	});
	const pending = [pool.acquire({ hostId: HOST, root: ROOT_A }), pool.acquire({ hostId: HOST, root: ROOT_A }), pool.acquire({ hostId: HOST, root: ROOT_A })];
	resolveGate();
	const results = await Promise.all(pending);
	assert.equal(established.length, 1, "same-key concurrency must merge into one establishment");
	assert.deepEqual(
		results.map((result) => result.ok),
		[true, true, true],
	);
	for (const result of results) result.lease.release();
});

test("maintaining a sibling root never invalidates the session another project is using", async () => {
	const { pool, retired } = harness();
	const a = await pool.acquire({ hostId: HOST, root: ROOT_A });
	const before = a.lease.connectionId;
	// B is read, its lease released: A keeps its own session and identity the whole time.
	const b = await pool.acquire({ hostId: HOST, root: ROOT_B });
	b.lease.release();
	assert.equal(pool.peek(HOST, ROOT_A).connectionId, before);
	assert.equal(retired.length, 0, "no root may be retired just because a sibling was visited");
	const again = await pool.acquire({ hostId: HOST, root: ROOT_A });
	assert.equal(again.lease.connectionId, before);
	again.lease.release();
	a.lease.release();
});

test("evidence the pool never hands out a sibling root's session", async () => {
	const { pool } = harness();
	const a = await pool.acquire({ hostId: HOST, root: ROOT_A });
	const b = await pool.acquire({ hostId: HOST, root: ROOT_B });
	assert.notEqual(a.lease.value.id, b.lease.value.id);
	assert.ok(!Object.is(a.lease.value, b.lease.value));
	assert.equal(pool.peek(HOST, ROOT_A).value.root, ROOT_A);
	assert.equal(pool.peek(HOST, ROOT_B).value.root, ROOT_B);
	assert.equal(pool.peek(HOST, ROOT_C), undefined);
	a.lease.release();
	b.lease.release();
});

test("a leased entry is never evicted, however long it lives", async () => {
	let clock = 0;
	const { pool, retired } = harness({ now: () => clock, policy: { idleTtlMs: 1000, idleCapacity: 0, maxEntries: 2 } });
	const a = await pool.acquire({ hostId: HOST, root: ROOT_A });
	clock = 10 * 60_000;
	await pool.sweep(clock);
	assert.equal(pool.peek(HOST, ROOT_A) !== undefined, true, "an in-flight operation must survive TTL");
	assert.equal(retired.length, 0);
	// A second root can still be opened: the active entry occupies the budget, not a project slot.
	const b = await pool.acquire({ hostId: HOST, root: ROOT_B });
	assert.equal(b.ok, true);
	b.lease.release();
	a.lease.release();
});

test("watched sessions stay warm; releasing the watch makes them collectable", async () => {
	let clock = 0;
	const { pool, retired } = harness({ now: () => clock, policy: { idleTtlMs: 10 * 60_000, idleCapacity: 0, maxEntries: 4 } });
	const a = await pool.acquire({ hostId: HOST, root: ROOT_A });
	a.lease.release();
	assert.equal(pool.retainWatch(HOST, ROOT_A), true);
	// A competing idle entry exists, so the sweep has a victim it is allowed to take.
	const b = await pool.acquire({ hostId: HOST, root: ROOT_B });
	b.lease.release();
	clock = 60_000;
	await pool.sweep(clock);
	assert.equal(pool.peek(HOST, ROOT_A) !== undefined, true, "a registered watcher must keep its session alive");
	assert.equal(pool.peek(HOST, ROOT_B), undefined, "the unwatched idle entry is the one recycled");
	assert.deepEqual(
		retired.map((entry) => entry.reason),
		["lru"],
	);
	// Releasing the watch only makes the entry collectable; the next sweep is then allowed to take it.
	pool.releaseWatch(HOST, ROOT_A);
	assert.equal(pool.retainWatch(HOST, "unknown-root"), false, "no session means nothing to keep alive");
	await pool.sweep(clock);
	assert.equal(pool.peek(HOST, ROOT_A), undefined);
	assert.deepEqual(
		retired.map((entry) => entry.reason),
		["lru", "lru"],
	);
});

test("idle entries expire after the keep-warm TTL, and only idle ones", async () => {
	let clock = 0;
	const { pool, retired } = harness({ now: () => clock, policy: { idleTtlMs: 1000, idleCapacity: 2 } });
	const warm = await pool.acquire({ hostId: HOST, root: ROOT_A });
	warm.lease.release();
	clock = 1_000;
	await pool.sweep(clock);
	assert.equal(pool.peek(HOST, ROOT_A), undefined);
	assert.deepEqual(
		retired.map((entry) => entry.reason),
		["ttl"],
	);
	// An entry used again after the TTL deadline is refreshed, not collected behind the operation's back.
	const reused = await pool.acquire({ hostId: HOST, root: ROOT_A });
	reused.lease.release();
	clock += 500;
	await pool.sweep(clock);
	assert.equal(pool.peek(HOST, ROOT_A) !== undefined, true);
});

test("idle keep-warm capacity is a warm-set bound, not a project limit", async () => {
	let clock = 0;
	const { pool, retired } = harness({ now: () => clock, policy: { idleCapacity: 2, idleTtlMs: 60_000, maxEntries: 8 } });
	const leases = [];
	for (const root of [ROOT_A, ROOT_B, ROOT_C]) {
		const acquired = await pool.acquire({ hostId: HOST, root });
		leases.push(acquired.lease);
	}
	// Three projects are registered and open at the same time even though only two may stay warm.
	assert.equal(pool.stats().entries, 3);
	for (const lease of leases) lease.release();
	await pool.sweep(clock);
	assert.equal(pool.stats().entries, 2, "only the warm set remains after the capacity sweep");
	assert.deepEqual(
		retired.map((entry) => entry.key.root),
		[ROOT_A],
		"the least recently used idle entry is the one dropped",
	);
});

test("when the budget is full the pool waits, then rejects with a stable code", async () => {
	const { pool } = harness({ policy: { maxEntries: 1, acquireTimeoutMs: 25 } });
	const held = await pool.acquire({ hostId: HOST, root: ROOT_A });
	const start = Date.now();
	const blocked = await pool.acquire({ hostId: HOST, root: ROOT_B });
	assert.equal(blocked.ok, false);
	assert.equal(blocked.code, "SSH_ROOT_POOL_BUSY");
	assert.ok(Date.now() - start >= 20, "the wait must be bounded but actually bounded by the configured budget");
	assert.equal(pool.stats().waitTimeouts, 1);
	held.lease.release();
	// Once a slot frees, the same root is accepted again.
	const after = await pool.acquire({ hostId: HOST, root: ROOT_B });
	assert.equal(after.ok, true);
	after.lease.release();
});

test("a queued acquire is served as soon as a slot is released", async () => {
	const { pool, established } = harness({ policy: { maxEntries: 1, acquireTimeoutMs: 500 } });
	const held = await pool.acquire({ hostId: HOST, root: ROOT_A });
	const queued = pool.acquire({ hostId: HOST, root: ROOT_B });
	await settle();
	assert.equal(established.length, 1, "the queued root must not build while the budget is full");
	held.lease.release();
	const served = await queued;
	assert.equal(served.ok, true);
	assert.equal(established.length, 2);
	served.lease.release();
});

test("a cancelled acquire reports the caller's withdrawal and never builds", async () => {
	const { pool, established } = harness({ policy: { maxEntries: 1, acquireTimeoutMs: 500 } });
	const held = await pool.acquire({ hostId: HOST, root: ROOT_A });
	const controller = new AbortController();
	const queued = pool.acquire({ hostId: HOST, root: ROOT_B }, { signal: controller.signal });
	await settle();
	controller.abort();
	const settled = await queued;
	assert.equal(settled.ok, false);
	assert.equal(settled.code, "REQUEST_CANCELLED");
	assert.equal(established.length, 1);
	held.lease.release();
});

test("retiring one root disposes only that root and reports it separately", async () => {
	const { pool, retired, retiredEvents } = harness();
	const a = await pool.acquire({ hostId: HOST, root: ROOT_A });
	const b = await pool.acquire({ hostId: HOST, root: ROOT_B });
	a.lease.release();
	b.lease.release();
	await pool.retireRoot(HOST, ROOT_A, "explicit");
	assert.deepEqual(
		retired.map((entry) => entry.key.root),
		[ROOT_A],
	);
	assert.equal(pool.peek(HOST, ROOT_A), undefined);
	assert.notEqual(pool.peek(HOST, ROOT_B), undefined, "retiring a root must not touch its neighbours");
	assert.deepEqual(
		retiredEvents.map((event) => ({ hostId: event.hostId, root: event.root, reason: event.reason })),
		[{ hostId: HOST, root: ROOT_A, reason: "explicit" }],
	);
});

test("retiring a host clears every root of that host only", async () => {
	const other = "22222222-2222-4222-8222-222222222222";
	const { pool, retired } = harness();
	const a = await pool.acquire({ hostId: HOST, root: ROOT_A });
	const b = await pool.acquire({ hostId: HOST, root: ROOT_B });
	const foreign = await pool.acquire({ hostId: other, root: ROOT_A });
	await pool.retireHost(HOST, "host");
	assert.deepEqual(
		retired.map((entry) => entry.key.hostId),
		[HOST, HOST].slice(0, 2).sort(),
	);
	assert.equal(pool.peek(HOST, ROOT_A), undefined);
	assert.equal(pool.peek(HOST, ROOT_B), undefined);
	assert.notEqual(pool.peek(other, ROOT_A), undefined, "another host's session is unrelated");
	a.lease.release();
	b.lease.release();
	foreign.lease.release();
});

test("a failed establishment leaves no entry behind and frees the budget", async () => {
	let attempt = 0;
	const retired = [];
	const pool = createRootSessionPool({
		policy: { maxEntries: 1 },
		establish: async (key) => {
			attempt += 1;
			if (attempt === 1) throw new Error("SSH_PROJECT_ROOT_CHANGED");
			return { root: key.root };
		},
		retire: (entry) => retired.push(entry),
		identity: (value) => value.root,
	});
	const failed = await pool.acquire({ hostId: HOST, root: ROOT_A });
	assert.equal(failed.ok, false);
	assert.equal(failed.code, "SSH_PROJECT_ROOT_CHANGED", "the establishment's own stable code must reach the caller");
	assert.equal(pool.stats().entries, 0);
	const rebuilt = await pool.acquire({ hostId: HOST, root: ROOT_A });
	assert.equal(rebuilt.ok, true, "a failed establishment must not consume the only slot");
	rebuilt.lease.release();
	assert.equal(retired.length, 0);
});

test("a latched root can be retired and rebuilt with a fresh identity", async () => {
	const { pool, established } = harness();
	const first = await pool.acquire({ hostId: HOST, root: ROOT_A });
	first.lease.release();
	const identity = first.lease.connectionId;
	await pool.retireRoot(HOST, ROOT_A, "latched");
	const rebuilt = await pool.acquire({ hostId: HOST, root: ROOT_A });
	assert.equal(rebuilt.ok, true);
	assert.equal(established.length, 2);
	assert.notEqual(rebuilt.lease.connectionId, identity, "a rebuilt session must carry a new identity so caches fence it");
	rebuilt.lease.release();
});

test("dispose retires everything and refuses further acquisitions", async () => {
	const { pool, retired } = harness();
	const a = await pool.acquire({ hostId: HOST, root: ROOT_A });
	const b = await pool.acquire({ hostId: HOST, root: ROOT_B });
	await pool.dispose();
	assert.deepEqual(
		retired.map((entry) => entry.reason),
		["dispose", "dispose"],
	);
	const after = await pool.acquire({ hostId: HOST, root: ROOT_C });
	assert.equal(after.ok, false);
	assert.equal(after.code, "REMOTE_CONNECTION_SERVICE_DISPOSED");
	a.lease.release();
	b.lease.release();
});

test("releasing a lease twice cannot corrupt the bookkeeping", async () => {
	const { pool } = harness();
	const acquired = await pool.acquire({ hostId: HOST, root: ROOT_A });
	acquired.lease.release();
	acquired.lease.release();
	assert.equal(pool.peek(HOST, ROOT_A).leases, 0);
	const again = await pool.acquire({ hostId: HOST, root: ROOT_A });
	assert.equal(again.lease.value.id, acquired.lease.value.id);
	again.lease.release();
});

test("the default policy keeps the ADR's candidate values", async () => {
	assert.equal(ROOT_POOL_DEFAULT_POLICY.idleCapacity, 2);
	assert.equal(ROOT_POOL_DEFAULT_POLICY.idleTtlMs, 10 * 60_000);
	assert.ok(ROOT_POOL_DEFAULT_POLICY.maxEntries > ROOT_POOL_DEFAULT_POLICY.idleCapacity, "the total budget must exceed the warm set, or a third project could never open");
});
