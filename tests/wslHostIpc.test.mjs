import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { preloadSource } from "./helpers/preloadSources.mjs";

function register(dir, references = { referencedHostIds: async () => new Set() }) {
	const handlers = new Map();
	const { registerWslHostIpc } = loadTsCommonJs("src/main/ipc/wslHostIpc.ts", {
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
	registerWslHostIpc({ userDataDir: dir, references });
	return handlers;
}

test("WSL host channels are declared, bridged and registered", async () => {
	const shared = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = preloadSource;
	assert.match(shared, /remoteHostsWslList:\s*"remote:wsl-hosts-list"/);
	assert.match(shared, /remoteHostsWslRemove:\s*"remote:wsl-hosts-remove"/);
	assert.match(preload, /listWslHosts:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.remoteHostsWslList\)/);
	assert.match(preload, /removeWslHost:\s*\(id: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.remoteHostsWslRemove/);
});

test("list/add/remove round-trip through IPC and reject bad input", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-wsl-ipc-"));
	try {
		const handlers = register(dir);
		const listed = await handlers.get("remote:wsl-hosts-list")({});
		assert.equal(listed.ok, true);
		assert.equal(listed.hosts.length, 0);

		const bad = await handlers.get("remote:wsl-hosts-add")({}, { label: "", distro: "Ubuntu", user: "dev" });
		assert.equal(bad.ok, false);
		assert.equal(bad.code, "WSL_HOST_INVALID");

		const added = await handlers.get("remote:wsl-hosts-add")({}, { label: "Ubuntu", distro: "Ubuntu", user: "dev" });
		assert.equal(added.ok, true);
		const removed = await handlers.get("remote:wsl-hosts-remove")({}, added.host.id);
		assert.equal(removed.ok, true);
		assert.equal((await handlers.get("remote:wsl-hosts-list")({})).hosts.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("referenced profiles are refused by the IPC boundary", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-wsl-ipc-ref-"));
	try {
		const first = register(dir);
		const added = await first.get("remote:wsl-hosts-add")({}, { label: "Ubuntu", distro: "Ubuntu", user: "dev" });
		const referenced = register(dir, { referencedHostIds: async () => new Set([added.host.id]) });
		const refused = await referenced.get("remote:wsl-hosts-remove")({}, added.host.id);
		assert.equal(refused.ok, false);
		assert.equal(refused.code, "WSL_HOST_REFERENCED");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
