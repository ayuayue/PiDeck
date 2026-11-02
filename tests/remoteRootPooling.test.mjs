import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteHostConnectionService } = loadTsCommonJs("src/main/remote/RemoteHostConnectionService.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");

const HOST = "b145de8c-6330-45be-8752-f20e8e270150";
const ROOT_A = "/srv/projects/a";
const ROOT_B = "/srv/projects/b";
const ROOT_C = "/srv/projects/c";
const CLIENT = { sshPath: "/usr/bin/ssh", scpPath: "/usr/bin/scp", env: { PATH: "/usr/bin" }, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
const BUNDLE = "a".repeat(64);

const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
	const box = {};
	box.promise = new Promise((resolve) => {
		box.resolve = resolve;
	});
	return box;
};

async function writeStore(userDataDir, revision) {
	const at = "2026-01-01T00:00:00.000Z";
	const profile = { id: HOST, label: "host", sshHost: "10.81.2.15", user: "deploy", port: 22, connectTimeoutMs: 10_000, createdAt: at, updatedAt: at };
	await writeFile(join(userDataDir, "remote-hosts.json"), JSON.stringify({ schemaVersion: 1, revision, profiles: [profile], retiredHostIds: [] }));
	const state = (await RemoteHostStore.open(userDataDir)).getSnapshot();
	assert.equal(state.status, "ready", "fixture store must be accepted, or every revision assertion below is vacuous");
}

/** Ports that never touch a network: every manager is a local object that reports what the service did to it. */
function poolingPorts(overrides = {}) {
	const calls = { managers: [], bootstrap: 0, verifyRoot: [] };
	const ports = {
		calls,
		bootstrap: async () => {
			calls.bootstrap += 1;
			return { bundleSha256: BUNDLE, deployRoot: "/home/remote/.pideck/remote-host", active: "/home/remote/.pideck/remote-host/bundles/" + BUNDLE };
		},
		resolveNode: async () => ({ nodePath: "/home/remote/.nvm/versions/node/v24.11.0/bin/node", version: "v24.11.0", probed: 1 }),
		createSentinel: () => "sentinel00000001",
		createNonce: () => "nonce-0000000001",
		verifyRoot: async ({ userPath }) => {
			calls.verifyRoot.push(userPath);
			return { canonicalPath: userPath };
		},
		createManager: (input) => {
			const manager = {
				helperSession: input.helperSession,
				onEvent: input.onEvent,
				onStateChange: input.onStateChange,
				disposed: 0,
				requests: [],
				capabilities: ["fs.watch", "fs.search"],
				state: "disconnected",
				latched: false,
				lastCode: "SSH_CONNECTION_READY",
				getState(hostId) {
					return { hostId, generation: 1, state: manager.state, attempts: 0, lastCode: manager.lastCode, latched: manager.latched };
				},
				getHome() {
					return "/home/remote";
				},
				getCapabilities() {
					return [...manager.capabilities];
				},
				async connect(hostId) {
					if (manager.state !== "needs-attention") manager.state = "ready";
					return manager.getState(hostId);
				},
				async retry(hostId) {
					manager.state = "ready";
					manager.latched = false;
					return manager.getState(hostId);
				},
				async disconnect() {
					manager.state = "disconnected";
				},
				async dispose() {
					manager.disposed += 1;
				},
				async request(_hostId, method) {
					manager.requests.push(method);
					return { ok: true };
				},
				async cancel() {
					return { ok: true };
				},
				listDiagnostics() {
					return [];
				},
				reportNeedsAttention(_hostId, code) {
					manager.state = "needs-attention";
					manager.lastCode = code;
				},
			};
			calls.managers.push(manager);
			return manager;
		},
		...overrides,
	};
	return ports;
}

