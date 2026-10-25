import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const queue = loadTsCommonJs("src/renderer/src/utils/cuaApprovalQueue.ts");

test("enqueue appends FIFO and peek returns the head", () => {
	const q0 = [];
	const q1 = queue.enqueueApproval(q0, { requestId: "a" });
	const q2 = queue.enqueueApproval(q1, { requestId: "b" });

	assert.strictEqual(q0.length, 0, "input queue is not mutated");
	assert.deepStrictEqual(
		[...q2].map((item) => item.requestId),
		["a", "b"],
	);
	assert.strictEqual(queue.peekApproval(q2).requestId, "a");
});

test("enqueue drops the oldest request beyond the capacity cap", () => {
	let q = [];
	for (let i = 0; i < 40; i += 1) {
		q = queue.enqueueApproval(q, { requestId: String(i) });
	}
	assert.strictEqual(q.length, queue.MAX_PENDING_APPROVALS ?? 32, "queue length is capped");
	assert.strictEqual(q[0].requestId, "8", "oldest requests are dropped first");
	assert.strictEqual(q.at(-1).requestId, "39", "newest request survives");
});

test("dequeue removes only the head", () => {
	const q = [{ requestId: "a" }, { requestId: "b" }, { requestId: "c" }];
	const next = queue.dequeueApproval(q);
	assert.deepStrictEqual(
		next.map((item) => item.requestId),
		["b", "c"],
	);
	assert.deepStrictEqual(
		["a", "b"].map((id) => id),
		["a", "b"],
	);
	assert.strictEqual(queue.peekApproval([]), undefined);
});

test("expireApprovals drops only the expired prefix and keeps fresh entries", () => {
	const now = 100_000;
	const entries = [
		{ requestId: "old1", timestampMs: now - 31_000 },
		{ requestId: "old2", timestampMs: now - 30_001 },
		{ requestId: "alive1", timestampMs: now - 29_000 },
		{ requestId: "alive2", timestampMs: now - 1_000 },
	];
	const next = queue.expireApprovals(entries, now);
	assert.deepStrictEqual(
		next.map((item) => item.requestId),
		["alive1", "alive2"],
		"only the expired prefix is removed (entries are ordered by timestamp)",
	);
});

test("expireApprovals returns empty for an all-expired queue and keeps an all-fresh one", () => {
	const now = 100_000;
	// 沙箱模块返回的是 vm realm 的数组，map 回宿主 realm 再比较（跨 realm deepStrictEqual 失配）。
	assert.deepStrictEqual(
		Array.from(queue.expireApprovals([{ requestId: "x", timestampMs: now - 60_000 }], now), (item) => item.requestId),
		[],
	);
	const fresh = [{ requestId: "y", timestampMs: now }];
	assert.deepStrictEqual(
		Array.from(queue.expireApprovals(fresh, now), (item) => item.requestId),
		["y"],
		"fresh head is kept",
	);
});
