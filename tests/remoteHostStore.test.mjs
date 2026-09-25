import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");
const { SshHostPinStore } = loadTsCommonJs("src/main/remote/SshHostPinStore.ts");
const stamp = "2026-08-01T00:00:00.000Z";
const hostId = "01234567-89ab-4def-8123-456789abcdef";
const draft = { id: hostId, label: "Build Pi", sshHost: "build-pi", user: "alice", port: 2222, connectTimeoutMs: 15000, createdAt: stamp, updatedAt: stamp };

function envelope(profiles, revision, retiredHostIds = []) {
	return { schemaVersion: 1, revision, profiles, retiredHostIds };
}

function sshString(text) {
	const value = Buffer.isBuffer(text) ? text : Buffer.from(text);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(value.length);
	return Buffer.concat([size, value]);
}

function authenticatedCandidate(id) {
	const pinAlias = `pideck-${id}`;
	const key = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 19))]);
	const bytes = Buffer.from(`${pinAlias} ssh-ed25519 ${key.toString("base64")}\n`);
	return {
		hostName: "pi.example.invalid",
		user: "alice",
		port: 2222,
		pinAlias,
		routeDigest: createHash("sha256").update("route-v1").digest("hex"),
		knownHostsSha256: createHash("sha256").update(bytes).digest("hex"),
		knownHostsBase64: bytes.toString("base64"),
		hostKeyFingerprints: [`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`],
	};
}

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-hosts-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

async function pinFor(t, directory, id = hostId) {
	const store = new SshHostPinStore(directory, { verifier: async () => authenticatedCandidate(id) });
	t.after(() => store.dispose());
	const offer = await store.offer({ hostId: id, senderId: 7, route: { sshHost: "build-pi", user: "alice", port: 2222 } });
	return store.answer({ requestId: offer.requestId, hostId: id, senderId: 7, choice: "approve" });
}

test("creates a draft, activates only a matching pin, then preserves identity in a disabled tombstone", async (t) => {
	const directory = await fixture(t);
	const pinStore = new SshHostPinStore(directory, { verifier: async (_route, alias) => authenticatedCandidate(alias.slice("pideck-".length)) });
	t.after(() => pinStore.dispose());
	const store = await RemoteHostStore.open(directory, { pinStore });
	assert.deepEqual(JSON.parse(JSON.stringify(store.getSnapshot())), { status: "ready", reasons: [], revision: 0, profiles: [], retiredHostIds: [] });
	const profile = await store.createDraft({ label: "Build Pi", sshHost: "build-pi", user: "alice", port: 2222, connectTimeoutMs: 15000 }, 0);
	assert.equal(profile.sshHost, "build-pi");
	assert.equal(store.getSnapshot().revision, 1);
	const offer = await store.offerPin(profile.id, 7, 1);
	assert.equal(await store.confirmPin({ requestId: offer.requestId, hostId: profile.id, senderId: 7, choice: "deny" }, 1), null);
	assert.equal(store.getSnapshot().revision, 1);
	const approved = await store.offerPin(profile.id, 7, 1);
	const { knownHostsBase64: _bytes, ...endpoint } = authenticatedCandidate(profile.id);
	await store.confirmPin({ requestId: approved.requestId, hostId: profile.id, senderId: 7, choice: "approve", endpoint: { ...endpoint, routeDigest: "0".repeat(64) } }, 1);
	assert.equal(store.getSnapshot().revision, 2);
	const reopened = await RemoteHostStore.open(directory);
	assert.equal(reopened.getSnapshot().status, "ready");
	assert.equal(reopened.getSnapshot().profiles[0].verifiedEndpoint.knownHostsSha256, endpoint.knownHostsSha256);
	await reopened.disable(profile.id, 2);
	const tombstone = reopened.getSnapshot().profiles[0];
	assert.ok(tombstone.disabledAt);
	assert.deepEqual(JSON.parse(JSON.stringify(tombstone.verifiedEndpoint)), JSON.parse(JSON.stringify(endpoint)));
	const disk = JSON.parse(await readFile(join(directory, "remote-hosts.json"), "utf8"));
	assert.equal(disk.revision, 3);
	assert.equal(disk.profiles[0].id, profile.id);
});

