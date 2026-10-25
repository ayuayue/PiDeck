/**
 * Web 服务的 API 路由表（从 WebServiceManager.handleRequest 按域迁出）。
 *
 * 保持原有**顺序**逐条匹配（顺序即优先级：/api/state 先于 /api/sessions/*，工作区
 * 路由最后兜底），命中即 return true；未命中返回 false 交给宿主继续（工作区路由 + 404）。
 * 所有运行时能力经 port 注入，本模块不持有服务生命周期状态。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRuntimeState, CreateAnonymousSessionInput, CreateSessionDraftInput, ImageContent, SendSessionPromptInput, SessionRuntimeTarget, SessionUiResponseInput, UpdateSessionRecordInput } from "../../shared/types";
import { readBoundedFile } from "./WebHttpResponders";
import { ifNoneMatchHits, stateEtag } from "./WebStateEtag";
import type { WebServiceDependencies } from "./WebServiceManager";

const CHAT_IMAGE_MAX_COUNT = 4;
const CHAT_IMAGE_MAX_BASE64_BYTES = 2 * 1024 * 1024;

/**
 * 从 useChat 提交的 user 消息 parts 里提取图片（type=file）转 ImageContent。
 * data 兼容三种形态：data URL（data:<mime>;base64,<payload>，AI SDK v5+
 * 的 file part 把它放在 url 字段）、裸 base64；非 image/* 媒体、超限图片
 * 直接丢弃，不影响文本轮次。
 */
export function extractChatImages(parts: Array<{ type?: string; mediaType?: string; data?: string; url?: string }>): ImageContent[] {
	const images: ImageContent[] = [];
	for (const part of parts) {
		const raw = typeof part.data === "string" && part.data ? part.data : typeof part.url === "string" ? part.url : "";
		if (part.type !== "file" || !raw) continue;
		if (images.length >= CHAT_IMAGE_MAX_COUNT) break;
		let mimeType = typeof part.mediaType === "string" ? part.mediaType : "";
		let payload = raw;
		const dataUrlMatch = raw.match(/^data:([^;]+);base64,(.*)$/s);
		if (dataUrlMatch) {
			mimeType = mimeType || dataUrlMatch[1];
			payload = dataUrlMatch[2];
		}
		if (!mimeType.startsWith("image/")) continue;
		if (payload.length > CHAT_IMAGE_MAX_BASE64_BYTES) continue;
		images.push({ type: "image", mimeType, data: payload });
	}
	return images;
}

/** 路由需要宿主提供的能力面（manager 用薄箭头函数适配；private 成员不进接口）。 */
export type WebApiRoutesPort = {
	deps: WebServiceDependencies;
	sendJson: (response: ServerResponse, body: unknown, extraHeaders?: Record<string, string>) => void;
	sendError: (response: ServerResponse, statusCode: number, code: string, error: string, params?: Record<string, string | number>) => void;
	sendNoContent: (response: ServerResponse) => void;
	readJson: <T>(request: IncomingMessage, maxBytes?: number) => Promise<T>;
	/** /api/state 载荷：这里只声明 ETag 需要的字段面，具体结构由装配层决定。 */
	getState: () => Promise<{ projects?: unknown[]; sessions?: unknown[]; runtimes?: unknown[]; pendingUiRequests?: unknown[] }>;
	queryNumber: (url: URL, key: string) => number | undefined;
	runtimeAgentIdForSession: (sessionId: string) => string | undefined;
	runtimeTargetForSession: (sessionId: string) => SessionRuntimeTarget | undefined;
	executeRestartWithProgress: (target: SessionRuntimeTarget, response: ServerResponse) => Promise<void>;
	handleStream: (sessionId: string, request: IncomingMessage, response: ServerResponse, options?: { keepAlive?: boolean }) => void;
	writeStreamError: (response: ServerResponse, errorText: string) => void;
};

