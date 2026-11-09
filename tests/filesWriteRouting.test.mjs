import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

/** vm 里创建的 Error 不是宿主 Error：按消息断言。 */
async function rejectsWith(run, pattern) {
	try {
		await run();
	} catch (error) {
		assert.match(String(error?.message ?? error), pattern);
		return;
	}
	assert.fail("expected rejection: " + pattern);
}

/**
 * 公共写面现在返回 `Op`：成功取 `value`、失败按稳定码抛出（等价于 renderer 的 `unwrapOp`）。
 * 信封本身由文件末尾的 `callRaw` 用例单独覆盖。
 */
function unwrap(op) {
	if (typeof op !== "object" || op === null || !("ok" in op)) return op;
	if (op.ok) return op.value;
	throw new Error(op.code);
}

/**
 * 位置分派收口（第二片）：`files:create` / `files:rename` 在 main 内按位置路由。
 *
 * 验收点：
 * 1. ssh 项目走 `remoteEntries` 端口（entry 服务 + 令牌表 + 事实失效都在 main 内复用），
 *    renderer 不再需要 `remoteHosts.createProjectFile` / `renameProjectEntry`；
 * 2. 本机项目仍走 local backend，端口一次都不碰；
 * 3. 未装配端口时对 ssh 明确拒绝（`UNSUPPORTED_PROJECT_LOCATION`），不静默回退本机。
 */
function harness(options = {}) {
	const handlers = new Map();
	const calls = { localCreate: [], localRename: [], remoteCreate: [], remoteRename: [], remoteMove: [], remoteMoveTo: [], remoteDelete: [] };
	const electron = {
		app: {},
		dialog: {},
		ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
		shell: { openPath: async () => "", showItemInFolder: () => undefined },
	};
	const { registerFilesIpc } = loadTsCommonJs("src/main/ipc/filesIpc.ts", { stubs: { electron } });
	const root = options.root ?? mkdtempSync(join(tmpdir(), "pideck-write-routing-"));
	const localProject = { id: "p1", name: "Local", path: root, lastOpenedAt: 0 };
	const remoteProject = { id: "p2", name: "Remote", locator: { kind: "ssh", hostId: "h1", remotePath: "/srv/p" }, lastOpenedAt: 0 };
	writeFileSync(join(root, "a.txt"), "a\n");
	const remoteEntries = options.remoteEntries ?? {
		async create(sender, projectId, parent, name, type) {
			calls.remoteCreate.push({ sender, projectId, parent, name, type });
			return { relativePath: parent === "" ? name : `${parent}/${name}` };
		},
		async rename(sender, projectId, source, targetPath) {
			calls.remoteRename.push({ sender, projectId, source, targetPath });
			return { relativePath: targetPath };
		},
		async moveTo(sender, projectId, source, targetPath) {
			calls.remoteMoveTo.push({ sender, projectId, source, targetPath });
			return { relativePath: targetPath };
		},
		async move(sender, projectId, source, targetDir) {
			calls.remoteMove.push({ sender, projectId, source, targetDir });
			const name = source.slice(source.lastIndexOf("/") + 1);
			return { relativePath: targetDir === "" ? name : `${targetDir}/${name}` };
		},
		async delete(sender, projectId, relativePath) {
			calls.remoteDelete.push({ sender, projectId, relativePath });
			return { trashId: "trash-1" };
		},
	};
	registerFilesIpc({
		fileSystemService: {
			listTree: async () => [],
			listTreePage: async () => ({ nodes: [], truncated: false }),
			searchNames: async () => [],
			create: async (parentDir, name) => {
				calls.localCreate.push({ parentDir, name });
			},
			delete: async () => undefined,
			rename: async (targetPath, newName) => {
				calls.localRename.push({ targetPath, newName });
			},
		},
		projectStore: { get: (id) => (id === localProject.id ? localProject : id === remoteProject.id ? remoteProject : undefined) },
		settingsStore: { get: () => ({}) },
		appLogger: { info: async () => undefined, error: async () => undefined },
		openExternalUrl: async () => undefined,
		...(options.remoteEntries === false ? {} : { remoteEntries }),
	});
	const sender = { id: 7, isDestroyed: () => false, once: () => undefined, removeListener: () => undefined };
	const callRaw = (channel, ...args) => {
		const handler = handlers.get(channel);
		assert.ok(handler, `handler for ${channel}`);
		return handler({ sender }, ...args);
	};
	const call = async (channel, ...args) => unwrap(await callRaw(channel, ...args));
	const dispose = () => rmSync(root, { recursive: true, force: true });
	return { call, callRaw, calls, root, dispose };
}

