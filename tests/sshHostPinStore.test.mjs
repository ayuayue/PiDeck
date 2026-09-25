import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SshHostPinStore } = loadTsCommonJs("src/main/remote/SshHostPinStore.ts");
const hostId = "01234567-89ab-4def-8123-456789abcdef";
const pinAlias = `pideck-${hostId}`;
const route = { sshHost: "work", user: "alice", port: 2222 };
const senderId = 12;

function sshString(value) {
	const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(data.length);
	return Buffer.concat([size, data]);
}

function candidate(seed = 17) {
	const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, seed))]);
	const bytes = Buffer.from(`${pinAlias} ssh-ed25519 ${blob.toString("base64")}\n`);
	return {
		hostName: "server.example.invalid",
		user: "alice",
		port: 2222,
		pinAlias,
		routeDigest: createHash("sha256").update("effective-route").digest("hex"),
		knownHostsBase64: bytes.toString("base64"),
		knownHostsSha256: createHash("sha256").update(bytes).digest("hex"),
		hostKeyFingerprints: [`SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`],
	};
}

async function root(t) {
	const path = await mkdtemp(join(tmpdir(), "pideck-pin-store-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

function pinPath(rootPath) {
	return join(rootPath, "ssh-host-keys", hostId);
}

async function assertMissing(path) {
	await assert.rejects(lstat(path), (error) => error.code === "ENOENT");
}

test("writes only the confirmed, reverified pin and validates its bytes on every read", async (t) => {
	const directory = await root(t);
	let verifications = 0;
	const store = new SshHostPinStore(directory, {
		verifier: async (_route, alias) => {
			assert.equal(alias, pinAlias);
			verifications += 1;
			return candidate();
		},
	});
	t.after(() => store.dispose());
	const offer = await store.offer({ hostId, senderId, route });
	assert.equal(offer.hostName, "server.example.invalid");
	assert.deepEqual(Array.from(offer.hostKeyFingerprints), candidate().hostKeyFingerprints);
	assert.equal("knownHostsBase64" in offer, false);
	await assertMissing(pinPath(directory));
	const endpoint = await store.answer({ requestId: offer.requestId, hostId, senderId, choice: "approve" });
	assert.equal(verifications, 2);
	assert.equal(endpoint.pinAlias, pinAlias);
	assert.equal(endpoint.knownHostsSha256, candidate().knownHostsSha256);
	assert.equal((await readFile(pinPath(directory))).toString("base64"), candidate().knownHostsBase64);
	assert.equal((await store.readPin(hostId, endpoint)).filePath, pinPath(directory));
	await assert.rejects(store.offer({ hostId, senderId, route }), /SSH_HOST_PIN_EXISTS/);
	await assert.rejects(store.answer({ requestId: offer.requestId, hostId, senderId, choice: "approve" }), /SSH_HOST_CONFIRMATION_INVALID/);
});

test("rejects a sender mismatch without consuming a valid pending request", async (t) => {
	const directory = await root(t);
	const store = new SshHostPinStore(directory, { verifier: async () => candidate() });
	t.after(() => store.dispose());
	const offer = await store.offer({ hostId, senderId, route });
	await assert.rejects(store.answer({ requestId: offer.requestId, hostId, senderId: senderId + 1, choice: "approve" }), /CONFIRMATION_INVALID/);
	assert.equal(await store.answer({ requestId: offer.requestId, hostId, senderId, choice: "deny" }), null);
	await assertMissing(pinPath(directory));
});

test("host key and route changes during the prompt never persist a pin", async (t) => {
	for (const variation of ["key", "route"]) {
		const directory = await root(t);
		let probes = 0;
		const store = new SshHostPinStore(directory, {
			verifier: async () => {
				probes += 1;
				if (probes === 1) return candidate();
				return variation === "key" ? candidate(18) : { ...candidate(), routeDigest: createHash("sha256").update("changed-route").digest("hex") };
			},
		});
		t.after(() => store.dispose());
		const offer = await store.offer({ hostId, senderId, route });
		await assert.rejects(store.answer({ requestId: offer.requestId, hostId, senderId, choice: "approve" }), /SSH_HOST_CANDIDATE_CHANGED/);
		await assertMissing(pinPath(directory));
	}
});

test("rejects a malformed candidate and a modified persisted pin", async (t) => {
	const directory = await root(t);
	const broken = new SshHostPinStore(directory, { verifier: async () => ({ ...candidate(), knownHostsSha256: "0".repeat(64) }) });
	t.after(() => broken.dispose());
	await assert.rejects(broken.offer({ hostId, senderId, route }), /SSH_HOST_CANDIDATE_INVALID/);
	await assertMissing(pinPath(directory));
	const store = new SshHostPinStore(directory, { verifier: async () => candidate() });
	t.after(() => store.dispose());
	const offer = await store.offer({ hostId, senderId, route });
	const endpoint = await store.answer({ requestId: offer.requestId, hostId, senderId, choice: "approve" });
	await writeFile(pinPath(directory), "changed\n", "utf8");
	await assert.rejects(store.readPin(hostId, endpoint), /SSH_HOST_PIN_INVALID/);
	assert.equal(await readFile(pinPath(directory), "utf8"), "changed\n");
});

test("a pin created after the prompt cannot be overwritten on approval", async (t) => {
	const directory = await root(t);
	const store = new SshHostPinStore(directory, { verifier: async () => candidate() });
	t.after(() => store.dispose());
	const offer = await store.offer({ hostId, senderId, route });
	const filePath = pinPath(directory);
	await mkdir(join(directory, "ssh-host-keys"));
	await writeFile(filePath, "existing pin\n", "utf8");
	await assert.rejects(store.answer({ requestId: offer.requestId, hostId, senderId, choice: "approve" }), /SSH_HOST_PIN_EXISTS/);
	assert.equal(await readFile(filePath, "utf8"), "existing pin\n");
});

test("an orphaned pin blocks enrollment until an explicit repair", async (t) => {
	const directory = await root(t);
	const filePath = pinPath(directory);
	await mkdir(join(directory, "ssh-host-keys"));
	await writeFile(filePath, Buffer.from(candidate().knownHostsBase64, "base64"));
	let invoked = false;
	const store = new SshHostPinStore(directory, {
		verifier: async () => {
			invoked = true;
			return candidate();
		},
	});
	t.after(() => store.dispose());
	await assert.rejects(store.offer({ hostId, senderId, route }), /SSH_HOST_PIN_EXISTS/);
	assert.equal(invoked, false);
});

test("never replaces an existing pin and fails closed after a hard-link error", async (t) => {
	const directory = await root(t);
	const realFs = await import("node:fs/promises");
	const { SshHostPinStore: FailingPinStore } = loadTsCommonJs("src/main/remote/SshHostPinStore.ts", {
		stubs: {
			"node:fs/promises": {
				...realFs,
				link: async () => {
					throw new Error("storage failure with private path");
				},
			},
		},
	});
	const store = new FailingPinStore(directory, { verifier: async () => candidate() });
	t.after(() => store.dispose());
	const offer = await store.offer({ hostId, senderId, route });
	await assert.rejects(store.answer({ requestId: offer.requestId, hostId, senderId, choice: "approve" }), (error) => error.message === "SSH_HOST_PIN_WRITE_FAILED");
	await assertMissing(pinPath(directory));
	const entries = await realFs.readdir(join(directory, "ssh-host-keys"));
	assert.deepEqual(entries, []);
});

test("a closed sender cannot receive a late prompt or publish a pin during revalidation", async (t) => {
	const directory = await root(t);
	let startFirst;
	let finishFirst;
	const firstStarted = new Promise((resolve) => {
		startFirst = resolve;
	});
	const firstStore = new SshHostPinStore(directory, {
		verifier: async () => {
			startFirst();
			return new Promise((resolve) => {
				finishFirst = resolve;
			});
		},
	});
	t.after(() => firstStore.dispose());
	const pendingOffer = firstStore.offer({ hostId, senderId, route });
	await firstStarted;
	firstStore.cancelSender(senderId);
	finishFirst(candidate());
	await assert.rejects(pendingOffer, /CONFIRMATION_CANCELLED/);
	await assertMissing(pinPath(directory));

	let count = 0;
	let startSecond;
	let finishSecond;
	const secondStarted = new Promise((resolve) => {
		startSecond = resolve;
	});
	const secondStore = new SshHostPinStore(directory, {
		verifier: async () => {
			count += 1;
			if (count === 1) return candidate();
			startSecond();
			return new Promise((resolve) => {
				finishSecond = resolve;
			});
		},
	});
	t.after(() => secondStore.dispose());
	const offer = await secondStore.offer({ hostId, senderId, route });
	const approval = secondStore.answer({ requestId: offer.requestId, hostId, senderId, choice: "approve" });
	await secondStarted;
	secondStore.cancelSender(senderId);
	finishSecond(candidate());
	await assert.rejects(approval, /CONFIRMATION_CANCELLED/);
	await assertMissing(pinPath(directory));
});

test("new prompt invalidates an earlier request, and closed windows cannot approve", async (t) => {
	const directory = await root(t);
	const store = new SshHostPinStore(directory, { verifier: async () => candidate() });
	t.after(() => store.dispose());
	const oldOffer = await store.offer({ hostId, senderId, route });
	const currentOffer = await store.offer({ hostId, senderId, route });
	await assert.rejects(store.answer({ requestId: oldOffer.requestId, hostId, senderId, choice: "approve" }), /SSH_HOST_CONFIRMATION_INVALID/);
	store.cancelSender(senderId);
	await assert.rejects(store.answer({ requestId: currentOffer.requestId, hostId, senderId, choice: "approve" }), /SSH_HOST_CONFIRMATION_INVALID/);
	await assertMissing(pinPath(directory));
});
