import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { RemoteHostRepair } = loadTsCommonJs("src/main/remote/RemoteHostRepair.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");
const { SshHostPinStore } = loadTsCommonJs("src/main/remote/SshHostPinStore.ts");

const CONFIRMATION = { requestId: "repair-1", senderId: 7 };

function sshString(text) {
	const value = Buffer.isBuffer(text) ? text : Buffer.from(text);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(value.length);
	return Buffer.concat([size, value]);
}

function authenticatedCandidate(id, seed = 41) {
	const pinAlias = `pideck-${id}`;
	const key = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, seed))]);
	const bytes = Buffer.from(`${pinAlias} ssh-ed25519 ${key.toString("base64")}\n`);
	return {
		hostName: "pi.example.invalid",
		user: "alice",
		port: 2222,
		pinAlias,
		routeDigest: createHash("sha256").update("route-repair").digest("hex"),
		knownHostsSha256: createHash("sha256").update(bytes).digest("hex"),
		knownHostsBase64: bytes.toString("base64"),
		hostKeyFingerprints: [`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`],
	};
}

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-host-repair-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const pinStore = new SshHostPinStore(directory, { verifier: async (_route, alias) => authenticatedCandidate(alias.slice("pideck-".length)) });
	t.after(() => pinStore.dispose());
	const references = { referencedHostIds: async () => new Set() };
	const store = await RemoteHostStore.open(directory, { pinStore, references });
	return {
		directory,
		pinStore,
		references,
		store,
		open: (options = {}) => RemoteHostStore.open(directory, { pinStore, references, ...options }),
	};
}

function repairFor(host, options = {}) {
	return new RemoteHostRepair({
		userDataDir: host.directory,
		store: options.store ?? host.store,
		pins: {
			verifyRoute: options.verifyRoute ?? (async (_route, alias) => authenticatedCandidate(alias.slice("pideck-".length))),
			readPin: (hostId, endpoint) => host.pinStore.readPin(hostId, endpoint),
			deletePin: (hostId) => host.pinStore.deletePin(hostId),
		},
		...(options.repair ?? {}),
	});
}

async function rejectsWithCode(operation, code) {
	await assert.rejects(operation, (error) => {
		assert.equal(error.message, code);
		return true;
	});
}

function pinPathOf(directory, hostId) {
	return join(directory, "ssh-host-keys", hostId);
}

async function pinBytes(directory, hostId) {
	return readFile(pinPathOf(directory, hostId));
}

async function assertMissing(path, message) {
	await assert.rejects(lstat(path), (error) => error.code === "ENOENT", message);
}

/** Content digest of the two stores plus the pins, used to prove "this primitive wrote nothing". */
async function stateDigest(directory) {
	const hosts = await readFile(join(directory, "remote-hosts.json"), "utf8").catch(() => null);
	let names = [];
	try {
		names = (await readdir(join(directory, "ssh-host-keys"))).sort();
	} catch {
		names = [];
	}
	const pins = [];
	for (const name of names) {
		const bytes = await readFile(join(directory, "ssh-host-keys", name));
		pins.push(`${name}:${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`);
	}
	return { hosts, pins: pins.join("|") };
}

async function verifiedHost(host, label = "Build Pi", sshHost = "build-pi") {
	const created = await host.store.createDraft({ label, sshHost, user: "alice", port: 2222, connectTimeoutMs: 15000 }, host.store.getSnapshot().revision);
	const offer = await host.store.offerPin(created.id, 7, host.store.getSnapshot().revision);
	await host.store.confirmPin({ hostId: created.id, senderId: 7, requestId: offer.requestId, choice: "approve" }, host.store.getSnapshot().revision);
	return host.store.getProfile(created.id);
}

/** Reproduces the interrupted `confirmPin`: the pin is published, the profile stays a draft. */
async function draftWithOrphanPin(host, label = "Draft") {
	const draft = await host.store.createDraft({ label, sshHost: "build-pi", user: "alice", port: 2222, connectTimeoutMs: 15000 }, host.store.getSnapshot().revision);
	const offer = await host.pinStore.offer({ hostId: draft.id, senderId: 7, route: { sshHost: draft.sshHost, user: draft.user, port: draft.port } });
	await host.pinStore.answer({ requestId: offer.requestId, hostId: draft.id, senderId: 7, choice: "approve" });
	await host.store.refresh();
	return draft;
}