export class WebApiRoutes {
	private readonly deps: WebServiceDependencies;
	private readonly sendJson: WebApiRoutesPort["sendJson"];
	private readonly sendError: WebApiRoutesPort["sendError"];
	private readonly sendNoContent: WebApiRoutesPort["sendNoContent"];
	private readonly readJson: WebApiRoutesPort["readJson"];
	private readonly getState: WebApiRoutesPort["getState"];
	private readonly queryNumber: WebApiRoutesPort["queryNumber"];
	private readonly runtimeAgentIdForSession: WebApiRoutesPort["runtimeAgentIdForSession"];
	private readonly runtimeTargetForSession: WebApiRoutesPort["runtimeTargetForSession"];
	private readonly executeRestartWithProgress: WebApiRoutesPort["executeRestartWithProgress"];
	private readonly handleStream: WebApiRoutesPort["handleStream"];
	private readonly writeStreamError: WebApiRoutesPort["writeStreamError"];

	constructor(port: WebApiRoutesPort) {
		this.deps = port.deps;
		this.sendJson = port.sendJson;
		this.sendError = port.sendError;
		this.sendNoContent = port.sendNoContent;
		this.readJson = port.readJson;
		this.getState = port.getState;
		this.queryNumber = port.queryNumber;
		this.runtimeAgentIdForSession = port.runtimeAgentIdForSession;
		this.runtimeTargetForSession = port.runtimeTargetForSession;
		this.executeRestartWithProgress = port.executeRestartWithProgress;
		this.handleStream = port.handleStream;
		this.writeStreamError = port.writeStreamError;
	}

