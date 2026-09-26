import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");
const { SshHostPinStore } = loadTsCommonJs("src/main/remote/SshHostPinStore.ts");
const missingHostId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function sshString(text) {
	const value = Buffer.isBuffer(text) ? text : Buffer.from(text);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(value.length);
	return Buffer.concat([size, value]);
}

function authenticatedCandidate(id) {
	const pinAlias = `pideck-${id}`;
	const key = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 29))]);
	const bytes = Buffer.from(`${pinAlias} ssh-ed25519 ${key.toString("base64")}\n`);
	return {
		hostName: "pi.example.invalid",
		user: "alice",
		port: 2222,
		pinAlias,
		routeDigest: createHash("sha256").update("route-lifecycle").digest("hex"),
		knownHostsSha256: createHash("sha256").update(bytes).digest("hex"),
		knownHostsBase64: bytes.toString("base64"),
		hostKeyFingerprints: [`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`],
	};
}

async function fixture(t, referenced = []) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-host-lifecycle-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const pinStore = new SshHostPinStore(directory, { verifier: async (_route, alias) => authenticatedCandidate(alias.slice("pideck-".length)) });
	t.after(() => pinStore.dispose());
	return { directory, pinStore, references: { referencedHostIds: async () => new Set(referenced) } };
}

/** Store holding one verified host (draft -> pin -> confirm), like the activation flow does. */
async function verifiedHost(t, referenced = []) {
	const { directory, pinStore, references } = await fixture(t, referenced);
	const store = await RemoteHostStore.open(directory, { pinStore, references });
	const profile = await store.createDraft({ label: "Build Pi", sshHost: "build-pi", user: "alice", port: 2222, connectTimeoutMs: 15000 }, 0);
	const offer = await store.offerPin(profile.id, 7, 1);
	await store.confirmPin({ hostId: profile.id, senderId: 7, requestId: offer.requestId, choice: "approve" }, 1);
	return { directory, store, pinStore, references, profile, pinPath: join(directory, "ssh-host-keys", profile.id) };
}

test("edits a never-verified draft, including clearing optional endpoint fields", async (t) => {
	const { directory, pinStore, references } = await fixture(t);
	const store = await RemoteHostStore.open(directory, { pinStore, references });
	const draft = await store.createDraft({ label: "Draft", sshHost: "build-pi", user: "alice", port: 2222, connectTimeoutMs: 15000 }, 0);
	const edited = await store.updateDraft(draft.id, { label: "Renamed", sshHost: "other-pi", user: undefined, port: 2200, proxyJump: "ops@bastion:2200" }, 1);
	assert.equal(edited.label, "Renamed");
	assert.equal(edited.sshHost, "other-pi");
	assert.equal(edited.user, undefined, "an explicit undefined clears the field");
	assert.equal(edited.port, 2200);
	assert.equal(edited.proxyJump, "ops@bastion:2200");
	assert.equal(edited.id, draft.id);
	assert.equal(edited.createdAt, draft.createdAt);
	const persisted = JSON.parse(await readFile(join(directory, "remote-hosts.json"), "utf8"));
	assert.equal(persisted.revision, 2);
	assert.equal(persisted.profiles.length, 1);
	assert.equal(Object.hasOwn(persisted.profiles[0], "user"), false, "the cleared field is gone from disk");
	assert.equal(persisted.profiles[0].sshHost, "other-pi");
	// A patch that omits a key keeps the current value.
	const kept = await store.updateDraft(draft.id, { label: "Renamed again" }, 2);
	assert.equal(kept.port, 2200);
	assert.equal(kept.proxyJump, "ops@bastion:2200");
	// getProfile hands out a copy, so a caller cannot mutate the live snapshot.
	const copy = store.getProfile(draft.id);
	copy.label = "mutated";
	assert.equal(store.getProfile(draft.id).label, "Renamed again");
	assert.equal(store.getProfile(missingHostId), undefined);
});