test("discardOrphanPin removes only the unclaimed pin of a draft and restores a ready store", async (t) => {
	const host = await fixture(t);
	const draft = await draftWithOrphanPin(host);
	assert.deepEqual(Array.from(host.store.getSnapshot().reasons), ["REMOTE_HOST_PIN_ORPHAN"]);
	assert.ok((await pinBytes(host.directory, draft.id)).length > 0);

	await repairFor(host).discardOrphanPin(draft.id, CONFIRMATION);

	await assertMissing(pinPathOf(host.directory, draft.id), "the orphan pin is gone");
	const snapshot = host.store.getSnapshot();
	assert.equal(snapshot.status, "ready");
	assert.deepEqual(Array.from(snapshot.reasons), []);
	assert.equal(snapshot.revision, 1, "a pin-only repair does not rewrite the profile snapshot");
	assert.equal(snapshot.profiles.length, 1, "the draft profile itself is untouched");
	assert.equal(host.store.getProfile(draft.id).verifiedEndpoint, undefined);
	assert.equal((await host.open()).getSnapshot().status, "ready", "a restart also sees a ready store");
});

test("discardOrphanPin never deletes a pin a profile still claims", async (t) => {
	const host = await fixture(t);
	const verified = await verifiedHost(host);
	const before = await pinBytes(host.directory, verified.id);
	const repair = repairFor(host);

	await rejectsWithCode(repair.discardOrphanPin(verified.id, CONFIRMATION), "HOST_REPAIR_NOT_APPLICABLE");
	assert.deepEqual(await pinBytes(host.directory, verified.id), before, "the trust anchor is byte-identical");

	await host.store.disable(verified.id, host.store.getSnapshot().revision);
	await rejectsWithCode(repair.discardOrphanPin(verified.id, CONFIRMATION), "HOST_REPAIR_NOT_APPLICABLE");
	assert.deepEqual(await pinBytes(host.directory, verified.id), before, "a disabled tombstone's anchor is not 'orphan'");

	await rejectsWithCode(repair.discardOrphanPin("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", CONFIRMATION), "HOST_REPAIR_NOT_APPLICABLE");
	await rejectsWithCode(repair.discardOrphanPin("not-a-host-id", CONFIRMATION), "HOST_REPAIR_HOST_ID_INVALID");
	assert.deepEqual(await pinBytes(host.directory, verified.id), before);
});

test("every primitive refuses to act without a human confirmation", async (t) => {
	const host = await fixture(t);
	// Set the damaged host up first: publishing an orphan pin immediately makes the store read-only.
	const damaged = await verifiedHost(host, "Damaged", "damaged-pi");
	const draft = await draftWithOrphanPin(host);
	await rm(pinPathOf(host.directory, damaged.id));
	await host.store.refresh();
	const repair = repairFor(host);
	const revision = host.store.getSnapshot().revision;
	const before = await stateDigest(host.directory);

	for (const confirmation of [undefined, {}, { requestId: "", senderId: 7 }, { requestId: "repair-1", senderId: 0 }, { requestId: "repair-1", senderId: 1.5 }]) {
		await rejectsWithCode(repair.completeActivationFromPin(draft.id, revision, confirmation), "HOST_REPAIR_CONFIRMATION_REQUIRED");
		await rejectsWithCode(repair.discardOrphanPin(draft.id, confirmation), "HOST_REPAIR_CONFIRMATION_REQUIRED");
		await rejectsWithCode(repair.clearStaleHostLock(process.pid, confirmation), "HOST_REPAIR_CONFIRMATION_REQUIRED");
		await rejectsWithCode(repair.forgetTrustAnchor(damaged.id, revision, confirmation), "HOST_REPAIR_CONFIRMATION_REQUIRED");
	}
	assert.deepEqual(await stateDigest(host.directory), before, "an unconfirmed call writes nothing");
});

