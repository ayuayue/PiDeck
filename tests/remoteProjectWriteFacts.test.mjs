import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * P0-2 follow-up：远端文件写的「可能已落地」路径也要失效事实。
 *
 * 现状：写成功才调用 afterWrite。结果未知（REMOTE_FILE_RESULT_UNCONFIRMED）或传输中断（断连/超时/
 * 会话换代）时，命令可能已经执行，而面板/tree 会停在写前；明确失败（校验/版本冲突/远端拒绝）不改
 * 远端，不该标脏。两条收敛规则：
 * 1. 成功 ⇒ 按**已知结果路径**失效；
 * 2. 结果未知 ⇒ 按**请求的目标路径**失效（不猜远端实际状态），且写绝不重放；
 * 3. 明确失败 ⇒ 不失效。
 */
const { isUncertainWrite } = loadTsCommonJs("src/main/remote/RemoteProjectWriteFacts.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

const PROJECT = "remote-project";
const plain = (value) => JSON.parse(JSON.stringify(value));
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

function sender() {
	const emitter = new EventEmitter();
	emitter.id = 1;
	emitter.isDestroyed = () => false;
	return emitter;
}

function entryHarness(entry) {
	const handlers = new Map();
	const afterWrite = [];
	const { registerRemoteProjectEntryIpc } = loadTsCommonJs("src/main/ipc/remoteProjectEntryIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } },
			"../remote/RemoteProjectEntryService": {
				REMOTE_FILE_ENTRY_CODES: new Set(["REMOTE_FILE_RESULT_UNCONFIRMED", "REMOTE_FILE_INPUT_INVALID", "REMOTE_FILE_TARGET_EXISTS", "REMOTE_FILE_CHANGED", "REMOTE_FILE_COMMAND_FAILED"]),
				createRemoteProjectEntryService: () => entry,
			},
		},
	});
	const handle = registerRemoteProjectEntryIpc({
		enabled: true,
		service: async () => ({}),
		locator: () => ({ kind: "ssh", hostId: "host", remotePath: "/srv/app" }),
		afterWrite: (projectId, paths) => afterWrite.push([projectId, [...paths]]),
	});
	return { handlers, afterWrite, handle };
}

function fileHarness(fileService) {
	const handlers = new Map();
	const afterWrite = [];
	const { registerRemoteProjectFileIpc } = loadTsCommonJs("src/main/ipc/remoteProjectFileIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } },
			"../remote/RemoteProjectFileService": { createRemoteProjectFileService: () => fileService },
		},
	});
	registerRemoteProjectFileIpc({
		enabled: true,
		service: async () => ({}),
		locator: () => ({ kind: "ssh", hostId: "host", remotePath: "/srv/app" }),
		afterWrite: (projectId, paths) => afterWrite.push([projectId, [...paths]]),
	});
	return { handlers, afterWrite };
}

test("isUncertainWrite：未知结果与传输中断算「可能已落地」，明确失败不算", () => {
	for (const code of ["REMOTE_FILE_RESULT_UNCONFIRMED", "GIT_WRITE_RESULT_UNCONFIRMED", "SSH_HOST_DISCONNECTED", "SSH_HOST_NOT_READY", "REMOTE_CONNECTION_LOST", "REQUEST_TIMEOUT"]) {
		assert.equal(isUncertainWrite(new Error(code)), true, code + " 可能已经执行");
	}
	for (const code of ["REMOTE_FILE_INPUT_INVALID", "REMOTE_FILE_CHANGED", "REMOTE_FILE_TARGET_EXISTS", "REMOTE_FILE_VERSION_INVALID", "REMOTE_FILE_COMMAND_FAILED", "REMOTE_FILE_NOT_FOUND"]) {
		assert.equal(isUncertainWrite(new Error(code)), false, code + " 明确未落地");
	}
	assert.equal(isUncertainWrite(new Error("boom")), false, "自由文本不猜成未知");
});

test("entry 写：结果未知时按请求目标路径失效，且不重放写", async () => {
	const calls = [];
	const entry = {
		async createFile(...args) {
			calls.push(args);
			throw new Error("REMOTE_FILE_RESULT_UNCONFIRMED");
		},
	};
	const h = entryHarness(entry);
	// 旧通道已删除；files:create 走同一 handle，unknown 仍按请求目标路径标脏。
	await rejectsWith(() => h.handle.create(sender(), PROJECT, "src", "new.txt", "file"), /REMOTE_FILE_RESULT_UNCONFIRMED/);
	assert.equal(calls.length, 1, "未知结果绝不重放写");
	assert.deepEqual(h.afterWrite, [[PROJECT, ["src/new.txt"]]], "按请求的目标路径标脏（不猜远端实际状态）");
});

