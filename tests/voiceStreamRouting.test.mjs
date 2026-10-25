import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 流式通路的服务层路由测试：配置判据、开流/推帧/收尾/取消的接线，以及
 * 「整段转写在流式资源下不得偷打极速版端点」这条硬约束。
 *
 * 为什么单独立一个文件：这三件事的失败方式都是「静默走错路」——
 * 发到 flash 端点会换来 45000030「未开通」，用户只会去反复改密钥；
 * 采样率判据松掉则服务端按错误规格解码，听起来全是噪声。
 */
const realmGlobals = { globals: { Uint8Array, ArrayBuffer } };
const { VoiceTranscriptionService } = loadTsCommonJs("src/main/voice/VoiceTranscriptionService.ts", realmGlobals);
const shared = loadTsCommonJs("src/shared/voiceTranscriptionConfig.ts", realmGlobals);
const silentWav = loadTsCommonJs("src/main/voice/silentWav.ts", realmGlobals);

const FLASH_ENDPOINT = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";

function int32BE(value) {
	const buffer = Buffer.alloc(4);
	buffer.writeInt32BE(value, 0);
	return buffer;
}

function ackFrame(sequence) {
	return Buffer.concat([Buffer.from([0x11, (0b1011 << 4) | 0b0001, 0x11, 0x00]), int32BE(sequence), int32BE(0)]);
}

function resultFrame(text, sequence, last) {
	const body = gzipSync(Buffer.from(JSON.stringify({ result: { text } }), "utf8"));
	return Buffer.concat([Buffer.from([0x11, (0b1001 << 4) | 0b0001 | (last ? 0b0010 : 0), 0x11, 0x00]), int32BE(sequence), int32BE(body.length), body]);
}

/**
 * 会自动应答的 WebSocket 替身：init 包回 ACK，收尾包（带 LAST_PACKAGE 标志）回终值。
 * 应答排在微任务里，模拟真实服务端的异步回帧，也确保会话层注册完监听之后才触发。
 */
function createAutoSocketFactory(state) {
	return (_url, headers) => {
		const socket = {
			handlers: { open: [], message: [], error: [], close: [] },
			on: (type, listener) => socket.handlers[type].push(listener),
			send: (data) => {
				const packet = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
				state.sent.push(packet);
				const messageType = packet[1] >> 4;
				const sequence = packet.readInt32BE(4);
				if (messageType === 0b0001) queueMicrotask(() => socket.handlers.message.forEach((listener) => listener(ackFrame(sequence))));
				if (messageType === 0b0010 && (packet[1] & 0x0f) === 0b0011) {
					queueMicrotask(() => socket.handlers.message.forEach((listener) => listener(resultFrame(state.text, -sequence, true))));
				}
			},
			close: () => {
				state.closed += 1;
			},
		};
		state.sockets.push(socket);
		queueMicrotask(() => socket.handlers.open.forEach((listener) => listener(undefined)));
		return socket;
	};
}

function createService(config, options = {}) {
	const state = { sent: [], sockets: [], closed: 0, text: options.text ?? "開發完成了。", partials: [], fetchCalls: 0 };
	const service = new VoiceTranscriptionService({
		getPublicConfig: async () => ({ ...config }),
		getCredentials: async () => options.credentials ?? null,
		createStreamSocket: createAutoSocketFactory(state),
		emitStreamPartial: (partial) => state.partials.push({ ...partial }),
		fetch: async () => {
			state.fetchCalls += 1;
			return new Response(JSON.stringify({ result: { text: "极速版正文" } }), { status: 200 });
		},
		log: () => undefined,
	});
	return { service, state };
}

const STREAM_CONFIG = { engine: "cloud", cloudProvider: "volcengine", cloudResourceId: shared.VOLC_STREAM_RESOURCE_ID, language: "zh" };
const STREAM_CREDENTIALS = { provider: "volcengine", appId: "app-1", accessToken: "tok-1", resourceId: shared.VOLC_STREAM_RESOURCE_ID, language: "zh" };

test("只有云端豆包且资源判为流式才允许开流，其余一律 engineUnavailable", async () => {
	const cases = [
		{ config: { ...STREAM_CONFIG, cloudResourceId: shared.VOLC_FLASH_RESOURCE_ID }, credentials: STREAM_CREDENTIALS, label: "极速版资源" },
		{ config: { engine: "local", cloudProvider: "volcengine", cloudResourceId: shared.VOLC_STREAM_RESOURCE_ID, language: "zh" }, credentials: STREAM_CREDENTIALS, label: "本地引擎" },
		{ config: { engine: "cloud", cloudProvider: "openai", cloudResourceId: shared.VOLC_STREAM_RESOURCE_ID, language: "zh" }, credentials: { provider: "openai", apiKey: "sk-a" }, label: "OpenAI 兼容" },
	];
	for (const { config, credentials, label } of cases) {
		const { service, state } = createService(config, { credentials });
		assert.deepEqual({ ...(await service.startStream({ requestId: "req-1", sampleRate: 16000 })) }, { ok: false, error: "engineUnavailable" }, label);
		assert.equal(state.sockets.length, 0, `${label}：判据不通过时不得建立连接`);
	}
});

