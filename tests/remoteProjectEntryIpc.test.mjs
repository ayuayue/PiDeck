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
	const handle = registerRemoteProjectEntryIpc({ enabled, service: () => undefined, locator: () => undefined });
	return { calls, released, sender, handlers, handle, invoke: async (channel, ...args) => structuredClone(await handlers.get(channel)({ sender }, ...args)) };
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

/* ------------------------------------------- files:create / files:rename 的主进程内复用（收口第二片） */

test("handle.create：与 IPC 通道同一套服务与事实路径，sender 作用域照旧", async () => {
	const h = entryIpcHarness();
	const created = await h.handle.create(h.sender, "p1", "src", "new.txt", "file");
	assert.deepEqual(JSON.parse(JSON.stringify(created)), { relativePath: "new.txt", kind: "file" });
	assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [["createFile", 1, "p1", "src", "new.txt"]], "sender id / projectId / parent / name 原样交给服务");

	const dir = await h.handle.create(h.sender, "p1", "src", "dir", "directory");
	assert.deepEqual(JSON.parse(JSON.stringify(dir)), { relativePath: "dir", kind: "directory" });
	assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1))), ["createDirectory", 1, "p1", "src", "dir"]);
});

test("handle.rename：main 内 stat→rename，令牌不出 main（renderer 不再传 version）", async () => {
	const h = entryIpcHarness();
	const renamed = await h.handle.rename(h.sender, "p1", "src/a.txt", "src/b.txt");
	assert.deepEqual(JSON.parse(JSON.stringify(renamed)), { relativePath: "b.txt" });
	const methods = h.calls.map((call) => call[0]);
	assert.deepEqual(methods, ["stat", "rename"], "先读版本再写");
	const token = h.calls[0][1] && "a".repeat(32);
	assert.equal(h.calls[1][5], token, "rename 用的就是刚才 stat 签发的那一个令牌");
});

test("handle.rename：改名不能变成跨目录移动，最后一段必须是单段名字", async () => {
	const h = entryIpcHarness();
	for (const target of ["src/sub/a.txt", "other/a.txt"]) await rejectsWith(() => h.handle.rename(h.sender, "p1", "src/a.txt", target), /REMOTE_FILE_INPUT_INVALID/);
	for (const target of ["src/.pideck-tmp", "src/a.pideck-tmp"]) await rejectsWith(() => h.handle.rename(h.sender, "p1", "src/a.txt", target), /REMOTE_FILE_NAME_INVALID/);
	assert.equal(h.calls.length, 0, "非法改名一个服务调用都不发");
});

/** vm 里创建的 Error 不是宿主 Error：按消息断言，不用 assert.rejects 的实例判定。 */
async function rejectsWith(run, pattern) {
	try {
		await run();
	} catch (error) {
		assert.match(String(error?.message ?? error), pattern);
		return;
	}
	assert.fail("expected rejection: " + pattern);
}

test("handle：门禁关闭与非法输入都不触达服务", async () => {
	const disabled = entryIpcHarness(false);
	await rejectsWith(() => disabled.handle.create(disabled.sender, "p1", "", "a.txt", "file"), /REMOTE_FEATURE_DISABLED/);
	await rejectsWith(() => disabled.handle.rename(disabled.sender, "p1", "a.txt", "b.txt"), /REMOTE_FEATURE_DISABLED/);
	assert.equal(disabled.calls.length, 0);

	const h = entryIpcHarness();
	await rejectsWith(() => h.handle.create(h.sender, "", "", "a.txt", "file"), /REMOTE_FILE_INPUT_INVALID/);
	await rejectsWith(() => h.handle.rename(h.sender, "p1", 1, "b.txt"), /REMOTE_FILE_INPUT_INVALID/);
	assert.equal(h.calls.length, 0, "非法输入在打开服务之前就被拒绝");
});

test("handle.move：main 内 stat→rename 到目标目录；同目录移动不签令牌也不发帧", async () => {
	const h = entryIpcHarness();
	const moved = await h.handle.move(h.sender, "p1", "src/a.txt", "lib");
	assert.deepEqual(JSON.parse(JSON.stringify(moved)), { relativePath: "b.txt" });
	assert.deepEqual(JSON.parse(JSON.stringify(h.calls.map((call) => call[0]))), ["stat", "rename"], "先读版本再写");
	assert.equal(h.calls[1][4], "lib/a.txt", "目标路径 = 目标目录 + 源文件名");

	const noop = entryIpcHarness();
	const same = await noop.handle.move(noop.sender, "p1", "src/a.txt", "src");
	assert.deepEqual(JSON.parse(JSON.stringify(same)), { relativePath: "src/a.txt" });
	assert.equal(noop.calls.length, 0, "移到同一目录是无操作：不签令牌、不发帧");
});

test("handle.delete：main 内 stat→deleteEntry，带回回收站收据", async () => {
	const h = entryIpcHarness();
	const deleted = await h.handle.delete(h.sender, "p1", "src/a.txt");
	assert.deepEqual(JSON.parse(JSON.stringify(deleted)), { trashId: "20261017T093012Z-aaaaaaaa" });
	assert.deepEqual(JSON.parse(JSON.stringify(h.calls.map((call) => call[0]))), ["stat", "deleteEntry"], "先读版本再删");
	assert.equal(h.calls[1][3], "src/a.txt");

	const disabled = entryIpcHarness(false);
	await rejectsWith(() => disabled.handle.move(disabled.sender, "p1", "a.txt", "b"), /REMOTE_FEATURE_DISABLED/);
	await rejectsWith(() => disabled.handle.delete(disabled.sender, "p1", "a.txt"), /REMOTE_FEATURE_DISABLED/);
	assert.equal(disabled.calls.length, 0);
});
