import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type {
	AgentTab,
	AgentRuntimeState,
	AvailableModel,
	AppSettings,
	ChatMessage,
	CreateAgentInput,
	Project,
	SendPromptInput,
	SendPromptResult,
	SessionSummary,
} from "../../shared/types";

type WebServiceSettings = Pick<
	AppSettings,
	"webServiceEnabled" | "webServiceHost" | "webServicePort"
>;

type WebServiceDependencies = {
	listProjects: () => Project[];
	listAgents: () => AgentTab[];
	listSessions: (projectId: string) => Promise<SessionSummary[]>;
	getMessages: (agentId: string) => ChatMessage[];
	createAgent: (input: CreateAgentInput) => Promise<AgentTab>;
	sendPrompt: (input: SendPromptInput) => Promise<SendPromptResult>;
	stopAgent: (agentId: string) => Promise<void>;
	runtimeState: (agentId: string) => Promise<AgentRuntimeState>;
	cycleModel: (agentId: string) => Promise<AgentRuntimeState>;
	availableModels: (agentId: string) => Promise<AvailableModel[]>;
	setModel: (agentId: string, provider: string, modelId: string) => Promise<AgentRuntimeState>;
	cycleThinking: (agentId: string) => Promise<AgentRuntimeState>;
	setThinking: (agentId: string, level: string) => Promise<AgentRuntimeState>;
};

export class WebServiceManager {
	private server: Server | null = null;
	private current: { host: string; port: number } | null = null;
	private readonly rendererRoot = join(__dirname, "../renderer");

	constructor(private readonly deps: WebServiceDependencies) {}

	async applySettings(settings: WebServiceSettings) {
		if (!settings.webServiceEnabled) {
			await this.stop();
			return;
		}

		const host = settings.webServiceHost.trim() || "0.0.0.0";
		const port = this.normalizePort(settings.webServicePort);
		if (this.server && this.current?.host === host && this.current.port === port) return;
		await this.stop();
		await this.start(host, port);
	}

