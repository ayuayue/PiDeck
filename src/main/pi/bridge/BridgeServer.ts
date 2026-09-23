/**
 * GUI 扩展桥的宿主端点（§9.2）。
 *
 * **方向**：PiDeck **监听**、pi **连接**。桥只做 HTTP 客户端，
 * 因此没有端口冲突、没有陈旧发现文件、没有 fs.watch。
 *
 * - 每个 agent spawn 时分配一个**独立 token 与路径**（多会话天然隔离，§9.2）
 * - `POST /bridge/<token>/ui`：桥推更新（body `{updates:[...]}`），
 *   响应体带回待处理事件 `{events:[...]}`（一次往返完成双向）
 * - 只绑 `127.0.0.1`，只认带正确 token 的请求
 *
 * **fail-safe**：端点起不来只是「桥不工作」，pi 会话与 PiDeck 都照常（§14.5）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { BridgeEvent, BridgeUpdate } from "../../../shared/types/bridge";
import { getAppLogger } from "../../logging/sharedLogger";

/** 单个 agent 的桥会话。 */
type BridgeSession = {
	agentId: string;
	token: string;
	/** 待回灌给桥的事件队列。 */
	pendingEvents: BridgeEvent[];
	/** 最近一次收到桥数据的时间（诊断用）。 */
	lastSeenAt: number;
	/** 桥推来的更新计数（诊断用）。 */
	updateCount: number;
	/** 收到更新时的回调（由 AgentManager 注入，负责转发给渲染进程）。 */
	onUpdate: (update: BridgeUpdate) => void;
};

/** 端点启动结果。 */
export type BridgeServerInfo = {
	/** 桥应访问的 base URL（注入给 pi 的 `PIDECK_BRIDGE_URL`）。 */
	baseUrl: string;
};

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4MB：单帧 UI 树的合理上界
const MAX_PENDING_EVENTS = 500;

/**
 * 桥端点服务。
 *
 * 进程内单例：一个 PiDeck 主进程只起一个 HTTP server，用 token 区分会话。
 */
export class BridgeServer {
	private server: Server | null = null;
	private port = 0;
	private readonly sessions = new Map<string, BridgeSession>();
	/** token → agentId 反查（请求路径里只有 token）。 */
	private readonly agentByToken = new Map<string, string>();

	/** 端点是否已就绪。 */
	get ready(): boolean {
		return this.server !== null;
	}

	/** 当前监听端口（未启动为 0）。 */
	get listeningPort(): number {
		return this.port;
	}

