import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 回归（安全边界）：scratchPad:load/save/delete/export 曾经直接使用渲染层
 * 传入的任意绝对路径——主进程被当成任意文件读/写/删的静默通道（对照
 * filesIpc 的 project boundary 与 pasteFilesIpc 的白名单，这里是漏网）。
 * 草稿路径必须限制在 userData/drafts 内；本测试从行为上验证越界路径被拒。
 */

function setup() {
	const userDataRoot = mkdtempSync(join(tmpdir(), "pideck-scratch-boundary-"));
	const handlers = new Map();
	const trashed = [];
	const exportedFiles = [];
	const load = createTsSandbox({
		stubs: {
			electron: {
				app: { getPath: () => userDataRoot },
				dialog: {
					showSaveDialog: async () => ({ canceled: false, filePath: join(userDataRoot, "export-out.md") }),
				},
				ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
			},
			// 回收站删除走 stub：记录调用而非真删，验证 delete 是否把越界路径送到 trash。
			"../fs/trash": { trashPath: async (path) => trashed.push(path) },
		},
	});
	load("src/main/ipc/scratchPadIpc.ts").registerScratchPadIpc({
		appLogger: { info: () => {}, error: () => {} },
	});
	return { userDataRoot, handlers, trashed };
}

test("scratchPad:save rejects paths outside the drafts directory", async () => {
	const { userDataRoot, handlers } = setup();
	const outside = join(userDataRoot, "escape.txt");
	await assert.rejects(() => handlers.get("scratch-pad:save")(null, outside, "evil content", 0), /Invalid draft path|drafts directory/i);
	assert.equal(existsSync(outside), false, "越界路径绝不能被写入");
});

test("scratchPad:load rejects reading arbitrary files outside drafts", async () => {
	const { userDataRoot, handlers } = setup();
	const secret = join(userDataRoot, "secret.txt");
	writeFileSync(secret, "top secret");
	await assert.rejects(() => handlers.get("scratch-pad:load")(null, secret), /Invalid draft path|drafts directory/i);
});

test("scratchPad:delete never sends out-of-bounds paths to trash", async () => {
	const { userDataRoot, handlers, trashed } = setup();
	const outside = join(userDataRoot, "victim.txt");
	writeFileSync(outside, "do not delete");
	await assert.rejects(() => handlers.get("scratch-pad:delete")(null, outside), /Invalid draft path|drafts directory/i);
	assert.deepEqual(trashed, [], "trash 不得收到 drafts 目录之外的路径");
});

test("scratchPad:export refuses to read outside drafts even with a dialog target", async () => {
	const { userDataRoot, handlers } = setup();
	const secret = join(userDataRoot, "secret-export.txt");
	writeFileSync(secret, "top secret");
	await assert.rejects(() => handlers.get("scratch-pad:export")(null, secret), /Invalid draft path|drafts directory/i);
});

test("scratchPad:load/save round-trip still works for paths inside drafts", async () => {
	const { userDataRoot, handlers } = setup();
	// 通过 create 拿一条合法草稿路径（list/create 的返回值是渲染层唯一合法来源）
	const draft = await handlers.get("scratch-pad:create")(null);
	await handlers.get("scratch-pad:save")(null, draft.path, "hello draft", 0);
	const data = await handlers.get("scratch-pad:load")(null, draft.path);
	assert.equal(data.content, "hello draft");
	// export 合法草稿：允许读取并写出
	const ok = await handlers.get("scratch-pad:export")(null, draft.path);
	assert.equal(ok, true);
	assert.equal(readFileSync(join(userDataRoot, "export-out.md"), "utf8"), "hello draft");
	rmSync(userDataRoot, { recursive: true, force: true });
});