test("files:create：ssh 项目走 remoteEntries（sender 透传），本机走 backend", async () => {
	const h = harness();
	try {
		const remote = await h.call(ipcChannels.filesCreate, { projectId: "p2", relativePath: "src" }, "b.ts", "file");
		assert.deepEqual(JSON.parse(JSON.stringify(remote)), { projectId: "p2", relativePath: "src/b.ts" });
		assert.equal(h.calls.remoteCreate.length, 1);
		assert.equal(h.calls.remoteCreate[0].projectId, "p2");
		assert.equal(h.calls.remoteCreate[0].parent, "src");
		assert.equal(h.calls.remoteCreate[0].type, "file");
		assert.equal(h.calls.remoteCreate[0].sender.id, 7, "sender 作用域照旧（令牌表按窗口隔离）");

		const local = await h.call(ipcChannels.filesCreate, { projectId: "p1", relativePath: "" }, "l.ts", "directory");
		assert.deepEqual(JSON.parse(JSON.stringify(local)), { projectId: "p1", relativePath: "l.ts" });
		assert.equal(h.calls.localCreate.length, 1, "本机仍由 backend 建");
		assert.equal(h.calls.remoteCreate.length, 1, "本机项目绝不触达远端端口");
	} finally {
		h.dispose();
	}
});

test("files:rename：ssh 项目走 remoteEntries，本机走 backend；目标路径按父目录拼接", async () => {
	const h = harness();
	try {
		const remote = await h.call(ipcChannels.filesRename, { projectId: "p2", relativePath: "src/a.txt" }, "c.txt");
		assert.deepEqual(JSON.parse(JSON.stringify(remote)), { projectId: "p2", relativePath: "src/c.txt" });
		assert.equal(h.calls.remoteRename.length, 1);
		assert.deepEqual(JSON.parse(JSON.stringify({ projectId: h.calls.remoteRename[0].projectId, source: h.calls.remoteRename[0].source, targetPath: h.calls.remoteRename[0].targetPath })), { projectId: "p2", source: "src/a.txt", targetPath: "src/c.txt" });
		assert.equal(h.calls.remoteRename[0].sender.id, 7, "sender 作用域照旧");

		const local = await h.call(ipcChannels.filesRename, { projectId: "p1", relativePath: "a.txt" }, "b.txt");
		assert.deepEqual(JSON.parse(JSON.stringify(local)), { projectId: "p1", relativePath: "b.txt" });
		assert.equal(h.calls.localRename.length, 1, "本机仍由 backend 改名");
		assert.equal(h.calls.remoteRename.length, 1);
	} finally {
		h.dispose();
	}
});

test("未装配 remoteEntries：ssh 项目明确拒绝，不静默回退本机", async () => {
	const h = harness({ remoteEntries: false });
	try {
		await assert.rejects(
			() => h.call(ipcChannels.filesCreate, { projectId: "p2", relativePath: "" }, "x.ts", "file"),
			(error) => /UNSUPPORTED_PROJECT_LOCATION/.test(String(error)),
		);
		await assert.rejects(
			() => h.call(ipcChannels.filesRename, { projectId: "p2", relativePath: "a.txt" }, "b.txt"),
			(error) => /UNSUPPORTED_PROJECT_LOCATION/.test(String(error)),
		);
		assert.equal(h.calls.localCreate.length, 0);
		assert.equal(h.calls.localRename.length, 0, "拒绝时一个本机写都不发生");
	} finally {
		h.dispose();
	}
});

test("files:move：ssh 项目走 remoteEntries（源与目标目录透传），本机不触达端口", async () => {
	const h = harness();
	try {
		const moved = await h.call(ipcChannels.filesMove, [{ projectId: "p2", relativePath: "src/a.txt" }], { projectId: "p2", relativePath: "lib" });
		assert.deepEqual(JSON.parse(JSON.stringify(moved)), [{ projectId: "p2", relativePath: "lib/a.txt" }]);
		assert.equal(h.calls.remoteMove.length, 1);
		assert.equal(h.calls.remoteMove[0].projectId, "p2");
		assert.equal(h.calls.remoteMove[0].source, "src/a.txt");
		assert.equal(h.calls.remoteMove[0].targetDir, "lib");
		assert.equal(h.calls.remoteMove[0].sender.id, 7, "sender 作用域照旧");
	} finally {
		h.dispose();
	}
});