test("entry 写：明确失败不失效事实", async () => {
	const entry = {
		async createFile() {
			throw new Error("REMOTE_FILE_TARGET_EXISTS");
		},
	};
	const h = entryHarness(entry);
	await rejectsWith(() => h.handle.create(sender(), PROJECT, "", "taken.txt", "file"), /REMOTE_FILE_TARGET_EXISTS/);
	assert.deepEqual(h.afterWrite, [], "远端明确拒绝时远端没变，不标脏");
});

test("entry 写：成功仍只按结果路径失效（行为不变）", async () => {
	const entry = {
		async createFile() {
			return { relativePath: "src/new.txt", kind: "file" };
		},
	};
	const h = entryHarness(entry);
	const created = await h.handle.create(sender(), PROJECT, "src", "new.txt", "file");
	assert.deepEqual(plain(created), { relativePath: "src/new.txt", kind: "file" });
	assert.deepEqual(h.afterWrite, [[PROJECT, ["src/new.txt"]]]);
});

test("entry 改名：未知结果时源与目标都标脏", async () => {
	const entry = {
		async stat() {
			return { stat: { kind: "file", bytes: 0, mtimeMs: 1 }, version: "a".repeat(32) };
		},
		async rename() {
			throw new Error("REMOTE_FILE_RESULT_UNCONFIRMED");
		},
	};
	const h = entryHarness(entry);
	await rejectsWith(() => h.handle.rename(sender(), PROJECT, "a.txt", "b.txt"), /REMOTE_FILE_RESULT_UNCONFIRMED/);
	assert.deepEqual(h.afterWrite, [[PROJECT, ["a.txt", "b.txt"]]], "改名两边都可能变了");
});

test("entry 回收站还原：未知结果时没有已知路径，仍发一次空范围失效（装配层据此失效 Git status）", async () => {
	const entry = {
		async restoreTrash() {
			throw new Error("REMOTE_FILE_RESULT_UNCONFIRMED");
		},
	};
	const h = entryHarness(entry);
	const result = await h.handlers.get(ipcChannels.remoteProjectTrashRestore)({ sender: sender() }, PROJECT, "20261030T120000Z-ab12cd34");
	assert.equal(result.code, "REMOTE_FILE_RESULT_UNCONFIRMED");
	assert.deepEqual(h.afterWrite, [[PROJECT, []]], "没有已知路径时不编路径，但仍通知项目级失效");
});

test("文本保存：未知结果/断连按文件路径失效且不重放；明确失败与校验失败不失效", async () => {
	const saves = [];
	const fileService = {
		async save(...args) {
			saves.push(args);
			const mode = saves.at(-1)[3];
			if (mode === "unknown") throw new Error("REMOTE_FILE_RESULT_UNCONFIRMED");
			if (mode === "offline") throw new Error("SSH_HOST_DISCONNECTED");
			if (mode === "changed") throw new Error("REMOTE_FILE_CHANGED");
			return { version: "b".repeat(32) };
		},
	};
	const h = fileHarness(fileService);
	const save = (content) => h.handlers.get(ipcChannels.remoteProjectTextSave)({ sender: sender() }, PROJECT, "a.txt", content, "a".repeat(32));

	assert.equal((await save("unknown")).code, "REMOTE_FILE_RESULT_UNCONFIRMED");
	assert.deepEqual(h.afterWrite, [[PROJECT, ["a.txt"]]], "未知结果可能已落地");
	h.afterWrite.length = 0;

	assert.equal((await save("offline")).code, "SSH_HOST_DISCONNECTED");
	assert.deepEqual(h.afterWrite, [[PROJECT, ["a.txt"]]], "断连可能发生在命令发出之后");
	h.afterWrite.length = 0;

	assert.equal((await save("changed")).code, "REMOTE_FILE_CHANGED");
	assert.deepEqual(h.afterWrite, [], "明确失败不标脏");
	assert.equal(saves.length, 3, "每次调用只写一次：未知结果不重放");

	const ok = await save("ok");
	assert.equal(ok.ok, true);
	assert.deepEqual(h.afterWrite, [[PROJECT, ["a.txt"]]], "成功路径不变");
	assert.deepEqual(plain(ok.value), { version: "b".repeat(32) });
});