test("completeActivationFromPin finishes the interrupted activation using the published pin", async (t) => {
	const host = await fixture(t);
	const draft = await draftWithOrphanPin(host);
	const revision = host.store.getSnapshot().revision;
	const before = await pinBytes(host.directory, draft.id);
	const candidate = authenticatedCandidate(draft.id);

	await repairFor(host).completeActivationFromPin(draft.id, revision, CONFIRMATION);

	const profile = host.store.getProfile(draft.id);
	assert.equal(profile.verifiedEndpoint.knownHostsSha256, createHash("sha256").update(before).digest("hex"));
	assert.deepEqual(Array.from(profile.verifiedEndpoint.hostKeyFingerprints), candidate.hostKeyFingerprints);
	assert.equal(profile.verifiedEndpoint.hostName, candidate.hostName);
	assert.equal(typeof profile.verifiedAt, "string");
	assert.equal(host.store.getSnapshot().status, "ready");
	assert.deepEqual(await pinBytes(host.directory, draft.id), before, "the original trust anchor is preserved");

	const reopened = await host.open();
	assert.equal(reopened.getSnapshot().status, "ready");
	assert.equal(reopened.getSnapshot().revision, revision + 1);
	assert.notEqual(reopened.getProfile(draft.id).verifiedEndpoint, undefined);
});

test("completeActivationFromPin refuses a host that no longer presents the pinned key", async (t) => {
	const host = await fixture(t);
	const draft = await draftWithOrphanPin(host);
	const revision = host.store.getSnapshot().revision;
	const before = await pinBytes(host.directory, draft.id);

	// Same alias, different host key: the candidate must not be able to replace the confirmed trust.
	const rotated = repairFor(host, { verifyRoute: async (_route, alias) => authenticatedCandidate(alias.slice("pideck-".length), 99) });
	await rejectsWithCode(rotated.completeActivationFromPin(draft.id, revision, CONFIRMATION), "HOST_REPAIR_ANCHOR_MISMATCH");
	assert.equal(host.store.getProfile(draft.id).verifiedEndpoint, undefined);
	assert.equal(host.store.getSnapshot().revision, revision);
	assert.deepEqual(await pinBytes(host.directory, draft.id), before);

	const unreachable = repairFor(host, {
		verifyRoute: async () => {
			throw new Error("SSH_HOST_AUTHENTICATION_FAILED");
		},
	});
	await rejectsWithCode(unreachable.completeActivationFromPin(draft.id, revision, CONFIRMATION), "HOST_REPAIR_ROUTE_UNVERIFIED");
	assert.equal(host.store.getProfile(draft.id).verifiedEndpoint, undefined);
});

test("completeActivationFromPin only applies to a draft with a readable pin and the right revision", async (t) => {
	const host = await fixture(t);
	const verified = await verifiedHost(host);
	await host.store.disable(verified.id, host.store.getSnapshot().revision);
	const revision = host.store.getSnapshot().revision;
	const repair = repairFor(host);

	await rejectsWithCode(repair.completeActivationFromPin(verified.id, revision, CONFIRMATION), "HOST_REPAIR_NOT_APPLICABLE");

	const fresh = await fixture(t);
	const draftOnly = await fresh.store.createDraft({ label: "No pin", sshHost: "no-pin", connectTimeoutMs: 15000 }, 0);
	await rejectsWithCode(repairFor(fresh).completeActivationFromPin(draftOnly.id, 1, CONFIRMATION), "HOST_REPAIR_NOT_APPLICABLE");
	await rejectsWithCode(repairFor(fresh).completeActivationFromPin(draftOnly.id, "1", CONFIRMATION), "HOST_REPAIR_REVISION_INVALID");
	await rejectsWithCode(repairFor(fresh).completeActivationFromPin(draftOnly.id, 7, CONFIRMATION), "HOST_REPAIR_REVISION_CONFLICT");
});

test("forgetTrustAnchor refuses while the anchor still certifies its pin", async (t) => {
	const host = await fixture(t);
	const verified = await verifiedHost(host);
	const revision = host.store.getSnapshot().revision;
	const pinBefore = await pinBytes(host.directory, verified.id);
	const hostsBefore = await readFile(join(host.directory, "remote-hosts.json"), "utf8");

	await rejectsWithCode(repairFor(host).forgetTrustAnchor(verified.id, revision, CONFIRMATION), "HOST_REPAIR_ANCHOR_STILL_VALID");
	assert.equal(await readFile(join(host.directory, "remote-hosts.json"), "utf8"), hostsBefore);
	assert.deepEqual(await pinBytes(host.directory, verified.id), pinBefore);
	assert.notEqual(host.store.getProfile(verified.id).verifiedEndpoint, undefined);
	assert.equal(host.store.getSnapshot().revision, revision);
});