	/**
	 * 启动端点（幂等）。失败返回 null —— 调用方据此不注入 env，桥静默不工作。
	 */
	async start(): Promise<BridgeServerInfo | null> {
		if (this.server) return { baseUrl: this.baseUrl() };
		try {
			const server = createServer((req, res) => {
				void this.handleRequest(req, res);
			});
			// 只绑回环：桥与 PiDeck 同机，不对外暴露
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
			void getAppLogger()?.info("gui-bridge", "Bridge endpoint listening", { port: this.port });
			return { baseUrl: this.baseUrl() };
		} catch (error) {
			void getAppLogger()?.warn("gui-bridge", "Bridge endpoint failed to start; bridge stays idle", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/** 关闭端点（应用退出时调用）。 */
	stop(): void {
		for (const session of this.sessions.values()) session.pendingEvents.length = 0;
		this.sessions.clear();
		this.agentByToken.clear();
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
	 * 为一个 agent 注册桥会话，返回要注入给 pi 的环境变量。
	 *
	 * `onUpdate` 由 AgentManager 注入：收到桥的更新后转发给渲染进程。
	 */
	registerAgent(agentId: string, onUpdate: (update: BridgeUpdate) => void): { url: string; token: string } {
		// 同 agentId 重复注册（重启/重连）→ 复用 token，保留队列
		const existing = this.findByAgent(agentId);
		const token = existing?.token ?? randomUUID();
		const session: BridgeSession = {
			agentId,
			token,
			pendingEvents: existing?.pendingEvents ?? [],
			lastSeenAt: Date.now(),
			updateCount: existing?.updateCount ?? 0,
			onUpdate,
		};
		this.sessions.set(token, session);
		this.agentByToken.set(token, agentId);
		return { url: `${this.baseUrl()}/${token}`, token };
	}

	/** 注销某 agent 的桥会话（agent 停止 / 会话删除）。 */
	unregisterAgent(agentId: string): void {
		const session = this.findByAgent(agentId);
		if (!session) return;
		this.sessions.delete(session.token);
		this.agentByToken.delete(session.token);
	}

	/**
	 * 把渲染层来的交互事件排入该 agent 的待回灌队列。
	 *
	 * 桥会在下一次轮询（~100ms）时取走。返回是否找到会话。
	 */
	pushEvent(agentId: string, event: BridgeEvent): boolean {
		const session = this.findByAgent(agentId);
		if (!session) return false;
		// 队列上限：超出丢最旧的（避免渲染层刷屏把内存顶爆）
		if (session.pendingEvents.length >= MAX_PENDING_EVENTS) session.pendingEvents.shift();
		session.pendingEvents.push(event);
		return true;
	}

	/** 诊断：某 agent 的桥是否活着（最近有数据往来）。 */
	isAgentConnected(agentId: string, withinMs = 5000): boolean {
		const session = this.findByAgent(agentId);
		if (!session) return false;
		return Date.now() - session.lastSeenAt < withinMs;
	}

	private baseUrl(): string {
		return `http://127.0.0.1:${this.port}/bridge`;
	}

	private findByAgent(agentId: string): BridgeSession | undefined {
		for (const session of this.sessions.values()) {
			if (session.agentId === agentId) return session;
		}
		return undefined;
	}

	/** 处理一次桥的请求。任何异常都返回 200 空体，避免桥侧重试风暴。 */
	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			if (req.method !== "POST") {
				this.respond(res, 405, { error: "method not allowed" });
				return;
			}
			const url = req.url ?? "";
			// 路径形态：/bridge/<token>/ui
			const match = url.match(/^\/bridge\/([^/]+)\/ui\/?$/);
			if (!match) {
				this.respond(res, 404, { error: "not found" });
				return;
			}
			const token = match[1];
			const session = this.sessions.get(token);
			if (!session) {
				// 未知 token：可能是上一轮 runtime 的残留请求，静默接受但不做事
				this.respond(res, 200, { events: [] });
				return;
			}
			// 请求头 token 校验（路径 token 已是秘密，这里再加一层）
			const headerToken = req.headers["x-pideck-bridge-token"];
			if (typeof headerToken === "string" && headerToken !== token) {
				this.respond(res, 403, { error: "token mismatch" });
				return;
			}

			const body = await readBody(req);
			let parsed: { updates?: BridgeUpdate[] } = {};
			if (body.trim()) {
				try {
					parsed = JSON.parse(body) as { updates?: BridgeUpdate[] };
				} catch {
					// 非法 JSON：当作空更新（不打断桥的轮询）
					parsed = {};
				}
			}

			session.lastSeenAt = Date.now();
			const updates = Array.isArray(parsed.updates) ? parsed.updates : [];
			session.updateCount += updates.length;
			for (const update of updates) {
				try {
					session.onUpdate(update);
				} catch (error) {
					// 单个更新转发失败不影响其余，也不影响桥
					void getAppLogger()?.warn("gui-bridge", "Bridge update forwarding failed", {
						agentId: session.agentId,
						type: update?.type,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			// 响应体带回待处理事件（一次往返完成双向，§9.2）
			const events = session.pendingEvents.splice(0, session.pendingEvents.length);
			this.respond(res, 200, { events });
		} catch (error) {
			// 端点自身出错也不能让桥卡住：返回 200 空体
			void getAppLogger()?.warn("gui-bridge", "Bridge request handling failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			try {
				this.respond(res, 200, { events: [] });
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
let sharedServer: BridgeServer | null = null;

export function getBridgeServer(): BridgeServer {
	if (!sharedServer) sharedServer = new BridgeServer();
	return sharedServer;
}

/** 应用退出时调用。 */
export function stopBridgeServer(): void {
	sharedServer?.stop();
	sharedServer = null;
}