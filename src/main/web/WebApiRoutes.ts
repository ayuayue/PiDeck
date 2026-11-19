import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRuntimeState, CreateAnonymousSessionInput, CreateSessionDraftInput, ImageContent, SendSessionPromptInput, SessionRuntimeTarget, SessionUiResponseInput, UpdateSessionRecordInput } from "../../shared/types";
import { buildAgentSessionTitle, type AgentProfile } from "../../shared/types/agentProfile";
import { readBoundedFile, WEB_CORS_HEADERS } from "./WebHttpResponders";
import { ifNoneMatchHits, stateEtag } from "./WebStateEtag";
import { toWebSecurityState } from "./WebSecurityProjection";
import type { WebServiceDependencies } from "./WebServiceManager";
import type { WebApiRoutesPort } from "./WebApiRouteContext";
import { WebApiReadRoutes } from "./WebApiReadRoutes";
import { WebApiRuntimeRoutes } from "./WebApiRuntimeRoutes";
import { WebApiSessionRoutes } from "./WebApiSessionRoutes";

export type { WebApiRoutesPort } from "./WebApiRouteContext";
export { extractChatImages, toWebAgentProjection } from "./WebApiRouteContext";

/** 路由表：一行一条路由，顺序即优先级。实现按域分在三个 handler 里。 */
export class WebApiRoutes {
	private readonly read: WebApiReadRoutes;
	private readonly session: WebApiSessionRoutes;
	private readonly runtime: WebApiRuntimeRoutes;

	constructor(port: WebApiRoutesPort) {
		this.read = new WebApiReadRoutes(port);
		this.session = new WebApiSessionRoutes(port);
		this.runtime = new WebApiRuntimeRoutes(port);
	}

	async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (url.pathname === "/api/easytier/config.toml" && request.method === "GET") return this.read.routeEasytierConfigToml(url, request, response);
		if (url.pathname === "/api/state") return this.read.routeState(url, request, response);
		if (url.pathname === "/api/ui-response" && request.method === "POST") return this.session.routeUiResponse(url, request, response);
		if (url.pathname === "/api/models" && request.method === "GET") return this.read.routeModels(url, request, response);
		if (url.pathname === "/api/agents" && request.method === "GET") return this.read.routeAgents(url, request, response);
		const agentUseMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/use$/);
		if (agentUseMatch && request.method === "POST") return this.session.routeAgentUse(agentUseMatch, url, request, response);
		if (url.pathname === "/api/projects" && request.method === "POST") return this.session.routeCreateProject(url, request, response);
		const deleteProjectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/delete$/);
		if (deleteProjectMatch && request.method === "POST") return this.session.routeDeleteProject(deleteProjectMatch, url, request, response);
		const sessionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
		if (sessionsMatch && request.method === "GET") return this.read.routeSessions(sessionsMatch, url, request, response);
		const catalogSessionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions\/catalog$/);
		if (catalogSessionsMatch && request.method === "GET") return this.read.routeCatalogSessions(catalogSessionsMatch, url, request, response);
		const subagentsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/subagents$/);
		if (subagentsMatch && request.method === "GET") return this.read.routeSubagents(subagentsMatch, url, request, response);
		const sessionSearchMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/search$/);
		if (sessionSearchMatch && request.method === "GET") return this.read.routeSessionSearch(sessionSearchMatch, url, request, response);
		const usageMatch = url.pathname.match(/^\/api\/usage\/([^/]+)$/);
		if (usageMatch && request.method === "GET") return this.read.routeUsage(usageMatch, url, request, response);
		const todoMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/todo$/);
		if (todoMatch && request.method === "GET") return this.read.routeTodo(todoMatch, url, request, response);
		const dshSubagentsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/dsh\/subagents$/);
		if (dshSubagentsMatch && request.method === "GET") return this.read.routeDshSubagents(dshSubagentsMatch, url, request, response);
		const dshSubagentHistoryMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/dsh\/subagents\/([^/]+)\/history$/);
		if (dshSubagentHistoryMatch && request.method === "GET") return this.read.routeDshSubagentHistory(dshSubagentHistoryMatch, url, request, response);
		const dshSkillsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/dsh\/skills$/);
		if (dshSkillsMatch && request.method === "GET") return this.read.routeDshSkills(dshSkillsMatch, url, request, response);
		const dshGoalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/dsh\/goal$/);
		if (dshGoalMatch && request.method === "GET") return this.read.routeDshGoal(dshGoalMatch, url, request, response);
		if (url.pathname === "/api/dsh/plugins" && request.method === "GET") return this.read.routeDshPlugins(url, request, response);
		if (url.pathname === "/api/dsh/plugins/install" && request.method === "POST") return this.session.routeDshPluginsInstall(url, request, response);
		const dshPluginActionMatch = url.pathname.match(/^\/api\/dsh\/plugins\/([^/]+)\/(run|stop|uninstall)$/);
		if (dshPluginActionMatch && request.method === "POST") return this.session.routeDshPluginAction(dshPluginActionMatch, url, request, response);
		if (url.pathname === "/api/sessions/runtimes" && request.method === "GET") return this.read.routeSessionsRuntimes(url, request, response);
		if (url.pathname === "/api/sessions" && request.method === "POST") return this.session.routeCreateSession(url, request, response);
		if (url.pathname === "/api/sessions/anonymous" && request.method === "POST") return this.session.routeSessionsAnonymous(url, request, response);
		const sessionSecurityLevelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/security-level$/);
		if (sessionSecurityLevelMatch && request.method === "POST") return this.session.routeSessionSecurityLevel(sessionSecurityLevelMatch, url, request, response);
		const sessionRecordActionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(update|delete|copy|export-html)$/);
		if (sessionRecordActionMatch && request.method === "POST") return this.session.routeSessionRecordAction(sessionRecordActionMatch, url, request, response);
		const sessionReferenceMessagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/reference-messages$/);
		if (sessionReferenceMessagesMatch && request.method === "GET") return this.read.routeSessionReferenceMessages(sessionReferenceMessagesMatch, url, request, response);
		const sessionExportHtmlDownloadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/export-html$/);
		if (sessionExportHtmlDownloadMatch && request.method === "GET") return this.session.routeSessionExportHtmlDownload(sessionExportHtmlDownloadMatch, url, request, response);
		const sessionMessagePageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages\/page$/);
		if (sessionMessagePageMatch && request.method === "GET") return this.read.routeSessionMessagePage(sessionMessagePageMatch, url, request, response);
		const sessionMessagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
		if (sessionMessagesMatch && request.method === "GET") return this.read.routeSessionMessages(sessionMessagesMatch, url, request, response);
		const sessionPromptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
		if (sessionPromptMatch && request.method === "POST") return this.session.routeSessionPrompt(sessionPromptMatch, url, request, response);
		const streamMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
		if (streamMatch && request.method === "GET") return this.session.routeStream(streamMatch, url, request, response);
		if (url.pathname === "/api/chat" && request.method === "POST") return this.session.routeChat(url, request, response);
		const sessionRuntimeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runtime\/(activate|stop|abort|restart|compact|state|commands|export-html|edit-message|delete-message|prepare-resend|models|model|thinking|permission|clone|fork|get-fork-messages|rewind-list|rewind-diff|rewind-restore)$/);
		if (sessionRuntimeMatch && request.method === "POST") return this.runtime.routeSessionRuntime(sessionRuntimeMatch, url, request, response);
		return false;
	}
}
