import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
	AgentRuntimeState,
	AppSettings,
	AvailableModel,
	ChatMessage,
	CreateAnonymousSessionInput,
	CreateAnonymousSessionResult,
	CreateSessionDraftInput,
	ImageContent,
	PiCommand,
	Project,
	ProviderUsageResult,
	UsageProbeBackend,
	RewindCheckpointPage,
	RewindCheckpointPageParams,
	RewindRestoreResult,
	RewindRestoreScope,
	SendSessionPromptInput,
	SendSessionPromptResult,
	SessionCommandResult,
	SessionMessagePage,
	SessionRecord,
	SessionRuntimeInfo,
	SessionRuntimeModelSelection,
	SessionRuntimeReplacement,
	SessionRuntimeTarget,
	SessionSearchResult,
	SessionSummary,
	SessionTargetedValue,
	SessionTodoSnapshot,
	SessionUiResponseInput,
	PiSubagentEntry,
	UpdateSessionRecordInput,
	WebServiceStatusInfo,
} from "../../shared/types";
import type { PendingUiRequestSnapshot } from "../sessions/SessionRuntimeCoordinator";
import type { SessionForkResult } from "../sessions/sessionForkCommands";
import { WebBodyTooLargeError, WebInvalidJsonError, readJson as readJsonBody, sendError as writeError, sendJson as writeJson, sendNoContent as writeNoContent } from "./WebHttpResponders";
import { WebStaticAssets } from "./WebStaticAssets";
import { WebApiRoutes } from "./WebApiRoutes";
import { WebStateEventHub } from "./WebStateEventHub";
import { toPublicSessions } from "./WebSessionProjection";
import { openSessionStream, writeSessionStreamError } from "./WebSessionStream";
import { WebTokenAuth, type WebTokenPolicy } from "./WebTokenAuth";
import { WebEventStreamRouter, type AgentChannelEventSource, type PiEvent } from "./WebEventStream";

type WebServiceSettings = Pick<AppSettings, "webServiceEnabled" | "webServiceHost" | "webServicePort" | "webServiceRequiresAuth" | "webServiceToken" | "webServiceTokenGeneratedAt" | "webServiceTokenExpiresIn">;

/** 令牌策略的最小形状（applySettings/restart → start 传递，避免 start 直接依赖完整设置） */
/** 清洗 host 输入：去空白、剥 IPv6 方括号、空串兜底为 0.0.0.0。 */
export function normalizeWebHost(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed || "0.0.0.0";
}

/** /api/chat 图片 parts 上限：最多 4 张，单张 base64 ≤2MB（客户端已预压缩）。 */

