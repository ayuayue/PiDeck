import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 服务层的依赖图里有 shared 契约与繁简收口模块，交给统一加载器按源文件目录解析
 * （手写 vm 加载器每加一个本地 import 就要补一层 require 桥，已经在 2026-09 踩过三次）。
 */
const load = createTsSandbox({ globals: { Blob, FormData, Response, fetch, URL } });
const { VoiceTranscriptionService } = load("src/main/voice/VoiceTranscriptionService.ts");
const credentials = {
	baseUrl: "https://api.example.com/v1/",
	apiKey: "sk-secret",
	model: "whisper-1",
	language: "zh",
};
// 云引擎配置：transcribe 先读它判引擎，再走 getCredentials。
const cloudConfig = {
	enabled: true,
	engine: "cloud",
	baseUrl: "https://api.example.com/v1/",
	model: "whisper-1",
	language: "zh",
	inputDeviceId: "",
	localModelId: "small-q5_1",
	cliPath: "",
	hasApiKey: true,
	runtimeReady: true,
};
const audio = new Uint8Array([1, 2, 3]).buffer;

test("sends bounded multipart fields to the normalized endpoint", async () => {
	let captured;
	const service = new VoiceTranscriptionService({
		getPublicConfig: async () => cloudConfig,
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
		getPublicConfig: async () => cloudConfig,
		getCredentials: async () => credentials,
		fetch: async () => {
			calls += 1;
			return new Response("{}");
		},
		log: () => {},
	});
	assert.equal((await service.transcribe({ requestId: "bad-1", audio, mimeType: "text/plain" })).error, "invalidRequest");
	assert.equal(
		(
			await service.transcribe({
				requestId: "bad-2",
				audio: new ArrayBuffer(25 * 1024 * 1024 + 1),
				mimeType: "audio/webm",
			})
		).error,
		"invalidRequest",
	);
	assert.equal(calls, 0);
});

test("maps status and malformed responses without returning upstream bodies or keys", async () => {
	for (const [status, expected] of [
		[401, "invalidKey"],
		[404, "badBaseUrl"],
		[500, "http"],
	]) {
		const service = new VoiceTranscriptionService({
			getPublicConfig: async () => cloudConfig,
			getCredentials: async () => credentials,
			fetch: async () => new Response(`secret body ${credentials.apiKey}`, { status }),
			log: () => {},
		});
		const result = await service.transcribe({ requestId: `status-${status}`, audio, mimeType: "audio/ogg" });
		assert.equal(result.error, expected);
		assert.equal("detail" in result, false);
	}
	const malformed = new VoiceTranscriptionService({
		getPublicConfig: async () => cloudConfig,
		getCredentials: async () => credentials,
		fetch: async () => new Response("not json", { status: 200 }),
		log: () => {},
	});
	assert.equal((await malformed.transcribe({ requestId: "empty", audio, mimeType: "audio/mp4" })).error, "empty");
});

