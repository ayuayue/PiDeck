/**
 * 模型请求快照的宿主端点（`pi-deck-model-trace` 扩展的上行通道）。
 *
 * **方向**：PiDeck **监听**、pi **连接**。扩展只做 HTTP 客户端，因此没有端口冲突、
 * 没有陈旧发现文件、没有 fs.watch。
 *
 * - 每个 agent spawn 时分配一个**独立 token 与路径**（多会话天然隔离）
 * - `POST /trace/<token>`：扩展推一条快照（`ModelTraceInput`）。单向投递，
 *   响应只有 `{ok}`；形状非法直接 400 —— 扩展不重试，不存在重试风暴
 * - 只绑 `127.0.0.1`，路径 token 与 `x-pideck-model-trace-token` 请求头都必须是同一个秘密
 *
 * **fail-safe**：端点起不来 → 不注入 env → 扩展静默不工作；pi 会话与 PiDeck 都照常。
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { getAppLogger } from "../../logging/sharedLogger";
import type { ModelTraceInput } from "../../../shared/types/modelTrace";

/** 单个 agent 的 trace 会话。 */
type TraceSession = {
	agentId: string;
	token: string;
	/** 收到快照时的回调（由 AgentManager 注入）。缺省表示不采集：快照被静默丢弃。 */
	onTrace?: (trace: ModelTraceInput) => void;
};

/** 端点启动结果。 */
export type ModelTraceServerInfo = {
	/** 扩展应访问的地址（注入给 pi 的 `PIDECK_MODEL_TRACE_URL`）。 */
	baseUrl: string;
};

/** 请求体上限：快照自身有截断上限，这里只是防跑偏的硬边界。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * 端点服务。
 *
 * 进程内单例：一个 PiDeck 主进程只起一个 HTTP server，用 token 区分会话。
 */
export class ModelTraceServer {
	private server: Server | null = null;
	private port = 0;
	private readonly sessions = new Map<string, TraceSession>();

	/** 端点是否已就绪。 */
	get ready(): boolean {
		return this.server !== null;
	}

	/** 当前监听端口（未启动为 0）。 */
	get listeningPort(): number {
		return this.port;
	}

	/** 启动端点（幂等）。失败返回 null —— 调用方据此不注入 env，扩展静默不工作。 */
	async start(): Promise<ModelTraceServerInfo | null> {
		if (this.server) return { baseUrl: this.baseUrl() };
		try {
			const server = createServer((req, res) => {
				void this.handleRequest(req, res);
			});
			// 只绑回环：扩展与 PiDeck 同机，不对外暴露
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					server.off("error", reject);
					resolve();
				});
			});
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				return null;
			}
			this.server = server;
			this.port = address.port;
			void getAppLogger()?.info("model-trace", "Model trace endpoint listening", { port: this.port });
			return { baseUrl: this.baseUrl() };
		} catch (error) {
			void getAppLogger()?.warn("model-trace", "Model trace endpoint failed to start; tracing stays idle", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/** 关闭端点（应用退出时调用）。 */
	stop(): void {
		this.sessions.clear();
		const server = this.server;
		this.server = null;
		this.port = 0;
		if (server) {
			try {
				server.close();
			} catch {
				// 已关闭
			}
		}
	}

	/**
	 * 为一个 agent 注册 trace 会话，返回要注入给 pi 的环境变量。
	 *
	 * 同 agentId 重复注册（重启/重连）复用旧 token。
	 */
	registerAgent(agentId: string, onTrace?: (trace: ModelTraceInput) => void): { url: string; token: string } {
		const existing = this.findByAgent(agentId);
		const token = existing?.token ?? randomUUID();
		this.sessions.set(token, { agentId, token, onTrace: onTrace ?? existing?.onTrace });
		return { url: `${this.baseUrl()}/${token}`, token };
	}

	/** 注销某 agent 的 trace 会话（agent 停止 / 会话删除时调用）。 */
	unregisterAgent(agentId: string): void {
		const session = this.findByAgent(agentId);
		if (session) this.sessions.delete(session.token);
	}

	private baseUrl(): string {
		return `http://127.0.0.1:${this.port}/trace`;
	}

	private findByAgent(agentId: string): TraceSession | undefined {
		for (const session of this.sessions.values()) {
			if (session.agentId === agentId) return session;
		}
		return undefined;
	}

	/** 处理一次快照推入。任何异常都只写日志，不影响扩展侧（它不重试）。 */
	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			if (req.method !== "POST") {
				this.respond(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			// 路径形态：/trace/<token>
			const match = (req.url ?? "").match(/^\/trace\/([^/]+)\/?$/);
			if (!match) {
				this.respond(res, 404, { ok: false, error: "not found" });
				return;
			}
			const token = match[1];
			const session = this.sessions.get(token);
			if (!session) {
				// 未知 token：可能是上一轮 runtime 的残留请求，静默接受但不做事
				this.respond(res, 200, { ok: false });
				return;
			}
			// 路径 token 与请求头都必须是同一个秘密，缺头不放行。
			if (req.headers["x-pideck-model-trace-token"] !== token) {
				this.respond(res, 403, { ok: false, error: "token mismatch" });
				return;
			}
			const body = await readBody(req);
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				this.respond(res, 400, { ok: false, error: "invalid json" });
				return;
			}
			if (!isModelTraceInput(parsed)) {
				this.respond(res, 400, { ok: false, error: "invalid trace" });
				return;
			}
			try {
				session.onTrace?.(parsed);
			} catch (error) {
				// 单个快照处理失败不影响后续快照，也不影响会话
				void getAppLogger()?.warn("model-trace", "Model trace forwarding failed", {
					agentId: session.agentId,
					kind: parsed.kind,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			this.respond(res, 200, { ok: true });
		} catch (error) {
			void getAppLogger()?.warn("model-trace", "Model trace request handling failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			try {
				this.respond(res, 200, { ok: false });
			} catch {
				// 响应已发出
			}
		}
	}

	private respond(res: ServerResponse, status: number, body: unknown): void {
		if (res.writableEnded) return;
		const text = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json",
			"content-length": Buffer.byteLength(text),
		});
		res.end(text);
	}
}

/**
 * 扩展侧对快照的最小校验：形状不对直接拒绝。
 * 字段全量对齐由 tests/modelTraceExtension.test.mjs 断言（扩展侧是自包含 .ts，无法共享类型）。
 */
function isModelTraceInput(value: unknown): value is ModelTraceInput {
	if (typeof value !== "object" || value === null) return false;
	const trace = value as Record<string, unknown>;
	if (typeof trace.traceId !== "string" || trace.traceId.length === 0 || typeof trace.ts !== "number") return false;
	if (trace.kind === "request") return typeof trace.payloadJson === "string" && typeof trace.payloadBytes === "number";
	if (trace.kind === "response") return typeof trace.status === "number";
	return false;
}

/** 读取请求体，带大小上限。 */
function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > MAX_BODY_BYTES) {
				// 超限：停止累积，但要把流读干净，否则连接不复用
				chunks.length = 0;
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** 进程级单例（主进程一份）。 */
let sharedServer: ModelTraceServer | null = null;

export function getModelTraceServer(): ModelTraceServer {
	if (!sharedServer) sharedServer = new ModelTraceServer();
	return sharedServer;
}

/** 应用退出时调用。 */
export function stopModelTraceServer(): void {
	sharedServer?.stop();
	sharedServer = null;
}
