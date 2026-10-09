import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { AcpIncomingRequest, AcpJsonRpcMessage, AcpRpcNotification, AcpRpcRequest } from "./acpProtocol";

/** JSON-RPC 调用被 agent 拒绝（响应带 error 对象）。 */
export class AcpRpcError extends Error {
	constructor(
		message: string,
		readonly code: number,
		readonly data?: unknown,
	) {
		super(`ACP RPC error ${code}: ${message}`);
		this.name = "AcpRpcError";
	}
}

/** handler 返回本哨兵时连接层不自动 respond（请求将由调用方经 respond() 异步应答）。 */
export const ACP_DEFER_RESPONSE: unique symbol = Symbol("ACP_DEFER_RESPONSE");

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

/** agent → client 请求的处理器注册；返回值作为 result，抛错按 JSON-RPC error 回给 agent。
 *  rpcId 供需要延迟应答的请求（如 permission/request 的异步审批）直接 respond。 */
export type AcpRequestHandler = (params: Record<string, unknown> | undefined, rpcId: number) => Promise<unknown> | unknown;

/**
 * 超过该长度的 NDJSON 行延后到 setImmediate 再 JSON.parse（与 PiRpcClient 同因：
 * 大响应不该堵住主进程事件循环）。数值对齐 PiRpcClient 便于统一心智。
 */
export const LARGE_ACP_LINE_PARSE_CHARS = 256 * 1024;

/** 单行缓冲硬上限：无 LF 的失控输出会让行缓冲无界增长（对齐 PiRpcClient）。 */
export const MAX_ACP_LINE_BYTES = 8 * 1024 * 1024;

const JSON_RPC_INTERNAL_ERROR = -32603;

/**
 * ACP stdio transport：NDJSON 上的 JSON-RPC 2.0 双向连接。
 *
 * 与 PiRpcClient 的差异：JSON-RPC 标准信封（method/result/error 字段），
 * 且双向——agent 也会向 client 发请求（permission/request 等），
 * 这类请求经 handleRequest 注册的处理器应答。
 *
 * 行缓冲护栏与大行延迟解析沿用 PiRpcClient 的实测结论（见该类注释）。
 */
export class AcpConnection extends EventEmitter {
	private buffer = "";
	private nextRequestId = 1;
	private readonly decoder = new StringDecoder("utf8");
	private readonly pending = new Map<number, PendingRequest>();
	private readonly requestHandlers = new Map<string, AcpRequestHandler>();
	private parseQueue: Promise<void> = Promise.resolve();
	private closed = false;
	private closeReason: Error | null = null;

	constructor(
		private readonly stdin: NodeJS.WritableStream,
		stdout: NodeJS.ReadableStream,
	) {
		super();
		// 断管兑底（同 PiRpcClient）：agent 死亡与 close() 之间的异步窗口里，
		// 并发 write 会打到断管道上（POSIX 报 EPIPE、Windows 报 EOF），未监听的
		// stdin error 会炸主进程；请求结账由 pending 超时与 close() 负责。
		this.stdin.on("error", () => {});
		stdout.on("data", (chunk) => this.consumeChunk(chunk));
		stdout.on("end", () => this.consumeEnd());
		stdout.on("error", (error) => this.close(error));
	}

	/** agent → client 请求分发注册。同名方法重复注册以后注册者为准（会话级覆盖）。 */
	handleRequest(method: string, handler: AcpRequestHandler): void {
		this.requestHandlers.set(method, handler);
	}

	handleRequestDisappear(method: string): void {
		this.requestHandlers.delete(method);
	}