test("rejects activation without a pin and never creates a missing pin from metadata", async (t) => {
	const directory = await fixture(t);
	const pinStore = {
		offer: async () => {
			throw new Error("not used");
		},
		answer: async (answer) => {
			const { knownHostsBase64: _bytes, ...endpoint } = authenticatedCandidate(answer.hostId);
			return endpoint;
		},
		readPin: async () => {
			throw new Error("missing pin");
		},
	};
	const store = await RemoteHostStore.open(directory, { pinStore });
	await store.createDraft({ label: "Build Pi", sshHost: "build-pi", connectTimeoutMs: 15000 }, 0);
	const id = store.getSnapshot().profiles[0].id;
	await assert.rejects(store.confirmPin({ requestId: "mock-confirmation", hostId: id, senderId: 7, choice: "approve" }, 1), /REMOTE_HOST_PIN_INVALID/);
	assert.equal(store.getSnapshot().revision, 1);
	await assert.rejects(readFile(join(directory, "ssh-host-keys", id)), { code: "ENOENT" });
});

test("a published pin left behind by failed activation marks the live store needs-repair", async (t) => {
	const directory = await fixture(t);
	const actual = new SshHostPinStore(directory, { verifier: async (_route, alias) => authenticatedCandidate(alias.slice("pideck-".length)) });
	t.after(() => actual.dispose());
	const pinStore = {
		offer: actual.offer.bind(actual),
		answer: async (answer) => {
			const endpoint = await actual.answer(answer);
			return endpoint && { ...endpoint, knownHostsSha256: "0".repeat(64) };
		},
		readPin: actual.readPin.bind(actual),
	};
	const store = await RemoteHostStore.open(directory, { pinStore });
	const profile = await store.createDraft({ label: "Build Pi", sshHost: "build-pi", connectTimeoutMs: 15000 }, 0);
	const offer = await store.offerPin(profile.id, 7, 1);
	await assert.rejects(store.confirmPin({ requestId: offer.requestId, hostId: profile.id, senderId: 7, choice: "approve" }, 1), /REMOTE_HOST_PIN_INVALID/);
	assert.equal(store.getSnapshot().status, "needs-repair");
	assert.equal(store.getSnapshot().revision, 1);
	await assert.rejects(store.createDraft({ label: "Other", sshHost: "other", connectTimeoutMs: 15000 }, 1), /REMOTE_HOST_STORE_NEEDS_REPAIR/);
});

test("loads a backup for offline inspection but never upgrades it to writable trust", async (t) => {
	const directory = await fixture(t);
	await writeFile(join(directory, "remote-hosts.json.bak"), JSON.stringify(envelope([draft], 1)));
	await writeFile(join(directory, "remote-hosts.json"), "{broken json");
	const store = await RemoteHostStore.open(directory);
	const snapshot = store.getSnapshot();
	assert.equal(snapshot.status, "needs-repair");
	assert.equal(snapshot.revision, 1);
	assert.deepEqual(Array.from(snapshot.reasons), ["REMOTE_HOST_PRIMARY_INVALID"]);
	await assert.rejects(store.createDraft({ label: "Other", sshHost: "other", connectTimeoutMs: 15000 }, 1), /REMOTE_HOST_STORE_NEEDS_REPAIR/);
	assert.equal(await readFile(join(directory, "remote-hosts.json"), "utf8"), "{broken json");
});

test("retired host IDs survive later draft writes", async (t) => {
	const directory = await fixture(t);
	const retired = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	await writeFile(join(directory, "remote-hosts.json"), JSON.stringify(envelope([draft], 3, [retired])));
	const store = await RemoteHostStore.open(directory);
	const profile = await store.createDraft({ label: "Other", sshHost: "other", connectTimeoutMs: 15000 }, 3);
	assert.notEqual(profile.id, retired);
	assert.deepEqual(Array.from(store.getSnapshot().retiredHostIds), [retired]);
	assert.deepEqual(JSON.parse(await readFile(join(directory, "remote-hosts.json"), "utf8")).retiredHostIds, [retired]);
});

test("missing, changed, unknown and draft-owned pins all fail closed on startup", async (t) => {
	for (const situation of ["missing", "changed", "unknown", "draft-pin"]) {
		const directory = await fixture(t);
		const profile = { ...draft };
		if (situation === "missing" || situation === "changed") {
			const endpoint = authenticatedCandidate(hostId);
			profile.verifiedEndpoint = { hostName: endpoint.hostName, user: endpoint.user, port: endpoint.port, pinAlias: endpoint.pinAlias, routeDigest: endpoint.routeDigest, knownHostsSha256: endpoint.knownHostsSha256, hostKeyFingerprints: endpoint.hostKeyFingerprints };
			profile.verifiedAt = stamp;
		}
		await writeFile(join(directory, "remote-hosts.json"), JSON.stringify(envelope(situation === "unknown" ? [] : [profile], 2)));
		if (situation !== "missing") {
			await mkdir(join(directory, "ssh-host-keys"));
			await writeFile(join(directory, "ssh-host-keys", hostId), situation === "changed" ? "tampered\n" : Buffer.from(authenticatedCandidate(hostId).knownHostsBase64, "base64"));
		}
		const store = await RemoteHostStore.open(directory);
		assert.equal(store.getSnapshot().status, "needs-repair", situation);
		await assert.rejects(store.createDraft({ label: "Other", sshHost: "other", connectTimeoutMs: 15000 }, 2), /REMOTE_HOST_STORE_NEEDS_REPAIR/);
	}
});

