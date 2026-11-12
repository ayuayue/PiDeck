import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { readSessionCatalogSources } from "./helpers/sessionCatalogSources.mjs";

/*
 * F4 independent verification of the sessions-domain hostId convergence (task-24, I2).
 *
 * The defect being closed is a split judgement: the session catalog codec accepted any non-empty hostId,
 * while the host-reference scan required a UUID - so the same record could be "loaded" by one and
 * "uninterpretable" by the other. A hostId is only ever produced by RemoteHostStore's randomUUID(), so a
 * non-UUID one can never name a host; the converged judgement must therefore refuse it everywhere without
 * losing a single legitimate legacy record.
 *
 * Both directions are asserted, because closing the gap by over-rejecting would be the worse bug:
 * 1. suspicious records fail closed in all three places (shared judgement, catalog codec, reference scan),
 *    and a catalog that contains one can neither present it as a session nor accept a write;
 * 2. a realistic legacy v1 catalog - early ssh shapes without a remotePath, alias lists, local locators,
 *    drafts without a locator, legacy mirror fields - still loads and still reports exactly its host
 *    references.
 */

const { SessionCatalog, isSessionLocator } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
	stubs: { "../logging/sharedLogger": { getAppLogger: () => null } },
});
const { readSshSessionLocator } = loadTsCommonJs("src/shared/projectLocation.ts");
const { createRemoteHostReferenceRegistry } = loadTsCommonJs("src/main/remote/RemoteHostReferenceSources.ts");

/** Two well-formed v4-shaped ids: the pattern is lowercase, version 1-8, variant 89ab. */
const HOST_A = "01234567-89ab-4def-8123-456789abcdef";
const HOST_B = "fedcba98-7654-4321-ba98-76543210fedc";
const CONTROL = String.fromCharCode(0);

/** Non-UUID shapes that must never be treated as a host reference. */
const BAD_HOST_IDS = [
	["a missing hostId", undefined],
	["an empty string", ""],
	["only whitespace", "   "],
	["an arbitrary label", "not-a-uuid"],
	["an uppercase uuid", HOST_A.toUpperCase()],
	["version 0", "01234567-89ab-0def-8123-456789abcdef"],
	["an invalid variant nibble", "01234567-89ab-4def-c123-456789abcdef"],
	["trailing text", HOST_A + "x"],
	["an over-long value", HOST_A + "x".repeat(300)],
	["a number", 42],
	["null", null],
	["a control byte", HOST_A.slice(0, 8) + CONTROL + HOST_A.slice(9)],
];

