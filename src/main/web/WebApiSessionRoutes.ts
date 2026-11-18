import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRuntimeState, CreateAnonymousSessionInput, CreateSessionDraftInput, ImageContent, SendSessionPromptInput, SessionRuntimeTarget, SessionUiResponseInput, UpdateSessionRecordInput } from "../../shared/types";
import { buildAgentSessionTitle, type AgentProfile } from "../../shared/types/agentProfile";
import { readBoundedFile, WEB_CORS_HEADERS } from "./WebHttpResponders";
import { ifNoneMatchHits, stateEtag } from "./WebStateEtag";
import { toWebSecurityState } from "./WebSecurityProjection";
import type { WebServiceDependencies } from "./WebServiceManager";
import { extractChatImages, toWebAgentProjection, WebApiRouteContext } from "./WebApiRouteContext";

/** WebApiSession 组的路由：每条一个方法，条件由 WebApiRoutes 的调度表判。 */
export class WebApiSessionRoutes extends WebApiRouteContext {
	async routeUiResponse(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
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

	// 「使用」智能体：先建草稿（复用 createSessionDraft 的 standby 预热/广播链路），再写会话绑定。
	// 绑定失败时把刚建的草稿删掉——不留下“看起来用了智能体却没人设”的会话。
	async routeAgentUse(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const agentUseMatch = match;
		const agentId = decodeURIComponent(agentUseMatch[1]);
		const body = await this.readJson<{ projectId?: string }>(request);
		const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
		const agents = this.deps.listAgentProfiles?.();
		const bind = this.deps.bindSessionAgent;
		if (!agents || !bind) {
			this.sendError(response, 503, "webError.agentsUnavailable", "agent profiles are not available");
			return true;
		}
		if (!projectId) {
			this.sendError(response, 400, "webError.projectIdRequired", "projectId is required");
			return true;
		}
		const agent = agents.find((candidate) => candidate.id === agentId);
		if (!agent) {
			this.sendError(response, 404, "webError.agentNotFound", "agent not found");
			return true;
		}
		const session = await this.deps.createSessionDraft({
			projectId,
			title: buildAgentSessionTitle(agent),
			...(agent.backend === "dsh" ? { backend: "dsh" as const } : {}),
			// 智能体偏好模型只在 pi 后端带入：DSH 的模型是 host route，塞 pi 的 provider/modelId 会写成无效值。
			...(agent.backend !== "dsh" && agent.model ? { model: agent.model } : {}),
		});
		try {
			await bind(session.id, agent.id);
		} catch (error) {
			await this.deps.deleteSessionRecord(session.id).catch(() => false);
			this.sendError(response, 400, "webError.agentBindFailed", error instanceof Error ? error.message : "agent bind failed");
			return true;
		}
		this.sendJson(response, { session, agent: toWebAgentProjection(agent) });
		return true;
	}

	async routeCreateProject(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
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

	async routeDeleteProject(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const deleteProjectMatch = match;
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

	async routeDshPluginsInstall(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
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

	async routeDshPluginAction(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const dshPluginActionMatch = match;
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

	async routeCreateSession(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const body = await this.readJson<CreateSessionDraftInput>(request);
		if (!body.projectId?.trim()) {
			this.sendError(response, 400, "webError.projectIdRequired", "projectId is required");
			return true;
		}
		const session = await this.deps.createSessionDraft(body);
		this.sendJson(response, { session });
		return true;
	}

	async routeSessionsAnonymous(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const body = await this.readJson<CreateAnonymousSessionInput>(request);
		if (!body.projectId?.trim()) {
			this.sendError(response, 400, "webError.projectIdRequired", "projectId is required");
			return true;
		}
		const result = await this.deps.createAnonymousSession(body);
		this.sendJson(response, result);
		return true;
	}

	// Pi 会话安全等级切换（桌面 SecurityLevelMenu 的 Web 对齐入口）：
	// 服务端负责会话存在性 / 后端类型 / 等级 id 校验，再写 SecurityStore（策略快照随之刷新）。
	// DSH 走 runtime 的 permission 命令、ACP 由 agent CLI 自管，这里显式拒绝，避免两套机制互相污染。
	async routeSessionSecurityLevel(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const sessionSecurityLevelMatch = match;
		const sessionId = decodeURIComponent(sessionSecurityLevelMatch[1]);
		const body = await this.readJson<Record<string, unknown> | null>(request);
		// levelId 必须显式给出（null=恢复默认）：缺字段不能当作「清除覆盖」，否则空请求会静默改策略。
		if (!body || typeof body !== "object" || !Object.hasOwn(body, "levelId") || (body.levelId !== null && typeof body.levelId !== "string")) {
			this.sendError(response, 400, "webError.securityLevelInvalid", "levelId must be a string or null");
			return true;
		}
		// 空串与 null 同义：清除会话覆盖，跟随全局默认（与桌面 IPC 的入参语义一致）
		const levelId = typeof body.levelId === "string" && body.levelId.trim() ? body.levelId.trim() : null;
		const config = this.deps.getSecurityConfig?.();
		const setSessionLevel = this.deps.setSessionSecurityLevel;
		if (!config || !setSessionLevel) {
			this.sendError(response, 503, "webError.securityUnavailable", "security management is not available");
			return true;
		}
		const record = (await this.deps.listCatalogSessions()).find((item) => item.id === sessionId);
		if (!record) {
			this.sendError(response, 404, "webError.sessionNotFound", "session not found");
			return true;
		}
		if (record.backend === "dsh" || record.backend === "acp") {
			this.sendError(response, 400, "webError.securityUnsupportedBackend", "security levels only apply to pi sessions");
			return true;
		}
		if (levelId && !config.levels.some((level) => level.id === levelId)) {
			this.sendError(response, 400, "webError.securityLevelUnknown", "unknown security level");
			return true;
		}
		try {
			const next = await setSessionLevel(sessionId, levelId);
			this.sendJson(response, { security: toWebSecurityState(next) });
		} catch (error) {
			this.sendError(response, 400, "webError.securityUpdateFailed", error instanceof Error ? error.message : "security level update failed");
		}
		return true;
	}

	async routeSessionRecordAction(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const sessionRecordActionMatch = match;
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

	async routeSessionExportHtmlDownload(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const sessionExportHtmlDownloadMatch = match;
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
				...WEB_CORS_HEADERS,
			});
			response.end(html);
		} catch (error) {
			this.sendError(response, 500, "webError.internal", error instanceof Error ? error.message : "export failed");
		}
		return true;
	}

	async routeSessionPrompt(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const sessionPromptMatch = match;
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
	async routeStream(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const streamMatch = match;
		const sessionId = decodeURIComponent(streamMatch[1]);
		this.handleStream(sessionId, request, response, { keepAlive: true });
		return true;
	}

	// AI SDK useChat 契约端点（A2）：POST body = { id: sessionId, messages, trigger, messageId }。
	// 先建立该 session 的流式连接，再发 prompt；pi 事件到达后经翻译器流式返回，
	// 前端 useChat 通过 x-vercel-ai-ui-message-stream: v1 头识别协议。
	async routeChat(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
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
}
