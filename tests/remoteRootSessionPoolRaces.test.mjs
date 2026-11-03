import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRootSessionPool } = loadTsCommonJs("src/main/remote/RemoteRootSessionPool.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const key = (root) => ({ hostId: "host", root });
function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function harness(overrides = {}) {
	let sequence = 0;
	const retired = [];
	const pool = createRootSessionPool({
		policy: { maxEntries: 2, acquireTimeoutMs: 80 },
		establish: async ({ root }) => ({ root, id: String(++sequence) }),
		identity: (value) => value.id,
		retire: async ({ value }) => {
			retired.push(value.id);
		},
		...overrides,
	});
	return { pool, retired };
}

test("retiring helpers still occupy the hard resource budget", async () => {
	const gate = deferred();
	const diagnostics = [];
	let live = 0;
	let peak = 0;
	const { pool } = harness({
		onDiagnostic: (event) => diagnostics.push(event),
		establish: async ({ root }) => {
			peak = Math.max(peak, ++live);
			return { root, id: root };
		},
		retire: async () => {
			await gate.promise;
			live -= 1;
		},
	});
	const a = await pool.acquire(key("a"));
	const b = await pool.acquire(key("b"));
	a.lease.release();
	b.lease.release();
	const retiring = pool.retireHost("host", "host");
	const next = pool.acquire(key("c"));
	await tick();
	const closing = diagnostics.findLast((event) => event.action === "retiring:host");
	assert.equal(closing.stats.retiring, 2);
	assert.deepEqual(
		Array.from(closing.roots, (entry) => [entry.root, entry.connectionId, entry.state]),
		[
			["a", "a", "retiring"],
			["b", "b", "retiring"],
		],
	);
	gate.resolve();
	await retiring;
	const c = await next;
	assert.equal(c.ok, true);
	c.lease.release();
	await pool.dispose();
	assert.equal(peak, 2, "a slot is reusable only after its helper has exited");
});

test("a diagnostic sink failure cannot leak a slot or fail a successful acquire", async () => {
	const { pool } = harness({
		onDiagnostic: () => {
			throw new Error("sink unavailable");
		},
	});
	const a = await pool.acquire(key("a"));
	assert.equal(a.ok, true);
	a.lease.release();
	await pool.dispose();
	assert.equal(pool.stats().entries + pool.stats().retiring + pool.stats().creating, 0);
});

test("sweep rechecks leases after each asynchronous retirement", async () => {
	const gate = deferred();
	const retired = [];
	const { pool } = harness({
		policy: { idleCapacity: 0, idleTtlMs: 1 },
		retire: async ({ value }) => {
			retired.push(value.root);
			if (value.root === "a") await gate.promise;
		},
	});
	const a = await pool.acquire(key("a"));
	const b = await pool.acquire(key("b"));
	a.lease.release();
	b.lease.release();
	const sweeping = pool.sweep(Date.now() + 100);
	await tick();
	const activeB = await pool.acquire(key("b"));
	gate.resolve();
	await sweeping;
	assert.deepEqual(retired, ["a"], "B acquired a lease while A was closing");
	activeB.lease.release();
	await pool.dispose();
});

test("retirement fences a late establishment before publishing it", async () => {
	const gate = deferred();
	const { pool, retired } = harness({
		establish: async () => {
			await gate.promise;
			return { id: "late" };
		},
	});
	const pending = pool.acquire(key("a"));
	await tick();
	const closing = pool.retireRoot("host", "a", "explicit");
	gate.resolve();
	await closing;
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.code, "SSH_HOST_NOT_READY");
	assert.equal(pool.peek("host", "a"), undefined);
	assert.deepEqual(retired, ["late"]);
	await pool.dispose();
});

test("dispose waits for late creation cleanup and is idempotent", async () => {
	const gate = deferred();
	const { pool, retired } = harness({
		establish: async () => {
			await gate.promise;
			return { id: "late" };
		},
	});
	const pending = pool.acquire(key("a"));
	await tick();
	let finished = false;
	const closing = pool.dispose().then(() => {
		finished = true;
	});
	await tick();
	const finishedBeforeCleanup = finished;
	gate.resolve();
	await closing;
	await pending;
	await pool.dispose();
	assert.equal(finishedBeforeCleanup, false);
	assert.deepEqual(retired, ["late"]);
});

