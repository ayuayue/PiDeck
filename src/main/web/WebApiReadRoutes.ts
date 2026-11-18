import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRuntimeState, CreateAnonymousSessionInput, CreateSessionDraftInput, ImageContent, SendSessionPromptInput, SessionRuntimeTarget, SessionUiResponseInput, UpdateSessionRecordInput } from "../../shared/types";
import { buildAgentSessionTitle, type AgentProfile } from "../../shared/types/agentProfile";
import { readBoundedFile, WEB_CORS_HEADERS } from "./WebHttpResponders";
import { ifNoneMatchHits, stateEtag } from "./WebStateEtag";
import { toWebSecurityState } from "./WebSecurityProjection";
import type { WebServiceDependencies } from "./WebServiceManager";
import { extractChatImages, toWebAgentProjection, WebApiRouteContext } from "./WebApiRouteContext";

/** WebApiRead 组的路由：每条一个方法，条件由 WebApiRoutes 的调度表判。 */
export class WebApiReadRoutes extends WebApiRouteContext {
	async routeEasytierConfigToml(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const toml = this.deps.getEasyTierConfigToml?.() ?? "";
		if (!toml) {
			this.sendError(response, 404, "easytier-config-missing", "EasyTier 托管配置未生成，请先在设置中填写网络名称与密钥");
			return true;
		}
		const body = Buffer.from(toml, "utf8");
		response.writeHead(200, {
			"content-type": "application/toml; charset=utf-8",
			"content-disposition": 'attachment; filename="easytier.toml"',
			"content-length": String(body.length),
			"cache-control": "no-store",
			...WEB_CORS_HEADERS,
		});
		response.end(body);
		return true;
	}

	async routeState(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const state = await this.getState();
		// 条件请求：载荷含全部会话投影（500+ 条约 228KB），而轮询窗口内目录多半没变。
		// 未变化时回 304，客户端保留原状态——空闲流量从每 10s 228KB 降到几十字节。
		const etag = stateEtag(state);
		if (ifNoneMatchHits(request.headers["if-none-match"], etag)) {
			// 304 也要带 CORS：缓存命中时浏览器仍按本次响应做跨域校验（#435 同类缺口）。
			// cache-control 用 no-cache 而不是 no-store：后者禁止客户端留存副本，等于让 ETag
			// 没有可复用对象，条件请求永远命中不了（#442 第 3 点）。no-cache = 可存但每次必校验。
			response.writeHead(304, { etag, "cache-control": "no-cache", ...WEB_CORS_HEADERS });
			response.end();
			return true;
		}
		this.sendJson(response, state, { etag, "cache-control": "no-cache" });
		return true;
	}

	async routeModels(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		// force=1：目标端 UI 点刷新时绕过模型列表缓存，重新 fork pi --list-models。
		const force = url.searchParams.get("force") === "1";
		this.sendJson(response, { models: await this.deps.listModels(force) });
		return true;
	}

	// 智能体目录：与桌面「智能体」页同一份 AgentProfileStore。只读（创建/编辑留在桌面端），
	// 角色设定一并下发——桌面详情面板同样展示它，且能读会话正文的令牌已是同一信任级。
	async routeAgents(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		// 目录未装配（启动早期 / 测试注入缺省）时回 503：Web 端展示错误态而不是空面板。
		const agents = this.deps.listAgentProfiles?.();
		if (!agents) {
			this.sendError(response, 503, "webError.agentsUnavailable", "agent profiles are not available");
			return true;
		}
		this.sendJson(response, { agents: agents.map(toWebAgentProjection) });
		return true;
	}

	// 「使用」智能体：先建草稿（复用 createSessionDraft 的 standby 预热/广播链路），再写会话绑定。
	// 绑定失败时把刚建的草稿删掉——不留下“看起来用了智能体却没人设”的会话。
	async routeSessions(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const sessionsMatch = match;
		const sessions = await this.deps.listSessions(decodeURIComponent(sessionsMatch[1]));
		this.sendJson(response, { sessions });
		return true;
	}

	async routeCatalogSessions(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const catalogSessionsMatch = match;
		const sessions = await this.deps.listCatalogSessions(decodeURIComponent(catalogSessionsMatch[1]));
		this.sendJson(response, { sessions });
		return true;
	}

	// ── 会话活动监控 strips：子代理/todo，与桌面 IPC 同源数据 ──
	async routeSubagents(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const subagentsMatch = match;
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
	async routeSessionSearch(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const sessionSearchMatch = match;
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
	async routeUsage(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const usageMatch = match;
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

	async routeTodo(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const todoMatch = match;
		if (!this.deps.listSessionTodo) {
			this.sendError(response, 503, "webError.stripsUnavailable", "session todo is not available");
			return true;
		}
		this.sendJson(response, { todo: (await this.deps.listSessionTodo(decodeURIComponent(todoMatch[1]))) ?? null });
		return true;
	}

	// ── DSH 工具面板路由（S6.3：goals/subagents/skills；无活跃 runtime 返回空）──
	async routeDshSubagents(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const dshSubagentsMatch = match;
		const agentId = this.runtimeAgentIdForSession(decodeURIComponent(dshSubagentsMatch[1]));
		if (!agentId || !this.deps.listDshSubagents) {
			this.sendJson(response, { subagents: [] });
			return true;
		}
		this.sendJson(response, { subagents: await this.deps.listDshSubagents(agentId) });
		return true;
	}

	async routeDshSubagentHistory(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const dshSubagentHistoryMatch = match;
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

	async routeDshSkills(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const dshSkillsMatch = match;
		const agentId = this.runtimeAgentIdForSession(decodeURIComponent(dshSkillsMatch[1]));
		if (!agentId || !this.deps.listDshSkills) {
			this.sendJson(response, { skills: [] });
			return true;
		}
		this.sendJson(response, { skills: await this.deps.listDshSkills(agentId) });
		return true;
	}

	async routeDshGoal(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const dshGoalMatch = match;
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
	async routeDshPlugins(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		this.sendJson(response, {
			dynamic: this.deps.listDshDynamicPlugins ? await this.deps.listDshDynamicPlugins() : [],
			static: this.deps.listDshStaticPlugins ? await this.deps.listDshStaticPlugins() : [],
		});
		return true;
	}

	async routeSessionsRuntimes(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		this.sendJson(response, { runtimes: this.deps.listSessionRuntimes() });
		return true;
	}

	async routeSessionReferenceMessages(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const sessionReferenceMessagesMatch = match;
		const messages = await this.deps.readSessionReferenceMessages(decodeURIComponent(sessionReferenceMessagesMatch[1]));
		this.sendJson(response, { messages });
		return true;
	}

	// GET 导出：生成 HTML 后作为附件直接下载（浏览器端无法访问服务端磁盘路径）
	async routeSessionMessagePage(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const sessionMessagePageMatch = match;
		const beforeValue = url.searchParams.get("before");
		const pageSizeValue = url.searchParams.get("pageSize");
		const before = beforeValue === null ? undefined : Number(beforeValue);
		const pageSize = pageSizeValue === null ? undefined : Number(pageSizeValue);
		const page = await this.deps.readSessionMessagePage(decodeURIComponent(sessionMessagePageMatch[1]), Number.isSafeInteger(before) ? before : undefined, Number.isSafeInteger(pageSize) ? pageSize : undefined);
		this.sendJson(response, page);
		return true;
	}

	async routeSessionMessages(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const sessionMessagesMatch = match;
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
}