export type WebServiceDependencies = {
	/**
	 * dev 模式渲染层 dev server 基址（如 http://localhost:5181）。
	 * 设置后静态资源请求全部代理到该地址，保证外部 Web 端在开发模式下
	 * 也加载重构后的 React 版（A2）页面并支持热更新；未设置时回退到
	 * out/renderer 构建产物（打包/正式构建场景）。
	 */
	devRendererUrl?: string;
	/**
	 * 令牌持久化回调：自动生成/轮换/手动修改后由 manager 上报，装配层写回 settings。
	 * 单向依赖（manager 不依赖 SettingsManager），未注入时令牌退化为内存态（仅测试场景）。
	 */
	persistToken?: (state: { token: string; generatedAt: number; expiresIn: number }) => void;
	/** 订阅主进程内部的 pi agent 事件流（agentId, event），返回退订函数。 */
	subscribePiEvents: (handler: (agentId: string, event: PiEvent) => void) => () => void;
	/**
	 * 订阅非 pi 后端（DSH）的 agent 通道事件（agentId, 通道名, 载荷），返回退订函数。
	 * 未注入时该后端在 Web 端退化为「状态轮询 + 磁盘重拉」的旧行为（fail-safe）。
	 */
	subscribeAgentChannelEvents?: AgentChannelEventSource;
	/** agentId → sessionId 路由，用于把 pi 事件导向对应 session 的 SSE 连接。 */
	getSessionIdForAgent: (agentId: string) => string | undefined;
	listProjects: () => Project[];
	createProject: (path: string) => Promise<Project>;
	deleteProject: (projectId: string) => Promise<boolean>;
	// force=true 时绕过缓存重新 fork pi --list-models（Web 端模型选择器刷新按钮）。
	listModels: (force?: boolean) => Promise<AvailableModel[]>;
	listSessions: (projectId: string) => Promise<SessionSummary[]>;
	listCatalogSessions: (projectId?: string) => Promise<SessionRecord[]>;
	createSessionDraft: (input: CreateSessionDraftInput) => Promise<SessionRecord>;
	createAnonymousSession: (input: CreateAnonymousSessionInput) => Promise<CreateAnonymousSessionResult>;
	updateSessionRecord: (sessionId: string, patch: UpdateSessionRecordInput) => Promise<SessionRecord>;
	deleteSessionRecord: (sessionId: string) => Promise<boolean>;
	copySessionRecord: (sessionId: string) => Promise<{ cancelled?: boolean; targetSessionId?: string }>;
	exportSessionRecordHtml: (sessionId: string) => Promise<{ path: string }>;
	readSessionReferenceMessages: (sessionId: string) => Promise<Array<{ role: string; content: string; timestamp: number }>>;
	/**
	 * 整量读入口（有界）：只返回「加载窗口」内的消息 + total/windowStart/truncated。
	 * 全量历史请用 readSessionMessagePage 翻页——大会话一次全量下发会同时顶爆
	 * 主进程与渲染层（#213）。
	 */
	readSessionMessages: (sessionId: string) => Promise<{
		messages: ChatMessage[];
		total: number;
		windowStart: number;
		truncated: boolean;
	}>;
	readSessionMessagePage: (sessionId: string, before?: number, pageSize?: number) => Promise<SessionMessagePage>;
	/**
	 * 会话内全文检索（跨全会话，不限已加载历史）：与桌面端 Ctrl+Shift+F 同源，
	 * 入参是 SessionRecord.id，主进程按 catalog 分派 pi（session-index sidecar）/
	 * DSH（host 历史投影）。未装配或索引未就绪返回 null——渲染层据此回退本地已加载
	 * 搜索，绝不把「读不到」显示成「没有匹配」。
	 */
	searchSessionMessages?: (sessionId: string, query: string) => Promise<SessionSearchResult | null>;
	/**
	 * 供应商额度/余额用量查询（与桌面端圆球面板同源，走 ConfigManager 的用量探针）：
	 * backend 决定配置与凭据链路（pi 用 $PI_HOME，dsh 用 $DSH_HOME）。
	 * 未装配 / 用户未开启用量查询 / 供应商无可用端点 → 返回结构化失败结果（success=false），
	 * 渲染层据此不渲染额度区块；抛异常由路由层兜底成 disabled 结果，不向浏览器暴露内部错误。
	 */
	fetchProviderUsage?: (provider: string, backend: UsageProbeBackend) => Promise<ProviderUsageResult>;
	sendSessionPrompt: (input: SendSessionPromptInput) => Promise<SendSessionPromptResult>;
	listSessionRuntimes: () => SessionRuntimeInfo[];
	listSessionRuntimeModels: (target: SessionRuntimeTarget) => Promise<SessionCommandResult<SessionTargetedValue<AvailableModel[]>>>;
	stopSessionRuntime: (target: SessionRuntimeTarget) => Promise<SessionCommandResult<SessionRuntimeTarget>>;
	abortSessionRuntime: (target: SessionRuntimeTarget) => Promise<SessionCommandResult<SessionTargetedValue<void>>>;
	restartSessionRuntime: (target: SessionRuntimeTarget) => Promise<SessionCommandResult<SessionRuntimeReplacement>>;
	compactSessionRuntime: (target: SessionRuntimeTarget, prompt?: string) => Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>>;
	getSessionRuntimeState: (target: SessionRuntimeTarget) => Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>>;
	listSessionRuntimeCommands: (target: SessionRuntimeTarget) => Promise<SessionCommandResult<SessionTargetedValue<PiCommand[]>>>;
	exportSessionRuntimeHtml: (target: SessionRuntimeTarget) => Promise<SessionCommandResult<SessionTargetedValue<unknown>>>;
	editSessionRuntimeMessage: (target: SessionRuntimeTarget, messageId: string, newText: string) => Promise<SessionCommandResult<SessionTargetedValue<void>>>;
	deleteSessionRuntimeMessage: (target: SessionRuntimeTarget, messageId: string) => Promise<SessionCommandResult<SessionTargetedValue<void>>>;
	listRewindCheckpoints: (target: SessionRuntimeTarget, params?: RewindCheckpointPageParams) => Promise<SessionCommandResult<SessionTargetedValue<RewindCheckpointPage>>>;
	getRewindCheckpointDiff: (target: SessionRuntimeTarget, checkpointId: string) => Promise<SessionCommandResult<SessionTargetedValue<string>>>;
	restoreRewindCheckpoint: (target: SessionRuntimeTarget, checkpointId: string, scope: RewindRestoreScope) => Promise<SessionCommandResult<SessionTargetedValue<RewindRestoreResult>>>;
	prepareSessionRuntimeResend: (target: SessionRuntimeTarget, messageId: string) => Promise<SessionCommandResult<SessionTargetedValue<{ text: string; images?: ImageContent[] }>>>;
	setSessionRuntimeModel: (target: SessionRuntimeTarget, provider: string, modelId: string, modelName?: string) => Promise<SessionCommandResult<SessionTargetedValue<SessionRuntimeModelSelection>>>;
	setSessionRuntimeThinking: (target: SessionRuntimeTarget, level: string) => Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>>;
	setSessionRuntimePermission: (target: SessionRuntimeTarget, preset: string) => Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>>;
	cloneSessionRuntime: (target: SessionRuntimeTarget) => Promise<
		SessionCommandResult<{
			cancelled?: boolean;
			targetSessionId?: string;
			[key: string]: unknown;
		}>
	>;
	/** 从历史轮次分叉新会话（P3 分支条；BrowserApi 已映射，服务端此前缺席）。 */
	getForkMessages: (target: SessionRuntimeTarget) => Promise<SessionCommandResult<SessionTargetedValue<Array<{ entryId: string; text: string }>>>>;
	/** fork（与桌面 IPC 同源）：options.mutationFork=尾部重发/编辑替换（旧会话打 supersededBy 隐藏），
	 * options.branchMode=分支保留旧会话。服务端只认显式 true（边界校验）。 */
	forkRuntimeSession: (target: SessionRuntimeTarget, entryId: string, options?: { mutationFork?: boolean; branchMode?: boolean }) => Promise<SessionForkResult>;
	/** 冷会话激活（Web 重发/编辑 fork 化用；与桌面 sessionsRuntimeActivate 同源）。 */
	activateSessionRuntime?: (sessionId: string) => Promise<SessionCommandResult<SessionRuntimeInfo>>;
	/** 会话活动监控 strips：子代理/todo 快照，装配侧对齐桌面 IPC 语义（含 running 降级对账）。缺省时路由返回 503。 */
	listSessionSubagents?: (sessionId: string) => Promise<PiSubagentEntry[]>;
	listSessionTodo?: (sessionId: string) => Promise<SessionTodoSnapshot | undefined>;
	listPendingUiRequests: () => PendingUiRequestSnapshot[];
	respondToUi: (input: SessionUiResponseInput) => Promise<void>;
	/** DSH 子代理列表（S6.3：web 端工具面板；未装配 DSH 时缺省）。 */
	listDshSubagents?: (agentId: string) => Promise<
		Array<{
			id: string;
			label?: string;
			activity: "running" | "inactive";
			hasChildren: boolean;
			mode: "one-shot" | "continuable";
			kind: "child" | "diagnostic";
		}>
	>;
	/** DSH 子代理历史（S6.3：只读 transcript）。 */
	readDshSubagentHistory?: (agentId: string, childSessionId: string, beforeSeq?: number, maxMessages?: number) => Promise<{ messages: ChatMessage[]; hasMore: boolean }>;
	/** DSH 技能目录（S6.3：skill.list 只读）。 */
	listDshSkills?: (agentId: string) => Promise<import("../../shared/types").DshSkillView[]>;
	/** DSH 动态插件清单（S6.5：进程内临时扩展；未装配 DSH 时缺省）。 */
	listDshDynamicPlugins?: () => Promise<import("../../shared/types").DshPluginView[]>;
	/** DSH 静态 Loader 条目清单（S6.5：origin 标注 user/builtin 来源）。 */
	listDshStaticPlugins?: () => Promise<import("../../shared/types").DshStaticPluginView[]>;
	/** DSH 用户自装静态插件卸载（移除用户补丁层行 + 可选回收插件目录）。 */
	uninstallDshUserPlugin?: (input: import("../../shared/types").DshUserPluginUninstallInput) => Promise<import("../../shared/types").DshUserPluginUninstallResult>;
	/** DSH 动态插件安装（define：定义源码包，不运行；按会话归属）。 */
	installDshPlugin?: (input: import("../../shared/types").DshPluginInstallInput) => Promise<unknown>;
	/** DSH 动态插件生命周期（run/stop/uninstall；面板手势无需审批）。 */
	runDshPlugin?: (input: import("../../shared/types").DshPluginLifecycleInput) => Promise<unknown>;
	stopDshPlugin?: (input: import("../../shared/types").DshPluginLifecycleInput) => Promise<unknown>;
	uninstallDshPlugin?: (input: import("../../shared/types").DshPluginLifecycleInput) => Promise<unknown>;
};

