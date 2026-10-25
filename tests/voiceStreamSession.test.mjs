import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 流式会话（VolcengineStreamSession）的生命周期测试：WebSocket 用替身，不碰网络。
 *
 * 这里钉住的是「只有真机才会暴露」的四类问题：
 * 1. init 包没被 ACK 之前不能先发音频（服务端按收到顺序解析，音频抢先 = 协议错误）；
 * 2. 收尾包只能发一次（第二个收尾包服务端回错误帧，用户看到的是「每次停录必失败」）；
 * 3. 结果帧可能在 send 的同一轮里同步到达，等待必须先建好；
 * 4. 取消/超时/超限都必须有终局，不能留一条常驻 WebSocket 占住会话。
 */
// vm 上下文有自己一套内置对象，跨 realm 的 instanceof 恒 false：会话里那道
// 「帧字节必须是 Uint8Array/ArrayBuffer」的守卫会把测试发来的帧整个丢掉。注入宿主构造器。
const realmGlobals = { globals: { Uint8Array, ArrayBuffer } };
const { VolcengineStreamSession } = loadTsCommonJs("src/main/voice/VolcengineStreamSession.ts", realmGlobals);

const CREDENTIALS = { appId: "app-1", accessToken: "tok-1", resourceId: "volc.bigasr.sauc.duration", language: "zh" };
const ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
const MESSAGE_INIT = 0b0001;
const MESSAGE_AUDIO = 0b0010;

function int32BE(value) {
	const buffer = Buffer.alloc(4);
	buffer.writeInt32BE(value, 0);
	return buffer;
}

/** 造一帧服务端下行的结果帧（载荷是 gzip JSON，与真实服务端一致）。 */
function resultFrame(text, { sequence = 2, last = false } = {}) {
	const body = gzipSync(Buffer.from(JSON.stringify({ result: { text } }), "utf8"));
	return Buffer.concat([Buffer.from([0x11, (0b1001 << 4) | 0b0001 | (last ? 0b0010 : 0), 0x11, 0x00]), int32BE(sequence), int32BE(body.length), body]);
}

function ackFrame({ sequence = 1 } = {}) {
	return Buffer.concat([Buffer.from([0x11, (0b1011 << 4) | 0b0001, 0x11, 0x00]), int32BE(sequence), int32BE(0)]);
}

function errorFrame(code, message, { sequence = 0 } = {}) {
	const body = gzipSync(Buffer.from(JSON.stringify({ message }), "utf8"));
	return Buffer.concat([Buffer.from([0x11, (0b1111 << 4) | 0b0001, 0x11, 0x00]), int32BE(sequence), int32BE(code), int32BE(body.length), body]);
}

/** WebSocket 替身：记录上行字节，由测试手动触发下行事件。 */
function createFakeSocket() {
	const sent = [];
	const handlers = { open: [], message: [], error: [], close: [] };
	const socket = {
		sent,
		closed: false,
		on: (type, listener) => handlers[type].push(listener),
		send: (data) => sent.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
		// teardown 已结算过等待方，这里只记录「连接被关闭」，不回调 close 事件（那是网络侧的事）。
		close: () => {
			socket.closed = true;
		},
		emit(type, value) {
			for (const listener of [...handlers[type]]) listener(value);
		},
	};
	return socket;
}

function createSession(overrides = {}) {
	const partials = [];
	const sockets = [];
	const session = new VolcengineStreamSession(
		{
			createSocket: (url, headers) => {
				const socket = createFakeSocket();
				socket.url = url;
				socket.headers = headers;
				sockets.push(socket);
				return socket;
			},
			onPartial: (text, final) => partials.push({ text, final }),
			log: () => undefined,
			...overrides,
		},
		CREDENTIALS,
		ENDPOINT,
	);
	return { session, sockets, partials };
}

/** 走完握手：连接建立 → 服务端 ACK。 */
function handshake(socket) {
	socket.emit("open", undefined);
	socket.emit("message", ackFrame({ sequence: 1 }));
}

test("握手成功才回 ok，鉴权头与资源 ID 挂在升级请求上，首包序号为 1", async () => {
	const { session, sockets } = createSession();
	const started = session.open();
	const socket = sockets[0];
	assert.equal(socket.url, ENDPOINT);
	assert.equal(socket.headers["X-Api-App-Key"], "app-1");
	assert.equal(socket.headers["X-Api-Access-Key"], "tok-1");
	assert.equal(socket.headers["X-Api-Resource-Id"], "volc.bigasr.sauc.duration");
	assert.match(socket.headers["X-Api-Request-Id"], /^[0-9a-f-]{36}$/);
	handshake(socket);
	assert.deepEqual({ ...(await started) }, { ok: true });
	const init = socket.sent[0];
	assert.equal(init[1] >> 4, MESSAGE_INIT, "连接建立后第一个上行包必须是整包");
	assert.equal(init.readInt32BE(4), 1, "序号从 1 起，不是 0");
});