test("refuses to edit verified, disabled, referenced or invalid drafts", async (t) => {
	const { store, profile } = await verifiedHost(t);
	// A verified profile's endpoint identity is frozen: editing it would re-point a saved pin.
	await assert.rejects(store.updateDraft(profile.id, { sshHost: "attacker" }, 2), /REMOTE_HOST_EDIT_INVALID/);
	await store.disable(profile.id, 2);
	await assert.rejects(store.updateDraft(profile.id, { label: "Nope" }, 3), /REMOTE_HOST_EDIT_INVALID/);

	const { directory, pinStore, references } = await fixture(t);
	const created = await (await RemoteHostStore.open(directory, { pinStore, references })).createDraft({ label: "Free", sshHost: "build-pi", connectTimeoutMs: 15000 }, 0);
	// This instance sees the draft as referenced, so an in-place edit must be refused before anything else.
	const referenced = await RemoteHostStore.open(directory, { pinStore, references: { referencedHostIds: async () => new Set([created.id]) } });
	assert.equal(referenced.getSnapshot().revision, 1);
	await assert.rejects(referenced.updateDraft(created.id, { label: "Nope" }, 1), /REMOTE_HOST_REFERENCED/);
	await assert.rejects(referenced.updateDraft(created.id, { label: "   " }, 1), /REMOTE_HOST_REFERENCED/, "references are checked before field values");

	// An unreferenced view validates the patch itself.
	const free = await RemoteHostStore.open(directory, { pinStore, references });
	for (const patch of [{ label: "   " }, { label: "x".repeat(129) }, { sshHost: "-oProxyCommand=evil" }, { port: 0 }, { connectTimeoutMs: 999 }, { identityFile: "relative/key" }, { user: "bad user" }]) {
		await assert.rejects(free.updateDraft(created.id, patch, 1), /REMOTE_HOST_EDIT_INVALID/, JSON.stringify(patch));
	}
	await assert.rejects(free.updateDraft(created.id, { label: "Stale" }, 0), /REMOTE_HOST_REVISION_CONFLICT/);
	await assert.rejects(free.updateDraft(missingHostId, { label: "Ghost" }, 1), /REMOTE_HOST_EDIT_INVALID/);
	// Every rejected edit left the file untouched.
	assert.equal(JSON.parse(await readFile(join(directory, "remote-hosts.json"), "utf8")).revision, 1);
});

test("a failed retire commit keeps the pin and leaves the store usable", async (t) => {
	const { directory, pinStore, references } = await fixture(t);
	const store = await RemoteHostStore.open(directory, { pinStore, references });
	const profile = await store.createDraft({ label: "Build Pi", sshHost: "build-pi", connectTimeoutMs: 15000 }, 0);
	const offer = await store.offerPin(profile.id, 7, 1);
	await store.confirmPin({ hostId: profile.id, senderId: 7, requestId: offer.requestId, choice: "approve" }, 1);
	await store.disable(profile.id, 2);
	const pinPath = join(directory, "ssh-host-keys", profile.id);
	await access(pinPath);

	// Fill the retired-id list to the codec cap so the retire snapshot cannot be encoded: the commit
	// fails after the point where the old implementation had already deleted the trust anchor.
	const retired = Array.from({ length: 1000 }, (_value, index) => `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`);
	const current = JSON.parse(await readFile(join(directory, "remote-hosts.json"), "utf8"));
	await writeFile(join(directory, "remote-hosts.json"), JSON.stringify({ ...current, retiredHostIds: retired }));
	const reloaded = await RemoteHostStore.open(directory, { pinStore, references });
	assert.equal(reloaded.getSnapshot().status, "ready");
	await assert.rejects(reloaded.retire(profile.id, 3), /REMOTE_HOST_/);

	// The pin must still be there: losing it would permanently destroy the trust anchor of a host that
	// still exists, and every later load would report needs-repair.
	await access(pinPath);
	const afterFailure = await RemoteHostStore.open(directory, { pinStore, references });
	assert.equal(afterFailure.getSnapshot().status, "ready");
	assert.equal(afterFailure.getProfile(profile.id).disabledAt !== undefined, true);
});

test("a re-pointed draft cannot be confirmed against the route that was offered", async (t) => {
	const { directory, pinStore, references } = await fixture(t);
	const offeredRoutes = new Map();
	const wrapper = {
		offer: async (input) => {
			const result = await pinStore.offer(input);
			offeredRoutes.set(input.hostId, { ...input.route });
			return result;
		},
		answer: (input) => pinStore.answer(input),
		readPin: (hostId, endpoint) => pinStore.readPin(hostId, endpoint),
		deletePin: (hostId) => pinStore.deletePin(hostId),
		// Simulates a store that cannot report a pending offer, so only the confirm-time route check stands.
		hasPendingOffer: () => false,
		pendingRoute: (hostId) => offeredRoutes.get(hostId),
	};
	const store = await RemoteHostStore.open(directory, { pinStore: wrapper, references });
	const draft = await store.createDraft({ label: "Build Pi", sshHost: "build-pi", connectTimeoutMs: 15000 }, 0);
	const offer = await store.offerPin(draft.id, 7, 1);
	// The route was already authenticated when the offer was made; editing it now must not be able to
	// attach the verified endpoint of the old route to the new one.
	await store.updateDraft(draft.id, { sshHost: "evil-pi" }, 1);
	assert.equal(store.getProfile(draft.id).sshHost, "evil-pi");
	await assert.rejects(store.confirmPin({ hostId: draft.id, senderId: 7, requestId: offer.requestId, choice: "approve" }, 2), /REMOTE_HOST_ACTIVATION_INVALID/);
	assert.equal(store.getProfile(draft.id).verifiedEndpoint, undefined);
});

