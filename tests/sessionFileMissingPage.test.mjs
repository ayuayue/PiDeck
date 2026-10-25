/** 空会话（pi 会话文件尚未写入）必须按「还没有内容」打开，而不是报 ENOENT 读取失败。 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function enoentError() {
	const error = new Error("ENOENT: no such file or directory, stat 'C:/sessions/empty.jsonl'");
	error.code = "ENOENT";
	return error;
}

/** 注册真实 IPC handler，用内存依赖替身；不启动 Electron、不读真实文件。 */
function harness({ throwError, entry = { id: "deck-session", projectId: "builtin-chat", filePath: "C:/sessions/empty.jsonl" } }) {
	const handlers = new Map();
	const logged = [];
	const { registerSessionIpc } = loadTsCommonJs("src/main/ipc/sessionIpc.ts", {
		stubs: { electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, dialog: {} } },
	});
	registerSessionIpc({
		sessionCatalog: { get: (id) => (id === "deck-session" ? entry : undefined) },
		sessionRuntimeCoordinator: { getTarget: () => undefined },
		dshBackend: {},
		readImageSessionMessages: async () => [],
		agentManager: {
			readSessionDisplayTurnPage: async () => {
				throw throwError;
			},
		},
		appLogger: {
			info: (...args) => logged.push(["info", ...args]),
			warn: (...args) => logged.push(["warn", ...args]),
		},
	});
	return { logged, read: () => handlers.get("sessions:catalog-read-message-page")({}, "deck-session", undefined, 20) };
}

test("missingSessionFilePage 只认文件不存在（ENOENT/ENOTDIR），其余错误返回 null", () => {
	const { missingSessionFilePage } = loadTsCommonJs("src/main/sessions/sessionFileMissingPage.ts");

	const page = missingSessionFilePage(enoentError());
	assert.equal(page.unavailable, "file-missing");
	assert.equal(page.messages.length, 0);
	assert.equal(page.total, 0);
	assert.equal(page.nextBefore, null);

	// fs 的 ENOTDIR（路径中某段不是目录）与「只有 message、没有 code」的形态都算文件不存在。
	assert.equal(missingSessionFilePage(Object.assign(new Error("x"), { code: "ENOTDIR" })).unavailable, "file-missing");
	assert.equal(missingSessionFilePage(new Error("ENOENT: no such file or directory")).unavailable, "file-missing");

	// 权限、损坏、解析失败等真实故障不能被伪装成「还没有内容」。
	assert.equal(missingSessionFilePage(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })), null);
	assert.equal(missingSessionFilePage(new SyntaxError("Unexpected token < in JSON")), null);
	assert.equal(missingSessionFilePage(null), null);
	assert.equal(missingSessionFilePage("boom"), null);
});

test("会话文件不存在时 IPC 返回友好空页并记 info，而不是 reject ENOENT", async () => {
	const { read, logged } = harness({ throwError: enoentError() });
	const page = await read();
	assert.equal(page.unavailable, "file-missing");
	assert.equal(page.messages.length, 0);
	assert.equal(page.total, 0);
	assert.equal(page.nextBefore, null);
	assert.deepEqual(
		logged.map(([level, scope, message]) => [level, scope, message]),
		[["info", "session", "Read message page: session file not written yet"]],
	);
});

test("非「文件不存在」的读取失败仍然 reject，保留明确错误态", async () => {
	const broken = new SyntaxError("Unexpected token < in JSON at position 0");
	const { read, logged } = harness({ throwError: broken });
	await assert.rejects(read(), (error) => error === broken);
	assert.deepEqual(
		logged.map(([level]) => level),
		["warn"],
	);
});