test("没有 Access Token 时用新版单密钥头", async () => {
	const partials = [];
	const sockets = [];
	const session = new VolcengineStreamSession(
		{
			createSocket: (_url, headers) => {
				const socket = createFakeSocket();
				socket.headers = headers;
				sockets.push(socket);
				return socket;
			},
			onPartial: (text, final) => partials.push({ text, final }),
			log: () => undefined,
		},
		{ ...CREDENTIALS, accessToken: "", appId: "key-1" },
		ENDPOINT,
	);
	const started = session.open();
	handshake(sockets[0]);
	await started;
	assert.equal(sockets[0].headers["X-Api-Key"], "key-1");
	assert.equal("X-Api-App-Key" in sockets[0].headers, false);
});

test("握手期失败立刻结算开流，不让设置页等满超时", async () => {
	const { session, sockets } = createSession();
	const started = session.open();
	sockets[0].emit("error", undefined);
	assert.deepEqual({ ...(await started) }, { ok: false, error: "network" });
});

test("服务端错误帧按业务码分类：45000030 是「没开通」不是「Key 无效」", async () => {
	const { session, sockets } = createSession();
	const started = session.open();
	const socket = sockets[0];
	socket.emit("open", undefined);
	socket.emit("message", errorFrame(45000030, "requested resource not granted"));
	const result = await started;
	assert.equal(result.ok, false);
	assert.equal(result.error, "notGranted", "误报成凭据错误会让用户反复改密钥，而该做的开通没人提示");
	assert.equal(result.detail.statusCode, "45000030");
});

test("ACK 之前推的音频帧排队补发，init 恒在最前且序号连续", async () => {
	const { session, sockets } = createSession();
	const started = session.open();
	const socket = sockets[0];
	assert.equal(session.push(new Uint8Array([1, 2, 3, 4])), true);
	socket.emit("open", undefined);
	assert.equal(session.push(new Uint8Array([5, 6])), true);
	socket.emit("message", ackFrame({ sequence: 1 }));
	await started;
	assert.deepEqual(
		socket.sent.map((packet) => packet[1] >> 4),
		[MESSAGE_INIT, MESSAGE_AUDIO, MESSAGE_AUDIO],
		"握手未完成时不得把音频排到 init 前面",
	);
	assert.deepEqual(
		socket.sent.map((packet) => packet.readInt32BE(4)),
		[1, 2, 3],
	);
});

test("中间结果整段上抛，final 只在收尾时给一次", async () => {
	const { session, sockets, partials } = createSession();
	const started = session.open();
	const socket = sockets[0];
	handshake(socket);
	await started;
	session.push(new Uint8Array([1, 2]));
	socket.emit("message", resultFrame("你好", { sequence: 2 }));
	socket.emit("message", resultFrame("你好，世界", { sequence: 3 }));
	// 服务端每帧回的是整段累积文本（还会改标点），所以渲染层拿到的必须是全量而不是增量。
	assert.deepEqual(
		partials.map((partial) => ({ ...partial })),
		[
			{ text: "你好", final: false },
			{ text: "你好，世界", final: false },
		],
	);
});

test("finish 幂等：只发一个收尾包，且收尾包序号为负", async () => {
	const { session, sockets, partials } = createSession();
	const started = session.open();
	const socket = sockets[0];
	handshake(socket);
	await started;
	session.push(new Uint8Array([1, 2]));
	socket.emit("message", resultFrame("半句", { sequence: 2 }));
	const first = session.finish();
	assert.equal(session.finish(), first, "重复 finish 必须复用同一次等待，否则第二个收尾包会被服务端判错");
	const audio = socket.sent.filter((packet) => packet[1] >> 4 === MESSAGE_AUDIO);
	assert.equal(audio.length, 2, "一帧音频 + 一个收尾包");
	const closing = audio[1];
	assert.equal(closing[1] & 0x0f, 0b0011, "收尾包要同时带序号与 LAST_PACKAGE 标志");
	assert.equal(closing.readInt32BE(4), -3, "收尾包序号必须为负（服务端实测：正数回 45000000 mismatch）");

	socket.emit("message", resultFrame("半句。", { sequence: 4, last: true }));
	assert.deepEqual({ ...(await first) }, { ok: true, text: "半句。" });
	assert.deepEqual(
		partials.map((partial) => ({ ...partial })),
		[
			{ text: "半句", final: false },
			{ text: "半句。", final: true },
		],
	);
});

