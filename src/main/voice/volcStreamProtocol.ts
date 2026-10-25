import { gunzipSync, gzipSync } from "node:zlib";
import { normalizeVolcLanguageTag, VOICE_STREAM_SAMPLE_RATE } from "../../shared/voiceTranscriptionConfig";

/**
 * 豆包「流式语音识别模型 2.0」的 WebSocket 二进制帧编解码。
 *
 * 这条协议不是 protobuf 也不是 JSON-over-WS，而是火山自家的一套 4 字节头 + 可选序号 +
 * 4 字节长度 + gzip 载荷的自定义帧（与官方 arkitect 客户端、多家第三方实现字节一致）。
 * 本文件只做**纯字节**换算，不碰网络，便于单测；会话生命周期在 VolcengineStreamSession。
 *
 * 下面三条是 2026-09-27 拿真实服务端逐字节实测出来的，文档抓不到（SPA），别再猜：
 * 1. 每个上行包的 `sequence` 从 1 起单调递增（整包=1，之后每帧 +1），服务端回帧带同一个序号；
 * 2. **收尾包**除了把 flags 置上 `FLAG_LAST_PACKAGE`，序号还必须写成**负数**（`-seq`）；
 *    写成正数会得到错误帧 `45000000 autoAssignedSequence (-4) mismatch sequence in request (4)`；
 * 3. 服务端每帧回的 `result.text` 是**整段会话的累积文本**（不是增量），而且会回头修正
 *    已下发部分的标点 —— 所以消费方要整段替换，不能逐次追加。
 */
const PROTOCOL_VERSION = 0b0001;
/** 头部长度字段以 4 字节为单位：1 = 一个 4 字节头，无扩展头。 */
const HEADER_WORDS = 0b0001;

const MESSAGE_FULL_CLIENT_REQUEST = 0b0001;
const MESSAGE_AUDIO_ONLY_REQUEST = 0b0010;
const MESSAGE_FULL_SERVER_RESPONSE = 0b1001;
const MESSAGE_SERVER_ACK = 0b1011;
const MESSAGE_SERVER_ERROR = 0b1111;

const FLAG_HAS_SEQUENCE = 0b0001;
const FLAG_LAST_PACKAGE = 0b0010;

const SERIALIZATION_JSON = 0b0001;
const COMPRESSION_GZIP = 0b0001;
const COMPRESSION_NONE = 0b0000;

/** 服务端帧的载荷上限：正常结果几百字节，超界即脏数据（防止按长度字段分配大内存）。 */
const MAX_PACKET_PAYLOAD_BYTES = 4 * 1024 * 1024;
/** 识别输出上限，与极速版/本地引擎同一口径。 */
const MAX_TEXT_LENGTH = 100_000;
/** 单帧服务端文案上限（错误详情会进日志与检测文案）。 */
const MAX_ERROR_MESSAGE_LENGTH = 500;

/** 会话握手后第一包的 `request` 字段：标点与数字规范化必须开，否则口述正文没有标点。 */
export type VolcStreamInitOptions = {
	/** App ID 参与日志关联；官方 demo 直接把它当 uid 用。 */
	uid: string;
	/** 用户在设置里填的语言（whisper 习惯的 ISO-639-1）；空 = 不传，由服务端判语种。 */
	language: string;
};

/** 整包（full client request）：JSON + gzip，带序号 1。 */
export function encodeVolcStreamInit(options: VolcStreamInitOptions, sequence: number): Buffer {
	const language = normalizeVolcLanguageTag(options.language);
	const payload = {
		user: { uid: options.uid },
		// 上行只吃裸 PCM（format=pcm + codec=raw）：边录边推不可能等整段 WAV 编码完。
		audio: { format: "pcm", codec: "raw", rate: VOICE_STREAM_SAMPLE_RATE, bits: 16, channel: 1, ...(language ? { language } : {}) },
		request: {
			model_name: "bigmodel",
			enable_itn: true,
			enable_punc: true,
			// end_session=false：一次会话内允许多句，标点由服务端按语义补。
			end_session: false,
		},
	};
	return frame(MESSAGE_FULL_CLIENT_REQUEST, FLAG_HAS_SEQUENCE, sequence, gzipSync(Buffer.from(JSON.stringify(payload), "utf8")));
}

/**
 * 音频帧。`last=true` 即收尾包：flags 带 LAST_PACKAGE，且序号取负（见文件头第 2 条实测结论）。
 * 载荷仍是 gzip 后的裸 PCM；空 PCM 也合法（纯收尾时用）。
 */
export function encodeVolcStreamAudio(pcm: Uint8Array, sequence: number, last: boolean): Buffer {
	const flags = FLAG_HAS_SEQUENCE | (last ? FLAG_LAST_PACKAGE : 0);
	return frame(MESSAGE_AUDIO_ONLY_REQUEST, flags, last ? -sequence : sequence, gzipSync(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)));
}

