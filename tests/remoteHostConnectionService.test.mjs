import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteHostConnectionService } = loadTsCommonJs("src/main/remote/RemoteHostConnectionService.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");

const HOST_ID = "b145de8c-6330-45be-8752-f20e8e270150";
const OTHER_HOST_ID = "0e0f18ba-6f0e-4bd8-9f6c-1c8f6f2a7d31";
const CLIENT = { sshPath: "/usr/bin/ssh", scpPath: "/usr/bin/scp", env: { PATH: "/usr/bin" }, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };

// The production modules are loaded into a `vm` realm, so their plain objects carry that realm's
// prototypes. `deepStrictEqual` compares prototypes across realms, so assertions run on JSON views.
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * A structurally valid profile: the store fails closed to revision 0 / needs-repair on a malformed
 * snapshot (`REMOTE_HOST_SNAPSHOT_INVALID`), which would silently make the revision checks vacuous.
 * No `verifiedEndpoint`, so the profile is a never-verified draft and needs no pin on disk.
 */
function profile(entry) {
	const hostId = typeof entry === "string" ? entry : entry.id;
	const at = "2026-01-01T00:00:00.000Z";
	return { id: hostId, label: `host ${hostId.slice(0, 8)}`, sshHost: "10.81.2.15", user: "deploy", port: 22, connectTimeoutMs: 10_000, createdAt: at, updatedAt: at };
}

/** A store file at a known revision, so the service can tie a bootstrap to the profile it came from. */
async function writeStore(userDataDir, revision, entries = []) {
	await writeFile(join(userDataDir, "remote-hosts.json"), JSON.stringify({ schemaVersion: 1, revision, profiles: entries.map(profile), retiredHostIds: [] }));
	// Fail loudly instead of testing against a snapshot the store rejected: revision 0 with
	// REMOTE_HOST_SNAPSHOT_INVALID would make every revision assertion below pass for the wrong reason.
	const state = (await RemoteHostStore.open(userDataDir)).getSnapshot();
	assert.deepEqual({ revision: state.revision, status: state.status, profiles: state.profiles.length }, { revision, status: "ready", profiles: entries.length }, `fixture store at revision ${revision} was rejected: ${state.reasons.join(",")}`);
}

async function withUserData(run) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-remote-connection-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Ports that record calls and never start a process; each test overrides only what it observes. */
function fakePorts(overrides = {}) {
	const calls = { bootstrap: [], createManager: [], nonce: 0 };
	const managers = [];
	const ports = {
		calls,
		managers,
		bootstrap: async (input) => {
			calls.bootstrap.push(input);
			return { bundleSha256: "a".repeat(64), deployRoot: "/home/remote/.pideck/remote-host", active: `/home/remote/.pideck/remote-host/bundles/${"a".repeat(64)}` };
		},
		createNonce: () => {
			calls.nonce += 1;
			return `nonce-${String(calls.nonce).padStart(12, "0")}`;
		},
		createManager: (input) => {
			calls.createManager.push(input);
			const manager = {
				connected: [],
				disposed: 0,
				disconnects: [],
				state: "disconnected",
				async connect(hostId) {
					manager.connected.push(hostId);
					manager.state = "ready";
					return manager.state;
				},
				async disconnect(hostId, reason) {
					manager.disconnects.push({ hostId, reason });
					manager.state = "disconnected";
				},
				listDiagnostics(hostId) {
					return hostId === undefined ? [{ code: "SSH_CONNECTION_PREFLIGHT" }] : [{ code: `SSH_${hostId.slice(0, 2)}` }];
				},
				async dispose() {
					manager.disposed += 1;
				},
				...overrides.manager,
			};
			managers.push(manager);
			return manager;
		},
		...overrides,
	};
	return ports;
}

test("an unknown host id is refused without reading the store or starting a bootstrap", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 7, []);
		const ports = fakePorts();
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		assert.deepEqual(plain(await service.connect("not-a-host-id")), { ok: false, hostId: "not-a-host-id", code: "REMOTE_CONNECTION_HOST_ID_INVALID" });
		assert.equal(ports.calls.bootstrap.length, 0);
		assert.equal(ports.calls.createManager.length, 0);
	});
});

