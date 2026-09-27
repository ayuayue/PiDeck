import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteHostReferenceRegistry } = loadTsCommonJs("src/main/remote/RemoteHostReferenceSources.ts");
const HOST_ID = "01234567-89ab-4def-8123-456789abcdef";

async function catalogPath(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-host-references-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "session-catalog.json");
}

function session(id, locator) {
	return { id, projectId: "project-1", title: "Session", environment: "native", status: "active", locator };
}

test("the registry refuses a relative or control-character catalog path", () => {
	assert.throws(() => createRemoteHostReferenceRegistry("session-catalog.json"), /REMOTE_HOST_REFERENCE_SCAN_INVALID/);
	assert.throws(() => createRemoteHostReferenceRegistry("/tmp/catalog\n.json"), /REMOTE_HOST_REFERENCE_SCAN_INVALID/);
});

test("all current sources are registered and an absent catalog has no persisted references", async (t) => {
	const registry = createRemoteHostReferenceRegistry(await catalogPath(t));
	assert.deepEqual(Array.from(registry.registeredSources()), ["projects", "sessions", "host-profiles", "runtime"]);
	const scan = await registry.scan();
	assert.equal(scan.complete, true);
	assert.deepEqual(Array.from(scan.unavailable), []);
	assert.deepEqual(Array.from(scan.referencedHostIds), []);
});

test("the persisted SSH locator contributes a host reference without rewriting the catalog", async (t) => {
	const filePath = await catalogPath(t);
	const raw = JSON.stringify({ version: 1, sessions: [session("remote-1", { kind: "ssh", hostId: HOST_ID, remotePath: "/work" }), session("local-1", { kind: "local", environment: "native", filePath: "/work/local" })] });
	await writeFile(filePath, raw);
	const registry = createRemoteHostReferenceRegistry(filePath);
	const scan = await registry.scan();
	assert.equal(scan.complete, true);
	assert.deepEqual(Array.from(scan.referencedHostIds), [HOST_ID]);
	assert.deepEqual(
		Array.from(scan.hits, (hit) => `${hit.source}:${hit.recordId}`),
		["sessions:remote-1"],
	);
	assert.equal(await readFile(filePath, "utf8"), raw);
});

test("a broken primary is incomplete even if a backup claims no references", async (t) => {
	const filePath = await catalogPath(t);
	await writeFile(filePath, "{bad json");
	await writeFile(`${filePath}.bak`, JSON.stringify({ version: 1, sessions: [] }));
	const registry = createRemoteHostReferenceRegistry(filePath);
	const scan = await registry.scan();
	assert.equal(scan.complete, false);
	assert.deepEqual(Array.from(scan.unavailable), ["sessions"]);
	await assert.rejects(registry.asStoreReferences().referencedHostIds(), /REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE/);
});

test("a missing primary with an existing backup never reports an empty complete scan", async (t) => {
	const filePath = await catalogPath(t);
	await writeFile(`${filePath}.bak`, JSON.stringify({ version: 1, sessions: [session("remote-1", { kind: "ssh", hostId: HOST_ID })] }));
	const scan = await createRemoteHostReferenceRegistry(filePath).scan();
	assert.equal(scan.complete, false);
	assert.deepEqual(Array.from(scan.unavailable), ["sessions"]);
});

test("unknown versions, locators and malformed siblings fail closed", async (t) => {
	const filePath = await catalogPath(t);
	for (const snapshot of [
		{ version: 2, sessions: [] },
		{ version: 1, sessions: [session("remote-1", { kind: "future", hostId: HOST_ID })] },
		{ version: 1, sessions: [session("remote-1", { kind: "ssh", hostId: "not-a-host-id" })] },
		{ version: 1, sessions: [session("remote-1", { kind: "ssh", hostId: HOST_ID }), {}] },
	]) {
		await writeFile(filePath, JSON.stringify(snapshot));
		const scan = await createRemoteHostReferenceRegistry(filePath).scan();
		assert.equal(scan.complete, false);
		assert.deepEqual(Array.from(scan.unavailable), ["sessions"]);
	}
});

test("an oversized catalog is incomplete without reading it into memory", async (t) => {
	const filePath = await catalogPath(t);
	await writeFile(filePath, "");
	await truncate(filePath, 16 * 1024 * 1024 + 1);
	const scan = await createRemoteHostReferenceRegistry(filePath).scan();
	assert.equal(scan.complete, false);
	assert.deepEqual(Array.from(scan.unavailable), ["sessions"]);
});

test("a catalog symlink is never followed", { skip: process.platform === "win32" }, async (t) => {
	const filePath = await catalogPath(t);
	const targetDir = await mkdtemp(join(tmpdir(), "pideck-host-target-"));
	t.after(() => rm(targetDir, { recursive: true, force: true }));
	const targetPath = join(targetDir, "target.json");
	await writeFile(targetPath, JSON.stringify({ version: 1, sessions: [] }));
	await symlink(targetPath, filePath);
	const scan = await createRemoteHostReferenceRegistry(filePath).scan();
	assert.equal(scan.complete, false);
	assert.deepEqual(Array.from(scan.unavailable), ["sessions"]);
});
