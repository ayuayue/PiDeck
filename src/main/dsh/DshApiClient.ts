import { randomUUID } from "node:crypto";
import {
	marshalFetchRequest,
	marshalStreamOpen,
	parseDshFetchMessage,
	type DshFetchMessage,
	type DshStreamFailure,
} from "./dshHostBridge";

/**
 * DSH v2 传输（utilityProcess 桥）的 fetch 抽象：
 * 主进程实现走 UtilityProcess.postMessage；测试用内存实现模拟 host 侧响应。
 */
export interface DshFetchTransport {
	/** 发送一条桥消息（fetch-request / stream-open 等）。 */
	send(message: DshFetchMessage): void;
	/** 订阅 host → main 的桥消息。返回退订函数。 */
	onMessage(listener: (message: DshFetchMessage) => void): () => void;
	/** 释放传输（退出清理）。 */
	dispose(): void;
}

/** 一次 in-flight fetch 的 pending 状态。 */
type PendingFetch = {
	resolve: (response: Response) => void;
	reject: (error: Error) => void;
	/** 请求超时定时器（E2：transport 死亡后请求不能永久悬挂）；结算时清理。 */
	timer?: NodeJS.Timeout;
	/** 外部 abort signal 与已注册的监听器（E8：结算时必须移除，避免长生命周期 signal 累积监听）。 */
	signal?: AbortSignal;
	abortHandler?: () => void;
	/** 流式响应组装中（fetch-stream-start 后建立）。 */
	stream?: {
		controller: ReadableStreamDefaultController<Uint8Array>;
		closed: boolean;
		/** 消费者 cancel 过：后续 chunk 丢弃。 */
		cancelled: boolean;
	};
};

/** Connection RPC 统一结果（对齐官方 ConnectionRpcResult 形状）。 */
export type DshRpcResult<T = unknown> =
	| { ok: true; value: T }
	| { ok: false; error: { code: string; message: string; details: object } };

/** Connection RPC 线上信封（对齐官方 ClientRequest/ServerResponse）。 */
type ClientRequestEnvelope = {
	type: "client-request";
	rpcId: string;
	method: string;
	payload: unknown;
};

/** 0.1.5 Connection 的共享 RPC 通道（hostEntry 用 createSharedFetchHandler 挂载）。 */
const RPC_CHANNEL = "/api";
/** Connection 的内部 origin（桥只承载它；见 marshalFetchRequest 的 origin 断言）。 */
const INTERNAL_ORIGIN = "http://dsh.internal";
/** Gateway 内部事件瀑布结果端点（RemoteEventResult 的 unary 载体）。 */
const REMOTE_EVENT_RESULT_ENDPOINT = "$events/result";

export type DshApiClientOptions = {
	/** 桥传输（utilityProcess / 内存测试实现）。 */
	transport: DshFetchTransport;
	/** 日志（可选；默认静默）。 */
	log?: (message: string, detail?: unknown) => void;
	/** 请求超时（毫秒；默认 30s）。流式请求在 fetch-stream-start 到达后不再受此限制。 */
	timeoutMs?: number;
};

/**
 * 0.1.5 Typert Remote 桥客户端（替代旧 AbstractApiClient 桥接形态）：
 * - unary：官方 Connection wire 协议——POST /api/<endpoint>，body 为
 *   ClientRequest JSON 信封，响应为 ServerResponse 信封。经既有 fetch-* 帧。
 * - 流式：Gateway Remote stream 协议（stream-open/cancel ↑，item/end/error ↓），
 *   帧形状与官方 RemoteStreamMuxClient 一致；host 半在 hostEntry 驱动
 *   ctx.typertGateway.wireStream.open。
 * - 事件瀑布应答：POST /api/$events/result（RemoteEventResult 载荷）。
 */
export class DshApiClient {
	private readonly pending = new Map<string, PendingFetch>();
	private readonly unsubscribe: () => void;
	private readonly transport: DshFetchTransport;
	private readonly log: (message: string, detail?: unknown) => void;
	/** dispose 后置位：拒绝新请求、abort/流取消回调不再向已死 transport 发消息。 */
	private disposed = false;
	private readonly timeoutMs: number;
	/** 打开中的逻辑流：id → 泵（end/error/取消后删除）。 */
	private readonly streams = new Map<string, DshStreamPump>();

