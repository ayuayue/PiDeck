import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LINKED_SESSION_INITIATIONS, type LinkedSessionInitiation, type LinkedSessionsRequest, type LinkedSessionsResponse } from "../../shared/types/linkedSessions";
import { getAppLogger } from "../logging/sharedLogger";

/**
 * 关联会话端点（docs/host-boundaries.md 例外九）：只绑 127.0.0.1，每 agent 一份 token。
 *
 * 与模型快照端点同构，但不复用它：每条例外通道只承载一种用途。
 * 调用方身份只认 token → agentId；请求体里的会话 id 只当「目标」，从不当「我是谁」。
 */

export type LinkedSessionsHandler = (agentId: string, request: LinkedSessionsRequest) => Promise<LinkedSessionsResponse>;

const MAX_BODY_BYTES = 256 * 1024;
const TOKEN_HEADER = "x-pideck-linked-token";

export class LinkedSessionServer {
	private server: Server | null = null;
	private port = 0;
	/** token → agentId */
	private readonly agents = new Map<string, string>();

	constructor(private readonly handler: LinkedSessionsHandler) {}

	get ready(): boolean {
		return this.server !== null;
	}

	async start(): Promise<boolean> {
		if (this.server) return true;
		try {
			const server = createServer((req, res) => {
				void this.handleRequest(req, res);
			});
			// offer 会挂起到用户点按钮，不能让 Node 默认的请求超时把它掐掉
			server.requestTimeout = 0;
			server.headersTimeout = 30_000;
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
				return false;
			}
			this.server = server;
			this.port = address.port;
			void getAppLogger()?.info("linked-sessions", "Linked sessions endpoint listening", { port: this.port });
			return true;
		} catch (error) {
			void getAppLogger()?.warn("linked-sessions", "Linked sessions endpoint failed to start; tools stay disabled", {
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	stop(): void {
		this.agents.clear();
		const server = this.server;
		this.server = null;
		this.port = 0;
		try {
			server?.close();
		} catch {
			// 已关闭
		}
	}

	/** 端点未就绪返回 undefined：调用方不注入 env，扩展整体不注册工具。 */
	registerAgent(agentId: string): Record<string, string> | undefined {
		if (!this.server) return undefined;
		let token: string | undefined;
		for (const [existing, owner] of this.agents) if (owner === agentId) token = existing;
		token ??= randomUUID();
		this.agents.set(token, agentId);
		return { PIDECK_LINKED_SESSIONS_URL: `http://127.0.0.1:${this.port}/linked/${token}`, PIDECK_LINKED_SESSIONS_TOKEN: token };
	}

	unregisterAgent(agentId: string): void {
		for (const [token, owner] of this.agents) if (owner === agentId) this.agents.delete(token);
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			if (req.method !== "POST") return this.respond(res, 405, { ok: false, error: "method-not-allowed" });
			const match = (req.url ?? "").match(/^\/linked\/([^/?#]+)\/?$/);
			if (!match) return this.respond(res, 404, { ok: false, error: "not-found" });
			const token = match[1];
			const agentId = this.agents.get(token);
			if (!agentId) return this.respond(res, 403, { ok: false, error: "runtime-gone" });
			if (req.headers[TOKEN_HEADER] !== token) return this.respond(res, 403, { ok: false, error: "token-mismatch" });
			let parsed: unknown;
			try {
				parsed = JSON.parse(await readBody(req));
			} catch {
				return this.respond(res, 400, { ok: false, error: "invalid-json" });
			}
			const request = parseLinkedSessionsRequest(parsed);
			if (!request) return this.respond(res, 400, { ok: false, error: "invalid-request" });
			const result = await this.handler(agentId, request);
			this.respond(res, 200, result);
		} catch (error) {
			void getAppLogger()?.warn("linked-sessions", "Linked sessions request failed", { error: error instanceof Error ? error.message : String(error) });
			this.respond(res, 200, { ok: false, error: "operation-failed" });
		}
	}

	private respond(res: ServerResponse, status: number, body: LinkedSessionsResponse): void {
		if (res.writableEnded) return;
		const text = JSON.stringify(body);
		res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
		res.end(text);
	}
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** 线格式校验：只放行共享类型声明过的三种 op 与字段。 */
export function parseLinkedSessionsRequest(value: unknown): LinkedSessionsRequest | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	switch (record.op) {
		case "list":
			return { op: "list" };
		case "send": {
			const sessionId = str(record.sessionId);
			const message = str(record.message);
			return sessionId && message ? { op: "send", sessionId, message } : null;
		}
		case "start": {
			const initiation = (LINKED_SESSION_INITIATIONS as readonly unknown[]).includes(record.initiation) ? (record.initiation as LinkedSessionInitiation) : undefined;
			const proposalId = str(record.proposalId);
			const title = str(record.title);
			const prompt = str(record.prompt);
			if (!proposalId && (!title || !prompt)) return null;
			return {
				op: "start",
				...(str(record.toolCallId) ? { toolCallId: str(record.toolCallId) } : {}),
				...(title ? { title } : {}),
				...(prompt ? { prompt } : {}),
				...(initiation ? { initiation } : {}),
				...(proposalId ? { proposalId } : {}),
			};
		}
		default:
			return null;
	}
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("body-too-large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