test("timeout aborts the request and maps to timeout", async () => {
	const service = new VoiceTranscriptionService({
		getPublicConfig: async () => cloudConfig,
		getCredentials: async () => credentials,
		timeoutMs: 5,
		fetch: async (_url, init) =>
			new Promise((_resolve, reject) => {
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
		getPublicConfig: async () => cloudConfig,
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

test("routes engine=local to the injected transcriber, and reports unavailable without one", async () => {
	const localConfig = { ...cloudConfig, engine: "local", cliPath: "/opt/whisper-cli", localModelId: "small-q5_1", language: "zh" };
	let forwarded;
	const withLocal = new VoiceTranscriptionService({
		getPublicConfig: async () => localConfig,
		getCredentials: async () => null, // 本地路径不得触碰云凭据
		transcribeLocal: async (input) => {
			forwarded = input;
			return { ok: true, text: "本地结果" };
		},
		log: () => {},
	});
	const result = await withLocal.transcribe({ requestId: "local-1", audio, mimeType: "audio/wav" });
	assert.equal(result.ok, true);
	assert.equal(result.text, "本地结果");
	assert.equal(forwarded.cliPath, "/opt/whisper-cli");
	assert.equal(forwarded.modelId, "small-q5_1");
	assert.equal(forwarded.language, "zh");

	const withoutLocal = new VoiceTranscriptionService({
		getPublicConfig: async () => localConfig,
		getCredentials: async () => null,
		log: () => {},
	});
	assert.equal((await withoutLocal.transcribe({ requestId: "local-2", audio, mimeType: "audio/wav" })).error, "engineUnavailable");
});

test("cancel forwards to the local engine's cancel hook", () => {
	const cancelled = [];
	const service = new VoiceTranscriptionService({
		getPublicConfig: async () => cloudConfig,
		getCredentials: async () => credentials,
		cancelLocal: (id) => cancelled.push(id),
		log: () => {},
	});
	service.cancel("req-9");
	assert.deepEqual(cancelled, ["req-9"]);
});

const volcCredentials = { provider: "volcengine", appId: "app-id", accessToken: "access-token", resourceId: "volc.bigasr.auc_turbo", language: "" };

/** 检测（probe）用的服务替身：记录 fetch 调用并回放指定的响应头/正文。 */
function probeService({ credentials = volcCredentials, status = 200, headers = {}, body = JSON.stringify({ result: { text: "你好" } }), calls = [] } = {}) {
	const service = new VoiceTranscriptionService({
		getPublicConfig: async () => cloudConfig,
		getCredentials: async () => credentials,
		fetch: async (url, init) => {
			calls.push({ url: String(url), init });
			return new Response(body, { status, headers });
		},
		log: () => {},
	});
	return { service, calls };
}

test("testConnection sends a decodable 16kHz mono wav probe and treats silence as a healthy link", async () => {
	// 20000003 = 静音音频：服务受理并解码了音频，只是没字——对探针来说这就是链路通了。
	const { service, calls } = probeService({ headers: { "x-api-status-code": "20000003" } });
	assert.equal((await service.testConnection()).ok, true);
	const payload = JSON.parse(calls[0].init.body);
	const wav = Buffer.from(payload.audio.data, "base64");
	assert.equal(wav.subarray(0, 4).toString(), "RIFF");
	assert.equal(wav.subarray(8, 12).toString(), "WAVE");
	assert.equal(wav.readUInt32LE(24), 16000, "采样率必须与渲染层编码器一致");
	assert.equal(wav.readUInt16LE(22), 1, "单声道");
	assert.equal(wav.readUInt16LE(34), 16);
	// data 块长度自洽：探针短到不占额度，又足够服务端解出一帧音频。
	assert.equal(wav.readUInt32LE(40), wav.length - 44);
	assert.ok(wav.length / 2 / 16000 < 1, "probe shorter than a second");
});

test("testConnection surfaces the upstream business code when the probe is rejected", async () => {
	const { service } = probeService({ headers: { "x-api-status-code": "45000001", "x-tt-logid": "log-9" } });
	const result = await service.testConnection();
	assert.equal(result.ok, false);
	assert.equal(result.error, "invalidRequest");
	assert.equal(result.detail.statusCode, "45000001");
	assert.equal(result.detail.logId, "log-9");
});

test("testConnection reports notConfigured without touching the network", async () => {
	const calls = [];
	const { service } = probeService({ credentials: null, calls });
	const result = await service.testConnection();
	assert.equal(result.ok, false);
	assert.equal(result.error, "notConfigured");
	assert.equal(calls.length, 0);
});

test("volc failures keep their detail through the transcription path", async () => {
	const { service } = probeService({ headers: { "x-api-status-code": "45000088", "x-api-message": "no permission" } });
	const result = await service.transcribe({ requestId: "volc-1", audio: new Uint8Array(44).buffer, mimeType: "audio/wav" });
	assert.equal(result.error, "http");
	assert.equal(result.detail.statusCode, "45000088");
	assert.equal(result.detail.message, "no permission");
});

test("the probe reuses the same engine routing: local failures are not silent successes", async () => {
	const localConfig = { ...cloudConfig, engine: "local" };
	const service = new VoiceTranscriptionService({
		getPublicConfig: async () => localConfig,
		getCredentials: async () => null,
		transcribeLocal: async () => ({ ok: false, error: "engineUnavailable" }),
		log: () => {},
	});
	const local = await service.testConnection();
	assert.equal(local.ok, false);
	assert.equal(local.error, "engineUnavailable");
});