test("files:delete：ssh 项目走 remoteEntries 并带回 trashId 收据；本机不触达端口", async () => {
	const h = harness();
	try {
		const receipt = await h.call(ipcChannels.filesDelete, { projectId: "p2", relativePath: "src/a.txt" });
		assert.deepEqual(JSON.parse(JSON.stringify(receipt)), { trashId: "trash-1" });
		assert.equal(h.calls.remoteDelete.length, 1);
		assert.equal(h.calls.remoteDelete[0].relativePath, "src/a.txt");
	} finally {
		h.dispose();
	}
});

test("未装配 remoteEntries：ssh 的 move/delete 明确拒绝，不做本机写", async () => {
	const h = harness({ remoteEntries: false });
	try {
		await rejectsWith(() => h.call(ipcChannels.filesMove, [{ projectId: "p2", relativePath: "src/a.txt" }], { projectId: "p2", relativePath: "lib" }), /UNSUPPORTED_PROJECT_LOCATION/);
		await rejectsWith(() => h.call(ipcChannels.filesDelete, { projectId: "p2", relativePath: "src/a.txt" }), /UNSUPPORTED_PROJECT_LOCATION/);
		assert.equal(h.calls.localCreate.length + h.calls.localRename.length, 0);
	} finally {
		h.dispose();
	}
});

test("files:create 的 ssh 分支保留 unknown：结果未确认不能被降级成 rejected", async () => {
	const h = harness({
		remoteEntries: {
			async create() {
				throw new Error("REMOTE_FILE_RESULT_UNCONFIRMED");
			},
		},
	});
	try {
		// 信封在结构上传 outcome：不再靠 message 反推，且 unknown 不会被降级成 rejected。
		const op = await h.callRaw(ipcChannels.filesCreate, { projectId: "p2", relativePath: "src" }, "b.ts", "file");
		assert.deepEqual(JSON.parse(JSON.stringify(op)), { ok: false, code: "REMOTE_FILE_RESULT_UNCONFIRMED", outcome: "unknown" });
		// renderer 的 unwrapOp 只透传稳定码，UI 仍按 unknown 处理（不自动重放）。
		const { normalizeProjectServiceError } = loadTsCommonJs("src/renderer/src/services/projectServiceFence.ts");
		const normalized = normalizeProjectServiceError(new Error(op.code));
		assert.equal(normalized.code, "REMOTE_FILE_RESULT_UNCONFIRMED");
		assert.equal(normalized.outcome, "unknown");
	} finally {
		h.dispose();
	}
});

test("files:move-to：ssh 项目一次写；跨项目/未装配都拒绝", async () => {
	const h = harness();
	try {
		const moved = await h.call(ipcChannels.filesMoveTo, { projectId: "p2", relativePath: "src/a.txt" }, { projectId: "p2", relativePath: "lib/b.txt" });
		assert.deepEqual(JSON.parse(JSON.stringify(moved)), { projectId: "p2", relativePath: "lib/b.txt" });
		assert.deepEqual(
			h.calls.remoteMoveTo.map((entry) => [entry.source, entry.targetPath]),
			[["src/a.txt", "lib/b.txt"]],
			"一次 stat→rename，没有先移动再改名",
		);
	} finally {
		h.dispose();
	}

	const cross = harness();
	try {
		await rejectsWith(() => cross.call(ipcChannels.filesMoveTo, { projectId: "p2", relativePath: "a" }, { projectId: "p1", relativePath: "b" }), /CROSS_BACKEND_FILE_OPERATION_UNSUPPORTED/);
	} finally {
		cross.dispose();
	}

	const unassembled = harness({ remoteEntries: false });
	try {
		await rejectsWith(() => unassembled.call(ipcChannels.filesMoveTo, { projectId: "p2", relativePath: "a" }, { projectId: "p2", relativePath: "b" }), /UNSUPPORTED_PROJECT_LOCATION/);
	} finally {
		unassembled.dispose();
	}
});
