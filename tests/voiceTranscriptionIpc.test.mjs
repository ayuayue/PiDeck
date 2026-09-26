import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function transpile(path) {
	return ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
}

function loadWhisperRuntime() {
	const module = { exports: {} };
	vm.runInNewContext(transpile("src/shared/types/whisperRuntime.ts"), { module, exports: module.exports });
	return module.exports;
}

function loadRegistration() {
	const handlers = new Map();
	const ipcChannels = {
		voiceTranscriptionGetConfig: "voice:get-config",
		voiceTranscriptionSaveConfig: "voice:save-config",
		voiceTranscriptionTranscribe: "voice:transcribe",
		voiceTranscriptionCancel: "voice:cancel",
		voiceTranscriptionTest: "voice:test",
		// 安装进度是 webContents.send 推送通道，不走 ipcMain.handle，故不出现在这里。
		voiceTranscriptionRuntimeStatus: "voice:runtime-status",
		voiceTranscriptionRuntimeInstall: "voice:runtime-install",
		voiceTranscriptionModelInstall: "voice:model-install",
		voiceTranscriptionModelDelete: "voice:model-delete",
		voiceTranscriptionInstallCancel: "voice:install-cancel",
	};
	const whisperRuntime = loadWhisperRuntime();
	const module = { exports: {} };
	vm.runInNewContext(transpile("src/main/ipc/voiceTranscriptionIpc.ts"), {
		module,
		exports: module.exports,
		ArrayBuffer,
		require: (id) => {
			if (id === "electron") {
				return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
			}
			if (id === "../../shared/ipc") return { ipcChannels };
			if (id === "../../shared/types/whisperRuntime") return whisperRuntime;
			throw new Error(`unexpected require: ${id}`);
		},
	});
	return { handlers, ipcChannels, register: module.exports.registerVoiceTranscriptionIpc };
}

test("voice IPC registers narrow handlers and validates transcription input", async () => {
	const { handlers, ipcChannels, register } = loadRegistration();
	const calls = { cancelled: [], transcribed: [] };
	const configStore = {
		getPublicConfig: async () => ({ hasApiKey: false, cliPath: "", localModelId: "small-q5_1" }),
		saveConfig: async () => ({ ok: false, error: "invalidConfig" }),
	};
	const service = {
		transcribe: async (input) => {
			calls.transcribed.push(input);
			return { ok: true, text: "voice" };
		},
		cancel: (requestId) => calls.cancelled.push(requestId),
		testConnection: async () => {
			calls.tests = (calls.tests ?? 0) + 1;
			return { ok: true };
		},
	};
	const runtimeCalls = { status: [], installRuntime: 0, installModel: [], deleteModel: [], abortInstall: 0 };
	const runtimeManager = {
		getStatus: async (input) => {
			runtimeCalls.status.push(input);
			return { cliReady: true };
		},
		installRuntime: async () => {
			runtimeCalls.installRuntime += 1;
			return { ok: true };
		},
		installModel: async (modelId) => {
			runtimeCalls.installModel.push(modelId);
			return { ok: true };
		},
		deleteModel: async (modelId) => {
			runtimeCalls.deleteModel.push(modelId);
			return { ok: true };
		},
		abortInstall: () => {
			runtimeCalls.abortInstall += 1;
			return runtimeCalls.abortInstall === 1;
		},
	};
	const emitted = [];
	register({ configStore, service, runtimeManager, emitRuntimeProgress: (p) => emitted.push(p) });

	assert.deepEqual(Array.from(handlers.keys()).sort(), Object.values(ipcChannels).sort());
	const transcribe = handlers.get(ipcChannels.voiceTranscriptionTranscribe);
	assert.equal((await transcribe({}, { requestId: "bad id", audio: new ArrayBuffer(1), mimeType: "audio/webm" })).error, "invalidRequest");
	assert.equal((await transcribe({}, { requestId: "request-1", audio: "not-bytes", mimeType: "audio/webm" })).error, "invalidRequest");

	const audio = new ArrayBuffer(3);
	assert.equal((await transcribe({}, { requestId: "request-1", audio, mimeType: "audio/webm" })).text, "voice");
	assert.equal(calls.transcribed.length, 1);
	assert.equal(calls.transcribed[0].audio, audio);

	// test 无入参：探针音频与密钥都留在主进程，渲染层只拿结论。
	const probe = handlers.get(ipcChannels.voiceTranscriptionTest);
	assert.equal((await probe({})).ok, true);
	assert.equal(calls.tests, 1);

	const cancel = handlers.get(ipcChannels.voiceTranscriptionCancel);
	await cancel({}, "bad id");
	await cancel({}, "request-1");
	assert.deepEqual(calls.cancelled, ["request-1"]);

	// runtime-status 读取当前配置后把 cliPath/localModelId 传给 manager
	// （入参对象在 vm realm 里构造，逐字段比较以避开跨 realm 原型差异）
	const status = handlers.get(ipcChannels.voiceTranscriptionRuntimeStatus);
	assert.equal((await status({})).cliReady, true);
	assert.equal(runtimeCalls.status.length, 1);
	assert.equal(runtimeCalls.status[0].cliPath, "");
	assert.equal(runtimeCalls.status[0].localModelId, "small-q5_1");

	// model-install / model-delete 只接受目录内的 modelId，未知一律拒绝、不触达 manager
	const installModel = handlers.get(ipcChannels.voiceTranscriptionModelInstall);
	const deleteModel = handlers.get(ipcChannels.voiceTranscriptionModelDelete);
	assert.equal((await installModel({}, "nope-not-a-model")).error, "unknown-model");
	assert.deepEqual(await installModel({}, "small-q5_1"), { ok: true });
	assert.equal((await deleteModel({}, "nope")).error, "unknown-model");
	assert.deepEqual(await deleteModel({}, "medium-q5_0"), { ok: true });
	assert.deepEqual(runtimeCalls.installModel, ["small-q5_1"]);
	assert.deepEqual(runtimeCalls.deleteModel, ["medium-q5_0"]);

	// runtime-install 触发安装并把进度回调透传给 manager（emitRuntimeProgress 引用一致）
	const runtimeInstall = handlers.get(ipcChannels.voiceTranscriptionRuntimeInstall);
	assert.deepEqual(await runtimeInstall({}), { ok: true });
	assert.equal(runtimeCalls.installRuntime, 1);

	// install-cancel 只负责中止主进程侧当前任务，并把「有没有任务可中止」原样返回给渲染层
	const installCancel = handlers.get(ipcChannels.voiceTranscriptionInstallCancel);
	assert.equal(await installCancel({}), true);
	assert.equal(await installCancel({}), false);
	assert.equal(runtimeCalls.abortInstall, 2);
});
