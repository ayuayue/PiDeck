import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteProjectTransferRegistry, REMOTE_PROJECT_TRANSFER_CODES } = loadTsCommonJs("src/main/remote/RemoteProjectTransferRegistry.ts");

const SENDER_A = 11;
const SENDER_B = 22;
const HOST = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "host#manager#7";

function scope(projectId = "project-a", overrides = {}) {
	return {
		senderId: SENDER_A,
		projectId,
		hostId: HOST,
		canonicalRoot: projectId === "project-a" ? "/srv/a" : "/srv/b",
		connectionId: CONNECTION,
		hostRevision: 4,
		...overrides,
	};
}

function registryHarness(options = {}) {
	let id = 0;
	const progress = [];
	const settled = [];
	const registry = createRemoteProjectTransferRegistry({
		createJobId: () => "job-" + String(++id).padStart(20, "0"),
		...options,
	});
	const create = (input = {}) =>
		registry.create({
			scope: scope(),
			operation: "upload",
			total: 10,
			onProgress: (event) => progress.push(event),
			onSettled: (event) => settled.push(event),
			...input,
		});
	return { registry, create, progress, settled };
}

test("create binds an opaque job to sender/project/scope and exposes only its abort signal", () => {
	const h = registryHarness();
	const job = h.create();
	assert.match(job.jobId, /^[A-Za-z0-9_-]{16,128}$/);
	assert.equal(job.operation, "upload");
	assert.equal(job.signal.aborted, false);
	assert.equal(h.registry.size(), 1);
	assert.equal(h.registry.cancel({ senderId: SENDER_A, projectId: "project-a", jobId: job.jobId }), true);
	assert.equal(job.signal.aborted, true);
});

test("the registry accepts the same project-id ceiling as the rest of the project services", () => {
	const id = "p".repeat(256);
	const registry = createRemoteProjectTransferRegistry({ createJobId: () => "job-0000000000001" });
	const handle = registry.create({ scope: scope(id, { canonicalRoot: "/srv/ceiling" }), operation: "upload", total: 0 });
	assert.equal(registry.cancel({ senderId: SENDER_A, projectId: id, jobId: handle.jobId }), true);
	assert.equal(handle.signal.aborted, true);
});

test("progress is operation-scoped, bounded, strictly monotonic and observer failures cannot corrupt state", () => {
	const h = registryHarness();
	const job = h.create({
		onProgress: () => {
			throw new Error("observer failed");
		},
	});
	assert.equal(job.reportProgress(0), true);
	assert.equal(job.reportProgress(2), true);
	assert.equal(job.reportProgress(2), false, "duplicate byte counts are ignored");
	assert.equal(job.reportProgress(1), false, "decreasing byte counts are ignored");
	assert.equal(job.reportProgress(11), false, "progress cannot exceed the fixed total");
	assert.deepEqual(
		h.progress.map((event) => ({ ...event })),
		[],
		"the throwing observer is swallowed; the first harness observer is replaced",
	);
	assert.equal(job.reportProgress(10), true);
});

test("success settles exactly once and removes the job before publishing", () => {
	let registry;
	let published = 0;
	registry = createRemoteProjectTransferRegistry({ createJobId: () => "job-aaaaaaaaaaaaaaaaaaaa" });
	const job = registry.create({
		scope: scope(),
		operation: "download",
		total: 3,
		onSettled: () => {
			published += 1;
			assert.equal(registry.size(), 0);
		},
	});
	assert.equal(job.settle({ outcome: "succeeded", result: { bytes: 3 } }), true);
	assert.equal(job.settle({ outcome: "succeeded", result: { bytes: 3 } }), false);
	assert.equal(published, 1);
	assert.equal(registry.size(), 0);
});

test("failed, cancelled and unknown settlements preserve stable codes only", () => {
	for (const outcome of ["failed", "cancelled", "unknown"]) {
		const h = registryHarness();
		const job = h.create();
		assert.equal(job.settle({ outcome, code: "REMOTE_TRANSFER_" + outcome.toUpperCase() }), true);
		assert.equal(h.settled.length, 1);
		assert.deepEqual(
			{ ...h.settled[0] },
			{
				jobId: job.jobId,
				operation: "upload",
				outcome,
				code: "REMOTE_TRANSFER_" + outcome.toUpperCase(),
			},
		);
	}
});