test("forgetTrustAnchor downgrades only the damaged profile and keeps every other anchor", async (t) => {
	const host = await fixture(t);
	const damaged = await verifiedHost(host, "Build Pi", "build-pi");
	const healthy = await verifiedHost(host, "Deploy Pi", "deploy-pi");
	const healthyPin = await pinBytes(host.directory, healthy.id);
	await rm(pinPathOf(host.directory, damaged.id));
	await host.store.refresh();
	assert.deepEqual(Array.from(host.store.getSnapshot().reasons), ["REMOTE_HOST_PIN_INVALID"]);

	const summary = await repairFor(host).forgetTrustAnchor(damaged.id, host.store.getSnapshot().revision, CONFIRMATION);

	assert.equal(summary.id, damaged.id);
	assert.equal(summary.label, "Build Pi");
	assert.equal(summary.verified, false);
	assert.equal(summary.disabled, true);
	assert.equal(summary.revision, host.store.getSnapshot().revision);
	const downgraded = host.store.getProfile(damaged.id);
	assert.equal(downgraded.verifiedEndpoint, undefined);
	assert.equal(downgraded.verifiedAt, undefined, "endpoint and timestamp are dropped together");
	assert.equal(typeof downgraded.disabledAt, "string");
	assert.equal(downgraded.label, "Build Pi", "the identity survives the downgrade");
	assert.equal(host.store.getSnapshot().profiles.length, 2, "the profile is not removed");
	assert.deepEqual(Array.from(host.store.getSnapshot().retiredHostIds), [], "no retirement happens here");
	assert.equal(host.store.getSnapshot().status, "ready");
	assert.deepEqual(await pinBytes(host.directory, healthy.id), healthyPin, "the healthy host keeps its anchor byte-for-byte");
	assert.notEqual(host.store.getProfile(healthy.id).verifiedEndpoint, undefined);
});

test("forgetTrustAnchor deletes a pin only when it provably no longer certifies the anchor", async (t) => {
	// (a) readable but mismatched pin: no profile claims it after the downgrade, so it is cleaned up.
	const tampered = await fixture(t);
	const tamperedHost = await verifiedHost(tampered);
	await writeFile(pinPathOf(tampered.directory, tamperedHost.id), "tampered host key\n");
	await tampered.store.refresh();
	assert.deepEqual(Array.from(tampered.store.getSnapshot().reasons), ["REMOTE_HOST_PIN_INVALID"]);
	await repairFor(tampered).forgetTrustAnchor(tamperedHost.id, tampered.store.getSnapshot().revision, CONFIRMATION);
	assert.equal(tampered.store.getSnapshot().status, "ready");
	await assertMissing(pinPathOf(tampered.directory, tamperedHost.id), "the unclaimed, non-certifying pin is gone");
	assert.equal(tampered.store.getProfile(tamperedHost.id).verifiedEndpoint, undefined);

	// (b) unreadable pin file: without proof nothing is deleted, and the leftover is reported instead.
	const opaque = await fixture(t);
	const second = await verifiedHost(opaque);
	const pinPath = pinPathOf(opaque.directory, second.id);
	await rm(pinPath);
	await mkdir(pinPath);
	await opaque.store.refresh();
	assert.deepEqual(Array.from(opaque.store.getSnapshot().reasons), ["REMOTE_HOST_PIN_INVALID"]);
	await repairFor(opaque).forgetTrustAnchor(second.id, opaque.store.getSnapshot().revision, CONFIRMATION);
	assert.equal((await lstat(pinPath)).isDirectory(), true, "an unreadable pin is never deleted");
	assert.deepEqual(Array.from(opaque.store.getSnapshot().reasons), ["REMOTE_HOST_PIN_ORPHAN"], "the leftover is reported for a human instead of vanishing");
	assert.equal(opaque.store.getProfile(second.id).verifiedEndpoint, undefined);
});