test("cancelling the creator does not cancel another acquire of the same root", async () => {
	const gate = deferred();
	let creates = 0;
	const { pool } = harness({
		establish: async (_, signal) => {
			creates++;
			await gate.promise;
			if (signal.aborted) throw new Error("REQUEST_CANCELLED");
			return { id: "shared" };
		},
	});
	const controller = new AbortController();
	const first = pool.acquire(key("a"), { signal: controller.signal });
	const second = pool.acquire(key("a"));
	await tick();
	controller.abort();
	gate.resolve();
	const [cancelled, shared] = await Promise.all([first, second]);
	assert.equal(cancelled.code, "REQUEST_CANCELLED");
	assert.equal(shared.ok, true);
	assert.equal(creates, 1);
	shared.lease.release();
	await pool.dispose();
});

test("releasing the final watcher wakes a full-budget waiter", async () => {
	const { pool } = harness({ policy: { maxEntries: 1, acquireTimeoutMs: 120 } });
	const a = await pool.acquire(key("a"));
	pool.retainWatch("host", "a", a.lease.connectionId);
	a.lease.release();
	const next = pool.acquire(key("b"));
	await tick();
	pool.releaseWatch("host", "a", a.lease.connectionId);
	const b = await next;
	assert.equal(b.ok, true);
	b.lease.release();
	await pool.dispose();
});

test("old watcher releases cannot decrement a replacement session", async () => {
	const { pool } = harness({ policy: { idleCapacity: 0 } });
	const a = await pool.acquire(key("a"));
	pool.retainWatch("host", "a", a.lease.connectionId);
	a.lease.release();
	await pool.retireRoot("host", "a", "explicit");
	const replacement = await pool.acquire(key("a"));
	pool.retainWatch("host", "a", replacement.lease.connectionId);
	replacement.lease.release();
	pool.releaseWatch("host", "a", a.lease.connectionId);
	await pool.sweep();
	assert.equal(pool.peek("host", "a")?.watchers, 1);
	await pool.dispose();
});

test("host retirement cancels queued old-generation acquires without starting them", async () => {
	const { pool } = harness({ policy: { maxEntries: 1, acquireTimeoutMs: 120 } });
	const a = await pool.acquire(key("a"));
	const waiting = pool.acquire(key("b"));
	await tick();
	await pool.retireHost("host", "host");
	const b = await waiting;
	assert.equal(b.ok, false);
	assert.equal(b.code, "SSH_HOST_NOT_READY");
	assert.equal(pool.stats().entries, 0);
	a.lease.release();
	await pool.dispose();
});

test("concurrent cold roots respect six slots before leases are delivered", async () => {
	const { pool } = harness({ policy: { maxEntries: 6, acquireTimeoutMs: 25 } });
	const results = await Promise.all(Array.from({ length: 8 }, (_, index) => pool.acquire(key(String(index)))));
	assert.equal(results.filter((result) => result.ok).length, 6);
	assert.equal(results.filter((result) => result.code === "SSH_ROOT_POOL_BUSY").length, 2);
	assert.equal(pool.stats().created, 6);
	assert.equal(pool.stats().peakEntries, 6);
	assert.equal(pool.stats().waitTimeouts, 2);
	assert.equal(pool.stats().waitCount, 0);
	for (const result of results) if (result.ok) result.lease.release();
	await pool.dispose();
});

test("sweep is repeatable and records counts before and after collection", async () => {
	const diagnostics = [];
	const { pool, retired } = harness({ policy: { idleCapacity: 0 }, onDiagnostic: (event) => diagnostics.push(event) });
	const a = await pool.acquire(key("a"));
	a.lease.release();
	await Promise.all([pool.sweep(), pool.sweep()]);
	await pool.sweep();
	assert.equal(retired.length, 1);
	assert.equal(pool.stats().entries, 0);
	assert.equal(pool.stats().retiring, 0);
	assert.equal(pool.stats().evictedIdle, 1);
	const sweep = diagnostics.find((event) => event.action === "sweep" && event.before.entries === 1);
	assert.equal(sweep.stats.entries, 0);
	await pool.dispose();
});