	constructor(options: DshApiClientOptions) {
		this.transport = options.transport;
		this.log = options.log ?? (() => undefined);
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.unsubscribe = this.transport.onMessage((message) => {
			const parsed = parseDshFetchMessage(message);
			if (parsed) this.handleMessage(parsed);
		});
	}

	// ── Connection unary RPC ──────────────────────────────────────────────────

	/**
	 * 调用一个 Connection RPC 端点（如 `session/list`）。
	 * 返回端点自己的 success/error 结果；传输失败按 `{ok:false, error:'internal'}` 收敛
	 * （与官方 transportError 契约一致，调用方不必同时处理 throw 与 error 结果）。
	 *
	 * payload 在这里统一包装为 typert Gateway 的 wire 形状 `{ args }`（gateway 侧
	 * remoteRequest 强校验「恰好一个 plain-object args 字段」，收到裸载荷直接
	 * gateway/internal 拒绝），handler 侧拿到的是解包后的 args——调用点因此保持
	 * 「直接传领域参数对象」的写法，不需要各自记得包一层。
	 */
	async call(
		endpoint: string,
		payload: unknown,
		signal?: AbortSignal,
	): Promise<DshRpcResult> {
		const rpcId = randomUUID();
		const envelope: ClientRequestEnvelope = {
			type: "client-request",
			rpcId,
			method: endpoint,
			payload: wrapRemoteArgs(endpoint, payload),
		};
		try {
			const response = await this.rawFetch(new URL(`${RPC_CHANNEL}/${endpoint}`, INTERNAL_ORIGIN), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(envelope),
				...(signal ? { signal } : {}),
			});
			if (!response.ok) {
				return {
					ok: false,
					error: { code: "internal", message: `transport failure for ${endpoint}: HTTP ${response.status}`, details: {} },
				};
			}
			return parseServerResponse(await response.json(), rpcId, endpoint);
		} catch (error) {
			return {
				ok: false,
				error: {
					code: "internal",
					message: error instanceof Error ? error.message : String(error),
					details: {},
				},
			};
		}
	}

	/**
	 * 应答一个 Gateway 事件瀑布（approval/request、user-questions/request）。
	 * value 为领域应答（ApprovalOutcome 字符串或 AskUserQuestionAnswer）。
	 */
	respondRemoteEvent(
		clientId: string,
		eventId: string,
		outcome: { kind: "next" } | { kind: "result"; value?: unknown } | { kind: "rejected"; error: { name: string; message: string } },
		signal?: AbortSignal,
	): Promise<DshRpcResult> {
		return this.call(REMOTE_EVENT_RESULT_ENDPOINT, { clientId, eventId, outcome }, signal);
	}

	// ── Gateway Remote 流 ─────────────────────────────────────────────────────

	/**
	 * 打开一条 Gateway 逻辑流（如 `session/follow`、内部 `$events`）。
	 * 返回宿主推送值的异步迭代器；宿主错误以 Error("code: message") reject。
	 * 外部 signal abort / dispose / host 退出都会终止迭代。
	 */
	openStream(endpoint: string, payload: unknown, signal?: AbortSignal): AsyncIterable<unknown> {
		const self = this;
		async function* generate(): AsyncGenerator<unknown> {
			if (self.disposed) throw new Error("DSH host transport disposed");
			const id = randomUUID();
			const pump = new DshStreamPump(id, signal, self);
			self.streams.set(id, pump);
			try {
				self.transport.send(marshalStreamOpen(id, endpoint, wrapRemoteArgs(endpoint, payload)));
				while (true) {
					const next = await pump.next();
					if (next.done) return;
					yield next.value;
				}
			} finally {
				self.streams.delete(id);
				pump.dispose();
			}
		}
		return generate();
	}

	// ── 原始 fetch（插件管理桥等非 Connection 路径用）───────────────────────────

	/** 桥接原始 fetch（任意 dsh.internal URL，unary SSE 流式通用）。 */
	rawFetch(
		input: URL | string,
		init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
	): Promise<Response> {
		const url = input instanceof URL ? input : new URL(input, INTERNAL_ORIGIN);
		return this.bridgedFetch(url, init);
	}

	/** 真正的桥接 fetch：发 fetch-request，等 unary 响应或组装流式响应。 */
	private bridgedFetch(
		input: URL,
		init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
	): Promise<Response> {
		// host 已 dispose：不再向桥发消息（transport.send 已静默丢弃，这里直接拒绝
		// 更快暴露问题，且不产生悬挂的 pending）。
		if (this.disposed) {
			return Promise.reject(new Error("DSH host transport disposed"));
		}
		const id = randomUUID();
		const request = marshalFetchRequest(id, input, init);
		return new Promise<Response>((resolve, reject) => {
			// 外部 signal 已中止：直接拒绝（不向 host 发请求）。
			if (init?.signal?.aborted) {
				reject(new DOMException("The operation was aborted.", "AbortError"));
				return;
			}
			// E2：请求超时——transport 死亡（host 崩溃且重启超限放弃）后，host 侧不会有
			// 任何响应帧，悬挂 pending 会让 IPC 永久挂起。流式请求在 fetch-stream-start
			// 到达后由 abort/fetch-end 管理，不再受此超时限制（mux 是长连接）。
			const timer = setTimeout(() => {
				const pending = this.pending.get(id);
				if (!pending) return;
				if (pending.stream) return;
				this.pending.delete(id);
				this.log(`fetch timed out after ${this.timeoutMs}ms`, { id });
				reject(new Error(`DSH bridge fetch timed out after ${this.timeoutMs}ms`));
			}, this.timeoutMs);
			timer.unref();
			const pending: PendingFetch = { resolve, reject, timer };
			this.pending.set(id, pending);
			this.transport.send(request);
			// abort 转发：host 侧 req.signal 联动取消（SSE 流 / 超时）。
			// E8：结算时（settlePending）必须 removeEventListener，否则长生命周期 signal
			// （会话级 controller，mux 重连多次复用）下监听器随请求数累积。
			const abortHandler = () => {
				// dispose 后 abort 回调仍可能触发（外部 signal 生命周期比 client 长）：
				// 不再向已死 transport 发消息，只清 pending。
				if (this.disposed) {
					this.settlePending(id, undefined, new DOMException("The operation was aborted.", "AbortError"));
					return;
				}
				this.transport.send({ type: "fetch-abort", id });
				const current = this.pending.get(id);
				if (current) {
					this.pending.delete(id);
					const stream = current.stream;
					if (stream && !stream.closed) {
						stream.closed = true;
						try {
							stream.controller.error(new DOMException("The operation was aborted.", "AbortError"));
						} catch {
							// 已关闭忽略
						}
					}
					if (current.timer) clearTimeout(current.timer);
					current.reject(new DOMException("The operation was aborted.", "AbortError"));
				}
			};
			pending.abortHandler = abortHandler;
			if (init?.signal) {
				pending.signal = init.signal;
				init.signal.addEventListener("abort", abortHandler, { once: true });
			}
		});
	}

	/** 结算 pending：清超时定时器 + 移除 abort 监听器（E2/E8）。 */
	private settlePending(id: string, resolveWith: Response | undefined, rejectWith: Error): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		this.cleanupPending(pending);
		if (resolveWith !== undefined) pending.resolve(resolveWith);
		else pending.reject(rejectWith);
	}

	/** 清理 pending 的超时定时器与 abort 监听器（E2/E8）。 */
	private cleanupPending(pending: PendingFetch): void {
		if (pending.timer) clearTimeout(pending.timer);
		if (pending.signal && pending.abortHandler) {
			pending.signal.removeEventListener("abort", pending.abortHandler);
		}
	}

	private handleMessage(message: DshFetchMessage): void {
		switch (message.type) {
			case "fetch-response": {
				// unary：一次性 body，直接组装 Response 并结算。
				const pending = this.pending.get(message.id);
				if (!pending) return;
				this.pending.delete(message.id);
				this.cleanupPending(pending);
				const headers = new Headers(message.headers);
				pending.resolve(new Response(message.body ?? "", {
					status: message.status,
					headers,
				}));
				return;
			}
			case "fetch-stream-start": {
				const pending = this.pending.get(message.id);
				if (!pending || pending.stream) return;
				const headers = new Headers(message.headers);
				let streamState: PendingFetch["stream"];
				const stream = new ReadableStream<Uint8Array>({
					start: (controller) => {
						streamState = { controller, closed: false, cancelled: false };
						pending.stream = streamState;
					},
					cancel: () => {
						// 消费者提前取消（readSse finally 的 reader.cancel）：
						// 通知 host 停止推送，避免 pending 泄漏。
						if (streamState) {
							streamState.cancelled = true;
							streamState.closed = true;
						}
						this.transport.send({ type: "fetch-abort", id: message.id });
					},
				});
				pending.resolve(new Response(stream, { status: message.status, headers }));
				return;
			}
			case "fetch-chunk": {
				const pending = this.pending.get(message.id);
				const stream = pending?.stream;
				if (!stream || stream.closed) return;
				try {
					stream.controller.enqueue(new TextEncoder().encode(message.data));
				} catch (error) {
					this.log("dsh-bridge", `chunk enqueue failed: ${String(error)}`);
				}
				return;
			}
			case "fetch-end": {
				const pending = this.pending.get(message.id);
				const stream = pending?.stream;
				this.pending.delete(message.id);
				if (pending) this.cleanupPending(pending);
				if (stream && !stream.closed) {
					stream.closed = true;
					try {
						stream.controller.close();
					} catch {
						// 已关闭（cancel 竞态）忽略
					}
				}
				return;
			}
			case "fetch-error": {
				const pending = this.pending.get(message.id);
				const stream = pending?.stream;
				this.pending.delete(message.id);
				if (pending) this.cleanupPending(pending);
				if (stream && !stream.closed) {
					stream.closed = true;
					try {
						stream.controller.error(new Error(message.message));
					} catch {
						// 已关闭忽略
					}
				}
				pending?.reject(new Error(message.message));
				return;
			}
			case "stream-item": {
				this.streams.get(message.id)?.push({ value: message.value });
				return;
			}
			case "stream-end": {
				this.streams.get(message.id)?.close();
				return;
			}
			case "stream-error": {
				this.streams.get(message.id)?.fail({
					code: message.code,
					message: message.message,
					details: message.details ?? {},
				});
				return;
			}
			default:
				return;
		}
	}

	/**
	 * host 进程退出时调用：中断全部在途 fetch（含 mux 长连接）与逻辑流。
	 * host 崩溃后桥消息永久中断，悬挂的 pending 若不主动 error，
	 * pump 的 for await 会永远等不到结束——这是「会话静默断开」的根因。
	 */
	abortAllPending(): void {
		for (const pending of this.pending.values()) {
			this.cleanupPending(pending);
			const stream = pending.stream;
			if (stream && !stream.closed) {
				stream.closed = true;
				try {
					stream.controller.error(new Error("DSH host process exited"));
				} catch {
					// 已关闭忽略
				}
			}
			pending.reject(new Error("DSH host process exited"));
		}
		this.pending.clear();
		for (const pump of this.streams.values()) {
			pump.fail({ code: "internal", message: "DSH host process exited" });
		}
		this.streams.clear();
	}

	/** 释放：清空 pending（拒绝在途请求），退订桥消息，置 disposed 阻止后续 send。 */
	dispose(): void {
		this.disposed = true;
		this.unsubscribe();
		for (const pending of this.pending.values()) {
			this.cleanupPending(pending);
			pending.reject(new Error("DSH host transport disposed"));
		}
		this.pending.clear();
		for (const pump of this.streams.values()) {
			pump.fail({ code: "internal", message: "DSH host transport disposed" });
		}
		this.streams.clear();
	}

	// ── DshStreamPump 回调（同模块内协作方法）──────────────────────────────────
	/** dispose 是否已触发（pump 决定是否还向 transport 发取消帧）。 */
	isDisposed(): boolean {
		return this.disposed;
	}

	/** 向 host 发送一条逻辑流的取消帧。 */
	sendStreamCancel(id: string): void {
		this.transport.send({ type: "stream-cancel", id });
	}
}