export class WebServiceManager {
	private server: Server | null = null;
	private current: {
		host: string;
		port: number;
		token: string;
		requiresAuth: boolean;
		tokenExpiresAt: number | null;
	} | null = null;
	/** P1-P3 工作区路由（git/files/prompts）；未装配时这些路由 404。由 main/index.ts 在构造后注入。 */
	workspaceRoutes: { handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> } | null = null;
	/** 设置页「需要 token 鉴权」开关；true 时所有 /api/*（/api/health 除外）强制令牌。 */
	private requiresAuth = false;
	/** 令牌鉴权状态机（实现已迁到 WebTokenAuth）。 */
	private readonly tokenAuth: WebTokenAuth;
	/** 静态产物出口与 dev 代理（实现已迁到 WebStaticAssets）。 */
	private readonly staticAssets: WebStaticAssets;

	private readonly eventStreamRouter: WebEventStreamRouter;

	/** API 路由表（实现已迁到 WebApiRoutes）。 */
	private readonly apiRoutes: WebApiRoutes;
	/** /api/events 状态推送（实现已迁到 WebStateEventHub）。 */
	private readonly stateHub: WebStateEventHub;

	constructor(private readonly deps: WebServiceDependencies) {
		this.tokenAuth = new WebTokenAuth({ persistToken: deps.persistToken, onChange: () => this.onTokenChanged() });
		this.staticAssets = new WebStaticAssets({ devRendererUrl: deps.devRendererUrl });
		this.eventStreamRouter = new WebEventStreamRouter((agentId) => this.deps.getSessionIdForAgent(agentId));
		this.stateHub = new WebStateEventHub({ loadState: () => this.getState(), stateRevision: () => this.stateRevision() });
		this.apiRoutes = new WebApiRoutes({
			deps,
			sendJson: (response, body) => this.sendJson(response, body),
			sendError: (response, statusCode, code, error, params) => this.sendError(response, statusCode, code, error, params),
			sendNoContent: (response) => this.sendNoContent(response),
			readJson: (request, maxBytes) => this.readJson(request, maxBytes),
			getState: () => this.getState(),
			queryNumber: (url, key) => this.queryNumber(url, key),
			runtimeAgentIdForSession: (sessionId) => this.runtimeAgentIdForSession(sessionId),
			runtimeTargetForSession: (sessionId) => this.runtimeTargetForSession(sessionId),
			executeRestartWithProgress: (target, response) => this.executeRestartWithProgress(target, response),
			handleStream: (sessionId, request, response, options) => this.handleStream(sessionId, request, response, options),
			writeStreamError: (response, errorText) => this.writeStreamError(response, errorText),
		});
	}