test("invalid service options are refused before any port is built", () => {
	assert.throws(() => createRemoteHostConnectionService({ userDataDir: "", client: CLIENT, nodePath: "/usr/bin/node" }), /REMOTE_CONNECTION_SERVICE_OPTIONS_INVALID/);
	assert.throws(() => createRemoteHostConnectionService({ userDataDir: "/tmp/ignored", client: {}, nodePath: "/usr/bin/node" }), /REMOTE_CONNECTION_SERVICE_OPTIONS_INVALID/);
});

test("one connect bootstraps once, hands the verified session to the manager and reuses it", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 7, [{ id: HOST_ID }]);
		const ports = fakePorts();
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		const first = plain(await service.connect(HOST_ID));
		assert.deepEqual(first, { ok: true, hostId: HOST_ID, state: "ready" });
		assert.equal(ports.calls.bootstrap.length, 1);
		assert.equal(ports.calls.createManager.length, 1);
		// The manager must receive the verified helper location, never a guess: deployRoot and the bundle
		// address come from the bootstrap result, and the root is forwarded verbatim at wiring time.
		assert.deepEqual(plain(ports.calls.createManager[0].helperSession), { nodePath: "/usr/bin/node", deployRoot: "/home/remote/.pideck/remote-host", bundleSha256: "a".repeat(64) });
		assert.deepEqual(plain(ports.managers[0].connected), [HOST_ID]);

		// A second connect under the same revision must reuse both the held bootstrap and the manager:
		// re-uploading the bundle on every connect would re-mint a nonce and invalidate the pin evidence.
		assert.deepEqual(plain(await service.connect(HOST_ID)), { ok: true, hostId: HOST_ID, state: "ready" });
		assert.equal(ports.calls.bootstrap.length, 1);
		assert.equal(ports.calls.createManager.length, 1);
		assert.deepEqual(plain(ports.managers[0].connected), [HOST_ID, HOST_ID]);
		await service.dispose();
	});
});

test("a workspace root is forwarded verbatim, and omitting it keeps the host-only session legal", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 3, [{ id: HOST_ID }]);
		const ports = fakePorts();
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", root: "/srv/app", ports });
		await service.connect(HOST_ID);
		assert.equal(ports.calls.createManager[0].helperSession.root, "/srv/app");
		await service.dispose();
	});
});

test("each attempt mints its own nonce and the nonce never repeats inside one host", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 1, [{ id: HOST_ID }]);
		const ports = fakePorts();
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		await service.connect(HOST_ID);
		// Bump the revision: the held bootstrap belongs to revision 1 and must not survive it.
		await writeStore(userDataDir, 2, [{ id: HOST_ID }]);
		await service.connect(HOST_ID);
		assert.equal(ports.calls.bootstrap.length, 2);
		const nonces = ports.calls.bootstrap.map((call) => call.nonce);
		assert.equal(new Set(nonces).size, 2);
		// The generation names the attempt, so a late frame from attempt 1 can never be adopted by attempt 2.
		// It is bumped at the top of every connect, so the first attempt is already generation 1 — a fresh
		// entry starts at 0 but no attempt ever runs under it.
		assert.deepEqual(
			ports.calls.bootstrap.map((call) => call.generation),
			[1, 2],
		);
		assert.deepEqual(plain(nonces.map((nonce) => call_nonce(nonce))), [true, true]);
		await service.dispose();
	});
});

/** The bootstrap contract requires 15–63 characters starting with an alphanumeric character. */
function call_nonce(nonce) {
	return typeof nonce === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{14,62}$/.test(nonce);
}

test("a rebind during the upload invalidates the result instead of publishing a retired deploy root", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 4, [{ id: HOST_ID }]);
		const ports = fakePorts({
			bootstrap: async () => {
				// The profile is re-verified while the entry is still uploading.
				await writeStore(userDataDir, 5, [{ id: HOST_ID }]);
				return { bundleSha256: "b".repeat(64), deployRoot: "/home/remote/.pideck/retired", active: "/home/remote/.pideck/retired/bundles/x" };
			},
		});
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		assert.deepEqual(plain(await service.connect(HOST_ID)), { ok: false, hostId: HOST_ID, code: "SSH_HOST_NOT_READY" });
		assert.equal(ports.calls.createManager.length, 0);
		await service.dispose();
	});
});