/** 解析 ServerResponse 信封（对齐官方 parseConnectionResponse 的校验语义）。 */
function parseServerResponse(value: unknown, rpcId: string, endpoint: string): DshRpcResult {
	if (!isRecord(value) || value.type !== "server-response" || typeof value.rpcId !== "string") {
		return failureResult(`connection: invalid server-response envelope for ${endpoint}`);
	}
	if (value.rpcId !== rpcId) {
		return failureResult(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${String(value.rpcId)}`);
	}
	const result = value.result;
	if (!isRecord(result)) return failureResult(`connection: invalid server-response result for ${endpoint}`);
	if (result.ok === true) return { ok: true, value: result.value };
	if (result.ok !== false || !isRecord(result.error)) {
		return failureResult(`connection: invalid server-response result for ${endpoint}`);
	}
	const error = result.error;
	if (typeof error.code !== "string" || typeof error.message !== "string" || !isRecord(error.details)) {
		return failureResult(`connection: invalid server-response failure for ${endpoint}`);
	}
	return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
}

function failureResult(message: string): DshRpcResult {
	return { ok: false, error: { code: "internal", message, details: {} } };
}

/**
 * 把领域参数包装为 typert Gateway 的 wire 载荷 `{ args }`。
 *
 * Gateway 的 remoteRequest 强校验：payload 必须是恰好一个 `args` 键的 plain object
 * （见 dsh-api-gateway remoteRequest —— 收到裸载荷抛 gateway/internal「Remote payload
 * must contain exactly one plain-object args field」），handler 收到的是解包后的 args。
 * 包装收口在 call/openStream 两个出口，调用点永远传「handler 期望的 args 对象」本身；
 * 非对象载荷（undefined/原始值）是调用点 bug，包成 `{args: value}` 让 host 侧 zod
 * 校验报出可读错误，而不是在这里静默吞掉。
 */
function wrapRemoteArgs(endpoint: string, payload: unknown): Record<string, unknown> {
	if (
		isRecord(payload) &&
		Object.hasOwn(payload, "args") &&
		Reflect.ownKeys(payload).length === 1
	) {
		// 防御已包装的载荷被二次包装（{args:{args:...}} host 侧 zod 很难读出原因）。
		throw new Error(`dsh rpc: payload for ${endpoint} is already args-wrapped; pass bare domain args`);
	}
	return { args: payload };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 一条逻辑流的宿主推送缓冲：item 值排队、end/error 终结。
 * next() 在队列空时等待，保证 openStream 的 for await 消费顺序与推送顺序一致。
 */
class DshStreamPump {
	private readonly queue: Array<{ value: unknown }> = [];
	private terminal?: { error?: DshStreamFailure };
	private waiter?: {
		resolve: (next: IteratorResult<unknown>) => void;
		reject: (error: Error) => void;
	};
	private readonly onAbort: (() => void) | undefined;
	private readonly abortSignal: AbortSignal | undefined;

	constructor(
		private readonly id: string,
		signal: AbortSignal | undefined,
		private readonly owner: DshApiClient,
	) {
		if (signal) {
			this.abortSignal = signal;
			const handler = () => {
				// 外部取消：通知 host 停止推送并终结本地迭代（幂等：settle 只生效一次）。
				if (!this.owner.isDisposed()) {
					this.owner.sendStreamCancel(id);
				}
				this.fail({ code: "cancelled", message: "stream cancelled" });
			};
			this.onAbort = handler;
			signal.addEventListener("abort", handler, { once: true });
		}
	}

	/** 下一个宿主值；流终结时返回 done。 */
	next(): Promise<IteratorResult<unknown>> {
		const item = this.queue.shift();
		if (item) return Promise.resolve({ value: item.value, done: false });
		if (this.terminal) {
			const error = this.terminal.error;
			if (error) return Promise.reject(new Error(`${error.code}: ${error.message}`));
			return Promise.resolve({ value: undefined, done: true });
		}
		return new Promise((resolve, reject) => {
			this.waiter = { resolve, reject };
		});
	}

	/** 宿主推送一个值；有等待者直接交付，否则入队。 */
	push(item: { value: unknown }): void {
		if (this.terminal) return;
		const waiter = this.waiter;
		if (waiter) {
			this.waiter = undefined;
			waiter.resolve({ value: item.value, done: false });
			return;
		}
		this.queue.push(item);
	}

	/** 流正常结束。 */
	close(): void {
		this.settle(undefined);
	}

	/** 流失败（宿主错误 / 本地取消 / host 退出）。 */
	fail(error: DshStreamFailure): void {
		this.settle(error);
	}

	/** 迭代器 finally 清理：移除外部 abort 监听。 */
	dispose(): void {
		if (this.abortSignal && this.onAbort) {
			this.abortSignal.removeEventListener("abort", this.onAbort);
		}
	}

	private settle(error?: DshStreamFailure): void {
		if (this.terminal) return;
		this.terminal = { error };
		const waiter = this.waiter;
		this.waiter = undefined;
		if (waiter) {
			if (error) waiter.reject(new Error(`${error.code}: ${error.message}`));
			else waiter.resolve({ value: undefined, done: true });
		}
		// 注意：不清空 queue——end/error 之前推送的 item 仍要按序交付，
		// next() 先排空 queue 再上报终结（否则宿主同步连发的最后一批值会丢）。
	}
}