	/** 去抖调度一次快照广播（实现已迁到 WebStateEventHub；事件源回调共用此入口）。 */
	private scheduleStatePush(): void {
		this.stateHub.schedule();
	}

	/** 令牌实际变化后刷新对外状态并广播（current 是 manager 的唯一状态面，测试与 IPC 都读它）。 */
	private onTokenChanged(): void {
		if (!this.current) return;
		this.current = { ...this.current, token: this.tokenAuth.token, tokenExpiresAt: this.tokenAuth.expiresAt() };
		this.scheduleStatePush();
	}

	async applySettings(settings: WebServiceSettings) {
		if (!settings.webServiceEnabled) {
			await this.stop();
			return;
		}

		const host = normalizeWebHost(settings.webServiceHost);
		const port = this.normalizePort(settings.webServicePort);
		const requiresAuth = settings.webServiceRequiresAuth ?? true;
		// 令牌策略变更不需要重启服务（热更新：已建立的 SSE/长连接不受影响），
		// 因此在「同配置早退」判断之前先应用；首启动（无 current）留给 start() 统一解析。
		if (this.current) this.refreshTokenRuntime({ token: settings.webServiceToken, generatedAt: settings.webServiceTokenGeneratedAt, expiresIn: settings.webServiceTokenExpiresIn });
		if (this.server && this.current?.host === host && this.current.port === port && this.current.requiresAuth === requiresAuth) return;
		await this.stop();
		await this.start(host, port, requiresAuth, { token: settings.webServiceToken, generatedAt: settings.webServiceTokenGeneratedAt, expiresIn: settings.webServiceTokenExpiresIn });
	}