test("getProfile returns a deep copy that cannot corrupt trust metadata", async (t) => {
	const { store, profile } = await verifiedHost(t);
	const verified = store.getProfile(profile.id);
	assert.equal(verified.verifiedEndpoint.hostName, "pi.example.invalid");
	const copy = store.getProfile(profile.id);
	copy.verifiedEndpoint.hostName = "attacker.invalid";
	copy.verifiedEndpoint.hostKeyFingerprints[0] = "SHA256:attacker";
	assert.equal(store.getProfile(profile.id).verifiedEndpoint.hostName, "pi.example.invalid");
	assert.notEqual(store.getProfile(profile.id).verifiedEndpoint.hostKeyFingerprints[0], "SHA256:attacker");
	// Mutating a copy must not wedge the instance into a permanent revision conflict.
	await store.disable(profile.id, 2);
	assert.equal(store.getSnapshot().revision, 3);
});

test("refresh recovers from a transient lock and tolerates a retired host's leftover pin", async (t) => {
	const { directory, pinStore, references, store, profile, pinPath } = await verifiedHost(t);
	await store.disable(profile.id, 2);
	await store.retire(profile.id, 3);
	// A leftover pin for a retired id is garbage, not damage: the id can never be reused.
	await writeFile(pinPath, "retired pin leftover\n");
	const reopened = await RemoteHostStore.open(directory, { pinStore, references });
	assert.equal(reopened.getSnapshot().status, "ready");
	await assert.rejects(access(pinPath), (error) => error.code === "ENOENT", "the leftover pin is pruned");

	// A held lock marks the instance, and refresh() is the way back once the other writer is done.
	const lockPath = join(directory, "remote-hosts.json.lock");
	await writeFile(lockPath, "");
	const blocked = await RemoteHostStore.open(directory, { pinStore, references });
	assert.equal(blocked.getSnapshot().status, "needs-repair");
	assert.deepEqual(Array.from(blocked.getSnapshot().reasons), ["REMOTE_HOST_LOCK_PRESENT"]);
	await rm(lockPath);
	const refreshed = await blocked.refresh();
	assert.equal(refreshed.status, "ready");
	const created = await blocked.createDraft({ label: "After lock", sshHost: "build-pi", connectTimeoutMs: 15000 }, refreshed.revision);
	assert.equal(blocked.getProfile(created.id).label, "After lock");
});

test("retiring needs a reference provider, a tombstone and no remaining references", async (t) => {
	const { directory: bareDirectory, pinStore: barePins } = await fixture(t);
	const withoutProvider = await RemoteHostStore.open(bareDirectory, { pinStore: barePins });
	const draft = await withoutProvider.createDraft({ label: "Draft", sshHost: "build-pi", connectTimeoutMs: 15000 }, 0);
	await withoutProvider.disable(draft.id, 1);
	// Without a provider the store cannot prove the host is unreferenced, so a hard delete is refused.
	await assert.rejects(withoutProvider.retire(draft.id, 2), /REMOTE_HOST_REFERENCES_UNAVAILABLE/);

	const { directory, store, pinStore, profile, pinPath } = await verifiedHost(t);
	await assert.rejects(store.retire(profile.id, 2), /REMOTE_HOST_RETIRE_INVALID/, "a verified, enabled host must be disabled first");
	await store.disable(profile.id, 2);
	const referenced = await RemoteHostStore.open(directory, { pinStore, references: { referencedHostIds: async () => new Set([profile.id]) } });
	await assert.rejects(referenced.retire(profile.id, 3), /REMOTE_HOST_REFERENCED/);

	await store.retire(profile.id, 3);
	const snapshot = store.getSnapshot();
	assert.equal(snapshot.status, "ready");
	assert.equal(snapshot.revision, 4);
	assert.equal(snapshot.profiles.length, 0);
	assert.deepEqual(Array.from(snapshot.retiredHostIds), [profile.id]);
	assert.equal(store.getProfile(profile.id), undefined);
	// The pin must not survive its profile, otherwise every later load reports an orphan pin.
	await assert.rejects(access(pinPath), (error) => error.code === "ENOENT");
	const reloaded = await RemoteHostStore.open(directory, { pinStore });
	assert.equal(reloaded.getSnapshot().status, "ready");
	assert.deepEqual(Array.from(reloaded.getSnapshot().retiredHostIds), [profile.id]);
	await assert.rejects(store.retire(profile.id, 4), /REMOTE_HOST_RETIRE_INVALID/, "a retired id has no profile left");
});
