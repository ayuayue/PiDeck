import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function createSender(id = 1) {
	const sender = new EventEmitter();
	sender.id = id;
	sender.isDestroyed = () => false;
	return sender;
}

/** 入口 IPC 的确定性宿主：服务层替身记录调用，断言信封/校验/门禁，不触达任何远端。 */
function entryIpcHarness(enabled = true) {
	const handlers = new Map();
	const calls = [];
	const released = [];
	const sender = createSender();
	const { registerRemoteProjectEntryIpc } = loadTsCommonJs("src/main/ipc/remoteProjectEntryIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) } },
			"../remote/RemoteProjectEntryService": {
				REMOTE_FILE_ENTRY_CODES: new Set(["REMOTE_FILE_INPUT_INVALID", "REMOTE_FILE_BUSY", "REMOTE_FILE_COMMAND_FAILED", "REMOTE_FILE_PATH_INVALID", "REMOTE_FILE_PROTECTED_PATH", "REMOTE_FILE_NAME_INVALID"]),
				createRemoteProjectEntryService: () => ({
					stat: async (...args) => {
						if (args[2].startsWith("..") || args[2].startsWith("/") || args[2] === "") throw new Error("REMOTE_FILE_PATH_INVALID");
						if (args[2].startsWith(".pideck-trash")) throw new Error("REMOTE_FILE_PROTECTED_PATH");
						calls.push(["stat", ...args]);
						return { stat: { kind: "file", bytes: 0, mtimeMs: 1 }, version: "a".repeat(32) };
					},
					createFile: async (...args) => {
						if (args[3].includes("/")) throw new Error("REMOTE_FILE_NAME_INVALID");
						calls.push(["createFile", ...args]);
						return { relativePath: "new.txt", kind: "file" };
					},
					createDirectory: async (...args) => {
						calls.push(["createDirectory", ...args]);
						return { relativePath: "dir", kind: "directory" };
					},
					rename: async (...args) => {
						calls.push(["rename", ...args]);
						return { relativePath: "b.txt" };
					},
					deleteEntry: async (...args) => {
						calls.push(["deleteEntry", ...args]);
						return { trashId: "20261017T093012Z-aaaaaaaa" };
					},
					listTrash: async (...args) => {
						calls.push(["listTrash", ...args]);
						return { entries: [], truncated: false };
					},
					restoreTrash: async (...args) => {
						calls.push(["restoreTrash", ...args]);
						return { relativePath: "a.txt" };
					},
					pruneTrash: async (...args) => {
						calls.push(["pruneTrash", ...args]);
						return { removed: [], kept: [] };
					},
					releaseSender: (id) => released.push(id),
				}),
			},
		},
	});
	registerRemoteProjectEntryIpc({ enabled, service: () => undefined, locator: () => undefined });
	return { calls, released, sender, handlers, invoke: async (channel, ...args) => structuredClone(await handlers.get(channel)({ sender }, ...args)) };
}

test("entry IPC validates renderer input before touching the remote service and returns stable envelopes", async () => {
	const f = entryIpcHarness();
	const invalidVersion = "forged";
	// 路径/名字的精确码由服务层拥有（见 entryService 套件）；IPC 这里只断言信封是失败且不触达成功分支。
	assert.equal((await f.invoke("remote:project-entry-stat", "project", "../x")).ok, false);
	assert.equal((await f.invoke("remote:project-entry-stat", "project", ".pideck-trash/x")).ok, false);
	assert.equal((await f.invoke("remote:project-file-create", "project", "", "a/b")).ok, false);
	assert.equal((await f.invoke("remote:project-entry-rename", "project", "a.txt", "b.txt", invalidVersion)).code, "REMOTE_FILE_INPUT_INVALID");
	assert.equal((await f.invoke("remote:project-entry-delete", "project", "a.txt", invalidVersion)).code, "REMOTE_FILE_INPUT_INVALID");
	assert.equal((await f.invoke("remote:project-trash-restore", "project", "bad-id")).ok, false);
	assert.equal((await f.invoke("remote:project-trash-prune", "project", [])).code, "REMOTE_FILE_INPUT_INVALID");
	assert.equal(
		(
			await f.invoke(
				"remote:project-trash-prune",
				"project",
				Array.from({ length: 33 }, () => "20261017T093012Z-aaaaaaaa"),
			)
		).code,
		"REMOTE_FILE_INPUT_INVALID",
	);
	assert.equal(f.calls.length, 0);
	const stat = await f.invoke("remote:project-entry-stat", "project", "a.txt");
	assert.equal(stat.ok, true);
	// v5 单信封：成功载荷在 `value` 下，失败带 `outcome`。
	assert.match(stat.value.version, /^[a-f0-9]{32}$/);
	const created = await f.invoke("remote:project-file-create", "project", "", "new.txt");
	assert.equal(created.ok, true);
	assert.equal(created.value.relativePath, "new.txt");
	const renamed = await f.invoke("remote:project-entry-rename", "project", "a.txt", "b.txt", "a".repeat(32));
	assert.equal(renamed.ok, true);
	assert.equal((await f.invoke("remote:project-trash-list", "project")).ok, true);
	assert.equal((await f.invoke("remote:project-trash-prune", "project", ["20261017T093012Z-aaaaaaaa"])).ok, true);
	assert.equal(f.calls.length, 5);
	f.sender.emit("destroyed");
	assert.deepEqual(f.released, [1]);
});