	/**
	 * 重启当前 Web 服务实例；不修改持久化设置，确保端口/监听地址仍由设置页控制。
	 * 未启用时直接返回，避免“重启”操作意外启动用户已经关闭的服务。
	 */
	async restart(settings: WebServiceSettings) {
		if (!settings.webServiceEnabled) return;
		const host = normalizeWebHost(settings.webServiceHost);
		const port = this.normalizePort(settings.webServicePort);
		const requiresAuth = settings.webServiceRequiresAuth ?? true;
		await this.stop();
		await this.start(host, port, requiresAuth, { token: settings.webServiceToken, generatedAt: settings.webServiceTokenGeneratedAt, expiresIn: settings.webServiceTokenExpiresIn });
	}

	/** 令牌状态机已迁到 WebTokenAuth；以下薄包装保留原调用面（IPC / 生命周期）。 */
	private applyTokenPolicy(policy: WebTokenPolicy): boolean {
		return this.tokenAuth.applyPolicy(policy);
	}

	/** 运行中热应用令牌策略并广播（applySettings 保存路径用，不重启服务）；广播由 WebTokenAuth 的 onChange 统一触发。 */
	private refreshTokenRuntime(policy: WebTokenPolicy) {
		this.applyTokenPolicy(policy);
	}

	/** 设置页手动修改令牌 / 过期策略（web:set-token IPC）：立即热生效 + 持久化，不重启服务。 */
	setTokenPolicy(input: { token?: string; expiresIn?: number }): void {
		this.tokenAuth.setPolicy(input);
	}

