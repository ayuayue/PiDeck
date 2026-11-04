import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

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
					releaseSender: (id) => calls.push(["released", id]),
				}),
			},
		},
	});
	registerRemoteProjectFileIpc({ enabled, service: () => undefined, locator: () => undefined });
	return { calls, sender, invoke: async (channel, ...args) => structuredClone(await handlers.get(channel)({ sender }, ...args)) };
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

test("editor channels are wired through shared/preload/main/preview without local files fallback", () => {
	const channels = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	const main = readFileSync("src/main/index.ts", "utf8");
	const preview = readFileSync("src/renderer/src/previewApi.ts", "utf8");
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