async function withService(run, options = {}) {
	const userDataDir = await mkdtemp(join(tmpdir(), "pideck-root-pool-"));
	try {
		await writeStore(userDataDir, 7);
		const ports = options.ports ?? poolingPorts();
		const events = { helper: [], rootRetired: [], disconnect: [], state: [] };
		const service = createRemoteHostConnectionService({
			userDataDir,
			client: CLIENT,
			nodePath: "/usr/bin/node",
			ports,
			rootPooling: { idleCapacity: 2, idleTtlMs: 60_000, maxEntries: 4, acquireTimeoutMs: 80, ...(options.policy ?? {}) },
			onHelperEvent: (entry) => events.helper.push(entry),
			onRootRetired: (entry) => events.rootRetired.push(entry),
			onDisconnect: (hostId) => events.disconnect.push(hostId),
			onStateChange: (entry) => events.state.push(entry),
		});
		try {
			return await run({ service, ports, events, userDataDir });
		} finally {
			await service.dispose();
		}
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
}

const read = (service, root) => service.withProjectSession(HOST, root, async (session) => ({ connectionId: session.connectionId, root: session.helperSessionRoot ?? session.connectionId }));

test("two reads of one project reuse a single helper session", async () => {
	await withService(async ({ service, ports, calls }) => {
		const first = await service.withProjectSession(HOST, ROOT_A, async (session) => session.connectionId);
		const second = await service.withProjectSession(HOST, ROOT_A, async (session) => session.connectionId);
		assert.equal(first.ok, true);
		assert.equal(second.ok, true);
		assert.equal(first.value, second.value, "the same project must keep the same session identity");
		assert.equal(ports.calls.managers.length, 1, "a warm root must not build a second helper");
		assert.equal(ports.calls.bootstrap, 1, "the host bundle is deployed once, not once per read");
	});
});

test("three projects on one host each get their own helper session and their own --root", async () => {
	await withService(async ({ service, ports }) => {
		const identities = [];
		for (const root of [ROOT_A, ROOT_B, ROOT_C]) {
			const outcome = await service.withProjectSession(HOST, root, async (session) => session.connectionId);
			assert.equal(outcome.ok, true);
			identities.push(outcome.value);
		}
		assert.equal(new Set(identities).size, 3, "each root owns a distinct session identity");
		assert.deepEqual(
			ports.calls.managers.map((manager) => manager.helperSession.root),
			[ROOT_A, ROOT_B, ROOT_C],
			"the helper for each root must be started with that root, not with whichever root was read last",
		);
		assert.equal(ports.calls.bootstrap, 1, "one host deploy serves every root");
	});
});

test("concurrent first reads of one root build exactly one helper", async () => {
	await withService(async ({ service, ports }) => {
		const [left, right] = await Promise.all([service.withProjectSession(HOST, ROOT_A, async (session) => session.connectionId), service.withProjectSession(HOST, ROOT_A, async (session) => session.connectionId)]);
		assert.equal(left.ok && right.ok, true);
		assert.equal(left.value, right.value);
		assert.equal(ports.calls.managers.length, 1, "same-key concurrency must merge into one establishment");
	});
});

test("visiting a sibling project never invalidates the first project's session", async () => {
	await withService(async ({ service }) => {
		const first = await service.withProjectSession(HOST, ROOT_A, async (session) => session.connectionId);
		const a = first.value;
		const second = await service.withProjectSession(HOST, ROOT_B, async (session) => session.connectionId);
		assert.notEqual(second.value, a);
		const third = await service.withProjectSession(HOST, ROOT_A, async (session) => session.connectionId);
		assert.equal(third.value, a, "reading another project must not replace this project's helper");
	});
});

test("an in-flight operation keeps its lease: the budget cannot recycle it out from under it", async () => {
	const gate = deferred();
	await withService(
		async ({ service }) => {
			const slow = service.withProjectSession(HOST, ROOT_A, async () => {
				await gate.promise;
				return "written";
			});
			// Give the slow read its lease before the second project asks for the only other slot.
			await new Promise((resolve) => setImmediate(resolve));
			const blocked = await service.withProjectSession(HOST, ROOT_B, async () => "b");
			assert.equal(blocked.ok, false);
			assert.equal(blocked.code, "SSH_ROOT_POOL_BUSY", "a full budget must fail with a stable code instead of recycling an active session");
			gate.resolve();
			assert.deepEqual(plain(await slow), { ok: true, value: "written" });
		},
		{ policy: { maxEntries: 1, acquireTimeoutMs: 40 } },
	);
});

test("a watched session cannot be evicted; releasing the watch makes it collectable again", async () => {
	await withService(
		async ({ service, ports }) => {
			await service.withProjectSession(HOST, ROOT_A, async (session) => session.connectionId);
			service.retainProjectSessionWatch(HOST, ROOT_A);
			const blocked = await service.withProjectSession(HOST, ROOT_B, async () => "b");
			assert.equal(blocked.ok, false, "a session with a live watcher is not idle, so it must not be recycled");
			assert.equal(blocked.code, "SSH_ROOT_POOL_BUSY");
			service.releaseProjectSessionWatch(HOST, ROOT_A);
			const allowed = await service.withProjectSession(HOST, ROOT_B, async () => "b");
			assert.equal(allowed.ok, true);
			assert.equal(ports.calls.managers[0].disposed, 1, "the released session is the one recycled for the budget");
		},
		{ policy: { maxEntries: 1, acquireTimeoutMs: 40 } },
	);
});

test("project facts and capabilities come from that project's root, never a sibling's", async () => {
	await withService(async ({ service }) => {
		const a = await service.withProjectSession(HOST, ROOT_A, async (session) => session.connectionId);
		const b = await service.withProjectSession(HOST, ROOT_B, async (session) => session.connectionId);
		const factsA = service.projectConnectionFacts(HOST, ROOT_A);
		const factsB = service.projectConnectionFacts(HOST, ROOT_B);
		assert.equal(factsA.connectionId, a.value);
		assert.equal(factsB.connectionId, b.value);
		assert.notEqual(factsA.connectionId, factsB.connectionId);
		assert.equal(service.projectConnectionFacts(HOST, ROOT_C), undefined, "a root with no session is unknown, not 'the host looks fine'");
		assert.deepEqual([...service.projectHelperCapabilities(HOST, ROOT_A)], ["fs.watch", "fs.search"]);
		assert.equal(service.projectHelperCapabilities(HOST, ROOT_C), undefined);
	});
});

test("requireReady never revives an offline host from a background read", async () => {
	await withService(async ({ service, ports }) => {
		const outcome = await service.withProjectSession(HOST, ROOT_A, async () => "x", { requireReady: true });
		assert.equal(outcome.ok, false);
		assert.equal(outcome.code, "SSH_HOST_NOT_READY");
		assert.equal(ports.calls.managers.length, 0, "no helper may be started by a read that only allowed ready hosts");
	});
});

test("a latched root is retired and rebuilt without touching its neighbours or the host", async () => {
	await withService(async ({ service, ports, events }) => {
		const firstA = await service.withProjectSession(HOST, ROOT_A, async (session) => session.connectionId);
		await service.withProjectSession(HOST, ROOT_B, async (session) => session.connectionId);
		const managerA = ports.calls.managers[0];
		managerA.latched = true;
		managerA.state = "needs-attention";
		const rebuilt = await service.withProjectSession(HOST, ROOT_A, async (session) => session.connectionId);
		assert.equal(rebuilt.ok, true);
		assert.notEqual(rebuilt.value, firstA.value, "a rebuilt session must carry a new identity");
		assert.equal(managerA.disposed, 1, "the retired manager is disposed");
		assert.deepEqual(
			events.rootRetired.map((entry) => ({ hostId: entry.hostId, root: entry.root })),
			[{ hostId: HOST, root: ROOT_A }],
			"only the retired root is reported - root retirement is not a host disconnect",
		);
		assert.deepEqual(events.disconnect, [], "retiring one root must not run the host disconnect path (it closes terminals)");
		assert.equal(ports.calls.managers[1].disposed, 0, "the sibling root's session is untouched");
		assert.equal(service.projectConnectionFacts(HOST, ROOT_B).state, "ready");
	});
});

test("the old session fails closed after its root was rebuilt, and nothing is replayed", async () => {
	await withService(async ({ service, ports }) => {
		let stale;
		await service.withProjectSession(HOST, ROOT_A, async (session) => {
			stale = session;
			return "ok";
		});
		const managerA = ports.calls.managers[0];
		managerA.latched = true;
		await service.withProjectSession(HOST, ROOT_A, async () => "rebuilt");
		await assert.rejects(stale.request("fs.list", {}), /SSH_HOST_NOT_READY/, "a retired session must refuse instead of reaching another helper");
		assert.deepEqual(managerA.requests, [], "the old helper must not receive a replayed request");
	});
});

test("a host-level disconnect retires the whole pool and keeps the user's decision", async () => {
	await withService(async ({ service, ports, events }) => {
		let stale;
		await service.withProjectSession(HOST, ROOT_A, async (session) => {
			stale = session;
			return "ok";
		});
		await service.withProjectSession(HOST, ROOT_B, async () => "ok");
		await service.disconnect(HOST, "abort");
		assert.deepEqual(events.disconnect, [HOST], "an explicit disconnect is still the host-level event (terminal teardown belongs to it)");
		assert.equal(ports.calls.managers[0].disposed, 1);
		assert.equal(ports.calls.managers[1].disposed, 1);
		const after = await service.withProjectSession(HOST, ROOT_A, async () => "x");
		assert.equal(after.ok, false);
		assert.equal(after.code, "SSH_HOST_DISCONNECTED", "a background read must not revive a host the user disconnected");
		assert.equal(service.projectConnectionFacts(HOST, ROOT_A), undefined);
		await assert.rejects(stale.request("fs.list", {}), /SSH_HOST_NOT_READY/);
	});
});

test("a store revision change (rebind) invalidates the pool instead of serving the old deploy root", async () => {
	await withService(async ({ service, ports, userDataDir }) => {
		const first = await service.withProjectSession(HOST, ROOT_A, async (session) => session.connectionId);
		await writeStore(userDataDir, 8);
		const second = await service.withProjectSession(HOST, ROOT_A, async (session) => session.connectionId);
		assert.equal(second.ok, true);
		assert.notEqual(second.value, first.value, "a rebind must produce a new session identity");
		assert.equal(ports.calls.bootstrap, 2, "the held deploy facts are re-established under the new revision");
	});
});

test("root drift is recorded per project and leaves the sibling healthy", async () => {
	const ports = poolingPorts({
		verifyRoot: async ({ userPath }) => {
			if (userPath === ROOT_C) throw new Error("readlink failed");
			return { canonicalPath: userPath };
		},
	});
	await withService(
		async ({ service, ports: used }) => {
			await service.withProjectSession(HOST, ROOT_A, async () => "a");
			const drift = await service.withProjectSession(HOST, ROOT_C, async () => "c");
			assert.equal(drift.ok, false);
			assert.equal(drift.code, "SSH_PROJECT_ROOT_UNRESOLVED");
			assert.deepEqual(plain(service.projectRootStatus(HOST, ROOT_C)), { status: "needs-attention", code: "SSH_PROJECT_ROOT_UNRESOLVED" });
			assert.deepEqual(plain(service.projectRootStatus(HOST, ROOT_A)), { status: "ok" });
			const healthy = await service.withProjectSession(HOST, ROOT_A, async () => "a2");
			assert.equal(healthy.ok, true);
			assert.equal(used.calls.managers[0].state, "ready", "one moved directory must not drive the host into needs-attention");
		},
		{ ports },
	);
});

test("helper events carry the session identity of the helper that produced them", async () => {
	await withService(async ({ service, ports, events }) => {
		let a;
		let b;
		await service.withProjectSession(HOST, ROOT_A, async (session) => {
			a = session.connectionId;
			return "ok";
		});
		await service.withProjectSession(HOST, ROOT_B, async (session) => {
			b = session.connectionId;
			return "ok";
		});
		// The helper for B reports a watch event; the entry must name B's session, not the host's "current" one.
		ports.calls.managers[1].onEvent(HOST, { watchId: "same-watch", paths: [""] });
		ports.calls.managers[0].onEvent(HOST, { watchId: "same-watch", paths: [""] });
		assert.equal(events.helper.length, 2);
		assert.equal(events.helper[0].sessionKey, b);
		assert.equal(events.helper[1].sessionKey, a);
		assert.equal(events.helper[0].watchId, events.helper[1].watchId, "the same watchId from two helpers stays distinguishable by session");
	});
});