	/** expiresIn > 0 时的绝对过期时刻；0/未设置 → null（永不过期）。 */
	private computeTokenExpiresAt(): number | null {
		return this.tokenAuth.expiresAt();
	}

	/** 轮换访问令牌（设置页「重新生成令牌」）：立即换新并广播状态。 */
	rotateToken(): void {
		this.tokenAuth.rotate();
	}
	/** 渲染层展示二维码/令牌用；未运行时返回空形状（running=false） */
	getStatus(): WebServiceStatusInfo {
		if (this.current) {
			return { running: true, ...this.current };
		}
		return { running: false, host: "", port: 0, token: "", requiresAuth: false, tokenExpiresAt: null };
	}

	async stop() {
		// 解绑 pi 事件源与 DSH 等非 pi 后端的通道事件源，避免服务关闭后仍在转发事件到已失效的 SSE 连接。
		this.eventStreamRouter.unbindPiSource();
		this.eventStreamRouter.unbindChannelSource();
		this.stateHub.dispose();
		if (!this.server) return;
		const server = this.server;
		this.server = null;
		this.current = null;
		// SSE 长连接不会因 server.close() 自动断开（Node 需显式关闭活跃连接），
		// 否则 stop() 会一直等待连接关闭导致卡死。
		try {
			server.closeAllConnections?.();
		} catch {
			// 旧版 Node 无该方法时忽略，退化为等待连接自然关闭
		}
		this.staticAssets.destroyHijackedSockets();
		await new Promise<void>((resolve, reject) => {
			// 超时兜底：任何未被追踪的连接形态（未来新增代理/长连接）都不能再把设置切换卡死。
			const timer = setTimeout(() => resolve(), 1500);
			server.close((error) => {
				clearTimeout(timer);
				if (error) reject(error);
				else resolve();
			});
		});
	}

	private async start(host: string, port: number, requiresAuth = true, tokenPolicy: WebTokenPolicy = {}) {
		// 启动时绑定 pi 事件源；路由器无订阅者时也维护会话级回放源（内存有界），
		// 外部流中途接入时才能补齐本轮已渲染内容；帧写出仍只对活跃 SSE 连接发生。
		// 状态推送：pi 事件是 runtime 状态翻转 / ask 待确认的源头，到达时去抖比对一次快照
		// （/api/events 订阅者从中拿到即时推送，不再依赖 Web 端轮询发现）。
		this.eventStreamRouter.bindPiSource(
			this.deps.subscribePiEvents
				? (handler) => {
						const unsubscribe = this.deps.subscribePiEvents((agentId, event) => {
							handler(agentId, event);
							this.scheduleStatePush();
						});
						return unsubscribe;
					}
				: undefined,
		);
		// DSH 后端的流式事件（正文/思考/工具）走自己的 IPC 通道，不在 pi 事件源里：
		// 不接这一层时 Web 端只能靠状态轮询 + 磁盘重拉追赶（输出很慢），且整轮没有
		// finish 帧（察觉不到结束/停止）。这里也顺手触发状态推送，让 runtime 忙闲翻转即时可达。
		const subscribeChannels = this.deps.subscribeAgentChannelEvents;
		this.eventStreamRouter.bindChannelSource(
			subscribeChannels
				? (handler) =>
						subscribeChannels((agentId, channel, payload) => {
							handler(agentId, channel, payload);
							this.scheduleStatePush();
						})
				: undefined,
		);
		// 5s 兑底 tick：捕捉不经 pi 事件的目录变更（桌面端改名/删除/导入等）。
		this.stateHub.startTick();
		const server = createServer(async (request, response) => {
			try {
				await this.handleRequest(request, response, host, port, server);
			} catch (error) {
				if (error instanceof WebBodyTooLargeError) {
					this.sendError(response, 413, "webError.bodyTooLarge", "Request body exceeds the size limit");
					return;
				}
				if (error instanceof WebInvalidJsonError) {
					this.sendError(response, 400, "webError.invalidJson", "Request body is not valid JSON");
					return;
				}
				console.error("[WebService] Request failed", error);
				this.sendError(response, 500, "webError.internal", "The web service encountered an internal error");
			}
		});

		server.on("clientError", (_error, socket) => {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
		});

		// dev 模式：把 WebSocket upgrade 请求（vite HMR 热更新）转发到 dev server，
		// 否则浏览器连同源的 / 只拿到 HTTP 升级失败，改代码不热更新。
		if (this.staticAssets.devRendererUrl) {
			server.on("upgrade", (request, socket, head) => {
				this.staticAssets.proxyWebSocket(request, socket, head);
			});
		}

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		this.server = server;
		// 令牌持久化固定：有持久值沿用（重启不换新，远程设备链接不失效）；缺省则生成并回写设置。
		this.applyTokenPolicy(tokenPolicy);
		this.requiresAuth = requiresAuth;
		this.current = {
			host,
			port: this.getPort(server, port),
			token: this.tokenAuth.token,
			requiresAuth: this.requiresAuth,
			tokenExpiresAt: this.computeTokenExpiresAt(),
		};
	}