test("cancel is idempotent, project/sender scoped and does not settle before the worker acknowledges", () => {
	const h = registryHarness();
	const job = h.create();
	const request = { senderId: SENDER_A, projectId: "project-a", jobId: job.jobId };
	assert.equal(h.registry.cancel(request), true);
	assert.equal(h.registry.cancel(request), true);
	assert.equal(job.signal.aborted, true);
	assert.equal(h.registry.size(), 1, "cancel only aborts; process cleanup still owns settlement");
	assert.equal(job.reportProgress(1), false, "cancelled jobs stop publishing progress");
	assert.equal(job.settle({ outcome: "cancelled", code: REMOTE_PROJECT_TRANSFER_CODES.cancelled }), true);
	assert.equal(h.registry.cancel(request), false);
});

test("cross-project and cross-sender cancellation cannot touch another job", () => {
	const h = registryHarness();
	const a = h.create();
	const b = h.create({ scope: scope("project-b") });
	assert.equal(h.registry.cancel({ senderId: SENDER_A, projectId: "project-b", jobId: a.jobId }), false);
	assert.equal(h.registry.cancel({ senderId: SENDER_B, projectId: "project-a", jobId: a.jobId }), false);
	assert.equal(a.signal.aborted, false);
	assert.equal(b.signal.aborted, false);
	assert.equal(b.reportProgress(1), true);
});

test("closing one project aborts only its jobs and silences later callbacks", () => {
	const h = registryHarness();
	const a = h.create();
	const b = h.create({ scope: scope("project-b") });
	const c = h.create({ scope: scope("project-b", { senderId: SENDER_B }) });
	assert.equal(h.registry.closeProject("project-b"), 2);
	assert.equal(a.signal.aborted, false);
	assert.equal(b.signal.aborted, true);
	assert.equal(c.signal.aborted, true);
	assert.equal(b.reportProgress(1), false);
	assert.equal(b.settle({ outcome: "cancelled", code: "REMOTE_TRANSFER_CANCELLED" }), true);
	assert.equal(c.settle({ outcome: "cancelled", code: "REMOTE_TRANSFER_CANCELLED" }), true);
	assert.equal(h.settled.length, 0, "destroyed projects must not receive settlement events");
	assert.equal(h.registry.size(), 1, "the unrelated project remains registered");
});

test("closing one sender aborts only its jobs and silences later callbacks", () => {
	const h = registryHarness();
	const a = h.create();
	const b = h.create({ scope: scope("project-b", { senderId: SENDER_B }) });
	const d = h.create();
	assert.equal(h.registry.closeSender(SENDER_A), 2);
	assert.equal(a.signal.aborted, true);
	assert.equal(b.signal.aborted, false);
	assert.equal(d.signal.aborted, true);
	assert.equal(b.reportProgress(1), true);
	assert.equal(a.settle({ outcome: "cancelled", code: "REMOTE_TRANSFER_CANCELLED" }), true);
	assert.equal(d.settle({ outcome: "cancelled", code: "REMOTE_TRANSFER_CANCELLED" }), true);
	assert.equal(h.settled.length, 0);
	assert.equal(h.registry.size(), 1, "the unrelated sender remains registered");
});

test("invalid ownership, progress and settlement input fail closed at the boundary", () => {
	const h = registryHarness();
	assert.throws(() => h.registry.create({ scope: scope("", { projectId: "" }), operation: "upload", total: 1 }), /REMOTE_TRANSFER_INPUT_INVALID/);
	assert.throws(() => h.registry.create({ scope: scope("project-a", { canonicalRoot: "/srv/../etc" }), operation: "upload", total: 1 }), /REMOTE_TRANSFER_INPUT_INVALID/);
	assert.throws(() => h.registry.create({ scope: scope(), operation: "other", total: 1 }), /REMOTE_TRANSFER_INPUT_INVALID/);
	assert.throws(() => h.registry.create({ scope: scope(), operation: "upload", total: -1 }), /REMOTE_TRANSFER_INPUT_INVALID/);
	const job = h.create();
	assert.throws(() => job.settle({ outcome: "failed", code: "not a code" }), /REMOTE_TRANSFER_INPUT_INVALID/);
	assert.equal(h.registry.size(), 1);
});
