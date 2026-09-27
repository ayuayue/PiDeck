import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { openRemoteHostCatalogView } = loadTsCommonJs("src/main/remote/RemoteHostCatalogView.ts");

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-catalog-view-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

test("ready host catalog has no repair findings", async (t) => {
	const directory = await fixture(t);
	const view = await openRemoteHostCatalogView(directory);
	assert.equal(view.snapshot.status, "ready");
	assert.deepEqual(Array.from(view.findings), []);
});

test("listing leaves retired pin bytes intact instead of performing cleanup", async (t) => {
	const directory = await fixture(t);
	const hostId = "01234567-89ab-4def-8123-456789abcdef";
	const pinDirectory = join(directory, "ssh-host-keys");
	await mkdir(pinDirectory);
	await writeFile(join(directory, "remote-hosts.json"), JSON.stringify({ schemaVersion: 1, revision: 1, profiles: [], retiredHostIds: [hostId] }));
	const pinPath = join(pinDirectory, hostId);
	await writeFile(pinPath, "retired-pin-evidence");
	const view = await openRemoteHostCatalogView(directory);
	assert.equal(view.snapshot.status, "ready");
	assert.equal(await readFile(pinPath, "utf8"), "retired-pin-evidence");
});

test("ownerless catalog lock is diagnosed without deleting the lock or changing the catalog", async (t) => {
	const directory = await fixture(t);
	const lockPath = join(directory, "remote-hosts.json.lock");
	await writeFile(lockPath, "");
	const view = await openRemoteHostCatalogView(directory);
	assert.equal(view.snapshot.status, "needs-repair");
	assert.deepEqual(JSON.parse(JSON.stringify(view.findings)), [{ reason: "REMOTE_HOST_LOCK_PRESENT", classification: "lock", hostIds: [], actions: ["clear-stale-lock"] }]);
	assert.equal(await readFile(lockPath, "utf8"), "");
});