	private async handleRequest(request: IncomingMessage, response: ServerResponse, host: string, port: number, server: Server) {
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

		// webServiceRequiresAuth 为 true 时强制令牌；/api/health 保持免鉴权以便健康检查。
		// GET 与 SSE 允许 ?token= 查询参数（浏览器 EventSource 无法携带 header），其余走 Authorization: Bearer。
		if (this.requiresAuth && url.pathname.startsWith("/api/") && !this.tokenAuth.isAuthorized(request, url)) {
			this.sendError(response, 401, "webError.unauthorized", "A valid web service token is required");
			return;
		}
		if (url.pathname === "/api/events" && request.method === "GET") {
			this.stateHub.handle(request, response);
			return;
		}
		if (await this.apiRoutes.handle(url, request, response)) return;

		if (url.pathname.startsWith("/api/")) {
			// P1-P3 工作区路由（git/files/prompts）：独立模块承载，返回 false 表示未命中
			if (this.workspaceRoutes && (await this.workspaceRoutes.handle(url, request, response))) return;
			this.sendError(response, 404, "webError.apiNotFound", "API not found");
			return;
		}

		await this.staticAssets.serve(url, response);
	}

	/**
	 * 会话 runtime 重启专属链路：先 flush 响应头，pending 期间每 2s 写一个空白字节当心跳。
	 * 重启 5~10s 期间浏览器不再只有一个转圈的黑盒，能持续确认请求活着；
	 * 心跳写的是 JSON body 前导空白，最终 \n 结尾的完整 JSON 对客户端解析无影响。
	 */
	private async executeRestartWithProgress(target: SessionRuntimeTarget, response: ServerResponse): Promise<void> {
		if (!response.headersSent) {
			response.writeHead(200, {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
				"access-control-allow-origin": "*",
			});
		}
		const heartbeat = setInterval(() => {
			try {
				response.write(" ");
			} catch {
				// 客户端已断开时静默，最终 end 阶段失败也无碍
			}
		}, 2000);
		try {
			const result = await this.deps.restartSessionRuntime(target);
			response.end(JSON.stringify({ result }));
		} catch (error) {
			// restartSessionRuntime 正常路径返回 {ok:false} 结构不抛；这里只是防御外层 500 的兜底。
			console.error("[WebService] Session restart failed", error);
			this.sendError(response, 500, "webError.internal", "The web service encountered an internal error");
		} finally {
			clearInterval(heartbeat);
		}
	}

	/** 按 sessionId 找活跃 runtime 的 agentId（DSH 工具面板路由；无 runtime 返回 undefined）。 */
	private runtimeAgentIdForSession(sessionId: string): string | undefined {
		return this.deps.listSessionRuntimes().find((runtime) => runtime.sessionId === sessionId)?.agentId;
	}