test("disabled entry IPC returns REMOTE_FEATURE_DISABLED and registers no sender resources", async () => {
	const f = entryIpcHarness(false);
	for (const [channel, args] of [
		["remote:project-entry-stat", ["project", "a.txt"]],
		["remote:project-file-create", ["project", "", "new.txt"]],
		["remote:project-trash-list", ["project"]],
	])
		assert.deepEqual(await f.invoke(channel, ...args), { ok: false, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" });
	assert.equal(f.calls.length, 0);
	assert.equal(f.sender.listenerCount("destroyed"), 0);
});

test("entry channels are wired through shared/preload/main/preview without local files fallback", () => {
	const channels = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	const main = readFileSync("src/main/index.ts", "utf8");
	const preview = readFileSync("src/renderer/src/previewApi.ts", "utf8");
	const names = ["remoteProjectEntryStat", "remoteProjectFileCreate", "remoteProjectDirectoryCreate", "remoteProjectEntryRename", "remoteProjectEntryDelete", "remoteProjectTrashList", "remoteProjectTrashRestore", "remoteProjectTrashPrune"];
	for (const name of names) {
		assert.match(channels, new RegExp(name + "\\s*:"), name + " missing channel");
		assert.match(preload, new RegExp("invoke\\(\\s*ipcChannels\\." + name), name + " missing preload invoke");
	}
	for (const method of ["statProjectEntry", "createProjectFile", "createProjectDirectory", "renameProjectEntry", "deleteProjectEntry", "listProjectTrash", "restoreProjectTrash", "pruneProjectTrash"]) assert.match(preview, new RegExp(method + "\\s*:"), method + " missing preview stub");
	assert.match(main, /registerRemoteProjectEntryIpc\(\{\s*enabled:\s*remoteFeatureEnabled/);
	const handler = readFileSync("src/main/ipc/remoteProjectEntryIpc.ts", "utf8");
	assert.match(handler, /ipcMain\.handle\(\s*ipcChannels\.remoteProjectEntryStat/);
	assert.doesNotMatch(handler, /node:fs|node:child_process|from "electron"\.app/);
	assert.match(readFileSync("src/main/ipc/remoteProjectFileIpc.ts", "utf8"), /REMOTE_FILE_PROTECTED_PATH/);
});

test("window destruction revokes BOTH token classes (text save + entry)", () => {
	const handlers = new Map();
	const releasedText = [];
	const releasedEntry = [];
	const sender = createSender(7);
	const { registerRemoteProjectFileIpc } = loadTsCommonJs("src/main/ipc/remoteProjectFileIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) } },
			"../remote/RemoteProjectFileService": {
				createRemoteProjectFileService: () => ({ open: async () => ({ content: "", version: "a".repeat(32) }), save: async () => ({ version: "b".repeat(32) }), releaseSender: (id) => releasedText.push(id) }),
			},
		},
	});
	registerRemoteProjectFileIpc({ enabled: true, service: () => undefined, locator: () => undefined });
	const { registerRemoteProjectEntryIpc } = loadTsCommonJs("src/main/ipc/remoteProjectEntryIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) } },
			"../remote/RemoteProjectEntryService": {
				REMOTE_FILE_ENTRY_CODES: new Set(),
				createRemoteProjectEntryService: () => ({
					stat: async () => ({ stat: { kind: "file", bytes: 0, mtimeMs: 1 }, version: "c".repeat(32) }),
					createFile: async () => ({ relativePath: "x", kind: "file" }),
					createDirectory: async () => ({ relativePath: "d", kind: "directory" }),
					rename: async () => ({ relativePath: "y" }),
					deleteEntry: async () => ({ trashId: "20261017T093012Z-aaaaaaaa" }),
					listTrash: async () => ({ entries: [], truncated: false }),
					restoreTrash: async () => ({ relativePath: "z" }),
					pruneTrash: async () => ({ removed: [], kept: [] }),
					releaseSender: (id) => releasedEntry.push(id),
				}),
			},
		},
	});
	registerRemoteProjectEntryIpc({ enabled: true, service: () => undefined, locator: () => undefined });
	// 门禁开启时两个模块都在首次合法调用时挂 destroyed 监听；销毁必须同时撤销两类令牌。
	return Promise.all([handlers.get("remote:project-text-open")({ sender }, "project", "a.txt"), handlers.get("remote:project-entry-stat")({ sender }, "project", "a.txt")]).then(() => {
		sender.emit("destroyed");
		assert.deepEqual(releasedText, [7]);
		assert.deepEqual(releasedEntry, [7]);
	});
});
