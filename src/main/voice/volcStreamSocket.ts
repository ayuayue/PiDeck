import type { VolcStreamSocket } from "./VolcengineStreamSession";

/**
 * 用 Electron 主进程的全局 `WebSocket` 建立豆包流式识别的连接。
 *
 * 为什么不引 `ws`：主进程跑的 Node 24 已内建 undici WebSocket，而它和 Electron 的实现在
 * 构造参数里都接受 `headers`（火山这条协议的鉴权全在握手头里，没有自定义头就完全连不上）。
 * 少一个原生依赖，包体积与安装面都不变——这是本项目对依赖的默认取舍。
 */
type StreamSocketInit = { headers: Record<string, string> };

type StreamSocketEvent = { data?: unknown; code?: number };

type StreamSocketLike = {
	binaryType: string;
	close(): void;
	send(data: Uint8Array): void;
	addEventListener(type: string, listener: (event: StreamSocketEvent) => void): void;
};

/** 连接被对端关闭时的兜底关闭码（1006 = 异常断开，服务端正常收尾是 1000）。 */
const ABNORMAL_CLOSURE = 1006;

export function createVolcStreamSocket(url: string, headers: Record<string, string>): VolcStreamSocket {
	const socket = new (WebSocket as unknown as new (url: string, init: StreamSocketInit) => StreamSocketLike)(url, { headers });
	// 默认 blob：读一帧要异步 await，会话层拿不到字节。改成 arraybuffer 才能同步交给解码器。
	socket.binaryType = "arraybuffer";
	return {
		send(data) {
			socket.send(data);
		},
		close() {
			socket.close();
		},
		on(type, listener) {
			socket.addEventListener(type, (event) => listener(type === "close" ? (event.code ?? ABNORMAL_CLOSURE) : event.data));
		},
	};
}
