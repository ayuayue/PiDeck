import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { connect as netConnect } from "node:net";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadWebServiceManager() {
	return loadTsCommonJs("src/main/web/WebServiceManager.ts", {
		// VM 沙箱默认没有 fetch（Node 18+ 全局），dev 代理与回退测试需要它
		globals: {
			fetch: globalThis.fetch,
			Response: globalThis.Response,
			ReadableStream: globalThis.ReadableStream,
		},
	}).WebServiceManager;
}

const minimalDeps = (devRendererUrl) => ({
	devRendererUrl,
	subscribePiEvents: () => () => undefined,
	getSessionIdForAgent: () => undefined,
});

// 模拟 vite dev server：接受 upgrade 后永远保持连接（HMR socket 的真实行为——不主动断）。
// 自己也要追踪 upgrade socket：Node http server 对 upgrade 后的 socket 同样不做生命周期追踪，
// 收尾不手动销毁的话 server.close() 也会挂起（与被测对象同一个坑）。
function startFakeVite() {
	const sockets = new Set();
	const server = createHttpServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<html></html>");
	});
	server.on("upgrade", (_req, socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () =>
			resolve({
				server,
				port: server.address().port,
				close: () =>
					new Promise((resolveClose) => {
						for (const socket of sockets) socket.destroy();
						server.close(() => resolveClose());
					}),
			}),
		);
	});
}

// 经 web 服务发一条 WebSocket upgrade 握手，返回已建立 101 的裸 socket（模拟浏览器 HMR 连接）。
function openUpgradeSocket(port) {
	return new Promise((resolve, reject) => {
		const socket = netConnect(port, "127.0.0.1");
		let buffer = Buffer.alloc(0);
		socket.on("connect", () => {
			socket.write(["GET / HTTP/1.1", "Host: 127.0.0.1", "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "\r\n"].join("\r\n"));
		});
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.includes("\r\n\r\n")) resolve(socket);
		});
		socket.on("error", reject);
	});
}

// 回归：dev 模式下浏览器挂着 HMR WebSocket 时，设置页切换 Web 服务开关调用的 stop()
// 曾永久挂起——upgrade 劫持 socket 不被 server.closeAllConnections() 追踪，close 回调不触发。
test("web service stop() closes hijacked HMR upgrade sockets and resolves promptly", async () => {
	const WebServiceManager = loadWebServiceManager();
	const vite = await startFakeVite();
	const manager = new WebServiceManager(minimalDeps(`http://127.0.0.1:${vite.port}`));
	await manager.start("127.0.0.1", 0, false);
	const port = manager.current.port;

	const socket = await openUpgradeSocket(port);
	const socketClosed = new Promise((resolve) => socket.on("close", resolve));

	const startedAt = Date.now();
	await manager.stop();
	const elapsed = Date.now() - startedAt;

	// ① stop 必须销毁被劫持的 socket（追踪生效的直接证据）。
	await socketClosed;
	// ② 且应远快于 1500ms 超时兜底——走到兜底说明追踪漏了，只是没卡死。
	assert.ok(elapsed < 1000, `stop() should resolve via socket tracking, took ${elapsed}ms`);

	await vite.close();
});

// 无升级连接时 stop() 仍是毫秒级（守护正常路径不被超时兜底拖慢）。
test("web service stop() without upgrade sockets stays fast", async () => {
	const WebServiceManager = loadWebServiceManager();
	const vite = await startFakeVite();
	const manager = new WebServiceManager(minimalDeps(`http://127.0.0.1:${vite.port}`));
	await manager.start("127.0.0.1", 0, false);

	const startedAt = Date.now();
	await manager.stop();
	assert.ok(Date.now() - startedAt < 1000, `stop() without connections should be instant`);

	await vite.close();
});
