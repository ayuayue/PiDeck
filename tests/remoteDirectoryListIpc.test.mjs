import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { preloadSource } from "./helpers/preloadSources.mjs";

function handlersFor(input) {
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
	return handlers;
}

const HOST = "0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const base = { userDataDir: "/tmp/pideck-list-dirs-unused", list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }) };

test("list-dirs channel is declared, bridged and registered", () => {
	assert.match(readFileSync("src/shared/ipc.ts", "utf8"), /remoteHostListDirs:\s*"remote:list-dirs"/);
	assert.match(preloadSource, /listDirs:\s*\(hostId: string, path\?: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.remoteHostListDirs/);
	assert.ok(handlersFor({ ...base, enabled: true }).get("remote:list-dirs"));
});

test("disabled builds and invalid host ids are refused before any probe", async () => {
	const disabled = handlersFor({ ...base, enabled: false }).get("remote:list-dirs");
	assert.equal((await disabled({}, HOST, "/srv")).code, "REMOTE_FEATURE_DISABLED");
	const enabled = handlersFor({ ...base, enabled: true }).get("remote:list-dirs");
	assert.equal((await enabled({}, "not-a-uuid", "/srv")).code, "REMOTE_HOST_ID_INVALID");
});
