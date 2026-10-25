/** Loopback-only stateless Streamable HTTP. The SDK owns MCP, this layer owns HTTP limits/auth. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_REQUESTS = 4;

export class PiDeckMcpHttpServer {
	private server?: Server;
	private port = 0;
	private active = 0;
	private stopped = false;
	constructor(
		private readonly token: string,
		private readonly createProtocol: () => McpServer,
		private readonly warn: (code: string) => void,
	) {}

	/** Bind only IPv4 loopback; port zero allocates once, the service persists the chosen port. */
	async start(port: number): Promise<number> {
		const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
			void this.handle(req, res).catch(() => {
				this.warn("request-failed");
				if (!res.headersSent) res.writeHead(500);
				res.end();
			});
		});
		this.server = server;
		server.maxConnections = 32;
		server.keepAliveTimeout = 1000;
		server.on("error", () => this.warn("listener-failed"));
		await new Promise<void>((resolve, reject) => {
			const failed = () => reject(new Error("listen-failed"));
			server.once("error", failed);
			server.listen(port, "127.0.0.1", () => {
				server.off("error", failed);
				resolve();
			});
		});
		const address = server.address();
		if (this.stopped || !address || typeof address === "string") {
			await this.stop();
			throw new Error("access-revoked");
		}
		this.port = address.port;
		return this.port;
	}

	/** Revoke existing keep-alive/in-flight sockets as well as accepting connections. */
	async stop(): Promise<void> {
		this.stopped = true;
		const server = this.server;
		if (!server) return;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		const reject = (status: number) => {
			res.setHeader("Connection", "close");
			res.writeHead(status).end();
		};
		// Reject browser origins entirely; no CORS or ambient-cookie authentication.
		if (this.stopped || req.headers.host !== `127.0.0.1:${this.port}` || req.headers.origin !== undefined) return reject(403);
		const expected = Buffer.from(`Bearer ${this.token}`);
		const supplied = Buffer.from(req.headers.authorization ?? "");
		if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return reject(401);
		if (req.url !== "/mcp") return reject(404);
		if (req.method !== "POST") {
			res.setHeader("Allow", "POST");
			return reject(405);
		}
		if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return reject(415);
		if (this.active >= MAX_REQUESTS) return reject(429);
		if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return reject(413);
		this.active++;
		res.setTimeout(30_000, () => res.destroy());
		req.setTimeout(10_000, () => req.destroy());
		let protocol: McpServer | undefined;
		try {
			let bytes = 0;
			const chunks: Buffer[] = [];
			for await (const chunk of req) {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				bytes += buffer.length;
				if (bytes > MAX_BODY_BYTES) return reject(413);
				chunks.push(buffer);
			}
			let body: unknown;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				return reject(400);
			}
			if (this.stopped || res.destroyed) return;
			// Batches would bypass request concurrency limits; MCP 2025-06-18+ is single-message.
			if (!body || typeof body !== "object" || Array.isArray(body)) return reject(400);
			protocol = this.createProtocol();
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
			// Keep ownership until bounded IO settles, even after a disconnect. Closing the SDK
			// early aborts its response and strands JSON-mode handleRequest's pending promise.
			await protocol.connect(transport);
			await transport.handleRequest(req, res, body);
		} finally {
			this.active--;
			await protocol?.close().catch(() => undefined);
		}
	}
}
