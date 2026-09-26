import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { RemoteHostReferenceRegistry } = loadTsCommonJs("src/main/remote/RemoteHostReferenceRegistry.ts");

const HOST_A = "01234567-89ab-4def-8123-456789abcdef";
const HOST_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** A well-formed provider result. `source` inside hits is deliberately wrong: the registry re-tags it. */
function scanOf(hostIds, recordIds = [], overrides = {}) {
	return { referencedHostIds: new Set(hostIds), hits: recordIds.map((recordId) => ({ source: "runtime", recordId })), complete: true, unavailable: [], ...overrides };
}

function registryWith(entries) {
	const registry = new RemoteHostReferenceRegistry();
	for (const [source, provider] of entries) registry.register(source, provider);
	return registry;
}

/**
 * `Array.from(..., fn)` builds the labels in this realm on purpose: values returned by the VM-loaded
 * module carry the VM realm's prototypes, which `deepStrictEqual` rejects even when they look equal.
 */
function hitLabels(scan) {
	return Array.from(scan.hits, (hit) => `${hit.source}:${hit.recordId}`);
}

test("unions every registered source and reports hits per source", async () => {
	const registry = registryWith([
		["sessions", { scan: async () => scanOf([HOST_A, HOST_B], ["s-2", "s-1"]) }],
		["projects", { scan: async () => scanOf([HOST_A], ["p-1"]) }],
	]);
	const scan = await registry.scan();
	assert.deepEqual([...scan.referencedHostIds].sort(), [HOST_A, HOST_B]);
	assert.equal(scan.complete, true);
	assert.deepEqual(Array.from(scan.unavailable), []);
	assert.deepEqual(hitLabels(scan), ["projects:p-1", "sessions:s-1", "sessions:s-2"], "hits are tagged with the registered source and ordered deterministically");
	assert.deepEqual(Array.from(registry.registeredSources()), ["sessions", "projects"]);
});

test("a source that throws makes the scan incomplete but keeps the ids that were readable", async () => {
	const registry = registryWith([
		["sessions", { scan: async () => scanOf([HOST_A]) }],
		["projects", { scan: async () => Promise.reject(new Error("EACCES at C:\\Users\\me\\projects.json")) }],
	]);
	const scan = await registry.scan();
	assert.equal(scan.complete, false);
	assert.deepEqual(Array.from(scan.unavailable), ["projects"]);
	// A partial answer stays a conservative superset: the readable source is still reported.
	assert.deepEqual([...scan.referencedHostIds], [HOST_A]);
});

test("a source that reports its own incomplete scan never makes the result look complete", async () => {
	const registry = registryWith([["projects", { scan: async () => scanOf([HOST_A], ["p-1"], { complete: false }) }]]);
	const scan = await registry.scan();
	assert.equal(scan.complete, false);
	assert.deepEqual(Array.from(scan.unavailable), ["projects"]);
	assert.deepEqual([...scan.referencedHostIds], [HOST_A]);
});

test("an unreadable source never degrades into an empty reference set", async () => {
	// The dangerous shape from the design (§1.3 / G1): a failing source must not look like "no references".
	for (const registry of [
		registryWith([["projects", { scan: async () => Promise.reject(new Error("read failure")) }]]),
		registryWith([
			["sessions", { scan: async () => scanOf([]) }],
			["projects", { scan: async () => Promise.reject(new Error("read failure")) }],
		]),
	]) {
		await assert.rejects(registry.asStoreReferences().referencedHostIds(), (error) => error.message === "REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE");
	}
});

test("the single-host verdict reports both facts and never hides an unreadable source", async () => {
	const complete = registryWith([["sessions", { scan: async () => scanOf([HOST_A]) }]]);
	assert.deepEqual(JSON.parse(JSON.stringify(await complete.isReferenced(HOST_A))), { referenced: true, complete: true });
	assert.deepEqual(JSON.parse(JSON.stringify(await complete.isReferenced(HOST_B))), { referenced: false, complete: true });

	const incomplete = registryWith([["sessions", { scan: async () => Promise.reject(new Error("read failure")) }]]);
	assert.deepEqual(JSON.parse(JSON.stringify(await incomplete.isReferenced(HOST_B))), { referenced: true, complete: false }, "complete:false is handled as possibly still referenced");
});