function frame(messageType: number, flags: number, sequence: number, body: Buffer): Buffer {
	const header = Buffer.from([(PROTOCOL_VERSION << 4) | HEADER_WORDS, (messageType << 4) | flags, (SERIALIZATION_JSON << 4) | COMPRESSION_GZIP, 0x00]);
	const head = Buffer.alloc(8);
	// 序号按有符号写入：收尾包的负数序号就是靠这里传出去的。
	head.writeInt32BE(sequence, 0);
	head.writeUInt32BE(body.length, 4);
	return Buffer.concat([header, head, body]);
}

/** 服务端帧的解析结果；未识别的消息类型只回报类型号，由会话层决定忽略还是失败。 */
export type VolcStreamPacket = { kind: "result"; sequence: number; lastPackage: boolean; text: string } | { kind: "ack"; sequence: number } | { kind: "error"; sequence: number; errorCode: string; errorMessage: string } | { kind: "unknown"; messageType: number };

/**
 * 解一帧服务端数据。任何越界/解压/JSON 失败都收敛成 `unknown`，绝不抛出去——
 * 录音正在跑时一个畸形帧不该让整个会话崩掉（真正致命的错误服务端会自己回 error 帧）。
 */
export function decodeVolcStreamPacket(data: ArrayBuffer | Uint8Array): VolcStreamPacket {
	try {
		const source = data instanceof Uint8Array ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data);
		if (source.length < 4) return { kind: "unknown", messageType: -1 };
		const headerWords = source[0] & 0x0f;
		const messageType = source[1] >> 4;
		const flags = source[1] & 0x0f;
		const compression = source[2] & 0x0f;
		let offset = headerWords * 4;
		if (offset > source.length) return { kind: "unknown", messageType };
		const hasSequence = (flags & FLAG_HAS_SEQUENCE) !== 0;
		const lastPackage = (flags & FLAG_LAST_PACKAGE) !== 0;
		const sequence = hasSequence ? source.readInt32BE(offset) : 0;
		if (hasSequence) offset += 4;

		if (messageType === MESSAGE_SERVER_ERROR) {
			const errorCode = String(source.readUInt32BE(offset));
			const body = readBody(source, offset + 4, compression);
			return { kind: "error", sequence, errorCode, errorMessage: extractErrorMessage(body) };
		}
		if (messageType === MESSAGE_SERVER_ACK) {
			return { kind: "ack", sequence };
		}
		if (messageType === MESSAGE_FULL_SERVER_RESPONSE) {
			const body = readBody(source, offset, compression);
			return { kind: "result", sequence, lastPackage, text: extractResultText(body) };
		}
		return { kind: "unknown", messageType };
	} catch {
		return { kind: "unknown", messageType: -2 };
	}
}

/** 长度字段 + 载荷；超出上限或长度不合法直接抛给上层 catch 收敛成 unknown。 */
function readBody(source: Buffer, offset: number, compression: number): Buffer {
	if (offset + 4 > source.length) throw new Error("short header");
	const size = source.readUInt32BE(offset);
	if (size > MAX_PACKET_PAYLOAD_BYTES || offset + 4 + size > source.length) throw new Error("bad payload size");
	const body = source.subarray(offset + 4, offset + 4 + size);
	return compression === COMPRESSION_GZIP ? gunzipSync(body) : compression === COMPRESSION_NONE ? body : Buffer.alloc(0);
}

/** `{result:{text}}`；读不出该字段时解成空文本，由会话层决定丢弃而不是崩。 */
function extractResultText(body: Buffer): string {
	const text = stringValue(objectValue(parseJson(body), "result"), "text");
	return text && text.length <= MAX_TEXT_LENGTH ? text : "";
}

/** 错误帧正文可能是 `{message}`、`{error}` 或整个对象，取首个可读字段。 */
function extractErrorMessage(body: Buffer): string {
	const parsed = parseJson(body);
	const message = stringValue(parsed, "message") || stringValue(objectValue(parsed, "error"), "message") || stringValue(parsed, "error") || stringValue(parsed, "reason");
	return (message ?? JSON.stringify(parsed ?? {})).slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function parseJson(body: Buffer): unknown {
	if (!body.length) return null;
	try {
		return JSON.parse(body.toString("utf8"));
	} catch {
		return null;
	}
}

function objectValue(value: unknown, key: string): unknown {
	return value && typeof value === "object" ? Reflect.get(value as Record<string, unknown>, key) : undefined;
}

function stringValue(value: unknown, key: string): string {
	const raw = objectValue(value, key);
	return typeof raw === "string" ? raw : "";
}
