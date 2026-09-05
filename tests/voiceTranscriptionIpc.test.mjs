import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function loadRegistration() {
	const handlers = new Map();
	const ipcChannels = {
		voiceTranscriptionGetConfig: "voice:get-config",
		voiceTranscriptionSaveConfig: "voice:save-config",
		voiceTranscriptionTranscribe: "voice:transcribe",
		voiceTranscriptionCancel: "voice:cancel",
	};
	const module = { exports: {} };
	const source = ts.transpileModule(
		readFileSync("src/main/ipc/voiceTranscriptionIpc.ts", "utf8"),
		{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
	).outputText;
	vm.runInNewContext(source, {
		module,
		exports: module.exports,
		ArrayBuffer,
		require: (id) => {
			if (id === "electron") {
				return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
			}
			if (id === "../../shared/ipc") return { ipcChannels };
			throw new Error(`unexpected require: ${id}`);
		},
	});
	return { handlers, ipcChannels, register: module.exports.registerVoiceTranscriptionIpc };
}

test("voice IPC registers narrow handlers and validates transcription input", async () => {
	const { handlers, ipcChannels, register } = loadRegistration();
	const calls = { cancelled: [], transcribed: [] };
	const configStore = {
		getPublicConfig: async () => ({ hasApiKey: false }),
		saveConfig: async () => ({ ok: false, error: "invalidConfig" }),
	};
	const service = {
		transcribe: async (input) => {
			calls.transcribed.push(input);
			return { ok: true, text: "voice" };
		},
		cancel: (requestId) => calls.cancelled.push(requestId),
	};
	register({ configStore, service });

	assert.deepEqual(
		Array.from(handlers.keys()).sort(),
		Object.values(ipcChannels).sort(),
	);
	const transcribe = handlers.get(ipcChannels.voiceTranscriptionTranscribe);
	assert.equal((await transcribe({}, { requestId: "bad id", audio: new ArrayBuffer(1), mimeType: "audio/webm" })).error, "invalidRequest");
	assert.equal((await transcribe({}, { requestId: "request-1", audio: "not-bytes", mimeType: "audio/webm" })).error, "invalidRequest");

	const audio = new ArrayBuffer(3);
	assert.equal((await transcribe({}, { requestId: "request-1", audio, mimeType: "audio/webm" })).text, "voice");
	assert.equal(calls.transcribed.length, 1);
	assert.equal(calls.transcribed[0].audio, audio);

	const cancel = handlers.get(ipcChannels.voiceTranscriptionCancel);
	await cancel({}, "bad id");
	await cancel({}, "request-1");
	assert.deepEqual(calls.cancelled, ["request-1"]);
});