async function tempDir(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-session-hostid-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

function sessionEntry(id, locator, extra = {}) {
	return { id, projectId: "project-1", title: "Session", environment: "native", status: "active", ...(locator === undefined ? {} : { locator }), ...extra };
}

function catalogJson(sessions) {
	return JSON.stringify({ version: 1, sessions }, null, 2);
}

/** Write a catalog file and return its path plus a loader bound to a fresh instance. */
async function catalogFixture(t, sessions, raw) {
	const directory = await tempDir(t);
	const filePath = join(directory, "session-catalog.json");
	await writeFile(filePath, raw ?? catalogJson(sessions));
	const catalog = new SessionCatalog(filePath);
	return { directory, filePath, catalog };
}

/** The reference scan over the same fixture (projects store absent). */
function scanFixture(directory, filePath) {
	return createRemoteHostReferenceRegistry(filePath, join(directory, "projects.json")).scan();
}

async function assertCatalogRefuses(t, sessions, label) {
	const { directory, filePath, catalog } = await catalogFixture(t, sessions);
	// Loading must not present the suspicious record as a session, whatever the recovery path decides.
	await catalog.load();
	assert.equal(catalog.listEntries().length, 0, label + ": the suspicious record must not be loaded as a session");
	assert.deepEqual(plain(catalog.listEntries()), []);
	// And a catalog that needs repair must not accept new writes (nothing may be persisted on top of it).
	await assert.rejects(catalog.ensureRemoteSession({ projectId: "project-1", hostId: HOST_A, remoteSessionId: "ws/a.jsonl", remotePath: "ws/a.jsonl", title: "a", updatedAt: 1 }), label + ": a catalog holding a suspicious record must refuse writes");
	assert.equal(catalog.listEntries().length, 0, label + ": the refused write must not appear");
	const scan = await scanFixture(directory, filePath);
	assert.equal(scan.complete, false, label + ": the reference scan must be incomplete, never empty-and-complete");
	assert.deepEqual(Array.from(scan.unavailable), ["sessions"], label + ": the sessions source is the incomplete one");
	return { directory, filePath };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("a non-UUID ssh hostId is refused by the shared judgement, the codec and the scan alike", async (t) => {
	const locator = { kind: "ssh", hostId: "not-a-uuid", remotePath: "/srv/app" };
	assert.equal(readSshSessionLocator(locator), undefined, "the shared judgement must refuse it");
	assert.equal(isSessionLocator(locator), false, "the catalog codec must refuse it");
	await assertCatalogRefuses(t, [sessionEntry("bad-1", locator)], "non-UUID ssh hostId");

	// The scan must not carry a second, private judgement: it has to go through the same function.
	const scannerSource = await readFile("src/main/remote/RemoteHostReferenceSources.ts", "utf8");
	assert.ok(!/HOST_ID/.test(scannerSource), "the scan must not keep its own host-id pattern");
	assert.ok(scannerSource.includes("isSessionLocator"), "the scan must decide through the shared session judgement");
});

test("a local locator carrying a hostId is refused instead of being read as no-reference", async (t) => {
	// The dangerous shape: a local-looking record that still names a host. Read as "local", it contributes no
	// reference, and a retire would then hard-delete a host that record still points at.
	const locator = { kind: "local", environment: "native", filePath: "/work/local", hostId: HOST_A };
	assert.equal(isSessionLocator(locator), false, "a local locator must not carry a host reference");
	await assertCatalogRefuses(t, [sessionEntry("shadow-1", locator)], "local locator with a hostId");
});

test("every non-UUID hostId shape fails closed in all three places", async (t) => {
	for (const [label, hostId] of BAD_HOST_IDS) {
		const locator = hostId === undefined ? { kind: "ssh", remotePath: "/srv/app" } : { kind: "ssh", hostId, remotePath: "/srv/app" };
		assert.equal(isSessionLocator(locator), false, label + ": the codec must refuse it");
		await assertCatalogRefuses(t, [sessionEntry("bad-" + label, locator)], label);
	}
	// The shared judgement itself keeps the legitimate shapes, independent of the catalog.
	assert.deepEqual(plain(readSshSessionLocator({ kind: "ssh", hostId: HOST_A })), { kind: "ssh", hostId: HOST_A }, "a host-only ssh locator is legitimate");
	assert.deepEqual(plain(readSshSessionLocator({ kind: "ssh", hostId: HOST_A, remoteSessionId: "ws/a.jsonl", remotePathAliases: ["/srv/old"] })), { kind: "ssh", hostId: HOST_A, remoteSessionId: "ws/a.jsonl", remotePathAliases: ["/srv/old"] });
});

test("a legitimate legacy v1 catalog still loads and keeps exactly its host references", async (t) => {
	const sessions = [
		// An early G3 shape: identity only, no remotePath at all.
		sessionEntry("ssh-id-only", { kind: "ssh", hostId: HOST_A, remoteSessionId: "ws/early.jsonl" }),
		// Identity plus an alias list.
		sessionEntry("ssh-aliases", { kind: "ssh", hostId: HOST_A, remotePath: "/srv/app", remoteSessionId: "ws/a.jsonl", remotePathAliases: ["/srv/app-moved"] }),
		sessionEntry("ssh-b", { kind: "ssh", hostId: HOST_B, remotePath: "/srv/other" }),
		sessionEntry("local-1", { kind: "local", environment: "native", filePath: "/work/local" }),
		sessionEntry("draft-no-locator", undefined),
		// A remote record that still carries the local mirror fields the codec is expected to clear.
		sessionEntry("ssh-mirrored", { kind: "ssh", hostId: HOST_B, remotePath: "/srv/other", remoteSessionId: "ws/b.jsonl" }, { filePath: "/stale/local.jsonl", originKey: "legacy", piSessionId: "pi-1" }),
	];

	const { directory, filePath, catalog } = await catalogFixture(t, sessions);
	await catalog.load();
	// The catalog normalizes legacy mirror fields on load (that is expected); the snapshot is taken after it,
	// so the rewrite assertion below is about the scan and nothing else.
	const rawAfterLoad = await readFile(filePath, "utf8");
	const entries = catalog.listEntries();
	assert.equal(entries.length, sessions.length, "every legitimate legacy record must survive the tightening");
	assert.ok(isSessionLocator(catalog.getLocator("ssh-id-only")), "a host-only ssh locator is legitimate");
	assert.ok(isSessionLocator(catalog.getLocator("ssh-aliases")));
	assert.ok(isSessionLocator(catalog.getLocator("ssh-b")));
	assert.equal(catalog.getLocator("local-1").kind, "local");
	assert.equal(catalog.getLocator("draft-no-locator"), undefined);
	// The ssh branch owns the location; legacy local mirror fields must not survive alongside it.
	const mirrored = entries.find((entry) => entry.id === "ssh-mirrored");
	assert.equal(mirrored.filePath, undefined, "the local mirror fields must be cleared on load");
	assert.equal(mirrored.originKey, undefined);
	assert.equal(mirrored.piSessionId, undefined);

	const scan = await scanFixture(directory, filePath);
	assert.equal(scan.complete, true, "a purely legitimate catalog must scan as complete");
	assert.deepEqual(Array.from(scan.referencedHostIds).sort(), [HOST_A, HOST_B]);
	assert.deepEqual(Array.from(scan.hits, (hit) => hit.recordId).sort(), ["ssh-aliases", "ssh-b", "ssh-id-only", "ssh-mirrored"], "every ssh record contributes a hit");
	assert.equal(await readFile(filePath, "utf8"), rawAfterLoad, "a scan must not rewrite the catalog");

	// The tightening must not block a legitimate write either.
	const created = await catalog.ensureRemoteSession({ projectId: "project-1", hostId: HOST_B, remoteSessionId: "ws/new.jsonl", remotePath: "ws/new.jsonl", title: "new", updatedAt: 2 });
	assert.equal(created.created, true);
	assert.ok(isSessionLocator(catalog.getLocator(created.record.id)));
});

test("the hostId judgement has exactly one shared source and is audited", async () => {
	const crossStore = await readFile("tests/remoteHostCrossStoreContract.test.mjs", "utf8");
	// Every shared file that declares the UUID pattern must be registered in the cross-store audit, otherwise
	// a new judgement file would be invisible to the "who references a host" review.
	const sharedDir = "src/shared";
	const { readdirSync } = await import("node:fs");
	const offenders = [];
	for (const name of readdirSync(sharedDir)) {
		if (!name.endsWith(".ts")) continue;
		const filePath = sharedDir + "/" + name;
		const source = await readFile(filePath, "utf8");
		if (/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/.test(source) && !crossStore.includes(filePath)) offenders.push(filePath);
	}
	assert.deepEqual(offenders, [], "a shared hostId judgement must be listed in the cross-store audit");
	assert.ok(crossStore.includes("src/shared/projectLocation.ts"), "the shared judgement file must stay audited");

	// The sessions domain must reuse it instead of growing a second regex.
	const sessionsCodec = readSessionCatalogSources();
	assert.ok(!/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/.test(sessionsCodec), "the sessions codec must not declare its own UUID pattern");
	assert.ok(sessionsCodec.includes("shared/projectLocation"), "the sessions codec must import the shared hostId judgement");
});
