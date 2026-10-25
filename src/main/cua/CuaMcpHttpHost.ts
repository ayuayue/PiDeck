/**
 * CuaMcpHttpHost — serves the CUA MCP server over Streamable HTTP from inside
 * the PiDeck Electron main process (Plan A).
 *
 * Why HTTP instead of stdio: the CUA tools need Electron's desktopCapturer for
 * screen capture, which is unavailable in a plain `node` child process. Running
 * the MCP server in the main process and exposing it on 127.0.0.1 lets pi's
 * pi-mcp-adapter connect via the `url` field.
 *
 * Transport: MCP Streamable HTTP (stateful mode, one transport per session).
 * Endpoint: POST/GET/DELETE http://127.0.0.1:<port>/mcp
 *
 * This module deliberately has no Electron imports so it can run under
 * `node --test`; the HTTP host is given a ready-made engine + gate.
 */

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { CuaEngine } from "./CuaEngine";
import type { CuaGate } from "./CuaGate";
import { createCuaMcpServer, type CuaMcpBrowserTools } from "./CuaMcpServer";

export type CuaMcpHttpHostConfig = {
	/** Port to listen on. 0 = auto-select. */
	port?: number;
	/**
	 * Optional shared secret. When set, every request must carry
	 * `Authorization: Bearer <token>`. Requests without it are rejected 401.
	 */
	authToken?: string;
};

export type CuaMcpHttpHostDeps = {
	engine: CuaEngine;
	gate: CuaGate;
	/** 能力开关：host 可能只为浏览器能力启动，此时不能注册 CUA 工具。 */
	cuaEnabled?: () => boolean;
	/** 浏览器工具组（开关 + controller）；未传 = 不注册 browser_*。 */
	browser?: CuaMcpBrowserTools;
	onLog?: (level: "info" | "error", message: string) => void;
};

const MCP_PATH = "/mcp";

export class CuaMcpHttpHost {
	private server: HttpServer | null = null;
	private actualPort = 0;
	private config: CuaMcpHttpHostConfig;
	private deps: CuaMcpHttpHostDeps;
	/** Active transports keyed by session ID (stateful mode). */
	private transports = new Map<string, StreamableHTTPServerTransport>();

	constructor(config: CuaMcpHttpHostConfig, deps: CuaMcpHttpHostDeps) {
		this.config = config;
		this.deps = deps;
	}

	/** Start listening. Resolves with the actual port. */
	start(): Promise<number> {
		return new Promise((resolve, reject) => {
			this.server = createServer((req, res) => {
				void this.handleRequest(req, res);
			});

			// Startup failures reject the promise; later runtime errors only log.
			// Two distinct handlers — previously a second persistent `on(error)`
			// also invoked `reject` forever after the promise had settled (dead
			// code that also swallowed the error event semantics twice).
			this.server.once("error", reject);
			this.server.on("error", (err) => {
				this.deps.onLog?.("error", `CUA MCP HTTP host error: ${err.message}`);
			});

			const port = this.config.port ?? 0;
			this.server.listen(port, "127.0.0.1", () => {
				const addr = this.server?.address();
				this.actualPort = typeof addr === "object" && addr ? addr.port : port;
				this.deps.onLog?.("info", `CUA MCP HTTP host listening on 127.0.0.1:${this.actualPort}${MCP_PATH}`);
				resolve(this.actualPort);
			});
		});
	}

	/** Stop listening and close all sessions. */
	async stop(): Promise<void> {
		for (const [sid, transport] of this.transports) {
			try {
				await transport.close();
			} catch {
				// best-effort
			}
			this.transports.delete(sid);
		}
		const server = this.server;
		this.server = null;
		this.actualPort = 0;
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	getPort(): number {
		return this.actualPort;
	}

	/** Full MCP endpoint URL (null before start). */
	getUrl(): string | null {
		if (this.actualPort === 0) return null;
		return `http://127.0.0.1:${this.actualPort}${MCP_PATH}`;
	}

	private isAuthorized(req: IncomingMessage): boolean {
		if (!this.config.authToken) return true;
		const header = req.headers["authorization"];
		return header === `Bearer ${this.config.authToken}`;
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = req.url ?? "";
		if (!url.startsWith(MCP_PATH)) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "not_found" }));
			return;
		}

		if (!this.isAuthorized(req)) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}

		try {
			if (req.method === "POST") {
				await this.handlePost(req, res);
			} else if (req.method === "GET" || req.method === "DELETE") {
				await this.handleSession(req, res);
			} else {
				res.writeHead(405, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "method_not_allowed" }));
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.onLog?.("error", `CUA MCP request failed: ${message}`);
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: { code: -32603, message: "Internal server error" },
						id: null,
					}),
				);
			}
		}
	}

	private readBody(req: IncomingMessage): Promise<unknown> {
		return new Promise((resolve, reject) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
				if (body.length > 8_000_000) {
					reject(new Error("payload_too_large"));
					req.destroy();
				}
			});
			req.on("end", () => {
				if (!body) {
					resolve(undefined);
					return;
				}
				try {
					resolve(JSON.parse(body));
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			req.on("error", reject);
		});
	}

	private async handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const parsedBody = await this.readBody(req);
		const sessionIdHeader = req.headers["mcp-session-id"];
		const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;

		if (sessionId && this.transports.has(sessionId)) {
			const transport = this.transports.get(sessionId)!;
			await transport.handleRequest(req, res, parsedBody);
			return;
		}

		if (!sessionId && isInitializeRequest(parsedBody)) {
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (sid) => {
					this.transports.set(sid, transport);
				},
			});

			transport.onclose = () => {
				const sid = transport.sessionId;
				if (sid) this.transports.delete(sid);
			};

			const server = createCuaMcpServer(this.deps.engine, this.deps.gate, { cuaEnabled: this.deps.cuaEnabled?.() ?? true, browser: this.deps.browser });
			await server.connect(transport);
			await transport.handleRequest(req, res, parsedBody);
			return;
		}

		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32000, message: "Bad Request: No valid session ID provided" },
				id: null,
			}),
		);
	}

	private async handleSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const sessionIdHeader = req.headers["mcp-session-id"];
		const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;
		const transport = sessionId ? this.transports.get(sessionId) : undefined;

		if (!transport) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "invalid_or_missing_session" }));
			return;
		}

		await transport.handleRequest(req, res);
	}
}