test("no registered source fails closed instead of reporting an empty set", async () => {
	const registry = new RemoteHostReferenceRegistry();
	const scan = await registry.scan();
	assert.equal(scan.complete, false, "nothing was proven, so the scan cannot claim completeness");
	assert.equal(scan.referencedHostIds.size, 0);
	assert.throws(
		() => registry.asStoreReferences(),
		(error) => error.message === "REMOTE_HOST_REFERENCE_SOURCE_MISSING",
	);
	// The store-facing view stays fail-closed for its whole lifetime, not only at creation time.
	const view = registryWith([["projects", { scan: async () => scanOf([]) }]]).asStoreReferences();
	assert.deepEqual([...(await view.referencedHostIds())], []);
});

test("a source that cannot hold host references is skipped and does not affect completeness", async () => {
	let probes = 0;
	const registry = registryWith([
		[
			"projects",
			{
				capability: { canHoldHostReferences: false },
				scan: async () => {
					probes += 1;
					return scanOf([HOST_B], ["never-read"]);
				},
			},
		],
		["sessions", { scan: async () => scanOf([HOST_A], ["s-1"]) }],
	]);
	const scan = await registry.scan();
	assert.equal(probes, 0, "a structurally reference-free source is not scanned at all");
	assert.equal(scan.complete, true);
	assert.deepEqual([...scan.referencedHostIds], [HOST_A]);
	assert.deepEqual(hitLabels(scan), ["sessions:s-1"]);

	// Pre-Phase-3 ProjectStore shape: only such a source exists, and "no ssh locators can exist" is a
	// complete answer (design Q6), unlike an empty registry.
	const skippedOnly = registryWith([["projects", { capability: { canHoldHostReferences: false }, scan: async () => scanOf([]) }]]);
	const skippedScan = await skippedOnly.scan();
	assert.equal(skippedScan.complete, true);
	await skippedOnly.asStoreReferences().referencedHostIds();
});

test("rejects an invalid or duplicate registration with stable codes and keeps the first provider", async () => {
	const registry = new RemoteHostReferenceRegistry();
	assert.throws(
		() => registry.register("settings", { scan: async () => scanOf([]) }),
		(error) => error.message === "REMOTE_HOST_REFERENCE_SOURCE_INVALID",
	);
	assert.throws(
		() => registry.register("projects", {}),
		(error) => error.message === "REMOTE_HOST_REFERENCE_SOURCE_INVALID",
	);
	registry.register("projects", { scan: async () => scanOf([HOST_A]) });
	assert.throws(
		() => registry.register("projects", { scan: async () => scanOf([HOST_B]) }),
		(error) => error.message === "REMOTE_HOST_REFERENCE_SOURCE_DUPLICATE",
	);
	assert.deepEqual([...(await registry.scan()).referencedHostIds], [HOST_A], "the original provider is still the one being used");
});

test("normalizes provider hits to the registered source and deduplicates them", async () => {
	const registry = registryWith([
		[
			"projects",
			{
				scan: async () => ({
					referencedHostIds: new Set([HOST_A]),
					hits: [
						{ source: "sessions", recordId: "p-1" },
						{ source: "projects", recordId: "p-1" },
						{ source: "runtime", recordId: "p-2" },
					],
					complete: true,
					unavailable: [],
				}),
			},
		],
	]);
	const scan = await registry.scan();
	assert.deepEqual(hitLabels(scan), ["projects:p-1", "projects:p-2"]);
});

test("a malformed provider result is unreadable, not empty", async () => {
	const withSizeDisagreement = {
		size: 3,
		has: () => true,
		forEach: (visit) => {
			visit(HOST_A);
		},
	};
	for (const malformed of [
		{ referencedHostIds: [HOST_A], hits: [], complete: true, unavailable: [] },
		{ referencedHostIds: new Set([HOST_A]), hits: [{ recordId: "" }], complete: true, unavailable: [] },
		{ referencedHostIds: new Set([HOST_A]), hits: [], complete: "yes", unavailable: [] },
		{ referencedHostIds: withSizeDisagreement, hits: [], complete: true, unavailable: [] },
		undefined,
	]) {
		const registry = registryWith([["projects", { scan: async () => malformed }]]);
		const scan = await registry.scan();
		assert.equal(scan.complete, false, JSON.stringify(malformed));
		assert.deepEqual(Array.from(scan.unavailable), ["projects"]);
		await assert.rejects(registry.asStoreReferences().referencedHostIds(), (error) => error.message === "REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE");
	}
});
