/**
 * Web 会话流（SSE）出口：把 AI SDK UIMessageStream 协议写到 HTTP 响应上。
 *
 * 从 WebServiceManager 按域迁出（Wave 6）。这里只做「响应侧」的机械工作——写头、
 * 心跳保活、断开清理、错误帧收口；事件来源与会话路由仍由 WebEventStreamRouter 负责，
 * 因此本模块不持有任何服务生命周期状态，可脱离 manager 单独测试。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { serializeSseFrame, type WebEventStreamRouter } from "./WebEventStream";

/**
 * 打开一条会话 SSE 连接：写协议头、注册到路由器、挂心跳与断开清理。
 *
 * keepAlive（外部 GET /stream）：onFinish 不结束响应，由路由器在一轮结束后换新翻译器保活。
 */
export function openSessionStream(eventStreamRouter: WebEventStreamRouter, sessionId: string, request: IncomingMessage, response: ServerResponse, options?: { keepAlive?: boolean }): void {
	// 写入 SSE 响应头；AI SDK 前端（useChat）靠 x-vercel-ai-ui-message-stream: v1 识别协议。
	response.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
		"access-control-allow-origin": "*",
		"x-vercel-ai-ui-message-stream": "v1",
	});
	response.flushHeaders?.();

	// 写出原始 wire 文本（帧或 [DONE]）；返回 false 表示连接已断开。
	const writeRaw = (wire: string): boolean => {
		if (response.writableEnded || response.destroyed) return false;
		try {
			response.write(wire);
			return true;
		} catch {
			return false;
		}
	};

	// 注册连接；onClose 在客户端断开/服务停止时被调，确保不再向失效 socket 写数据。
	const close = eventStreamRouter.add(
		sessionId,
		writeRaw,
		() => {
			if (!response.writableEnded) {
				try {
					response.end();
				} catch {
					// 已销毁的连接 end() 抛错可忽略
				}
			}
		},
		() => {
			if (!response.writableEnded) response.end();
		},
		options?.keepAlive ? { keepAlive: true } : undefined,
	);

	// 客户端断开（页面刷新/关闭）时清理；对已结束的请求忽略重复事件。
	const onClientClose = () => close();
	response.once("close", onClientClose);
	request.once("close", onClientClose);

	// 心跳：部分代理/浏览器会因空闲断开长连接；每 15s 发一个注释帧保持活跃。
	const heartbeat = setInterval(() => {
		if (response.writableEnded || response.destroyed) {
			clearInterval(heartbeat);
			close();
			return;
		}
		try {
			response.write(": ping\n\n");
		} catch {
			clearInterval(heartbeat);
			close();
		}
	}, 15_000);

	// 连接关闭时清理心跳与监听器。
	response.once("close", () => {
		clearInterval(heartbeat);
		response.removeListener("close", onClientClose);
		request.removeListener("close", onClientClose);
	});
}

/**
 * 向已打开的 SSE 响应写入 AI SDK 错误帧 + finish + [DONE]。
 * 用于 prompt 预检被拒时（useChat 收到 error 帧进入 error 状态）。
 */
export function writeSessionStreamError(response: ServerResponse, errorText: string): void {
	if (response.writableEnded || response.destroyed) return;
	try {
		response.write(serializeSseFrame({ type: "error", errorText }));
		response.write(serializeSseFrame({ type: "finish" }));
		response.end("data: [DONE]\n\n");
	} catch {
		// 连接已失效则忽略
	}
}