	async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (url.pathname === "/api/state") {
			const state = await this.getState();
			// 条件请求：载荷含全部会话投影（500+ 条约 228KB），而轮询窗口内目录多半没变。
			// 未变化时回 304，客户端保留原状态——空闲流量从每 10s 228KB 降到几十字节。
			const etag = stateEtag(state);
			if (ifNoneMatchHits(request.headers["if-none-match"], etag)) {
				response.writeHead(304, { etag, "cache-control": "no-store" });
				response.end();
				return true;
			}
			this.sendJson(response, state, { etag });
			return true;
		}
		if (url.pathname === "/api/ui-response" && request.method === "POST") {
			const body = await this.readJson<Partial<SessionUiResponseInput>>(request);
			const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
			const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
			const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
			const runtimeGeneration = typeof body.runtimeGeneration === "number" ? body.runtimeGeneration : NaN;
			if (!sessionId || !requestId || !agentId || !Number.isFinite(runtimeGeneration)) {
				this.sendError(response, 400, "webError.requestIdRequired", "ui response target is required");
				return true;
			}
			try {
				await this.deps.respondToUi({
					sessionId,
					requestId,
					agentId,
					runtimeGeneration,
					response: body.response ?? {},
				});
				this.sendJson(response, { ok: true });
			} catch (error) {
				this.sendError(response, 409, "webError.runtimeTargetRequired", error instanceof Error ? error.message : "ui response rejected");
			}
			return true;
		}
		if (url.pathname === "/api/models" && request.method === "GET") {
			// force=1：目标端 UI 点刷新时绕过模型列表缓存，重新 fork pi --list-models。
			const force = url.searchParams.get("force") === "1";
			this.sendJson(response, { models: await this.deps.listModels(force) });
			return true;
		}
		if (url.pathname === "/api/projects" && request.method === "POST") {
			const body = await this.readJson<{ path?: string }>(request);
			const path = body.path?.trim() ?? "";
			if (!path) {
				this.sendError(response, 400, "webError.projectPathRequired", "path is required");
				return true;
			}
			const project = await this.deps.createProject(path);
			this.sendJson(response, { project });
			return true;
		}
		const deleteProjectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/delete$/);
		if (deleteProjectMatch && request.method === "POST") {
			const projectId = decodeURIComponent(deleteProjectMatch[1]);
			const project = this.deps.listProjects().find((item) => item.id === projectId);
			if (!project) {
				this.sendError(response, 404, "webError.projectNotFound", "project not found");
				return true;
			}
			if (project.kind === "chat") {
				this.sendError(response, 400, "webError.chatProjectProtected", "the built-in chat project cannot be deleted");
				return true;
			}
			const deleted = await this.deps.deleteProject(projectId);
			this.sendJson(response, { deleted });
			return true;
		}
		const sessionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
		if (sessionsMatch && request.method === "GET") {
			const sessions = await this.deps.listSessions(decodeURIComponent(sessionsMatch[1]));
			this.sendJson(response, { sessions });
			return true;
		}
		const catalogSessionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions\/catalog$/);
		if (catalogSessionsMatch && request.method === "GET") {
			const sessions = await this.deps.listCatalogSessions(decodeURIComponent(catalogSessionsMatch[1]));
			this.sendJson(response, { sessions });
			return true;
		}
		// ── 会话活动监控 strips：子代理/todo，与桌面 IPC 同源数据 ──
		const subagentsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/subagents$/);
		if (subagentsMatch && request.method === "GET") {
			if (!this.deps.listSessionSubagents) {
				this.sendError(response, 503, "webError.stripsUnavailable", "session subagents are not available");
				return true;
			}
			this.sendJson(response, { subagents: await this.deps.listSessionSubagents(decodeURIComponent(subagentsMatch[1])) });
			return true;
		}
		// 会话内全文检索（全会话，不限已加载历史）：与桌面端 Ctrl+Shift+F 同源。
		// 未装配 / 索引未就绪一律 200 + `{ result: null }`，前端据此回退本地已加载搜索
		// 并提示「仅搜索已加载消息」；不返回 503，避免前端把「可降级」当成错误弹 toast。
		const sessionSearchMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/search$/);
		if (sessionSearchMatch && request.method === "GET") {
			const query = (url.searchParams.get("q") ?? "").trim();
			const search = this.deps.searchSessionMessages;
			if (!search || !query || query.length > 256) {
				this.sendJson(response, { result: null });
				return true;
			}
			let result = null;
			try {
				result = await search(decodeURIComponent(sessionSearchMatch[1]), query);
			} catch {
				// 检索失败按「不可用」降级（与索引未就绪同形态），不影响会话本身
				result = null;
			}
			this.sendJson(response, { result });
			return true;
		}
		// 供应商额度/余额用量（与桌面圆球面板同源）：usage probe 是用户显式开关的能力，
		// 「未装配 / 未开启 / 供应商无端点」都是正常态而非故障——一律 200 + success=false，
		// 前端据此不渲染额度区块（与桌面 ProviderUsageDetails 的 disabled 分支同语义）。
		const usageMatch = url.pathname.match(/^\/api\/usage\/([^/]+)$/);
		if (usageMatch && request.method === "GET") {
			const provider = decodeURIComponent(usageMatch[1]).trim();
			const backend = url.searchParams.get("backend") === "dsh" ? "dsh" : "pi";
			const probe = this.deps.fetchProviderUsage;
			if (!probe || !provider || provider.length > 128) {
				this.sendJson(response, { result: { success: false, provider, disabled: true } });
				return true;
			}
			let result;
			try {
				result = await probe(provider, backend);
			} catch {
				// 探针异常（网络/解析）按「不可用」降级，不把内部错误回给浏览器
				result = { success: false, provider, disabled: true };
			}
			this.sendJson(response, { result });
			return true;
		}
		const todoMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/todo$/);
		if (todoMatch && request.method === "GET") {
			if (!this.deps.listSessionTodo) {
				this.sendError(response, 503, "webError.stripsUnavailable", "session todo is not available");
				return true;
			}
			this.sendJson(response, { todo: (await this.deps.listSessionTodo(decodeURIComponent(todoMatch[1]))) ?? null });
			return true;
		}
		// ── DSH 工具面板路由（S6.3：goals/subagents/skills；无活跃 runtime 返回空）──
		const dshSubagentsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/dsh\/subagents$/);
		if (dshSubagentsMatch && request.method === "GET") {
			const agentId = this.runtimeAgentIdForSession(decodeURIComponent(dshSubagentsMatch[1]));
			if (!agentId || !this.deps.listDshSubagents) {
				this.sendJson(response, { subagents: [] });
				return true;
			}
			this.sendJson(response, { subagents: await this.deps.listDshSubagents(agentId) });
			return true;
		}
		const dshSubagentHistoryMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/dsh\/subagents\/([^/]+)\/history$/);
		if (dshSubagentHistoryMatch && request.method === "GET") {
			const agentId = this.runtimeAgentIdForSession(decodeURIComponent(dshSubagentHistoryMatch[1]));
			const childSessionId = decodeURIComponent(dshSubagentHistoryMatch[2]);
			if (!agentId || !this.deps.readDshSubagentHistory) {
				this.sendJson(response, { messages: [], hasMore: false });
				return true;
			}
			const beforeSeq = this.queryNumber(url, "beforeSeq");
			const maxMessages = this.queryNumber(url, "maxMessages");
			this.sendJson(response, await this.deps.readDshSubagentHistory(agentId, childSessionId, beforeSeq, maxMessages));
			return true;
		}
		const dshSkillsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/dsh\/skills$/);
		if (dshSkillsMatch && request.method === "GET") {
			const agentId = this.runtimeAgentIdForSession(decodeURIComponent(dshSkillsMatch[1]));
			if (!agentId || !this.deps.listDshSkills) {
				this.sendJson(response, { skills: [] });
				return true;
			}
			this.sendJson(response, { skills: await this.deps.listDshSkills(agentId) });
			return true;
		}
		const dshGoalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/dsh\/goal$/);
		if (dshGoalMatch && request.method === "GET") {
			const target = this.runtimeTargetForSession(decodeURIComponent(dshGoalMatch[1]));
			if (!target) {
				this.sendJson(response, { goal: null });
				return true;
			}
			const result = await this.deps.getSessionRuntimeState(target);
			const state = result.ok && result.value && "value" in result.value ? (result.value as { value?: AgentRuntimeState }).value : undefined;
			this.sendJson(response, { goal: state?.goal ?? null });
			return true;
		}
		// ── DSH 插件路由（S6.5：动态插件清单/安装/启停/卸载，与桌面配置页同源）──
		if (url.pathname === "/api/dsh/plugins" && request.method === "GET") {
			this.sendJson(response, {
				dynamic: this.deps.listDshDynamicPlugins ? await this.deps.listDshDynamicPlugins() : [],
				static: this.deps.listDshStaticPlugins ? await this.deps.listDshStaticPlugins() : [],
			});
			return true;
		}
		if (url.pathname === "/api/dsh/plugins/install" && request.method === "POST") {
			const body = await this.readJson<import("../../shared/types").DshPluginInstallInput>(request);
			if (!body.sessionId?.trim() || !this.deps.installDshPlugin) {
				this.sendError(response, 400, "webError.pluginInstallRequired", "plugin install requires sessionId");
				return true;
			}
			try {
				this.sendJson(response, { receipt: await this.deps.installDshPlugin(body) });
			} catch (error) {
				this.sendError(response, 400, "webError.pluginInstallFailed", error instanceof Error ? error.message : "plugin install failed");
			}
			return true;
		}
		const dshPluginActionMatch = url.pathname.match(/^\/api\/dsh\/plugins\/([^/]+)\/(run|stop|uninstall)$/);
		if (dshPluginActionMatch && request.method === "POST") {
			const pluginId = decodeURIComponent(dshPluginActionMatch[1]);
			const action = dshPluginActionMatch[2];
			const body = await this.readJson<{ sessionId?: string; packageId?: string }>(request);
			if (!body.sessionId?.trim()) {
				this.sendError(response, 400, "webError.pluginActionRequired", "plugin action requires sessionId");
				return true;
			}
			const fn = action === "run" ? this.deps.runDshPlugin : action === "stop" ? this.deps.stopDshPlugin : this.deps.uninstallDshPlugin;
			if (!fn) {
				this.sendError(response, 400, "webError.pluginUnavailable", "DSH plugins are not available");
				return true;
			}
			try {
				this.sendJson(response, {
					ok: true,
					value: await fn({
						sessionId: body.sessionId,
						pluginId,
						...(typeof body.packageId === "string" ? { packageId: body.packageId } : {}),
					}),
				});
			} catch (error) {
				this.sendError(response, 400, "webError.pluginActionFailed", error instanceof Error ? error.message : `plugin ${action} failed`);
			}
			return true;
		}
		if (url.pathname === "/api/sessions/runtimes" && request.method === "GET") {
			this.sendJson(response, { runtimes: this.deps.listSessionRuntimes() });
			return true;
		}
		if (url.pathname === "/api/sessions" && request.method === "POST") {
			const body = await this.readJson<CreateSessionDraftInput>(request);
			if (!body.projectId?.trim()) {
				this.sendError(response, 400, "webError.projectIdRequired", "projectId is required");
				return true;
			}
			const session = await this.deps.createSessionDraft(body);
			this.sendJson(response, { session });
			return true;
		}
		if (url.pathname === "/api/sessions/anonymous" && request.method === "POST") {
			const body = await this.readJson<CreateAnonymousSessionInput>(request);
			if (!body.projectId?.trim()) {
				this.sendError(response, 400, "webError.projectIdRequired", "projectId is required");
				return true;
			}
			const result = await this.deps.createAnonymousSession(body);
			this.sendJson(response, result);
			return true;
		}
		const sessionRecordActionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(update|delete|copy|export-html)$/);
		if (sessionRecordActionMatch && request.method === "POST") {
			const sessionId = decodeURIComponent(sessionRecordActionMatch[1]);
			const action = sessionRecordActionMatch[2];
			if (action === "update") {
				const patch = await this.readJson<UpdateSessionRecordInput>(request);
				const session = await this.deps.updateSessionRecord(sessionId, patch);
				this.sendJson(response, { session });
			} else if (action === "delete") {
				const deleted = await this.deps.deleteSessionRecord(sessionId);
				this.sendJson(response, { deleted });
			} else if (action === "copy") {
				const result = await this.deps.copySessionRecord(sessionId);
				this.sendJson(response, { result });
			} else {
				const result = await this.deps.exportSessionRecordHtml(sessionId);
				this.sendJson(response, { result });
			}
			return true;
		}
		const sessionReferenceMessagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/reference-messages$/);
		if (sessionReferenceMessagesMatch && request.method === "GET") {
			const messages = await this.deps.readSessionReferenceMessages(decodeURIComponent(sessionReferenceMessagesMatch[1]));
			this.sendJson(response, { messages });
			return true;
		}
		// GET 导出：生成 HTML 后作为附件直接下载（浏览器端无法访问服务端磁盘路径）
		const sessionExportHtmlDownloadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/export-html$/);
		if (sessionExportHtmlDownloadMatch && request.method === "GET") {
			const sessionId = decodeURIComponent(sessionExportHtmlDownloadMatch[1]);
			try {
				const { path } = await this.deps.exportSessionRecordHtml(sessionId);
				// 有界读取：导出 HTML 理论上可很大，上限 16MB，超出直接报错
				const html = await readBoundedFile(path, 16 * 1024 * 1024);
				const safeTitle = sessionId.replace(/[^\w.-]+/g, "_");
				response.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
					"content-disposition": `attachment; filename="pideck-session-${safeTitle}.html"`,
					"cache-control": "no-store",
				});
				response.end(html);
			} catch (error) {
				this.sendError(response, 500, "webError.internal", error instanceof Error ? error.message : "export failed");
			}
			return true;
		}
		const sessionMessagePageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages\/page$/);
		if (sessionMessagePageMatch && request.method === "GET") {
			const beforeValue = url.searchParams.get("before");
			const pageSizeValue = url.searchParams.get("pageSize");
			const before = beforeValue === null ? undefined : Number(beforeValue);
			const pageSize = pageSizeValue === null ? undefined : Number(pageSizeValue);
			const page = await this.deps.readSessionMessagePage(decodeURIComponent(sessionMessagePageMatch[1]), Number.isSafeInteger(before) ? before : undefined, Number.isSafeInteger(pageSize) ? pageSize : undefined);
			this.sendJson(response, page);
			return true;
		}
		const sessionMessagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
		if (sessionMessagesMatch && request.method === "GET") {
			// 有界窗口（total/windowStart/truncated 一并下发，客户端据 nextBefore 走
			// /messages/page 翻更早历史），不再一次性吐出整份历史。
			const window = await this.deps.readSessionMessages(decodeURIComponent(sessionMessagesMatch[1]));
			this.sendJson(response, {
				messages: window.messages,
				total: window.total,
				windowStart: window.windowStart,
				truncated: window.truncated,
			});
			return true;
		}
		const sessionPromptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
		if (sessionPromptMatch && request.method === "POST") {
			const sessionId = decodeURIComponent(sessionPromptMatch[1]);
			const body = await this.readJson<Omit<SendSessionPromptInput, "sessionId">>(request);
			const message = body.message?.trim() ?? "";
			if (!body.requestId?.trim()) {
				this.sendError(response, 400, "webError.requestIdRequired", "requestId is required");
				return true;
			}
			if (!message && !body.images?.length) {
				this.sendError(response, 400, "webError.messageRequired", "message or images is required");
				return true;
			}
			const result = await this.deps.sendSessionPrompt({
				...body,
				sessionId,
				message,
			});
			this.sendJson(response, { result });
			return true;
		}

		// SSE 流式端点：按 AI SDK v5 UIMessageStream 协议输出 pi agent 事件，
		// 前端提交 prompt 后订阅本端点实现打字机/思考/工具实时展示（A1）；
		// 协议与 useChat 兼容，升级 A2 时前端换成 React hook 即可，后端零改动。
		// keepAlive：本端点是 EventSource 常驻订阅（useExternalSessionStream），
		// 一轮 [DONE] 后连接保留等下一轮，消除轮间重连空窗（Ask 续答丢帧的根因）。
		const streamMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
		if (streamMatch && request.method === "GET") {
			const sessionId = decodeURIComponent(streamMatch[1]);
			this.handleStream(sessionId, request, response, { keepAlive: true });
			return true;
		}

		// AI SDK useChat 契约端点（A2）：POST body = { id: sessionId, messages, trigger, messageId }。
		// 先建立该 session 的流式连接，再发 prompt；pi 事件到达后经翻译器流式返回，
		// 前端 useChat 通过 x-vercel-ai-ui-message-stream: v1 头识别协议。
		if (url.pathname === "/api/chat" && request.method === "POST") {
			// 带图片的轮次 body 会明显变大（客户端已压缩到单图 ≤1.2MB，最多 4 张）
			const CHAT_MAX_BODY_BYTES = 8 * 1024 * 1024;
			const body = await this.readJson<{
				id?: string;
				messages?: Array<{ role?: string; content?: unknown; parts?: Array<{ type?: string; text?: string; mediaType?: string; data?: string }> }>;
				/** 本轮提交的 user 消息 id（AI SDK submit-message 必然携带）。 */
				messageId?: string;
				/** 计划模式等隐藏指令（复用桌面 composer 的 agentMessage 通道）：仅发给 pi，不进用户时间线。 */
				agentMessage?: string;
			}>(request, CHAT_MAX_BODY_BYTES);
			const sessionId = body.id?.trim();
			if (!sessionId) {
				this.sendError(response, 400, "webError.requestIdRequired", "session id is required");
				return true;
			}
			// 取最后一条 user 消息的文本（useChat 的 parts 或 content 均可）
			const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
			const partsText = (lastUser?.parts ?? [])
				.filter((part) => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text ?? "")
				.join("");
			const contentText = typeof lastUser?.content === "string" ? lastUser.content : "";
			const message = (partsText || contentText).trim();
			// 图片 parts（type=file）→ ImageContent（最多 4 张，单图 base64 ≤2MB）
			const images = extractChatImages(lastUser?.parts ?? []);
			if (!message && images.length === 0) {
				this.sendError(response, 400, "webError.messageRequired", "message is required");
				return true;
			}

			// 幂等键必须「每轮唯一」：body.id 是 useChat 的 chatId（== sessionId），每轮
			// 提交都相同。直接拿它当 requestId 会被 SessionRuntimeCoordinator 的投递缓存
			// （按 sessionId+requestId 去重，TTL 10 分钟）误判为同一请求的重试，第二轮起
			// 只返回上一轮缓存的 accepted 结果而不再派发给 pi —— Web 端没有任何响应，
			// 桌面端也不会落盘。messageId 是本轮 user 消息 id：同一轮重试保持不变（天然
			// 幂等），不同轮必然不同，正好是投递缓存需要的键；缺失时退化为一次性 UUID。
			const requestId = body.messageId?.trim() || crypto.randomUUID();

			// 先开流（事件可能在 prompt 预检返回前就到达），再发 prompt。
			this.handleStream(sessionId, request, response);
			// agentMessage 只在非空时携带；长度上限与 /prompt 端点的消息体限制对齐，防滥用注入超长隐藏指令
			const agentMessage = typeof body.agentMessage === "string" ? body.agentMessage.trim().slice(0, 64 * 1024) : "";
			const result = await this.deps
				.sendSessionPrompt({
					sessionId,
					requestId,
					message: message || " ",
					...(images.length > 0 ? { images } : {}),
					...(agentMessage ? { agentMessage } : {}),
				})
				.catch((error: unknown) => ({
					accepted: false as const,
					error: error instanceof Error ? error.message : String(error),
				}));
			if (!result.accepted) {
				// 预检拒绝：向已建立的流写入 error + finish + [DONE]，
				// 前端 useChat 会进入 error 状态并可重试。
				// 无法直接访问 router 的 entry，走响应流写协议帧。
				const errText = typeof result.error === "string" ? result.error : "Prompt was rejected";
				this.writeStreamError(response, errText);
				return true;
			}
			return true;
		}
		const sessionRuntimeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runtime\/(activate|stop|abort|restart|compact|state|commands|export-html|edit-message|delete-message|prepare-resend|models|model|thinking|permission|clone|fork|get-fork-messages|rewind-list|rewind-diff|rewind-restore)$/);
		if (sessionRuntimeMatch && request.method === "POST") {
			const sessionId = decodeURIComponent(sessionRuntimeMatch[1]);
			const action = sessionRuntimeMatch[2];
			const body = await this.readJson<{
				target?: SessionRuntimeTarget;
				prompt?: string;
				messageId?: string;
				newText?: string;
				provider?: string;
				modelId?: string;
				modelName?: string;
				level?: string;
				preset?: string;
				checkpointId?: string;
				scope?: string;
				/** 检查点列表分页：每页条数 / 游标（rewind-list 用）。 */
				limit?: number;
				beforeTimestamp?: number;
				/** fork：从哪个历史轮次分叉（entryId 来自 get-fork-messages）。 */
				entryId?: string;
				/** fork 化重试标记（重发/编辑迁移用）：只认显式 true。mutationFork+非 branchMode = 尾部替换（旧会话隐藏）。 */
				mutationFork?: boolean;
				/** 分支模式：fork 锚点不是最后一条用户消息 → 旧会话保留可见。 */
				branchMode?: boolean;
			}>(request);
			const target = body.target;
			// activate 是唯一不要求 runtime target 的动作：冷会话（无 runtime）激活正是它的用途
			if (action === "activate") {
				if (!this.deps.activateSessionRuntime) {
					this.sendError(response, 503, "webError.runtimeUnavailable", "Session runtime activation is not available");
					return true;
				}
				this.sendJson(response, { result: await this.deps.activateSessionRuntime(sessionId) });
				return true;
			}
			if (!target || target.sessionId !== sessionId) {
				this.sendError(response, 400, "webError.runtimeTargetRequired", "A matching Session runtime target is required");
				return true;
			}
			let result: unknown;
			switch (action) {
				case "stop":
					result = await this.deps.stopSessionRuntime(target);
					break;
				case "abort":
					result = await this.deps.abortSessionRuntime(target);
					break;
				case "restart": {
					// 重启走专属链路：pending 期间每 2s 回心跳——重启 5~10s 期间浏览器不再只有一个
					// 转圈的黑盒，能持续确认请求活着。
					await this.executeRestartWithProgress(target, response);
					// 专属链路自己写完响应，通用壳不再二次写。
					return true;
				}
				case "compact":
					result = await this.deps.compactSessionRuntime(target, body.prompt);
					break;
				case "state":
					result = await this.deps.getSessionRuntimeState(target);
					break;
				case "commands":
					result = await this.deps.listSessionRuntimeCommands(target);
					break;
				case "models":
					result = await this.deps.listSessionRuntimeModels(target);
					break;
				case "export-html":
					result = await this.deps.exportSessionRuntimeHtml(target);
					break;
				case "edit-message":
					result = await this.deps.editSessionRuntimeMessage(target, body.messageId ?? "", body.newText ?? "");
					break;
				case "delete-message":
					result = await this.deps.deleteSessionRuntimeMessage(target, body.messageId ?? "");
					break;
				case "prepare-resend":
					result = await this.deps.prepareSessionRuntimeResend(target, body.messageId ?? "");
					break;
				case "model":
					result = await this.deps.setSessionRuntimeModel(target, typeof body.provider === "string" ? body.provider : "", typeof body.modelId === "string" ? body.modelId : "", typeof body.modelName === "string" ? body.modelName : undefined);
					break;
				case "thinking":
					result = await this.deps.setSessionRuntimeThinking(target, body.level ?? "");
					break;
				case "permission":
					result = await this.deps.setSessionRuntimePermission(target, body.preset ?? "");
					break;
				case "clone":
					result = await this.deps.cloneSessionRuntime(target);
					break;
				case "fork":
					result = await this.deps.forkRuntimeSession(target, typeof body.entryId === "string" ? body.entryId : "", {
						// 边界校验：只认显式 true，其余值（含恶意载荷）一律按 false 处理
						mutationFork: body.mutationFork === true,
						branchMode: body.branchMode === true,
					});
					break;
				case "get-fork-messages":
					result = await this.deps.getForkMessages(target);
					break;
				case "rewind-list":
					result = await this.deps.listRewindCheckpoints(target, {
						limit: typeof body.limit === "number" && Number.isFinite(body.limit) ? body.limit : undefined,
						beforeTimestamp: typeof body.beforeTimestamp === "number" && Number.isFinite(body.beforeTimestamp) ? body.beforeTimestamp : undefined,
					});
					break;
				case "rewind-diff":
					result = await this.deps.getRewindCheckpointDiff(target, body.checkpointId ?? "");
					break;
				case "rewind-restore":
					result = await this.deps.restoreRewindCheckpoint(target, body.checkpointId ?? "", body.scope === "files" ? "files" : body.scope === "conversation" ? "conversation" : "all");
					break;
			}
			this.sendJson(response, { result });
			return true;
		}
		return false;
	}
}