test("握手期间就停录：等 ACK 补发积压后再收尾", async () => {
	const { session, sockets } = createSession();
	const started = session.open();
	const socket = sockets[0];
	session.push(new Uint8Array([1, 2]));
	const finished = session.finish();
	socket.emit("open", undefined);
	socket.emit("message", ackFrame({ sequence: 1 }));
	await started;
	assert.deepEqual(
		socket.sent.map((packet) => packet[1] >> 4),
		[MESSAGE_INIT, MESSAGE_AUDIO, MESSAGE_AUDIO],
		"顺序必须是 init → 音频 → 收尾",
	);
	socket.emit("message", resultFrame("收尾了", { sequence: 4, last: true }));
	assert.deepEqual({ ...(await finished) }, { ok: true, text: "收尾了" });
});

test("全程静音：无文本收尾按 empty，而不是谎报成功", async () => {
	const { session, sockets } = createSession();
	const started = session.open();
	const socket = sockets[0];
	handshake(socket);
	await started;
	session.push(new Uint8Array([1, 2]));
	const finished = session.finish();
	socket.emit("message", resultFrame("", { sequence: 3, last: true }));
	const result = await finished;
	assert.equal(result.ok, false);
	assert.equal(result.error, "empty");
});

test("收尾超时但已有中间文本：按已识别内容收口并断开连接", async () => {
	const { session, sockets, partials } = createSession({ finishTimeoutMs: 5 });
	const started = session.open();
	const socket = sockets[0];
	handshake(socket);
	await started;
	session.push(new Uint8Array([1, 2]));
	socket.emit("message", resultFrame("已经上屏的字", { sequence: 2 }));
	const result = await session.finish();
	assert.equal(result.ok, true, "用户说过的话不该跟着超时一起丢");
	assert.equal(result.text, "已经上屏的字");
	assert.equal(partials.filter((partial) => partial.final).length, 1, "终文本只推一次");
	assert.equal(socket.closed, true, "超时后必须断开，不能留一条常驻 WebSocket");
});

test("取消后不再上抛中间结果，也不回结果", async () => {
	const { session, sockets, partials } = createSession();
	const started = session.open();
	const socket = sockets[0];
	handshake(socket);
	await started;
	session.push(new Uint8Array([1, 2]));
	session.cancel();
	socket.emit("message", resultFrame("不该出现", { sequence: 2 }));
	assert.equal(partials.length, 0);
	assert.equal(socket.closed, true);
	assert.deepEqual({ ...(await session.finish()) }, { ok: false, error: "cancelled" });
});

test("连接中途断开：已识别的文本仍然交付", async () => {
	const { session, sockets } = createSession();
	const started = session.open();
	const socket = sockets[0];
	handshake(socket);
	await started;
	session.push(new Uint8Array([1, 2]));
	socket.emit("message", resultFrame("说到一半", { sequence: 2 }));
	const finished = session.finish();
	socket.emit("close", 1006);
	assert.deepEqual({ ...(await finished) }, { ok: true, text: "说到一半" });
});

test("没拿到任何文本就异常断开，按 network 失败而不是静默成功", async () => {
	const { session, sockets } = createSession();
	const started = session.open();
	const socket = sockets[0];
	handshake(socket);
	await started;
	const finished = session.finish();
	socket.emit("close", 1006);
	assert.deepEqual({ ...(await finished) }, { ok: false, error: "network" });
});

test("超过帧数上限时止损收口，后续 push 回 false", async () => {
	const { session, sockets, partials } = createSession();
	const started = session.open();
	const socket = sockets[0];
	handshake(socket);
	await started;
	socket.emit("message", resultFrame("说了很久", { sequence: 1 }));
	let accepted = true;
	for (let index = 0; index < 9001 && (accepted = session.push(new Uint8Array([index % 256]))); index += 1) continue;
	assert.equal(accepted, false, "超限后 push 必须回 false，调用方据此停止送数据");
	assert.equal(partials.at(-1).final, true, "把已识别的字作为终值交回");
	assert.deepEqual({ ...(await session.finish()) }, { ok: true, text: "说了很久" });
});
