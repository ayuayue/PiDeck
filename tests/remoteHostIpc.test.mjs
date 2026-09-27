import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function handlerFor(input) {
	const handlers = new Map();
	const { registerRemoteHostIpc } = loadTsCommonJs("src/main/ipc/remoteHostIpc.ts", {
		stubs: {
			electron: {
				ipcMain: {
					handle(channel, handler) {
						handlers.set(channel, handler);
					},
				},
			},
		},
	});
	registerRemoteHostIpc(input);
	return handlers.get("remote:hosts-list");
}

test("remote host channel is declared, bridged, and registered behind the dev gate", () => {
	const shared = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	const main = readFileSync("src/main/index.ts", "utf8");
	const catalog = readFileSync("src/main/remote/RemoteHostCatalogView.ts", "utf8");
	assert.match(shared, /remoteHostsList:\s*"remote:hosts-list"/);
	assert.match(preload, /remoteHosts:\s*\{[\s\S]*?ipcRenderer\.invoke\(ipcChannels\.remoteHostsList\)/);
	assert.match(main, /registerRemoteHostIpc\(\{\s*enabled:\s*!app\.isPackaged\s*&&\s*process\.env\.PIDECK_REMOTE_EXPERIMENTAL\s*===\s*"1"/);
	assert.match(main, /openRemoteHostCatalogView\(app\.getPath\("userData"\)\)/);
	assert.match(catalog, /createRemoteHostReferenceRegistry\(join\(userDataDir,\s*"session-catalog\.json"\)\)/);
});

test("remote listing stays disabled without reading persisted hosts", async () => {
	let called = false;
	const handler = handlerFor({
		enabled: false,
		list: async () => {
			called = true;
			throw new Error("must not read");
		},
	});
	assert.deepEqual(JSON.parse(JSON.stringify(await handler())), { ok: false, code: "REMOTE_FEATURE_DISABLED" });
	assert.equal(called, false);
});

test("remote listing returns only UI fields and never pin metadata or identity paths", async () => {
	const handler = handlerFor({
		enabled: true,
		list: async () => ({
			snapshot: { status: "ready", reasons: [], revision: 1, retiredHostIds: [], profiles: [{ id: "host-a", label: "Test", sshHost: "serve", identityFile: "/private/key", verifiedEndpoint: { knownHostsSha256: "secret", hostKeyFingerprints: ["fingerprint"] }, disabledAt: undefined }] },
			findings: [],
		}),
	});
	assert.deepEqual(JSON.parse(JSON.stringify(await handler())), { ok: true, status: "ready", hosts: [{ id: "host-a", label: "Test", sshHost: "serve", verified: true, disabled: false }] });
});

test("needs-repair lists only stable diagnostic fields and valid host ids", async () => {
	const hostId = "01234567-89ab-4def-8123-456789abcdef";
	const handler = handlerFor({
		enabled: true,
		list: async () => ({
			snapshot: { status: "needs-repair", reasons: ["REMOTE_HOST_LOCK_PRESENT"], revision: 1, retiredHostIds: [], profiles: [] },
			findings: [{ reason: "REMOTE_HOST_LOCK_PRESENT", classification: "lock", hostIds: [hostId, "../../private/key"], actions: ["clear-stale-lock"], privatePath: "/private/key" }],
		}),
	});
	assert.deepEqual(JSON.parse(JSON.stringify(await handler())), { ok: true, status: "needs-repair", hosts: [], repair: [{ reason: "REMOTE_HOST_LOCK_PRESENT", classification: "lock", hostIds: [hostId] }] });
});

test("remote listing folds unexpected store errors into a stable code", async () => {
	const handler = handlerFor({
		enabled: true,
		list: async () => {
			throw new Error("private storage path");
		},
	});
	assert.deepEqual(JSON.parse(JSON.stringify(await handler())), { ok: false, code: "REMOTE_HOST_LIST_UNAVAILABLE" });
});