	/** client → agent 请求；agent 返回 error 时 reject AcpRpcError。 */
	request(method: string, params?: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(this.closeReason ? new Error(`${this.closeReason.message} (ACP request not sent: ${method})`) : new Error(`ACP connection closed: ${method}`));
		}
		const id = this.nextRequestId++;
		const payload: AcpRpcRequest = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };

		const promise = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`ACP request timed out after ${timeoutMs}ms: ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
		});

		this.write(payload);
		return promise;
	}

	/** client → agent 通知（fire-and-forget）。 */
	notify(method: string, params?: Record<string, unknown>): void {
		if (this.closed) return;
		const payload: AcpRpcNotification = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
		this.write(payload);
	}

	/** agent → client 请求的直接应答通道（供连接层之外的审批应答使用）。 */
	respond(id: number, result: unknown): void {
		if (this.closed) return;
		this.write({ jsonrpc: "2.0", id, result } as Record<string, unknown>);
	}

	respondError(id: number, code: number, message: string): void {
		if (this.closed) return;
		this.write({ jsonrpc: "2.0", id, error: { code, message } } as Record<string, unknown>);
	}

	close(error?: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.closeReason = error ?? null;
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error ?? new Error("ACP connection closed before response"));
		}
		this.pending.clear();
		this.emit("closed", error ?? null);
	}

	isClosed(): boolean {
		return this.closed;
	}

	private write(payload: Record<string, unknown>): void {
		if (this.closed) return;
		this.emit("log", { direction: "send", data: payload });
		this.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	private consumeChunk(chunk: Buffer | string): void {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		if (this.buffer.length > MAX_ACP_LINE_BYTES) {
			const droppedBytes = this.buffer.length;
			this.buffer = "";
			this.emit("protocol-error", `ACP line buffer overflow: dropped ${droppedBytes} bytes without newline`);
			return;
		}
		this.drainLines();
	}

	private consumeEnd(): void {
		this.buffer += this.decoder.end();
		if (this.buffer.length > 0) {
			this.handleLine(this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer);
			this.buffer = "";
		}
		// stdout 结束 = agent 进程退出/关管道：必须收口连接，否则挂起请求
		// 只能等各自超时（真实场景：CLI 崩溃后 session/prompt 吊到 60s）。
		this.close(new Error("ACP agent stdout ended"));
	}

	private drainLines(): void {
		while (true) {
			const newlineIndex = this.buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			let line = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		if (line.length > LARGE_ACP_LINE_PARSE_CHARS) {
			this.parseQueue = this.parseQueue.then(
				() =>
					new Promise<void>((resolve) => {
						setImmediate(() => {
							this.dispatchLine(line);
							resolve();
						});
					}),
			);
			return;
		}
		this.dispatchLine(line);
	}

	private dispatchLine(line: string): void {
		let message: AcpJsonRpcMessage;
		try {
			message = JSON.parse(line) as AcpJsonRpcMessage;
		} catch {
			// stdout 混入非 JSON 输出（CLI banner、调试日志）：保留原文上抛，由上层决定是否致命。
			this.emit("protocol-error", line);
			return;
		}
		this.emit("log", { direction: "recv", data: message });

		if (!message || typeof message !== "object" || !("jsonrpc" in message)) return;

		// 响应（有 id 无 method）：结算 pending。
		if (!("method" in message)) {
			const id = typeof (message as { id?: unknown }).id === "number" ? ((message as { id: number }).id as number) : null;
			if (id === null) return;
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			clearTimeout(pending.timer);
			const error = (message as { error?: { code: number; message: string; data?: unknown } }).error;
			if (error) pending.reject(new AcpRpcError(error.message, error.code, error.data));
			else pending.resolve((message as { result?: unknown }).result);
			return;
		}

		// agent → client 请求（有 id 有 method）：分发给注册的处理器。
		if ("id" in message) {
			void this.dispatchAgentRequest(message as AcpIncomingRequest);
			return;
		}

		// 通知（无 id）。
		this.emit("notification", message as AcpRpcNotification);
	}

	private async dispatchAgentRequest(message: AcpIncomingRequest): Promise<void> {
		const handler = this.requestHandlers.get(message.method);
		if (!handler) {
			// 未注册的方法按 JSON-RPC 约定回 method not found，agent 能据此降级。
			this.respondError(message.id, -32601, `Method not found: ${message.method}`);
			return;
		}
		try {
			const result = await handler(message.params, message.id);
			// 异步应答（审批等）：handler 显式声明延迟，连接层不代答。
			if (result === ACP_DEFER_RESPONSE) return;
			this.respond(message.id, result ?? {});
		} catch (error) {
			const message_ = error instanceof Error ? error.message : String(error);
			this.respondError(message.id, JSON_RPC_INTERNAL_ERROR, message_);
		}
	}
}
