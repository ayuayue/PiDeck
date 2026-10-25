import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 豆包流式识别 2.0 的帧编解码是纯字节换算，也是整条通路里最容易「看着对、服务端解不了」的一段。
 * 下面钉住的每条都来自 2026-09-27 对真实服务端的逐字节探测（官方文档是 SPA 抓不到）：
 * 序号从 1 起、收尾包序号必须为负、下行 `result.text` 是整段累积文本。
 * 这三条任何一条改错，症状都是「录音没反应」而不是报错，所以必须由测试把住。
 */
// 同 createTsSandbox 的坑：vm 里的 Uint8Array 与宿主不是同一个构造器，
// 不注入的话 instanceof 分支永远走不到，测的就不是真实路径。
const realmGlobals = { globals: { Uint8Array, ArrayBuffer } };
const codec = loadTsCommonJs("src/main/voice/volcStreamProtocol.ts", realmGlobals);
const shared = loadTsCommonJs("src/shared/voiceTranscriptionConfig.ts");

const MESSAGE_FULL_CLIENT_REQUEST = 0b0001;
const MESSAGE_AUDIO_ONLY_REQUEST = 0b0010;
const MESSAGE_FULL_SERVER_RESPONSE = 0b1001;
const MESSAGE_SERVER_ACK = 0b1011;
const MESSAGE_SERVER_ERROR = 0b1111;
const FLAG_HAS_SEQUENCE = 0b0001;
const FLAG_LAST_PACKAGE = 0b0010;

function headerOf(packet) {
	return {
		messageType: packet[1] >> 4,
		flags: packet[1] & 0x0f,
		sequence: packet.readInt32BE(4),
		payloadSize: packet.readUInt32BE(8),
	};
}

test("整包（init）声明的是 16k 单声道裸 PCM，并打开标点与数规", () => {
	const packet = codec.encodeVolcStreamInit({ uid: "app-1", language: "zh" }, 1);
	const header = headerOf(packet);
	assert.equal(header.messageType, MESSAGE_FULL_CLIENT_REQUEST);
	assert.equal(header.flags, FLAG_HAS_SEQUENCE, "init 不带 LAST_PACKAGE，只带序号标志");
	assert.equal(header.sequence, 1, "首包序号是 1，不是 0");
	const body = JSON.parse(gunzipSync(packet.subarray(12, 12 + header.payloadSize)).toString("utf8"));
	assert.deepEqual({ uid: body.user.uid, ...body.audio }, { uid: "app-1", format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1, language: "zh-CN" });
	assert.equal(body.request.enable_punc, true, "标点默认关，口述正文没有标点");
	assert.equal(body.request.enable_itn, true);
	assert.equal(body.request.end_session, false, "一次会话允许多句，不能让服务端每句后关会话");
});

test("语言留空时不带 language 字段，由服务端判语种", () => {
	const packet = codec.encodeVolcStreamInit({ uid: "app-1", language: "  " }, 1);
	const body = JSON.parse(gunzipSync(packet.subarray(12)).toString("utf8"));
	assert.equal("language" in body.audio, false);
});

test("音频帧序号递增，收尾包同时置 LAST_PACKAGE 并把序号写成负数", () => {
	const pcm = Uint8Array.from([1, 2, 3, 4]);
	const plain = codec.encodeVolcStreamAudio(pcm, 2, false);
	assert.equal(headerOf(plain).messageType, MESSAGE_AUDIO_ONLY_REQUEST);
	assert.equal(headerOf(plain).flags, FLAG_HAS_SEQUENCE);
	assert.equal(headerOf(plain).sequence, 2);
	assert.deepEqual(Array.from(gunzipSync(plain.subarray(12))), [1, 2, 3, 4], "载荷是 gzip 后的裸 PCM，不含 WAV 头");

	const closing = codec.encodeVolcStreamAudio(pcm, 3, true);
	assert.equal(headerOf(closing).flags, FLAG_HAS_SEQUENCE | FLAG_LAST_PACKAGE);
	// 服务端实测：正数序号的收尾包会被判 `45000000 autoAssignedSequence (-3) mismatch sequence in request (3)`。
	assert.equal(headerOf(closing).sequence, -3);
});

/** 造一帧服务端下行数据，字节布局与官方协议一致。 */
function serverFrame(messageType, flags, sequence, body) {
	const payload = body ? gzipSync(Buffer.from(body, "utf8")) : Buffer.alloc(0);
	const head = Buffer.alloc(8);
	head.writeInt32BE(sequence, 0);
	head.writeUInt32BE(payload.length, 4);
	return Buffer.concat([Buffer.from([0x11, (messageType << 4) | flags, 0x11, 0x00]), head, payload]);
}