test("chooses highest valid revision before checking pins instead of rolling back endpoint trust", async (t) => {
	const directory = await fixture(t);
	const pin = authenticatedCandidate(hostId);
	const endpoint = { hostName: pin.hostName, port: pin.port, user: pin.user, pinAlias: pin.pinAlias, routeDigest: pin.routeDigest, knownHostsSha256: pin.knownHostsSha256, hostKeyFingerprints: pin.hostKeyFingerprints };
	await mkdir(join(directory, "ssh-host-keys"));
	await writeFile(join(directory, "ssh-host-keys", hostId), Buffer.from(pin.knownHostsBase64, "base64"));
	await writeFile(join(directory, "remote-hosts.json.bak"), JSON.stringify(envelope([{ ...draft, verifiedEndpoint: endpoint, verifiedAt: stamp }], 1)));
	await writeFile(join(directory, "remote-hosts.json"), JSON.stringify(envelope([{ ...draft, verifiedEndpoint: { ...endpoint, knownHostsSha256: "0".repeat(64) }, verifiedAt: stamp }], 2)));
	const store = await RemoteHostStore.open(directory);
	assert.equal(store.getSnapshot().revision, 2);
	assert.equal(store.getSnapshot().status, "needs-repair");
	assert.ok(store.getSnapshot().reasons.includes("REMOTE_HOST_PIN_INVALID"));
});

test("a stale confirmation fails before authentication or pin publication", async (t) => {
	const directory = await fixture(t);
	let probes = 0;
	const pinStore = new SshHostPinStore(directory, {
		verifier: async (_route, alias) => {
			probes += 1;
			return authenticatedCandidate(alias.slice("pideck-".length));
		},
	});
	t.after(() => pinStore.dispose());
	const first = await RemoteHostStore.open(directory, { pinStore });
	const profile = await first.createDraft({ label: "Build Pi", sshHost: "build-pi", connectTimeoutMs: 15000 }, 0);
	const offer = await first.offerPin(profile.id, 7, 1);
	assert.equal(probes, 1);
	const other = await RemoteHostStore.open(directory, { pinStore });
	await other.disable(profile.id, 1);
	await assert.rejects(first.confirmPin({ requestId: offer.requestId, hostId: profile.id, senderId: 7, choice: "approve" }, 1), /REMOTE_HOST_REVISION_CONFLICT/);
	assert.equal(probes, 1);
	await assert.rejects(readFile(join(directory, "ssh-host-keys", profile.id)), { code: "ENOENT" });
});

test("stale instances, held lock files, and malformed snapshots do not overwrite newer data", async (t) => {
	const directory = await fixture(t);
	const first = await RemoteHostStore.open(directory);
	const stale = await RemoteHostStore.open(directory);
	await first.createDraft({ label: "Build Pi", sshHost: "build-pi", connectTimeoutMs: 15000 }, 0);
	await assert.rejects(stale.createDraft({ label: "Other", sshHost: "other", connectTimeoutMs: 15000 }, 0), /REMOTE_HOST_REVISION_CONFLICT/);
	const lockPath = join(directory, "remote-hosts.json.lock");
	await writeFile(lockPath, "held");
	await assert.rejects(first.createDraft({ label: "Third", sshHost: "third", connectTimeoutMs: 15000 }, 1), /REMOTE_HOST_STORE_BUSY/);
	await rm(lockPath);
	await assert.rejects(first.createDraft({ label: "Still stale", sshHost: "other", connectTimeoutMs: 15000 }, 0), /REMOTE_HOST_REVISION_CONFLICT/);
	assert.equal(JSON.parse(await readFile(join(directory, "remote-hosts.json"), "utf8")).revision, 1);
	await writeFile(join(directory, "remote-hosts.json"), "not json");
	await writeFile(join(directory, "remote-hosts.json.bak"), "also broken");
	const broken = await RemoteHostStore.open(directory);
	assert.equal(broken.getSnapshot().status, "needs-repair");
	await assert.rejects(broken.createDraft({ label: "Nope", sshHost: "nope", connectTimeoutMs: 15000 }, 0), /REMOTE_HOST_STORE_NEEDS_REPAIR/);
});
