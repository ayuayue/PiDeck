import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

import { previewApiSource } from "./helpers/previewApiSources.mjs";
import { preloadSource } from "./helpers/preloadSources.mjs";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";

function setup(enabled = true) {
	const handlers = new Map();
	const calls = [];
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const { registerRemoteProjectFileIpc } = loadTsCommonJs("src/main/ipc/remoteProjectFileIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) } },
			"../remote/RemoteProjectFileService": {
				createRemoteProjectFileService: () => ({
					open: async (...args) => {
						calls.push(args);
						return { content: "remote text", version: "a".repeat(32) };
					},
					save: async (...args) => {
						calls.push(args);
						return { version: "b".repeat(32) };
					},
					readBase64: async (...args) => {
						calls.push(["readBase64", ...args]);
						return "UklGRg==";
					},
					releaseSender: (id) => calls.push(["released", id]),
				}),
			},
		},
	});
	const port = registerRemoteProjectFileIpc({ enabled, service: () => undefined, locator: () => undefined });
	return { calls, sender, port, invoke: async (channel, ...args) => structuredClone(await handlers.get(channel)({ sender }, ...args)) };
}

test("editor IPC validates renderer input before touching remote service and returns stable envelopes", async () => {
	const f = setup();
	for (const path of ["", "../secret", "/absolute", "x\n", "a\\b"]) assert.equal((await f.invoke("remote:project-text-open", "project", path)).ok, false);
	assert.equal((await f.invoke("remote:project-text-save", "project", "code.ts", "text", "forged")).ok, false);
	assert.equal((await f.invoke("remote:project-text-save", "project", "code.ts", "x".repeat(262145), "a".repeat(32))).code, "REMOTE_FILE_TOO_LARGE");
	assert.equal(f.calls.length, 0);
	const opened = await f.invoke("remote:project-text-open", "project", "code.ts");
	assert.deepEqual(opened, { ok: true, value: { document: { content: "remote text", version: "a".repeat(32) } } });
	assert.deepEqual(await f.invoke("remote:project-text-save", "project", "code.ts", "next", opened.value.document.version), { ok: true, value: { version: "b".repeat(32) } });
	assert.deepEqual(f.calls, [
		[1, "project", "code.ts"],
		[1, "project", "code.ts", "next", "a".repeat(32)],
	]);
	f.sender.emit("destroyed");
	assert.deepEqual(f.calls.at(-1), ["released", 1]);
});

test("disabled feature cannot read/write or register sender resources", async () => {
	const f = setup(false);
	assert.deepEqual(await f.invoke("remote:project-text-open", "project", "code.ts"), { ok: false, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" });
	assert.deepEqual(await f.invoke("remote:project-text-save", "project", "code.ts", "next", "a".repeat(32)), { ok: false, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" });
	assert.equal(f.calls.length, 0);
	assert.equal(f.sender.listenerCount("destroyed"), 0);
});

test("远端二进制读（中央编辑器预览）复用同一服务实例，回收站命名空间一律拒绝", async () => {
	const f = setup();
	// 图片/PDF/Office/压缩包在中间栏渲染时走这条：裸 base64 原样透出（与 files:read-base64 本机分支同形）。
	assert.equal(await f.port.readBase64(1, "project", "docs/shot.png", 1024), "UklGRg==");
	assert.deepEqual(f.calls.at(-1), ["readBase64", 1, "project", "docs/shot.png", 1024]);
	// 回收站不是用户可读的项目文件；穿越段/绝对路径在校验层就拒绝，绝不落到服务。
	assert.throws(() => f.port.readBase64(1, "project", ".pideck-trash/shot.png", 1024), /REMOTE_FILE_PROTECTED_PATH/);
	assert.throws(() => f.port.readBase64(1, "project", "../secret.png", 1024), /REMOTE_FILE_PATH_INVALID/);
	assert.equal(f.calls.filter((call) => call[0] === "readBase64").length, 1);
});

test("editor channels are wired through shared/preload/main/preview without local files fallback", () => {
	const channels = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = preloadSource;
	const main = mainIpcSource;
	const preview = previewApiSource;
	for (const name of ["remoteProjectTextOpen", "remoteProjectTextSave"]) {
		assert.match(channels, new RegExp(name + "\\s*:"));
		assert.match(preload, new RegExp("invoke\\(ipcChannels\\." + name));
	}
	assert.match(main, /registerRemoteProjectFileIpc\(\{\s*enabled:\s*remoteFeatureEnabled/);
	for (const name of ["openProjectText", "saveProjectText"]) assert.match(preview, new RegExp(name + "\\s*:"));
	const editor = readFileSync("src/renderer/src/components/workspace/RemoteFileEditor.tsx", "utf8");
	assert.match(editor, /CodeMirrorEditor/);
	assert.match(editor, /remoteFile\.discardReload/);
	assert.doesNotMatch(editor, /files\.(writeContent|readContent)|setTimeout|setInterval/);
});