test("下行结果帧解出整段累积文本与 last 标志", () => {
	const packet = serverFrame(MESSAGE_FULL_SERVER_RESPONSE, FLAG_HAS_SEQUENCE | FLAG_LAST_PACKAGE, 4, JSON.stringify({ result: { text: "你好，世界。" } }));
	// 解码器在 vm 上下文里构造对象，跨 realm 不能 deepStrictEqual，逐字段比。
	assert.deepEqual({ ...codec.decodeVolcStreamPacket(packet) }, { kind: "result", sequence: 4, lastPackage: true, text: "你好，世界。" });
	// 没有 result.text 的帧（服务端只回 ACK 形状却带结果标志位）解成空文本，由会话层决定要不要丢弃。
	const noText = serverFrame(MESSAGE_FULL_SERVER_RESPONSE, FLAG_HAS_SEQUENCE, 5, JSON.stringify({ result: { audio_length: 100 } }));
	assert.equal(codec.decodeVolcStreamPacket(noText).text, "");
});

test("ACK 与错误帧各自解出，错误码与文案不被吞", () => {
	assert.deepEqual({ ...codec.decodeVolcStreamPacket(serverFrame(MESSAGE_SERVER_ACK, FLAG_HAS_SEQUENCE, 1, null)) }, { kind: "ack", sequence: 1 });
	// 错误帧里「载荷长度」那个字段位放的是业务码本身，正文再排在其后（协议如此，别当成解析器 bug）。
	const body = gzipSync(Buffer.from(JSON.stringify({ message: "resource not granted" }), "utf8"));
	const error = Buffer.alloc(16 + body.length);
	error[0] = 0x11;
	error[1] = (MESSAGE_SERVER_ERROR << 4) | FLAG_HAS_SEQUENCE;
	error[2] = 0x11;
	error.writeInt32BE(2, 4);
	error.writeUInt32BE(45000030, 8);
	error.writeUInt32BE(body.length, 12);
	body.copy(error, 16);
	assert.deepEqual({ ...codec.decodeVolcStreamPacket(error) }, { kind: "error", sequence: 2, errorCode: "45000030", errorMessage: "resource not granted" });
	const truncated = Buffer.from([0x11, (MESSAGE_SERVER_ERROR << 4) | FLAG_HAS_SEQUENCE, 0x11, 0x00, 0, 0, 0, 2]);
	assert.equal(codec.decodeVolcStreamPacket(truncated).kind, "unknown", "短到读不出错误码的帧不得抛错");
});

test("畸形帧一律收敛成 unknown，绝不抛出打断正在进行的录音", () => {
	for (const dirty of [new Uint8Array([0x11]), Buffer.alloc(0), Buffer.from([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 4, 1, 2, 3, 4]), serverFrame(0b0110, FLAG_HAS_SEQUENCE, 1, "{}")]) {
		const decoded = codec.decodeVolcStreamPacket(dirty);
		assert.equal(decoded.kind, "unknown", `脏数据必须收敛成 unknown：${String(decoded.kind)}`);
	}
	// 正文不是 JSON 的「结果帧」是形状正确但读不出字：解成空文本，让会话层继续跑而不是崩。
	const garbageResult = codec.decodeVolcStreamPacket(serverFrame(MESSAGE_FULL_SERVER_RESPONSE, FLAG_HAS_SEQUENCE, 1, "not json"));
	assert.equal(garbageResult.kind, "result");
	assert.equal(garbageResult.text, "");
	// 载荷长度字段谎报超大：按上限拒绝，而不是照着它分配内存。
	const lying = Buffer.concat([Buffer.from([0x11, (MESSAGE_FULL_SERVER_RESPONSE << 4) | FLAG_HAS_SEQUENCE, 0x11, 0x00]), Buffer.from([0, 0, 0, 1, 0, 0xff, 0xff, 0xff]), Buffer.alloc(4)]);
	assert.equal(codec.decodeVolcStreamPacket(lying).kind, "unknown");
});

test("上行帧长与共享层常量同口径（worklet 出帧字节数必须等于协议帧长）", () => {
	assert.equal(shared.VOICE_STREAM_FRAME_BYTES, ((shared.VOICE_STREAM_SAMPLE_RATE * shared.VOICE_STREAM_FRAME_MS) / 1000) * 2, "16bit 单声道：采样数 × 2 字节");
	assert.equal(shared.VOICE_STREAM_FRAME_BYTES, 6400);
	assert.equal(shared.VOLC_STREAM_ENDPOINT, "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel");
});
