import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function transpile(path) {
	return ts.transpileModule(readFileSync(path, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: path,
	}).outputText;
}

function loadSharedConfig() {
	const module = { exports: {} };
	vm.runInNewContext(transpile("src/shared/voiceTranscriptionConfig.ts"), {
		module,
		exports: module.exports,
		URL,
	});
	return module.exports;
}

function loadServiceClass() {
	const sharedConfig = loadSharedConfig();
	const module = { exports: {} };
	vm.runInNewContext(transpile("src/main/voice/VoiceTranscriptionService.ts"), {
		module,
		exports: module.exports,
		AbortController,
		Blob,
		FormData,
		TextDecoder,
		TextEncoder,
		setTimeout,
		clearTimeout,
		fetch,
		require: (id) => {
			if (id === "../../shared/voiceTranscriptionConfig") return sharedConfig;
			throw new Error(`unexpected require: ${id}`);
		},
	});
	return module.exports.VoiceTranscriptionService;
}

const VoiceTranscriptionService = loadServiceClass();
const credentials = {
	baseUrl: "https://api.example.com/v1/",
	apiKey: "sk-secret",
	model: "whisper-1",
	language: "zh",
};
const audio = new Uint8Array([1, 2, 3]).buffer;

test("sends bounded multipart fields to the normalized endpoint", async () => {
	let captured;
	const service = new VoiceTranscriptionService({
		getCredentials: async () => credentials,
		fetch: async (url, init) => {
			captured = { url: String(url), init };
			return new Response(JSON.stringify({ text: "  hello voice  " }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
		log: () => {},
	});
	const result = await service.transcribe({ requestId: "request-1", audio, mimeType: "audio/webm;codecs=opus" });
	assert.equal(result.ok, true);
	assert.equal(result.text, "hello voice");
	assert.equal(captured.url, "https://api.example.com/v1/audio/transcriptions");
	assert.equal(captured.init.headers.Authorization, "Bearer sk-secret");
	assert.equal(captured.init.body.get("model"), "whisper-1");
	assert.equal(captured.init.body.get("language"), "zh");
	const file = captured.init.body.get("file");
	assert.equal(file.type, "audio/webm");
	assert.equal(file.name, "recording.webm");
});

test("rejects unsupported MIME and oversized audio before fetching", async () => {
	let calls = 0;
	const service = new VoiceTranscriptionService({
		getCredentials: async () => credentials,
		fetch: async () => {
			calls += 1;
			return new Response("{}");
		},
		log: () => {},
	});
	assert.equal((await service.transcribe({ requestId: "bad-1", audio, mimeType: "text/plain" })).error, "invalidRequest");
	assert.equal((await service.transcribe({
		requestId: "bad-2",
		audio: new ArrayBuffer(25 * 1024 * 1024 + 1),
		mimeType: "audio/webm",
	})).error, "invalidRequest");
	assert.equal(calls, 0);
});

test("maps status and malformed responses without returning upstream bodies or keys", async () => {
	for (const [status, expected] of [[401, "invalidKey"], [404, "badBaseUrl"], [500, "http"]]) {
		const service = new VoiceTranscriptionService({
			getCredentials: async () => credentials,
			fetch: async () => new Response(`secret body ${credentials.apiKey}`, { status }),
			log: () => {},
		});
		const result = await service.transcribe({ requestId: `status-${status}`, audio, mimeType: "audio/ogg" });
		assert.equal(result.error, expected);
		assert.equal("detail" in result, false);
	}
	const malformed = new VoiceTranscriptionService({
		getCredentials: async () => credentials,
		fetch: async () => new Response("not json", { status: 200 }),
		log: () => {},
	});
	assert.equal((await malformed.transcribe({ requestId: "empty", audio, mimeType: "audio/mp4" })).error, "empty");
});

test("timeout aborts the request and maps to timeout", async () => {
	const service = new VoiceTranscriptionService({
		getCredentials: async () => credentials,
		timeoutMs: 5,
		fetch: async (_url, init) => new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		}),
		log: () => {},
	});
	const result = await service.transcribe({ requestId: "timeout", audio, mimeType: "audio/wav" });
	assert.equal(result.error, "timeout");
});

test("cancel aborts and removes in-flight state so the request id can be reused", async () => {
	let calls = 0;
	let markStarted;
	const started = new Promise((resolve) => {
		markStarted = resolve;
	});
	const service = new VoiceTranscriptionService({
		getCredentials: async () => credentials,
		fetch: async (_url, init) => {
			calls += 1;
			if (calls === 1) {
				markStarted();
				return new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			}
			return new Response(JSON.stringify({ text: "second" }), { status: 200 });
		},
		log: () => {},
	});
	const first = service.transcribe({ requestId: "reused", audio, mimeType: "audio/mpeg" });
	await started;
	service.cancel("reused");
	assert.equal((await first).error, "cancelled");
	const second = await service.transcribe({ requestId: "reused", audio, mimeType: "audio/mpeg" });
	assert.equal(second.ok, true);
	assert.equal(second.text, "second");
});
