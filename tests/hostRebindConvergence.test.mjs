import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { classifyRebindRecord, classifyRebindResult } = loadTsCommonJs("src/main/remote/HostRebindConvergence.ts");

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";

/** 跨 VM realm 的对象比较前先归一化：deepStrictEqual 会比较原型，两个 realm 的字面量原型不同。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function locatorOf(hostId) {
	return JSON.stringify({ kind: "ssh", hostId, remotePath: "/srv/app" });
}

const BEFORE = locatorOf(SOURCE);
const AFTER = locatorOf(TARGET);

function planOf(overrides = {}) {
	return { store: "projects", recordId: "p-1", beforeLocator: BEFORE, afterLocator: AFTER, ...overrides };
}

test("a record the store no longer holds is missing, whatever the plan expected", () => {
	// INV-6: an absent record can never be a "needs a write" or an "already done" verdict.
	assert.deepEqual(plain(classifyRebindRecord(planOf(), undefined)), { kind: "missing" });
});

test("a record already at the target locator is done and produces no patch", () => {
	const disposition = classifyRebindRecord(planOf(), AFTER);
	assert.deepEqual(plain(disposition), { kind: "done" });
	assert.equal(Object.hasOwn(disposition, "patch"), false, "a done record must not hand a patch to the store");
});

test("a record at its expected before-locator is pending, with exactly the port patch shape", () => {
	const disposition = classifyRebindRecord(planOf({ store: "sessions", recordId: "s-1" }), BEFORE);
	assert.deepEqual(plain(disposition), { kind: "pending", patch: { recordId: "s-1", beforeLocator: BEFORE, afterLocator: AFTER } });
	assert.equal(Object.hasOwn(disposition.patch, "store"), false, "the journal's `store` field must not leak into the port call");
});

test("a locator written by anyone else is a stale plan, never a retry", () => {
	const foreign = locatorOf("33333333-3333-4333-8333-333333333333");
	assert.deepEqual(plain(classifyRebindRecord(planOf(), foreign)), { kind: "stale" });
	// "Almost after" (e.g. same host, different path) is foreign too: the CAS is byte-wise.
	assert.deepEqual(plain(classifyRebindRecord(planOf(), JSON.stringify({ kind: "ssh", hostId: TARGET, remotePath: "/srv/other" }))), { kind: "stale" });
});

test("store results keep their own verdicts and are never upgraded to success", () => {
	const verdicts = [
		[{ recordId: "p-1", outcome: "applied" }, "applied"],
		[{ recordId: "p-1", outcome: "already-applied" }, "already-applied"],
		[{ recordId: "p-1", outcome: "missing" }, "missing"],
		[{ recordId: "p-1", outcome: "changed" }, "changed"],
	];
	for (const [result, kind] of verdicts) assert.deepEqual(plain(classifyRebindResult(result)), { kind });
});

test("a malformed or unrecognised store result is unknown, not already-applied", () => {
	const malformed = [undefined, null, "applied", 42, {}, { recordId: "" }, { recordId: "a".repeat(129) }, { recordId: "p-1" }, { recordId: "p-1", outcome: 7 }, { recordId: "p-1", outcome: "skipped" }, { recordId: "p-1", outcome: "Applied" }];
	for (const result of malformed) {
		assert.deepEqual(plain(classifyRebindResult(result)), { kind: "unknown" }, JSON.stringify(result));
	}
	// Shape is checked first: a well-known outcome with an unusable recordId is still unknown.
	assert.deepEqual(plain(classifyRebindResult({ recordId: null, outcome: "applied" })), { kind: "unknown" });
});
