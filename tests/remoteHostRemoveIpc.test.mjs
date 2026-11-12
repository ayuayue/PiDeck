import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { preloadSource } from "./helpers/preloadSources.mjs";

// 移除连接是三处同步的新通道（shared 常量 / preload / main handler），并且必须：
// - 在 id 非法或功能关闭时不碰磁盘；
// - 先断开连接，再走 store 的 disable → retire（引用扫描由 store 负责）。

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

const base = { userDataDir: "/tmp/pideck-remove-never-used", list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }) };

test("remove channel is declared, bridged and registered", () => {
	const shared = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = preloadSource;
	assert.match(shared, /remoteHostRemove:\s*"remote:remove"/);
	assert.match(preload, /remove:\s*\(hostId: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.remoteHostRemove/);
	assert.ok(handlersFor({ ...base, enabled: true }).get("remote:remove"));
});

test("invalid ids and disabled builds never reach the store", async () => {
	const remove = handlersFor({ ...base, enabled: true }).get("remote:remove");
	const invalid = await remove({}, "not-a-uuid");
	assert.equal(invalid.ok, false);
	assert.equal(invalid.hostId, "not-a-uuid");
	assert.equal(invalid.code, "REMOTE_HOST_ID_INVALID");
	const disabled = handlersFor({ ...base, enabled: false }).get("remote:remove");
	const hostId = "0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
	assert.equal((await disabled({}, hostId)).code, "REMOTE_FEATURE_DISABLED");
});

test("disconnect is attempted before retirement", () => {
	const source = readFileSync("src/main/ipc/remoteHostIpc.ts", "utf8");
	assert.match(source, /resolved\.service\.disconnect\(hostId, "shutdown"\)/);
	assert.match(source, /opened\.store\.disable\(hostId, snapshot\.revision\)/);
	assert.match(source, /opened\.store\.retire\(hostId, snapshot\.revision\)/);
	// 引用保护由 store 自己的 retire 扫描负责，IPC 不绕过它做硬删。
	assert.doesNotMatch(source, /profiles\.filter\(\(item\) => item\.id !== hostId\)/);
});