test("a store damaged for another reason stays read-only for every repair write", async (t) => {
	const host = await fixture(t);
	const damaged = await verifiedHost(host, "Damaged", "damaged-pi");
	const draft = await draftWithOrphanPin(host);
	await rm(pinPathOf(host.directory, damaged.id));
	await host.store.refresh();
	const revision = host.store.getSnapshot().revision;
	const before = await stateDigest(host.directory);
	const repair = repairFor(host);

	// Both reasons coexist, so neither primitive may act: each owns exactly one reason class.
	await rejectsWithCode(repair.completeActivationFromPin(draft.id, revision, CONFIRMATION), "HOST_REPAIR_STORE_NOT_READY");
	await rejectsWithCode(repair.forgetTrustAnchor(damaged.id, revision, CONFIRMATION), "HOST_REPAIR_STORE_NOT_READY");
	assert.deepEqual(await stateDigest(host.directory), before);
	assert.equal(host.store.getProfile(draft.id).verifiedEndpoint, undefined);
	assert.notEqual(host.store.getProfile(damaged.id).verifiedEndpoint, undefined);
});

test("the store re-checks the pin under its lock, so a pin replaced in between aborts the repair", async (t) => {
	const host = await fixture(t);
	const draft = await draftWithOrphanPin(host);
	const revision = host.store.getSnapshot().revision;
	// The repair module's own certification still succeeds; the store's lock-time check is what fails.
	const guarded = await RemoteHostStore.open(host.directory, {
		pinStore: {
			offer: (input) => host.pinStore.offer(input),
			answer: (input) => host.pinStore.answer(input),
			readPin: async () => {
				throw new Error("SSH_HOST_PIN_INVALID");
			},
			deletePin: (hostId) => host.pinStore.deletePin(hostId),
		},
		references: host.references,
	});
	const repair = repairFor(host, { store: guarded });
	await rejectsWithCode(repair.completeActivationFromPin(draft.id, revision, CONFIRMATION), "HOST_REPAIR_ANCHOR_UNREADABLE");
	assert.equal(guarded.getSnapshot().revision, revision);
	assert.equal(guarded.getProfile(draft.id).verifiedEndpoint, undefined);
});

test("diagnose maps every reason to legal actions and never writes", async (t) => {
	const host = await fixture(t);
	const damaged = await verifiedHost(host, "Damaged", "damaged-pi");
	const draft = await draftWithOrphanPin(host);
	await rm(pinPathOf(host.directory, damaged.id));
	await host.store.refresh();
	assert.deepEqual(Array.from(host.store.getSnapshot().reasons).sort(), ["REMOTE_HOST_PIN_INVALID", "REMOTE_HOST_PIN_ORPHAN"]);

	const before = await stateDigest(host.directory);
	const findings = await repairFor(host).diagnose();
	assert.deepEqual(await stateDigest(host.directory), before, "diagnosis is read-only");

	const byReason = new Map(Array.from(findings, (finding) => [finding.reason, finding]));
	assert.deepEqual(Array.from(byReason.get("REMOTE_HOST_PIN_ORPHAN").hostIds), [draft.id]);
	assert.equal(byReason.get("REMOTE_HOST_PIN_ORPHAN").classification, "orphan-pin");
	assert.deepEqual(Array.from(byReason.get("REMOTE_HOST_PIN_ORPHAN").actions), ["complete-activation-from-pin", "discard-orphan-pin"]);
	assert.deepEqual(Array.from(byReason.get("REMOTE_HOST_PIN_INVALID").hostIds), [damaged.id]);
	assert.equal(byReason.get("REMOTE_HOST_PIN_INVALID").classification, "anchor-invalid");
	assert.deepEqual(Array.from(byReason.get("REMOTE_HOST_PIN_INVALID").actions), ["rebuild-target-and-rebind", "forget-trust-anchor", "fix-filesystem-permissions"]);
});