	async stop() {
		if (!this.server) return;
		const server = this.server;
		this.server = null;
		this.current = null;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	private async start(host: string, port: number) {
		const server = createServer(async (request, response) => {
			try {
				await this.handleRequest(request, response, host, port, server);
			} catch (error) {
				this.sendError(response, 500, error instanceof Error ? error.message : String(error));
			}
		});

		server.on("clientError", (_error, socket) => {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
		});

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		this.server = server;
		this.current = { host, port: this.getPort(server, port) };
	}

	private async handleRequest(
		request: IncomingMessage,
		response: ServerResponse,
		host: string,
		port: number,
		server: Server,
	) {
			const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
			if (request.method === "OPTIONS") {
				this.sendNoContent(response);
				return;
			}

			if (url.pathname === "/api/health") {
				this.sendJson(response, {
					ok: true,
					service: "PiDeck",
					host,
					port: this.getPort(server, port),
				});
				return;
			}
			if (url.pathname === "/api/state") {
				this.sendJson(response, this.getState());
				return;
			}
			const sessionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
			if (sessionsMatch && request.method === "GET") {
				const sessions = await this.deps.listSessions(decodeURIComponent(sessionsMatch[1]));
				this.sendJson(response, { sessions });
				return;
			}
			if (url.pathname === "/api/agents" && request.method === "POST") {
				const body = await this.readJson<{ projectId?: string }>(request);
				if (!body.projectId) {
					this.sendError(response, 400, "projectId 不能为空");
					return;
				}
				const agent = await this.deps.createAgent({ projectId: body.projectId });
				this.sendJson(response, { agent });
				return;
			}
			const promptMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/prompt$/);
			if (promptMatch && request.method === "POST") {
				const body = await this.readJson<Omit<SendPromptInput, "agentId">>(request);
				const message = body.message?.trim() ?? "";
				if (!message && !body.images?.length) {
					this.sendError(response, 400, "message 或 images 不能为空");
					return;
				}
				const result = await this.deps.sendPrompt({
					...body,
					agentId: decodeURIComponent(promptMatch[1]),
					message,
				});
				// prompt endpoint is a transport for SendPromptResult. Semantic rejection is still
				// a successful HTTP exchange so browser clients can distinguish rejected from
				// post-write unknown instead of collapsing both into a thrown fetch error.
				this.sendJson(response, { result });
				return;
			}
			const stopMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/stop$/);
			if (stopMatch && request.method === "POST") {
				await this.deps.stopAgent(decodeURIComponent(stopMatch[1]));
				this.sendJson(response, { ok: true });
				return;
			}
			const runtimeMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/runtime$/);
			if (runtimeMatch && request.method === "GET") {
				const state = await this.deps.runtimeState(decodeURIComponent(runtimeMatch[1]));
				this.sendJson(response, { state });
				return;
			}
			const cycleModelMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/cycle-model$/);
			if (cycleModelMatch && request.method === "POST") {
				const state = await this.deps.cycleModel(decodeURIComponent(cycleModelMatch[1]));
				this.sendJson(response, { state });
				return;
			}
			const modelsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/models$/);
			if (modelsMatch && request.method === "GET") {
				const models = await this.deps.availableModels(decodeURIComponent(modelsMatch[1]));
				this.sendJson(response, { models });
				return;
			}
			const setModelMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/model$/);
			if (setModelMatch && request.method === "POST") {
				const body = await this.readJson<{ provider?: string; modelId?: string }>(request);
				const state = await this.deps.setModel(
					decodeURIComponent(setModelMatch[1]),
					body.provider ?? "",
					body.modelId ?? "",
				);
				this.sendJson(response, { state });
				return;
			}
			const cycleThinkingMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/cycle-thinking$/);
			if (cycleThinkingMatch && request.method === "POST") {
				const state = await this.deps.cycleThinking(decodeURIComponent(cycleThinkingMatch[1]));
				this.sendJson(response, { state });
				return;
			}
			const setThinkingMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/thinking$/);
			if (setThinkingMatch && request.method === "POST") {
				const body = await this.readJson<{ level?: string }>(request);
				const state = await this.deps.setThinking(decodeURIComponent(setThinkingMatch[1]), body.level ?? "");
				this.sendJson(response, { state });
				return;
			}
			if (url.pathname.startsWith("/api/")) {
				this.sendError(response, 404, "API 不存在");
				return;
			}

			await this.serveRenderer(url.pathname, response);
	}

	private getState() {
		const agents = this.deps.listAgents();
		const messagesByAgent = Object.fromEntries(
			agents.map((agent) => [agent.id, this.deps.getMessages(agent.id)]),
		);
		return {
			projects: this.deps.listProjects(),
			agents,
			messagesByAgent,
		};
	}

	private renderPage() {
		return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>PiDeck Web Service</title>
	<style>
		:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
		body { margin: 0; background: #f4f6f8; color: #252a31; }
		.app { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 100vh; }
		aside { border-right: 1px solid #dfe5ee; background: #fff; padding: 16px; overflow: auto; }
		main { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; }
		header { min-height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 18px; border-bottom: 1px solid #dfe5ee; background: #fff; }
		h1 { margin: 0; font-size: 16px; }
		.status { font-size: 12px; color: #687280; }
		.list { display: grid; gap: 8px; }
		button { border: 1px solid #d7dce4; background: #fff; border-radius: 8px; padding: 8px 10px; color: #252a31; cursor: pointer; transition: transform .12s ease, border-color .12s ease, background .12s ease, opacity .12s ease; }
		button:hover:not(:disabled) { transform: translateY(-1px); border-color: #b8c2d0; }
		button.primary { border-color: #14a514; background: #14a514; color: #fff; min-width: 88px; font-weight: 700; }
		button.primary:hover:not(:disabled) { background: #129212; border-color: #129212; }
		button.danger { color: #d93025; border-color: #f1b9b9; background: #fff7f7; }
		button.ghost { color: #687280; background: #f8fafc; }
		.header-actions { display: flex; align-items: center; gap: 8px; }
		.header-actions button { height: 34px; padding: 0 12px; }
		button:disabled { opacity: .6; cursor: not-allowed; }
		.item { text-align: left; display: grid; gap: 3px; min-width: 0; }
		.item.loading { border-color: #14a514; background: #f0fdf4; }
		.item.active { border-color: #14a514; box-shadow: 0 0 0 2px rgba(20,165,20,.12); }
		.item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.item small { color: #687280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.section-title { margin: 18px 0 8px; color: #687280; font-size: 12px; font-weight: 700; }
		.agent-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: stretch; }
		.close-agent { padding: 0 10px; font-size: 12px; }
		.messages { overflow: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
		.message { max-width: min(820px, 88%); border: 1px solid #dfe5ee; background: #fff; border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; line-height: 1.55; }
		.message.user { align-self: flex-end; background: #eaf8ee; border-color: #bee8c6; }
		.message.error { border-color: #ffd0d0; background: #fff4f4; color: #b42318; }
		.role { display: block; margin-bottom: 4px; font-size: 11px; font-weight: 700; color: #687280; }
		.composer { display: grid; gap: 8px; padding: 12px; border-top: 1px solid #dfe5ee; background: #fff; }
		.composer-box { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; border: 1px solid #d7dce4; border-radius: 10px; padding: 8px; background: #fff; }
		textarea { width: 100%; min-height: 44px; max-height: 160px; resize: vertical; border: 0; outline: 0; padding: 6px 8px; font: inherit; line-height: 1.5; }
		.composer-actions { display: flex; align-items: center; gap: 8px; }
		.composer-hint { color: #8a94a6; font-size: 12px; padding-left: 4px; }
		.empty { margin: auto; color: #687280; text-align: center; }
		.pulse { display: inline-flex; width: 8px; height: 8px; border-radius: 999px; background: #14a514; animation: pulse 1s infinite ease-in-out; margin-right: 6px; }
		@keyframes pulse { 0%, 100% { opacity: .35; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
		@media (max-width: 760px) { .app { grid-template-columns: 1fr; } aside { max-height: 42vh; border-right: 0; border-bottom: 1px solid #dfe5ee; } }
	</style>
</head>
<body>
	<div class="app">
		<aside>
			<h1>PiDeck</h1>
			<div class="section-title">项目</div>
			<div id="projects" class="list"></div>
			<div class="section-title">Agent</div>
			<div id="agents" class="list"></div>
		</aside>
		<main>
			<header>
				<h1 id="title">选择或创建 Agent</h1>
				<div class="header-actions">
					<span id="status" class="status">连接中...</span>
					<button class="danger" type="button" id="stop">关闭 Agent</button>
				</div>
			</header>
			<div id="messages" class="messages"><div class="empty">从左侧选择项目创建 Agent，或选择现有 Agent。</div></div>
			<form id="composer" class="composer">
				<div class="composer-box">
					<textarea id="prompt" placeholder="发送消息到当前 Agent"></textarea>
					<div class="composer-actions">
						<button class="primary" type="submit">发送</button>
					</div>
				</div>
				<div class="composer-hint">Enter 发送，Shift/Ctrl + Enter 换行</div>
			</form>
		</main>
	</div>
	<script>
		let state = { projects: [], agents: [], messagesByAgent: {} };
		let activeAgentId = "";
		let creatingProjectId = "";
		let refreshing = false;
		const el = (id) => document.getElementById(id);
		async function api(path, options) {
			const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
			if (!res.ok) throw new Error((await res.json()).error || res.statusText);
			return res.json();
		}
		async function refresh() {
			if (refreshing) return;
			refreshing = true;
			try {
				state = await api("/api/state");
				if (!activeAgentId && state.agents[0]) activeAgentId = state.agents[0].id;
				render();
				el("status").textContent = "已连接";
			} catch (error) {
				el("status").textContent = error.message || String(error);
			} finally {
				refreshing = false;
			}
		}
		function render() {
			el("projects").innerHTML = state.projects.map(project => \`
				<button class="item \${project.id === creatingProjectId ? "loading" : ""}" data-project="\${project.id}" \${creatingProjectId ? "disabled" : ""}>
					<strong>\${escapeHtml(project.name)}</strong>
					<small>\${project.id === creatingProjectId ? '<span class="pulse"></span>正在打开...' : escapeHtml(project.path)}</small>
				</button>\`).join("");
			el("agents").innerHTML = state.agents.map(agent => \`
				<div class="agent-row">
					<button class="item \${agent.id === activeAgentId ? "active" : ""}" data-agent="\${agent.id}">
						<strong>\${escapeHtml(agent.title)}</strong>
						<small>\${agent.status === "running" ? '<span class="pulse"></span>' : ""}\${agent.status} · \${escapeHtml(agent.cwd)}</small>
					</button>
					<button class="close-agent ghost" data-close-agent="\${agent.id}" title="关闭 Agent">关闭</button>
				</div>\`).join("");
			const agent = state.agents.find(item => item.id === activeAgentId);
			el("title").textContent = agent ? agent.title : "选择或创建 Agent";
			el("status").innerHTML = agent?.status === "running" ? '<span class="pulse"></span>正在响应...' : (agent ? agent.status : "已连接");
			const messages = activeAgentId ? state.messagesByAgent[activeAgentId] || [] : [];
			el("messages").innerHTML = messages.length
				? messages.map(message => \`<div class="message \${message.role}"><span class="role">\${message.role}</span>\${escapeHtml(message.text || "")}</div>\`).join("")
				: '<div class="empty">暂无消息</div>';
			el("prompt").disabled = !agent;
			el("composer").querySelector("button[type=submit]").disabled = !agent;
			el("stop").disabled = !agent || agent.status === "closed";
			el("stop").textContent = agent?.status === "running" ? "停止响应" : "关闭 Agent";
		}
		document.addEventListener("click", async (event) => {
			const closeButton = event.target.closest("[data-close-agent]");
			if (closeButton) {
				const agentId = closeButton.dataset.closeAgent;
				closeButton.disabled = true;
				closeButton.textContent = "关闭中";
				try {
					await api(\`/api/agents/\${encodeURIComponent(agentId)}/stop\`, { method: "POST" });
					if (activeAgentId === agentId) activeAgentId = "";
					await refresh();
				} finally {
					closeButton.disabled = false;
					closeButton.textContent = "关闭";
				}
				return;
			}
			const projectButton = event.target.closest("[data-project]");
			if (projectButton) {
				creatingProjectId = projectButton.dataset.project;
				render();
				try {
					const result = await api("/api/agents", { method: "POST", body: JSON.stringify({ projectId: projectButton.dataset.project }) });
					activeAgentId = result.agent.id;
					await refresh();
				} finally {
					creatingProjectId = "";
					render();
				}
				return;
			}
			const agentButton = event.target.closest("[data-agent]");
			if (agentButton) {
				activeAgentId = agentButton.dataset.agent;
				render();
			}
		});
		el("composer").addEventListener("submit", async (event) => {
			event.preventDefault();
			const prompt = el("prompt");
			const message = prompt.value.trim();
			if (!message || !activeAgentId) return;
			const targetAgentId = activeAgentId;
			prompt.value = "";
			try {
				const response = await api(\`/api/agents/\${encodeURIComponent(targetAgentId)}/prompt\`, { method: "POST", body: JSON.stringify({ message }) });
				if (!response.result.accepted) {
					if (response.result.delivery !== "unknown" && activeAgentId === targetAgentId) {
						prompt.value = message;
					}
					throw new Error(response.result.error);
				}
				await refresh();
			} catch (error) {
				// Only transport errors reach this branch. The request may already have been
				// accepted, so restoring an apparently retryable draft could duplicate it.
				throw error;
			}
		});
		el("prompt").addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return;
			event.preventDefault();
			el("composer").requestSubmit();
		});
		el("stop").addEventListener("click", async () => {
			if (!activeAgentId) return;
			el("stop").disabled = true;
			el("stop").textContent = "处理中";
			try {
				await api(\`/api/agents/\${encodeURIComponent(activeAgentId)}/stop\`, { method: "POST" });
				activeAgentId = "";
				await refresh();
			} finally {
				el("stop").textContent = "关闭 Agent";
			}
		});
		function escapeHtml(value) {
			return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
		}
		refresh();
		setInterval(refresh, 600);
	</script>
</body>
</html>`;
	}

	private async serveRenderer(pathname: string, response: ServerResponse) {
		const requestedPath = decodeURIComponent(pathname);
		const relativePath = requestedPath === "/" || !extname(requestedPath)
			? "index.html"
			: requestedPath.replace(/^\/+/, "");
		const filePath = normalize(join(this.rendererRoot, relativePath));
		if (!filePath.startsWith(normalize(this.rendererRoot)) || !existsSync(filePath)) {
			if (relativePath !== "index.html" && existsSync(join(this.rendererRoot, "index.html"))) {
				return this.sendFile(join(this.rendererRoot, "index.html"), response);
			}
			this.sendHtml(response, this.renderPage());
			return;
		}
		await this.sendFile(filePath, response);
	}

	private async sendFile(filePath: string, response: ServerResponse) {
		const body = await readFile(filePath);
		response.writeHead(200, {
			"content-type": this.contentType(filePath),
			"cache-control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
		});
		response.end(body);
	}

	private sendHtml(response: ServerResponse, html: string) {
		response.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		});
		response.end(html);
	}

	private contentType(filePath: string) {
		switch (extname(filePath).toLowerCase()) {
			case ".html":
				return "text/html; charset=utf-8";
			case ".js":
				return "text/javascript; charset=utf-8";
			case ".css":
				return "text/css; charset=utf-8";
			case ".svg":
				return "image/svg+xml";
			case ".png":
				return "image/png";
			case ".ico":
				return "image/x-icon";
			default:
				return "application/octet-stream";
		}
	}

	private sendJson(response: ServerResponse, body: unknown) {
		response.writeHead(200, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"access-control-allow-origin": "*",
		});
		response.end(JSON.stringify(body));
	}

	private sendError(response: ServerResponse, statusCode: number, error: string) {
		response.writeHead(statusCode, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"access-control-allow-origin": "*",
		});
		response.end(JSON.stringify({ error }));
	}

	private sendNoContent(response: ServerResponse) {
		response.writeHead(204, {
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET,POST,OPTIONS",
			"access-control-allow-headers": "content-type",
		});
		response.end();
	}

	private async readJson<T>(request: IncomingMessage) {
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		if (chunks.length === 0) return {} as T;
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
	}

	private getPort(server: Server, fallback: number) {
		const address = server.address();
		return typeof address === "object" && address ? (address as AddressInfo).port : fallback;
	}

	private normalizePort(value: number) {
		const port = Number(value);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error("Web 服务端口必须是 1-65535 之间的整数");
		}
		return port;
	}
}