test("采样率不是 16k 直接拒：服务端按固定规格解码，没有协商余地", async () => {
	const { service, state } = createService(STREAM_CONFIG, { credentials: STREAM_CREDENTIALS });
	assert.deepEqual({ ...(await service.startStream({ requestId: "req-1", sampleRate: 48000 })) }, { ok: false, error: "invalidRequest" });
	assert.equal(state.sockets.length, 0);
});

test("开流 → 推帧 → 收尾：中间结果按 requestId 广播，终值走统一收口", async () => {
	const { service, state } = createService(STREAM_CONFIG, { credentials: STREAM_CREDENTIALS });
	assert.deepEqual({ ...(await service.startStream({ requestId: "req-1", sampleRate: 16000 })) }, { ok: true });
	// 主进程只吃 ArrayBuffer（IPC 结构化克隆的形态），渲染层推来的帧在此转成 PCM。
	service.pushStreamFrame({ requestId: "req-1", pcm: new Uint8Array(3200).fill(7).buffer });
	const finished = service.finishStream("req-1");
	assert.deepEqual({ ...(await finished) }, { ok: true, text: "开发完成了。" }, "流式终值要与其余引擎同一套收口（繁简转换在应用侧）");
	assert.equal(state.sockets.length, 1);
	assert.equal(state.closed, 1, "收尾必须断开连接，不能留常驻 WS");
	// 帧数 = init + 一帧音频 + 收尾包
	assert.equal(state.sent.length, 3);
	assert.equal(state.sent[1].readInt32BE(4), 2, "音频帧序号接在 init 之后");
	assert.ok(state.sent[2].readInt32BE(4) < 0, "收尾包序号为负");
});

test("未知 requestId 的帧与收尾都不会建会话，也不会抛错", async () => {
	const { service, state } = createService(STREAM_CONFIG, { credentials: STREAM_CREDENTIALS });
	service.pushStreamFrame({ requestId: "nope", pcm: new Uint8Array(4).buffer });
	service.pushStreamFrame({ requestId: "nope", pcm: "not-bytes" });
	assert.equal(state.sockets.length, 0);
	assert.deepEqual({ ...(await service.finishStream("nope")) }, { ok: false, error: "cancelled" });
});

test("取消会摘掉会话：迟到的收尾不会把已取消的录音算成成功", async () => {
	const { service, state } = createService(STREAM_CONFIG, { credentials: STREAM_CREDENTIALS });
	await service.startStream({ requestId: "req-1", sampleRate: 16000 });
	service.cancel("req-1");
	assert.equal(state.closed, 1);
	assert.deepEqual({ ...(await service.finishStream("req-1")) }, { ok: false, error: "cancelled" });
});

test("整段转写在流式资源下改走流式会话，绝不把流式资源 ID 发到极速版端点", async () => {
	const { service, state } = createService(STREAM_CONFIG, { credentials: STREAM_CREDENTIALS });
	// 渲染层在 provider=volcengine 时已把录音转成 16k 单声道 WAV；400ms 静音 = 12800 字节 PCM。
	const wav = silentWav.createSilentWav(400);
	const result = await service.transcribe({ requestId: "req-9", audio: wav, mimeType: "audio/wav" });
	assert.deepEqual({ ...result }, { ok: true, text: "开发完成了。" });
	assert.equal(state.fetchCalls, 0, "一次 HTTP 都不该发出去：流式资源打到 flash 端点只会换来 45000030");
	assert.equal(state.sockets.length, 1);
	// 帧数 = init + 两个整帧（12800 / 6400）+ 收尾包；RIFF 头必须被剥掉，否则首帧是噪声。
	assert.equal(state.sent.length, 4);
});

test("极速版资源仍走原来的 HTTP 通路，流式改动没有劫持它", async () => {
	const { service, state } = createService({ ...STREAM_CONFIG, cloudResourceId: shared.VOLC_FLASH_RESOURCE_ID }, { credentials: { ...STREAM_CREDENTIALS, resourceId: shared.VOLC_FLASH_RESOURCE_ID } });
	const result = await service.transcribe({ requestId: "req-10", audio: new Uint8Array([1, 2, 3, 4]).buffer, mimeType: "audio/wav" });
	assert.equal(result.ok, true);
	assert.equal(state.fetchCalls, 1);
	assert.equal(state.sockets.length, 0, "极速版不建 WebSocket");
});

test("流式配置下的连通性检测走流式探针，不用 WAV", async () => {
	const { service, state } = createService(STREAM_CONFIG, { credentials: STREAM_CREDENTIALS });
	const probed = await service.testConnection();
	assert.equal(probed.ok, true);
	assert.equal(state.sockets.length, 1, "检测应开一条流式会话探针");
	assert.equal(state.fetchCalls, 0);
});

test("探针失败时把服务端原始码带回设置页文案", async () => {
	const state = { sent: [], sockets: [], closed: 0, text: "", partials: [], fetchCalls: 0 };
	const service = new VoiceTranscriptionService({
		getPublicConfig: async () => ({ ...STREAM_CONFIG }),
		getCredentials: async () => ({ ...STREAM_CREDENTIALS }),
		createStreamSocket: (_url, headers) => {
			state.headers = headers;
			return {
				on: (type, listener) => {
					if (type === "error") queueMicrotask(() => listener(undefined));
				},
				send: () => undefined,
				close: () => {
					state.closed += 1;
				},
			};
		},
		log: () => undefined,
	});
	const probed = await service.testConnection();
	assert.equal(probed.ok, false);
	assert.equal(probed.error, "network");
});