	/** 按 sessionId 构造 runtime target（DSH goal 路由用；无 runtime 返回 undefined）。 */
	private runtimeTargetForSession(sessionId: string): SessionRuntimeTarget | undefined {
		const runtime = this.deps.listSessionRuntimes().find((item) => item.sessionId === sessionId);
		if (!runtime) return undefined;
		return {
			sessionId: runtime.sessionId,
			agentId: runtime.agentId,
			runtimeGeneration: runtime.runtimeGeneration ?? 0,
		};
	}

	/** 查询参数转 number（缺失/非法返回 undefined）。 */
	private queryNumber(url: URL, key: string): number | undefined {
		const raw = url.searchParams.get(key);
		if (raw === null || raw === "") return undefined;
		const value = Number(raw);
		return Number.isFinite(value) ? value : undefined;
	}

	/**
	 * 状态推送的廉价版本键（2027-02 性能审计，见 WebStateEventHub.push）：
	 * 只聚合 runtimes 身份/状态/代数与 pendingUi 摘要——pi 事件能驱动的变化面。
	 * catalog/项目列表的变更频率低且不由 pi 事件驱动，交给 5s tick 的全量比对，
	 * 不为它们把 catalog 克隆拉进这条每 delta 都可能触发的路径。
	 */
	private stateRevision(): string {
		const runtimes = this.deps.listSessionRuntimes();
		const pending = this.deps.listPendingUiRequests();
		return `${runtimes.map((entry) => `${entry.sessionId}:${entry.agentId}:${entry.status}:${entry.runtimeGeneration ?? ""}`).join(";")}#${pending.length}:${pending.map((entry) => `${entry.sessionId}:${entry.requestId}`).join(",")}`;
	}

	private async getState() {
		// messagesBySession 已移除（P0：轮询全量消息是纯浪费，React A2 从不消费；
		// LAN Web 全量 UI 改为按 runtime 拉 GET /api/sessions/:id/messages，A1 兜底页
		// 切会话/流结束时拉 /messages/page）。
		const sessions = await this.deps.listCatalogSessions();
		const runtimes = this.deps.listSessionRuntimes();
		return {
			projects: this.deps.listProjects(),
			// 会话按 Web 可见字段投影：filePath/environment/dshSessionId/agentPreset/preview/
			// messageCount 等桌面端专用字段不下发（实测占快照 ~99% 中的三成，Web 端零消费）。
			sessions: toPublicSessions(sessions),
			runtimes,
			pendingUiRequests: this.deps.listPendingUiRequests(),
		};
	}

	/** SSE 流式响应（实现在 WebSessionStream）：写协议头、注册路由、心跳保活。 */
	private handleStream(sessionId: string, request: IncomingMessage, response: ServerResponse, options?: { keepAlive?: boolean }): void {
		openSessionStream(this.eventStreamRouter, sessionId, request, response, options);
	}

	/** 已打开的 SSE 连接写入 error + finish + [DONE]（实现在 WebSessionStream）。 */
	private writeStreamError(response: ServerResponse, errorText: string): void {
		writeSessionStreamError(response, errorText);
	}

	private getPort(server: Server, fallback: number) {
		const address = server.address();
		return typeof address === "object" && address ? (address as AddressInfo).port : fallback;
	}

	private normalizePort(value: number) {
		const port = Number(value);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error("WEB_SERVICE_INVALID_PORT");
		}
		return port;
	}

	// ── HTTP 响应/请求体工具：实现在 WebHttpResponders；路由与静态资源各用自己的入口，这里只留仍在用的包装 ──
	private sendJson(response: ServerResponse, body: unknown) {
		return writeJson(response, body);
	}

	private sendError(response: ServerResponse, statusCode: number, code: string, error: string, params?: Record<string, string | number>) {
		return writeError(response, statusCode, code, error, params);
	}

	private sendNoContent(response: ServerResponse) {
		return writeNoContent(response);
	}

	private readJson<T>(request: IncomingMessage, maxBytes?: number) {
		return readJsonBody<T>(request, maxBytes);
	}
}