test("clearStaleHostLock clears an old ownerless lock and the store accepts writes again", async (t) => {
	const host = await fixture(t);
	const lockPath = join(host.directory, "remote-hosts.json.lock");
	await writeFile(lockPath, "");
	const past = new Date(Date.now() - 10 * 60 * 1000);
	await utimes(lockPath, past, past);
	await host.store.refresh();
	assert.deepEqual(Array.from(host.store.getSnapshot().reasons), ["REMOTE_HOST_LOCK_PRESENT"]);

	await repairFor(host, { repair: { lockAgeMs: 60_000 } }).clearStaleHostLock(process.pid, CONFIRMATION);

	await assertMissing(lockPath, "the stale lock is gone");
	assert.equal(host.store.getSnapshot().status, "ready");
	// End-to-end: a harmless write succeeds, which is the "back to usable" check of §6.2 C.
	const created = await host.store.createDraft({ label: "After repair", sshHost: "after-pi", connectTimeoutMs: 15000 }, host.store.getSnapshot().revision);
	assert.equal(host.store.getProfile(created.id).label, "After repair");
});

test("clearStaleHostLock refuses live writers, its own pid, fresh locks and active writes", async (t) => {
	const host = await fixture(t);
	const lockPath = join(host.directory, "remote-hosts.json.lock");
	const ownerOf = (overrides = {}) => JSON.stringify({ pid: 424242, bootId: "boot-1", startedAt: "2026-09-01T00:00:00.000Z", ...overrides });
	await writeFile(lockPath, ownerOf());

	const liveOwner = repairFor(host, { repair: { isProcessAlive: () => true, bootId: "boot-1", lockAgeMs: 0 } });
	await rejectsWithCode(liveOwner.clearStaleHostLock(999, CONFIRMATION), "HOST_REPAIR_LOCK_HELD");
	await rejectsWithCode(liveOwner.clearStaleHostLock(424242, CONFIRMATION), "HOST_REPAIR_LOCK_HELD");
	assert.equal((await lstat(lockPath)).isFile(), true);

	// Same pid, different boot id: the pid was reused after a reboot, so the lock is provably stale.
	await repairFor(host, { repair: { isProcessAlive: () => true, bootId: "boot-2", lockAgeMs: 0 } }).clearStaleHostLock(999, CONFIRMATION);
	await assertMissing(lockPath, "a provably stale owner is recovered");

	// Ownerless lock: only age plus "no active writer" may clear it.
	await writeFile(lockPath, "");
	const tooFresh = repairFor(host, { repair: { lockAgeMs: 60_000 } });
	await rejectsWithCode(tooFresh.clearStaleHostLock(process.pid, CONFIRMATION), "HOST_REPAIR_LOCK_HELD");
	const past = new Date(Date.now() - 10 * 60 * 1000);
	await utimes(lockPath, past, past);
	const tempPath = join(host.directory, `remote-hosts.json.${"a".repeat(8)}.tmp`);
	await writeFile(tempPath, "in flight");
	await rejectsWithCode(tooFresh.clearStaleHostLock(process.pid, CONFIRMATION), "HOST_REPAIR_LOCK_HELD");
	assert.equal((await lstat(lockPath)).isFile(), true, "no lock is removed while a writer may be committing");
	await rm(tempPath);

	await rejectsWithCode(tooFresh.clearStaleHostLock(0, CONFIRMATION), "HOST_REPAIR_OBSERVER_PID_INVALID");
	await tooFresh.clearStaleHostLock(process.pid, CONFIRMATION);
	await rejectsWithCode(tooFresh.clearStaleHostLock(process.pid, CONFIRMATION), "HOST_REPAIR_NOT_APPLICABLE");
});

test("a repair primitive never touches a host other than the one it was given", async (t) => {
	const host = await fixture(t);
	const damaged = await verifiedHost(host, "Damaged", "damaged-pi");
	const untouched = await verifiedHost(host, "Untouched", "untouched-pi");
	const untouchedPin = await pinBytes(host.directory, untouched.id);
	const untouchedProfile = JSON.stringify(host.store.getProfile(untouched.id));
	await rm(pinPathOf(host.directory, damaged.id));
	await host.store.refresh();

	await repairFor(host).forgetTrustAnchor(damaged.id, host.store.getSnapshot().revision, CONFIRMATION);

	assert.deepEqual(await pinBytes(host.directory, untouched.id), untouchedPin);
	assert.equal(JSON.stringify(host.store.getProfile(untouched.id)), untouchedProfile);
	assert.deepEqual(Array.from(host.store.getSnapshot().retiredHostIds), []);
});
