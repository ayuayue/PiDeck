import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
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
	RewindCheckpointPage,
	RewindCheckpointPageParams,
	RewindRestoreResult,
	RewindRestoreScope,
	SendSessionPromptInput,
	SendSessionPromptResult,
	SessionCommandResult,
	SessionFileChange,
	SessionMessagePage,
	SessionRecord,
	SessionRuntimeInfo,
	SessionRuntimeModelSelection,
	SessionRuntimeReplacement,
	SessionRuntimeTarget,
	SessionSummary,
	SessionTargetedValue,
	SessionTodoSnapshot,
	SessionUiResponseInput,
	PiSubagentEntry,
	UpdateSessionRecordInput,
	WebServiceStatusInfo,
} from "../../shared/types";
import type { PendingUiRequestSnapshot } from "../sessions/SessionRuntimeCoordinator";
import { replaceExpandedRefBlocksWithLabels } from "../../shared/expandedRefBlocks";
import { serializeWebClientDictionaries, webEnUS } from "./WebI18n";
import { WebEventStreamRouter, serializeSseFrame, type PiEvent } from "./WebEventStream";
import { rewriteWebHtmlAssetUrls } from "./webHtmlAssetUrls";

type WebServiceSettings = Pick<AppSettings, "webServiceEnabled" | "webServiceHost" | "webServicePort" | "webServiceRequiresAuth" | "webServiceToken" | "webServiceTokenGeneratedAt" | "webServiceTokenExpiresIn">;

/** 令牌策略的最小形状（applySettings/restart → start 传递，避免 start 直接依赖完整设置） */
type WebTokenPolicy = { token?: string; generatedAt?: number; expiresIn?: number };

/** 清洗 host 输入：去空白、剥 IPv6 方括号、空串兜底为 0.0.0.0。 */
export function normalizeWebHost(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed || "0.0.0.0";
}

/** /api JSON 请求体逻辑上限：超出后丢弃剩余数据并回 413（合法 payload 都是短 JSON，见 memo H3） */
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
/** 硬上限：超过即断开连接，阻断无界上传占带宽/触发内存峰值 */
const HARD_BODY_ABORT_BYTES = 16 * 1024 * 1024;

/** readJson 超限的哨兵错误：由 createServer 的统一 catch 映射为 413 */
class WebBodyTooLargeError extends Error {
	constructor() {
		super("WEB_SERVICE_BODY_TOO_LARGE");
		this.name = "WebBodyTooLargeError";
	}
}

/** /api/chat 图片 parts 上限：最多 4 张，单张 base64 ≤2MB（客户端已预压缩）。 */
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

/** 有界读文件：先 stat 校验大小再读，超过 maxBytes 抛错（避免把超大文件拉进内存）。 */
async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
	const info = await stat(path);
	if (!info.isFile() || info.size > maxBytes) {
		throw new Error(`WEB_SERVICE_FILE_TOO_LARGE_OR_MISSING: ${info.size} > ${maxBytes}`);
	}
	return readFile(path);
}

type WebServiceDependencies = {
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
	forkRuntimeSession: (target: SessionRuntimeTarget, entryId: string) => Promise<SessionCommandResult<SessionTargetedValue<unknown>>>;
	/** 会话活动监控（第二批 strips）：文件变更/子代理/todo 快照，装配侧对齐桌面 IPC 语义（含 running 降级对账）。缺省时路由返回 503。 */
	listSessionFileChanges?: (sessionId: string) => Promise<SessionFileChange[]>;
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

function serializePublicWebPayload(body: unknown): string {
	return JSON.stringify(body, function (key, value) {
		if (key === "debugDetails" || key === "stack") return undefined;
		if (key === "error" && typeof value === "string" && this && typeof this === "object" && typeof (this as { i18nKey?: unknown }).i18nKey === "string") {
			const i18nKey = (this as { i18nKey: string }).i18nKey;
			return (webEnUS as Record<string, string>)[i18nKey] ?? webEnUS["webError.internal"];
		}
		return value;
	});
}

export class WebServiceManager {
	private server: Server | null = null;
	private current: {
		host: string;
		port: number;
		token: string;
		requiresAuth: boolean;
		tokenExpiresAt: number | null;
	} | null = null;
	/** 访问令牌：持久化固定（deps.persistToken 回写设置），重启不换新，见 applyTokenPolicy。 */
	private authToken = "";
	/** 令牌生成/最后修改时刻（epoch ms），持久化不随重启重置 */
	private tokenGeneratedAt = 0;
	/** 令牌有效期（ms）；0 = 永不过期 */
	private tokenExpiresInMs = 0;
	/** P1-P3 工作区路由（git/files/prompts）；未装配时这些路由 404。由 main/index.ts 在构造后注入。 */
	workspaceRoutes: { handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> } | null = null;
	/** 设置页「需要 token 鉴权」开关；true 时所有 /api/*（/api/health 除外）强制令牌。 */
	private requiresAuth = false;
	/** dev 模式渲染层 dev server 基址（无尾斜杠）；空串表示走构建产物。 */
	private readonly devRendererUrl: string;
	private readonly rendererRoot = join(__dirname, "../renderer");
	/** web.html 改写后的缓存（按文件 mtime 失效）：避免每次页面请求都重读重改写。 */
	private webEntryHtmlCache: { mtimeMs: number; html: string } | null = null;

	private readonly eventStreamRouter: WebEventStreamRouter;

	/** dev 模式被劫持的 upgrade socket（vite HMR 代理）：Node 的 closeAllConnections
	 *  不追踪 upgrade 后的 socket，不手动销毁会让 stop() 的 server.close() 永远等不到回调。 */
	private readonly hijackedSockets = new Set<import("node:stream").Duplex>();

	// ── /api/events 状态推送（B：替代 Web 端 1s/3s 轮询）──
	/** 订阅者集合；写失败（连接断开）时在推送循环里剔除。 */
	private readonly stateEventClients = new Set<{ writeRaw: (wire: string) => boolean }>();
	/** 变化检测去抖定时器：pi 事件风暴（流式期间每秒数十条）合并成一次快照比对。 */
	private statePushTimer: ReturnType<typeof setTimeout> | null = null;
	/** 最近一次广播的载荷；快照与它一致则跳过推送（流式期间 state 多数字段不变）。 */
	private lastStatePushJson: string | null = null;
	/** 低频兑底 tick：捕捉不经 pi 事件的目录变更（桌面端改名/删除/导入）。 */
	private stateTickTimer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly deps: WebServiceDependencies) {
		this.devRendererUrl = deps.devRendererUrl?.trim() ? deps.devRendererUrl.trim().replace(/\/$/, "") : "";
		this.eventStreamRouter = new WebEventStreamRouter((agentId) => this.deps.getSessionIdForAgent(agentId));
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

	/**
	 * 应用令牌策略（返回是否变化）：
	 * - 有持久化令牌 → 沿用（重启不换新，远程设备已保存的链接不失效）；
	 * - 无持久化令牌 → 自动生成 UUID 并回写（首次启用）；
	 * - expiresIn 从 generatedAt 起算，0 = 永不过期；generatedAt 缺省视为 now。
	 */
	private applyTokenPolicy(policy: WebTokenPolicy): boolean {
		const persisted = policy.token?.trim();
		const nextToken = persisted && persisted === this.authToken ? this.authToken : persisted || randomUUID();
		const nextGeneratedAt = policy.generatedAt && policy.generatedAt > 0 ? policy.generatedAt : Date.now();
		const nextExpiresIn = policy.expiresIn && policy.expiresIn > 0 ? policy.expiresIn : 0;
		// 新生成的令牌没有持久值可沿用，立即回写（首次启用场景）。
		if (!persisted) this.deps.persistToken?.({ token: nextToken, generatedAt: nextGeneratedAt, expiresIn: nextExpiresIn });
		if (nextToken === this.authToken && nextGeneratedAt === this.tokenGeneratedAt && nextExpiresIn === this.tokenExpiresInMs) return false;
		this.authToken = nextToken;
		this.tokenGeneratedAt = nextGeneratedAt;
		this.tokenExpiresInMs = nextExpiresIn;
		return true;
	}

	/** 运行中热应用令牌策略并广播（applySettings 保存路径用，不重启服务）。 */
	private refreshTokenRuntime(policy: WebTokenPolicy) {
		if (this.applyTokenPolicy(policy)) this.scheduleStatePush();
	}

	/**
	 * 设置页手动修改令牌 / 过期策略（web:set-token IPC）：立即热生效 + 持久化，
	 * 不重启服务（远程设备仅旧令牌失效，服务本身不断）；服务未运行时仅持久化。
	 */
	setTokenPolicy(input: { token?: string; expiresIn?: number }): void {
		const nextToken = input.token?.trim() || this.authToken;
		const nextExpiresIn = input.expiresIn !== undefined ? (input.expiresIn > 0 ? input.expiresIn : 0) : this.tokenExpiresInMs;
		// 手动修改令牌 → 过期计时重新起算；仅改过期策略 → 沿用原 generatedAt。
		const tokenChanged = nextToken !== this.authToken;
		const nextGeneratedAt = tokenChanged ? Date.now() : this.tokenGeneratedAt || Date.now();
		if (input.token !== undefined || input.expiresIn !== undefined) this.deps.persistToken?.({ token: nextToken, generatedAt: nextGeneratedAt, expiresIn: nextExpiresIn });
		this.authToken = nextToken;
		this.tokenGeneratedAt = nextGeneratedAt;
		this.tokenExpiresInMs = nextExpiresIn;
		if (this.current) {
			this.current = { ...this.current, token: this.authToken, tokenExpiresAt: this.computeTokenExpiresAt() };
			this.scheduleStatePush();
		}
	}

	/** expiresIn > 0 时的绝对过期时刻；0/未设置 → null（永不过期）。 */
	private computeTokenExpiresAt(): number | null {
		return this.tokenExpiresInMs > 0 ? this.tokenGeneratedAt + this.tokenExpiresInMs : null;
	}

	/**
	 * 轮换访问令牌（设置页「重新生成令牌」）：立即换新并广播状态。
	 * 旧令牌下一个请求即 401；已建立的 SSE 连接不主动断（下次事件写入失败自然回收），
	 * Web 端由 401 兜底 UX 引导重新扫码。未运行时无操作。
	 */
	rotateToken(): void {
		const nextToken = randomUUID();
		const nextGeneratedAt = Date.now();
		// 轮换后持久化新令牌并重置计时（否则旧 generatedAt 会让新令牌一出生就临近过期）；未运行时仅持久化，下次启动生效。
		this.deps.persistToken?.({ token: nextToken, generatedAt: nextGeneratedAt, expiresIn: this.tokenExpiresInMs });
		this.authToken = nextToken;
		this.tokenGeneratedAt = nextGeneratedAt;
		if (this.current) {
			this.current = { ...this.current, token: this.authToken, tokenExpiresAt: this.computeTokenExpiresAt() };
			this.scheduleStatePush();
		}
	}

	/** 渲染层展示二维码/令牌用；未运行时返回空形状（running=false） */
	getStatus(): WebServiceStatusInfo {
		if (this.current) {
			return { running: true, ...this.current };
		}
		return { running: false, host: "", port: 0, token: "", requiresAuth: false, tokenExpiresAt: null };
	}

	async stop() {
		// 解绑 pi 事件源，避免服务关闭后仍在转发事件到已失效的 SSE 连接。
		this.eventStreamRouter.unbindPiSource();
		// /api/events：停定时器、断开全部状态订阅者（避免向已关服务的 socket 写数据）。
		if (this.statePushTimer) {
			clearTimeout(this.statePushTimer);
			this.statePushTimer = null;
		}
		if (this.stateTickTimer) {
			clearInterval(this.stateTickTimer);
			this.stateTickTimer = null;
		}
		for (const client of this.stateEventClients) {
			try {
				client.writeRaw(": service stopping\n\n");
			} catch {
				// 连接已失效则忽略
			}
		}
		this.stateEventClients.clear();
		this.lastStatePushJson = null;
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
		// 销毁被劫持的 upgrade socket（dev HMR 代理），否则 server.close() 回调不触发、stop() 挂死。
		for (const socket of this.hijackedSockets) {
			try {
				socket.destroy();
			} catch {
				// 已销毁的 socket 重复 destroy 是安全的，防御即可
			}
		}
		this.hijackedSockets.clear();
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
		// 启动时绑定 pi 事件源；路由器只在存在活跃 SSE 连接时转发，空闲时零开销。
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
		// 5s 兑底 tick：捕捉不经 pi 事件的目录变更（桌面端改名/删除/导入等）。
		this.stateTickTimer = setInterval(() => this.scheduleStatePush(), 5_000);
		const server = createServer(async (request, response) => {
			try {
				await this.handleRequest(request, response, host, port, server);
			} catch (error) {
				if (error instanceof WebBodyTooLargeError) {
					this.sendError(response, 413, "webError.bodyTooLarge", "Request body exceeds the size limit");
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
		if (this.devRendererUrl) {
			server.on("upgrade", (request, socket, head) => {
				this.proxyDevWebSocket(request, socket, head);
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
			token: this.authToken,
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
		if (this.requiresAuth && url.pathname.startsWith("/api/") && !this.isAuthorized(request, url)) {
			this.sendError(response, 401, "webError.unauthorized", "A valid web service token is required");
			return;
		}
		if (url.pathname === "/api/events" && request.method === "GET") {
			this.handleStateEvents(request, response);
			return;
		}
		if (url.pathname === "/api/state") {
			this.sendJson(response, await this.getState());
			return;
		}
		if (url.pathname === "/api/ui-response" && request.method === "POST") {
			const body = await this.readJson<Partial<SessionUiResponseInput>>(request);
			const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
			const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
			const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
			const runtimeGeneration = typeof body.runtimeGeneration === "number" ? body.runtimeGeneration : NaN;
			if (!sessionId || !requestId || !agentId || !Number.isFinite(runtimeGeneration)) {
				this.sendError(response, 400, "webError.requestIdRequired", "ui response target is required");
				return;
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
			return;
		}
		if (url.pathname === "/api/models" && request.method === "GET") {
			// force=1：目标端 UI 点刷新时绕过模型列表缓存，重新 fork pi --list-models。
			const force = url.searchParams.get("force") === "1";
			this.sendJson(response, { models: await this.deps.listModels(force) });
			return;
		}
		if (url.pathname === "/api/projects" && request.method === "POST") {
			const body = await this.readJson<{ path?: string }>(request);
			const path = body.path?.trim() ?? "";
			if (!path) {
				this.sendError(response, 400, "webError.projectPathRequired", "path is required");
				return;
			}
			const project = await this.deps.createProject(path);
			this.sendJson(response, { project });
			return;
		}
		const deleteProjectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/delete$/);
		if (deleteProjectMatch && request.method === "POST") {
			const projectId = decodeURIComponent(deleteProjectMatch[1]);
			const project = this.deps.listProjects().find((item) => item.id === projectId);
			if (!project) {
				this.sendError(response, 404, "webError.projectNotFound", "project not found");
				return;
			}
			if (project.kind === "chat") {
				this.sendError(response, 400, "webError.chatProjectProtected", "the built-in chat project cannot be deleted");
				return;
			}
			const deleted = await this.deps.deleteProject(projectId);
			this.sendJson(response, { deleted });
			return;
		}
		const sessionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
		if (sessionsMatch && request.method === "GET") {
			const sessions = await this.deps.listSessions(decodeURIComponent(sessionsMatch[1]));
			this.sendJson(response, { sessions });
			return;
		}
		const catalogSessionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions\/catalog$/);
		if (catalogSessionsMatch && request.method === "GET") {
			const sessions = await this.deps.listCatalogSessions(decodeURIComponent(catalogSessionsMatch[1]));
			this.sendJson(response, { sessions });
			return;
		}
		// ── 会话活动监控（第二批 strips）：文件变更/子代理/todo，与桌面 IPC 同源数据 ──
		const fileChangesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/file-changes$/);
		if (fileChangesMatch && request.method === "GET") {
			if (!this.deps.listSessionFileChanges) {
				this.sendError(response, 503, "webError.stripsUnavailable", "session file changes are not available");
				return;
			}
			this.sendJson(response, { changes: await this.deps.listSessionFileChanges(decodeURIComponent(fileChangesMatch[1])) });
			return;
		}
		const subagentsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/subagents$/);
		if (subagentsMatch && request.method === "GET") {
			if (!this.deps.listSessionSubagents) {
				this.sendError(response, 503, "webError.stripsUnavailable", "session subagents are not available");
				return;
			}
			this.sendJson(response, { subagents: await this.deps.listSessionSubagents(decodeURIComponent(subagentsMatch[1])) });
			return;
		}
		const todoMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/todo$/);
		if (todoMatch && request.method === "GET") {
			if (!this.deps.listSessionTodo) {
				this.sendError(response, 503, "webError.stripsUnavailable", "session todo is not available");
				return;
			}
			this.sendJson(response, { todo: (await this.deps.listSessionTodo(decodeURIComponent(todoMatch[1]))) ?? null });
			return;
		}
		// ── DSH 工具面板路由（S6.3：goals/subagents/skills；无活跃 runtime 返回空）──
		const dshSubagentsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/dsh\/subagents$/);
		if (dshSubagentsMatch && request.method === "GET") {
			const agentId = this.runtimeAgentIdForSession(decodeURIComponent(dshSubagentsMatch[1]));
			if (!agentId || !this.deps.listDshSubagents) {
				this.sendJson(response, { subagents: [] });
				return;
			}
			this.sendJson(response, { subagents: await this.deps.listDshSubagents(agentId) });
			return;
		}
		const dshSubagentHistoryMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/dsh\/subagents\/([^/]+)\/history$/);
		if (dshSubagentHistoryMatch && request.method === "GET") {
			const agentId = this.runtimeAgentIdForSession(decodeURIComponent(dshSubagentHistoryMatch[1]));
			const childSessionId = decodeURIComponent(dshSubagentHistoryMatch[2]);
			if (!agentId || !this.deps.readDshSubagentHistory) {
				this.sendJson(response, { messages: [], hasMore: false });
				return;
			}
			const beforeSeq = this.queryNumber(url, "beforeSeq");
			const maxMessages = this.queryNumber(url, "maxMessages");
			this.sendJson(response, await this.deps.readDshSubagentHistory(agentId, childSessionId, beforeSeq, maxMessages));
			return;
		}
		const dshSkillsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/dsh\/skills$/);
		if (dshSkillsMatch && request.method === "GET") {
			const agentId = this.runtimeAgentIdForSession(decodeURIComponent(dshSkillsMatch[1]));
			if (!agentId || !this.deps.listDshSkills) {
				this.sendJson(response, { skills: [] });
				return;
			}
			this.sendJson(response, { skills: await this.deps.listDshSkills(agentId) });
			return;
		}
		const dshGoalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/dsh\/goal$/);
		if (dshGoalMatch && request.method === "GET") {
			const target = this.runtimeTargetForSession(decodeURIComponent(dshGoalMatch[1]));
			if (!target) {
				this.sendJson(response, { goal: null });
				return;
			}
			const result = await this.deps.getSessionRuntimeState(target);
			const state = result.ok && result.value && "value" in result.value ? (result.value as { value?: AgentRuntimeState }).value : undefined;
			this.sendJson(response, { goal: state?.goal ?? null });
			return;
		}
		// ── DSH 插件路由（S6.5：动态插件清单/安装/启停/卸载，与桌面配置页同源）──
		if (url.pathname === "/api/dsh/plugins" && request.method === "GET") {
			this.sendJson(response, {
				dynamic: this.deps.listDshDynamicPlugins ? await this.deps.listDshDynamicPlugins() : [],
				static: this.deps.listDshStaticPlugins ? await this.deps.listDshStaticPlugins() : [],
			});
			return;
		}
		if (url.pathname === "/api/dsh/plugins/install" && request.method === "POST") {
			const body = await this.readJson<import("../../shared/types").DshPluginInstallInput>(request);
			if (!body.sessionId?.trim() || !this.deps.installDshPlugin) {
				this.sendError(response, 400, "webError.pluginInstallRequired", "plugin install requires sessionId");
				return;
			}
			try {
				this.sendJson(response, { receipt: await this.deps.installDshPlugin(body) });
			} catch (error) {
				this.sendError(response, 400, "webError.pluginInstallFailed", error instanceof Error ? error.message : "plugin install failed");
			}
			return;
		}
		const dshPluginActionMatch = url.pathname.match(/^\/api\/dsh\/plugins\/([^/]+)\/(run|stop|uninstall)$/);
		if (dshPluginActionMatch && request.method === "POST") {
			const pluginId = decodeURIComponent(dshPluginActionMatch[1]);
			const action = dshPluginActionMatch[2];
			const body = await this.readJson<{ sessionId?: string; packageId?: string }>(request);
			if (!body.sessionId?.trim()) {
				this.sendError(response, 400, "webError.pluginActionRequired", "plugin action requires sessionId");
				return;
			}
			const fn = action === "run" ? this.deps.runDshPlugin : action === "stop" ? this.deps.stopDshPlugin : this.deps.uninstallDshPlugin;
			if (!fn) {
				this.sendError(response, 400, "webError.pluginUnavailable", "DSH plugins are not available");
				return;
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
			return;
		}
		if (url.pathname === "/api/sessions/runtimes" && request.method === "GET") {
			this.sendJson(response, { runtimes: this.deps.listSessionRuntimes() });
			return;
		}
		if (url.pathname === "/api/sessions" && request.method === "POST") {
			const body = await this.readJson<CreateSessionDraftInput>(request);
			if (!body.projectId?.trim()) {
				this.sendError(response, 400, "webError.projectIdRequired", "projectId is required");
				return;
			}
			const session = await this.deps.createSessionDraft(body);
			this.sendJson(response, { session });
			return;
		}
		if (url.pathname === "/api/sessions/anonymous" && request.method === "POST") {
			const body = await this.readJson<CreateAnonymousSessionInput>(request);
			if (!body.projectId?.trim()) {
				this.sendError(response, 400, "webError.projectIdRequired", "projectId is required");
				return;
			}
			const result = await this.deps.createAnonymousSession(body);
			this.sendJson(response, result);
			return;
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
			return;
		}
		const sessionReferenceMessagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/reference-messages$/);
		if (sessionReferenceMessagesMatch && request.method === "GET") {
			const messages = await this.deps.readSessionReferenceMessages(decodeURIComponent(sessionReferenceMessagesMatch[1]));
			this.sendJson(response, { messages });
			return;
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
			return;
		}
		const sessionMessagePageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages\/page$/);
		if (sessionMessagePageMatch && request.method === "GET") {
			const beforeValue = url.searchParams.get("before");
			const pageSizeValue = url.searchParams.get("pageSize");
			const before = beforeValue === null ? undefined : Number(beforeValue);
			const pageSize = pageSizeValue === null ? undefined : Number(pageSizeValue);
			const page = await this.deps.readSessionMessagePage(decodeURIComponent(sessionMessagePageMatch[1]), Number.isSafeInteger(before) ? before : undefined, Number.isSafeInteger(pageSize) ? pageSize : undefined);
			this.sendJson(response, page);
			return;
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
			return;
		}
		const sessionPromptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
		if (sessionPromptMatch && request.method === "POST") {
			const sessionId = decodeURIComponent(sessionPromptMatch[1]);
			const body = await this.readJson<Omit<SendSessionPromptInput, "sessionId">>(request);
			const message = body.message?.trim() ?? "";
			if (!body.requestId?.trim()) {
				this.sendError(response, 400, "webError.requestIdRequired", "requestId is required");
				return;
			}
			if (!message && !body.images?.length) {
				this.sendError(response, 400, "webError.messageRequired", "message or images is required");
				return;
			}
			const result = await this.deps.sendSessionPrompt({
				...body,
				sessionId,
				message,
			});
			this.sendJson(response, { result });
			return;
		}

		// SSE 流式端点：按 AI SDK v5 UIMessageStream 协议输出 pi agent 事件，
		// 前端提交 prompt 后订阅本端点实现打字机/思考/工具实时展示（A1）；
		// 协议与 useChat 兼容，升级 A2 时前端换成 React hook 即可，后端零改动。
		const streamMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
		if (streamMatch && request.method === "GET") {
			const sessionId = decodeURIComponent(streamMatch[1]);
			this.handleStream(sessionId, request, response);
			return;
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
				return;
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
				return;
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
				return;
			}
			return;
		}
		const sessionRuntimeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runtime\/(stop|abort|restart|compact|state|commands|export-html|edit-message|delete-message|prepare-resend|models|model|thinking|permission|clone|fork|get-fork-messages|rewind-list|rewind-diff|rewind-restore)$/);
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
			}>(request);
			const target = body.target;
			if (!target || target.sessionId !== sessionId) {
				this.sendError(response, 400, "webError.runtimeTargetRequired", "A matching Session runtime target is required");
				return;
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
					return;
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
					result = await this.deps.forkRuntimeSession(target, typeof body.entryId === "string" ? body.entryId : "");
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
			return;
		}
		if (url.pathname.startsWith("/api/")) {
			// P1-P3 工作区路由（git/files/prompts）：独立模块承载，返回 false 表示未命中
			if (this.workspaceRoutes && (await this.workspaceRoutes.handle(url, request, response))) return;
			this.sendError(response, 404, "webError.apiNotFound", "API not found");
			return;
		}

		await this.serveRenderer(url, response);
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

	private async getState() {
		// messagesBySession 已移除（P0：轮询全量消息是纯浪费，React A2 从不消费；
		// LAN Web 全量 UI 改为按 runtime 拉 GET /api/sessions/:id/messages，A1 兜底页
		// 切会话/流结束时拉 /messages/page）。
		const sessions = await this.deps.listCatalogSessions();
		const runtimes = this.deps.listSessionRuntimes();
		return {
			projects: this.deps.listProjects(),
			sessions,
			runtimes,
			pendingUiRequests: this.deps.listPendingUiRequests(),
		};
	}

	/**
	 * /api/events SSE：把项目/会话/运行态快照推给 Web 端，替代 1s/3s 轮询。
	 *
	 * 主进程没有统一的「state 变更」emitter（桌面端的推送点散落在 emitSessionRuntimeEvent
	 * 各调用处），因此这里用「事件驱动 + 低频兑底」的变化检测：pi agent 事件（runtime
	 * 状态翻转 / ask 待确认等的源头）到达时去抖 400ms 比对一次快照，另有 5s tick 兑底
	 * 捕捉桌面端发起的目录变更（改名/删除/导入）。快照与上次广播一致则不推——流式期间
	 * pi 事件高频但 state 载荷几乎不变，靠 JSON 比对免推。
	 */
	private handleStateEvents(request: IncomingMessage, response: ServerResponse): void {
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
			"access-control-allow-origin": "*",
		});
		response.flushHeaders?.();

		const client = {
			writeRaw: (wire: string): boolean => {
				if (response.writableEnded || response.destroyed) return false;
				try {
					response.write(wire);
					return true;
				} catch {
					return false;
				}
			},
		};
		this.stateEventClients.add(client);
		// 连接即推当前快照：前端订阅成功后不再需要首拉 /api/state。
		void this.pushStateSnapshot([client], true);

		// 心跳：防代理/浏览器空闲断连（与会话流同节奏）。
		const heartbeat = setInterval(() => {
			if (response.writableEnded || response.destroyed) {
				cleanup();
				return;
			}
			try {
				response.write(": ping\n\n");
			} catch {
				cleanup();
			}
		}, 15_000);
		const cleanup = () => {
			clearInterval(heartbeat);
			this.stateEventClients.delete(client);
			if (!response.writableEnded) {
				try {
					response.end();
				} catch {
					// 已销毁的连接 end() 抛错可忽略
				}
			}
		};
		response.once("close", cleanup);
		request.once("close", cleanup);
	}

	/** 去抖调度一次快照广播；已有待发定时器时静默合并（事件风暴防抖）。 */
	private scheduleStatePush(): void {
		if (this.statePushTimer) return;
		this.statePushTimer = setTimeout(() => {
			this.statePushTimer = null;
			void this.pushStateSnapshot();
		}, 400);
	}

	/**
	 * 构建快照并推给目标订阅者（缺省全部）。
	 * force=true 时无视「与上次一致」门控（新连接的初始快照必须下发）。
	 */
	private async pushStateSnapshot(targetClients: Array<{ writeRaw: (wire: string) => boolean }> = [...this.stateEventClients], force = false): Promise<void> {
		if (targetClients.length === 0) return;
		let json: string;
		try {
			json = serializePublicWebPayload(await this.getState());
		} catch {
			// 快照构建失败不广播（订阅者保留旧状态，兑底 tick / 轮询会重试）
			return;
		}
		if (!force && json === this.lastStatePushJson) return;
		this.lastStatePushJson = json;
		const wire = `event: state\ndata: ${json}\n\n`;
		for (const client of targetClients) {
			if (!client.writeRaw(wire)) this.stateEventClients.delete(client);
		}
	}

	private renderPage() {
		return `<!doctype html>
<html lang="en-US">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
	<link rel="manifest" href="/manifest.webmanifest" />
	<meta name="theme-color" content="#18181b" />
	<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
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
		.session-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: stretch; }
		.close-session { padding: 0 10px; font-size: 12px; }
		.messages { overflow: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
		.message { max-width: min(820px, 88%); border: 1px solid #dfe5ee; background: #fff; border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; line-height: 1.55; }
		.message.user { align-self: flex-end; background: #eaf8ee; border-color: #bee8c6; }
		.message.error { border-color: #ffd0d0; background: #fff4f4; color: #b42318; }
		.message.streaming { border-color: #c3d5f0; background: #f7fafd; }
		.role { display: block; margin-bottom: 4px; font-size: 11px; font-weight: 700; color: #687280; }
		.streaming-thinking { margin: 6px 0; padding: 6px 10px; border-left: 3px solid #b8c2d0; background: #f1f4f8; color: #687280; font-size: 12px; white-space: pre-wrap; line-height: 1.5; }
		.streaming-tool { margin: 6px 0; padding: 6px 10px; border: 1px solid #dfe5ee; border-radius: 6px; background: #fbfcfe; font-size: 12px; color: #46505e; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
		.streaming-tool .tool-name { font-weight: 700; color: #14a514; }
		.streaming-tool.error .tool-name { color: #d93025; }
		.caret { display: inline-block; width: 7px; height: 14px; margin-left: 2px; vertical-align: -2px; background: #14a514; animation: blink 1s steps(2) infinite; }
		@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
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
			<div id="projects-title" class="section-title"></div>
			<div id="projects" class="list"></div>
			<div id="sessions-title" class="section-title"></div>
			<div id="sessions" class="list"></div>
		</aside>
		<main>
			<header>
				<h1 id="title"></h1>
				<div class="header-actions">
					<span id="status" class="status"></span>
					<button class="danger" type="button" id="stop"></button>
				</div>
			</header>
			<div id="messages" class="messages"></div>
			<form id="composer" class="composer">
				<div class="composer-box">
					<textarea id="prompt"></textarea>
					<div class="composer-actions">
						<button class="primary" type="submit" id="submit"></button>
					</div>
				</div>
				<div id="composer-hint" class="composer-hint"></div>
			</form>
		</main>
	</div>
	<script>
		const dictionaries = ${serializeWebClientDictionaries()};
		const clientTag = (navigator.languages?.[0] || navigator.language || "").replace(/_/g, "-").toLowerCase();
		const locale = clientTag.startsWith("zh") ? (/hant|zh-(tw|hk|mo)/.test(clientTag) ? "zh-TW" : "zh-CN") : "en-US";
		const copy = dictionaries[locale] || dictionaries["en-US"];
		// messagesBySession 现在是纯客户端缓存：/api/state 不再携带全量消息（P0 轮询瘦身），
		// 切会话/轮询时按需拉 /messages/page。
		let state = { projects: [], sessions: [], runtimes: [], messagesBySession: {} };
		let activeSessionId = "";
		let creatingProjectId = "";
		let refreshing = false;
		const el = (id) => document.getElementById(id);
		function tr(key, params) {
			let text = copy[key] || dictionaries["en-US"][key] || key;
			if (!params) return text;
			return text.replace(/\\{(\\w+)\\}/g, (match, name) => params[name] == null ? match : String(params[name]));
		}
		function trOr(key, fallback) {
			return copy[key] || dictionaries["en-US"][key] || fallback;
		}
		function localizeDescriptor(value, fallback) {
			if (!value?.i18nKey || !copy[value.i18nKey]) return fallback;
			return tr(value.i18nKey, value.i18nParams);
		}
		function localizeMessage(message) {
			// Web 端消息是纯文本出口：折叠自包含引用块，避免把 <quoted_context> 等 XML 原文发给浏览器。
			const localized = replaceExpandedRefBlocksWithLabels(
				localizeDescriptor(message.meta, message.text || ""),
			);
			const debug = typeof message.meta?.debugDetails === "string" ? message.meta.debugDetails.trim() : "";
			if (debug) console.error(debug);
			return localized;
		}
		function runtimeFor(sessionId) {
			return state.runtimes.find(runtime => runtime.sessionId === sessionId);
		}
		function runtimeTarget(runtime) {
			return runtime ? {
				sessionId: runtime.sessionId,
				agentId: runtime.agentId,
				runtimeGeneration: runtime.runtimeGeneration,
			} : undefined;
		}
		function displayStatus(session, runtime) {
			return trOr("web.status." + (runtime?.status || session?.status || "unknown"), tr("web.status.unknown"));
		}
		function mergeRejectedDraft(rejected, current) {
			return [rejected, current].filter(value => value && value.trim()).join("\n\n");
		}
		function applyStaticCopy() {
			document.documentElement.lang = locale;
			el("projects-title").textContent = tr("web.projects");
			el("sessions-title").textContent = tr("web.sessions");
			el("title").textContent = tr("web.chooseSession");
			el("status").textContent = tr("web.connecting");
			el("stop").textContent = tr("web.closeSession");
			el("messages").innerHTML = '<div class="empty">' + escapeHtml(tr("web.emptySelection")) + '</div>';
			el("prompt").placeholder = tr("web.promptPlaceholder");
			el("submit").textContent = tr("web.send");
			el("composer-hint").textContent = tr("web.composerHint");
		}
		async function api(path, options) {
			const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
			if (!res.ok) {
				const payload = await res.json().catch(() => ({}));
				if (payload.debugDetails) console.error(payload.debugDetails);
				throw new Error(payload.code ? tr(payload.code, payload.params) : (payload.error || res.statusText));
			}
			return res.json();
		}
		async function loadSessionMessages(sessionId) {
			const response = await api(\`/api/sessions/\${encodeURIComponent(sessionId)}/messages/page\`);
			state.messagesBySession = { ...state.messagesBySession, [sessionId]: response.messages || [] };
		}
		async function refresh() {
			if (refreshing) return;
			refreshing = true;
			try {
				const next = await api("/api/state");
				// 保留客户端已加载的消息，清理已删除会话的残留项
				const liveSessionIds = new Set(next.sessions.map(session => session.id));
				for (const key of Object.keys(state.messagesBySession)) {
					if (!liveSessionIds.has(key)) delete state.messagesBySession[key];
				}
				state = { ...next, messagesBySession: state.messagesBySession };
				if (!state.sessions.some(session => session.id === activeSessionId)) {
					activeSessionId = state.sessions[0]?.id || "";
				}
				el("status").textContent = tr("web.connected");
				// 流式期间保留 #messages 的实时打字机内容；仅刷新侧栏/状态，
				// 避免 600ms 轮询的全量 innerHTML 重绘清掉正在流式的块。
				if (streamingSessionId) {
					render();
				} else {
					// 非流式时刷新活跃会话消息（与旧的 /api/state 内嵌行为对齐）
					if (activeSessionId) await loadSessionMessages(activeSessionId);
					render();
					renderMessages();
				}
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
					<small>\${project.id === creatingProjectId ? '<span class="pulse"></span>' + escapeHtml(tr("web.opening")) : escapeHtml(project.path)}</small>
				</button>\`).join("");
			el("sessions").innerHTML = state.sessions.map(session => {
				const runtime = runtimeFor(session.id);
				const project = state.projects.find(item => item.id === session.projectId);
				return \`<div class="session-row">
					<button class="item \${session.id === activeSessionId ? "active" : ""}" data-session="\${session.id}">
						<strong>\${escapeHtml(session.title)}</strong>
						<small>\${runtime?.status === "running" ? '<span class="pulse"></span>' : ""}\${escapeHtml(displayStatus(session, runtime))} · \${escapeHtml(runtime?.cwd || session.projectPath || project?.path || "")}</small>
					</button>
					<button class="close-session ghost" data-close-session="\${session.id}" title="\${escapeHtml(tr("web.closeSession"))}" \${runtime ? "" : "disabled"}>\${escapeHtml(tr("web.closeSession"))}</button>
				</div>\`;
			}).join("");
			const session = state.sessions.find(item => item.id === activeSessionId);
			const runtime = session ? runtimeFor(session.id) : undefined;
			el("title").textContent = session ? session.title : tr("web.chooseSession");
			el("status").innerHTML = runtime?.status === "running"
				? '<span class="pulse"></span>' + escapeHtml(tr("web.responding"))
				: (session ? escapeHtml(displayStatus(session, runtime)) : escapeHtml(tr("web.connected")));
			el("prompt").disabled = !session;
			el("composer").querySelector("button[type=submit]").disabled = !session;
			el("stop").disabled = !runtime || runtime.status === "closed";
			el("stop").textContent = runtime?.status === "running" ? tr("web.stopResponse") : tr("web.closeSession");
		}
		function renderMessages() {
			const messages = activeSessionId ? state.messagesBySession[activeSessionId] || [] : [];
			el("messages").innerHTML = messages.length
				? messages.map(message => \`<div class="message \${message.role}"><span class="role">\${escapeHtml(trOr("web.role." + message.role, message.role))}</span>\${escapeHtml(localizeMessage(message))}</div>\`).join("")
				: '<div class="empty">' + escapeHtml(tr("web.noMessages")) + '</div>';
		}
		document.addEventListener("click", async (event) => {
			const closeButton = event.target.closest("[data-close-session]");
			if (closeButton) {
				const sessionId = closeButton.dataset.closeSession;
				const runtime = runtimeFor(sessionId);
				if (!runtime) return;
				closeButton.disabled = true;
				closeButton.textContent = tr("web.closing");
				try {
					const action = runtime.status === "running" ? "abort" : "stop";
					await api(\`/api/sessions/\${encodeURIComponent(sessionId)}/runtime/\${action}\`, {
						method: "POST",
						body: JSON.stringify({ target: runtimeTarget(runtime) }),
					});
					await refresh();
				} finally {
					closeButton.disabled = false;
					closeButton.textContent = tr("web.closeSession");
				}
				return;
			}
			const projectButton = event.target.closest("[data-project]");
			if (projectButton) {
				creatingProjectId = projectButton.dataset.project;
				render();
				try {
					const result = await api("/api/sessions", { method: "POST", body: JSON.stringify({ projectId: projectButton.dataset.project }) });
					activeSessionId = result.session.id;
					await refresh();
				} finally {
					creatingProjectId = "";
					render();
				}
				return;
			}
			const sessionButton = event.target.closest("[data-session]");
			if (sessionButton) {
				// 切换会话：终止上一个 SSE 流，避免流式块串到别的会话；
				// 每次切换都重拉消息（客户端缓存可能已过期）
				stopStream();
				activeSessionId = sessionButton.dataset.session;
				try {
					await loadSessionMessages(activeSessionId);
				} catch {}
				render();
				renderMessages();
				return;
			}
		});
		// ── SSE 流式渲染：提交 prompt 后订阅 /stream，实时展示思考/工具/文本（A1） ──
		let streamingSessionId = "";
		let streamAbortController = null;
		let streamBlocks = { message: null, thinking: null, text: null, tools: [] };

		function ensureStreamingMessage() {
			if (streamBlocks.message) return streamBlocks.message;
			const messages = el("messages");
			// 清空空态占位（"请选择会话/暂无消息"）后再追加流式块
			const empty = messages.querySelector(".empty");
			if (empty) empty.remove();
			const div = document.createElement("div");
			div.className = "message streaming";
			div.innerHTML = '<span class="role">' + escapeHtml(tr("web.role.assistant")) + '</span>';
			messages.appendChild(div);
			streamBlocks.message = div;
			return div;
		}
		function ensureStreamingThinking() {
			if (streamBlocks.thinking) return streamBlocks.thinking;
			const block = document.createElement("div");
			block.className = "streaming-thinking";
			ensureStreamingMessage().appendChild(block);
			streamBlocks.thinking = block;
			return block;
		}
		function ensureStreamingText() {
			if (streamBlocks.text) return streamBlocks.text;
			const block = document.createElement("div");
			block.className = "streaming-text";
			ensureStreamingMessage().appendChild(block);
			streamBlocks.text = block;
			return block;
		}
		function addToolBlock(name, isError) {
			const block = document.createElement("div");
			block.className = "streaming-tool" + (isError ? " error" : "");
			block.innerHTML = '<span class="tool-name">' + escapeHtml(name) + '</span>' + escapeHtml(" 执行中…");
			ensureStreamingMessage().appendChild(block);
			streamBlocks.tools.push(block);
			return block;
		}
		function scrollStreamToBottom() {
			const messages = el("messages");
			messages.scrollTop = messages.scrollHeight;
		}
		function applyStreamFrame(frame) {
			const type = frame && frame.type;
			if (!type) return;
			if (type === "reasoning-start") {
				ensureStreamingThinking();
				scrollStreamToBottom();
				return;
			}
			if (type === "reasoning-delta") {
				const block = ensureStreamingThinking();
				block.textContent += (frame.delta || "");
				scrollStreamToBottom();
				return;
			}
			if (type === "reasoning-end") {
				scrollStreamToBottom();
				return;
			}
			if (type === "text-start") {
				ensureStreamingText();
				scrollStreamToBottom();
				return;
			}
			if (type === "text-delta") {
				const block = ensureStreamingText();
				block.textContent += (frame.delta || "");
				scrollStreamToBottom();
				return;
			}
			if (type === "text-end") {
				scrollStreamToBottom();
				return;
			}
			if (type === "tool-input-available") {
				const tool = addToolBlock(frame.toolName || "tool", false);
				// 记录工具名供 output 阶段回写（dataset 无法存 JSON 外的富文本，这里直接存）
				tool.dataset.toolName = String(frame.toolName || "tool");
				scrollStreamToBottom();
				return;
			}
			if (type === "tool-output-available") {
				const tool = streamBlocks.tools.pop();
				if (tool) {
					tool.className = "streaming-tool" + (frame.output && frame.output.error ? " error" : "");
					tool.innerHTML = '<span class="tool-name">' + escapeHtml(tool.dataset.toolName || "tool") + '</span>' + escapeHtml(" 完成");
				}
				scrollStreamToBottom();
				return;
			}
			if (type === "error") {
				const block = ensureStreamingText();
				block.textContent += "\n[错误] " + (frame.errorText || "");
				scrollStreamToBottom();
				return;
			}
			// finish / start 等由外部统一处理
		}
		async function startStream(sessionId) {
			stopStream();
			streamingSessionId = sessionId;
			streamBlocks = { message: null, thinking: null, text: null, tools: [] };
			streamAbortController = new AbortController();
			try {
				const res = await fetch(
					\`/api/sessions/\${encodeURIComponent(sessionId)}/stream\`,
					{ signal: streamAbortController.signal, headers: { accept: "text/event-stream" } },
				);
				if (!res.ok || !res.body) {
					el("status").textContent = tr("web.streamFailed");
					return;
				}
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					// SSE 帧以空行分隔；逐帧解析 data: 行
					let sep;
					while ((sep = buffer.indexOf("\n\n")) !== -1) {
						const rawEvent = buffer.slice(0, sep);
						buffer = buffer.slice(sep + 2);
						const dataLine = rawEvent.split("\n").find(line => line.startsWith("data:"));
						if (!dataLine) continue;
						const payload = dataLine.slice(5).trim();
						if (payload === "[DONE]") {
							// 流结束：先停流（保留已渲染的打字机内容），再拉权威消息列表整体替换，
							// 保证最终展示的是 pi 落盘的完整回复（含被流式块拆分的边界）。
							setTimeout(() => { finishStream(sessionId); }, 0);
							return;
						}
						if (!payload) continue;
						try {
							applyStreamFrame(JSON.parse(payload));
						} catch { /* 忽略无法解析的帧 */ }
					}
				}
				// 流正常结束（无 [DONE]）也同步一次
				if (streamingSessionId === sessionId) { finishStream(sessionId); }
			} catch (error) {
				if (error && error.name === "AbortError") return;
				el("status").textContent = tr("web.streamFailed");
			} finally {
				if (streamingSessionId === sessionId) streamingSessionId = "";
			}
		}
		function stopStream() {
			if (streamAbortController) {
				try { streamAbortController.abort(); } catch {}
				streamAbortController = null;
			}
			streamingSessionId = "";
			streamBlocks = { message: null, thinking: null, text: null, tools: [] };
		}
		async function finishStream(sessionId) {
			stopStream();
			// 拉取权威消息列表（pi 已落盘完整回复）并整体重绘，替换流式时的增量块。
			try {
				await loadSessionMessages(sessionId);
			} catch { /* 历史加载失败则保留流式内容 */ }
			render();
			renderMessages();
		}
		// 切换会话时终止上一个流，避免串台（在 click 委托中调用 stopStream）
		el("composer").addEventListener("submit", async (event) => {
			event.preventDefault();
			const prompt = el("prompt");
			const message = prompt.value.trim();
			if (!message || !activeSessionId) return;
			const targetSessionId = activeSessionId;
			prompt.value = "";
			try {
				const response = await api(\`/api/sessions/\${encodeURIComponent(targetSessionId)}/prompt\`, {
					method: "POST",
					body: JSON.stringify({ requestId: crypto.randomUUID(), message }),
				});
				if (!response.result.accepted) {
					if (response.result.delivery !== "unknown" && activeSessionId === targetSessionId) {
						prompt.value = mergeRejectedDraft(message, prompt.value);
					}
					el("status").textContent = localizeDescriptor(response.result, response.result.error);
					return;
				}
				// 已接受：立刻打开 SSE 订阅该会话的流式事件；
				// 流结束后（agent_end → [DONE]）再 refresh() 同步权威消息列表。
				if (activeSessionId === targetSessionId) {
					void startStream(targetSessionId);
				} else {
					// 提交后切走了会话，仍要拉一次最新消息
					await refresh();
				}
			} catch (error) {
				// Transport errors are indeterminate after the request leaves the browser.
				// Never restore automatically because the Session may already have accepted it.
				el("status").textContent = error.message || String(error);
				console.error(error);
			}
		});
		el("prompt").addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return;
			event.preventDefault();
			el("composer").requestSubmit();
		});
		el("stop").addEventListener("click", async () => {
			if (!activeSessionId) return;
			const runtime = runtimeFor(activeSessionId);
			if (!runtime) return;
			el("stop").disabled = true;
			el("stop").textContent = tr("web.processing");
			try {
				const action = runtime.status === "running" ? "abort" : "stop";
				await api(\`/api/sessions/\${encodeURIComponent(activeSessionId)}/runtime/\${action}\`, {
					method: "POST",
					body: JSON.stringify({ target: runtimeTarget(runtime) }),
				});
				await refresh();
			} finally {
				el("stop").textContent = tr("web.closeSession");
			}
		});
		function escapeHtml(value) {
			return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
		}
		applyStaticCopy();
		refresh();
		setInterval(refresh, 600);
	</script>
</body>
</html>`;
	}

	private async serveRenderer(url: URL, response: ServerResponse) {
		const requestedPath = decodeURIComponent(url.pathname);
		// ?view=legacy 强制回退到 A1 vanilla 内嵌页，便于对比新旧 Web 前端体验。
		const forceLegacy = url.searchParams.get("view") === "legacy";
		if (forceLegacy) {
			this.sendHtml(response, this.renderPage());
			return;
		}
		// dev 模式：静态资源一律代理到 vite dev server。
		// 否则 electron-vite dev 不产出 out/renderer 构建物，WebServiceManager 会
		// 回退到 A1 vanilla 内嵌页——外部端永远看不到重构后的 React 版（A2）。
		if (this.devRendererUrl) {
			await this.proxyDevRenderer(url, response);
			return;
		}
		// Web 服务根路径：优先 serve React 版 web.html（A2）；
		// 构建产物缺失时回退到内嵌 renderPage（A1 vanilla 页，保持兼容）。
		const webEntry = join(this.rendererRoot, "web.html");
		const relativePath = requestedPath === "/" || !extname(requestedPath) ? (existsSync(webEntry) ? "web.html" : "index.html") : requestedPath.replace(/^\/+/, "");
		const filePath = normalize(join(this.rendererRoot, relativePath));
		// 资源请求（带扩展名且非 .html）缺失时返回 404，不回退内嵌页：
		// 缺失资源若被 HTML 冒充，浏览器按 module script 解析报 MIME 错误白屏。
		const isResourceRequest = Boolean(extname(requestedPath)) && !requestedPath.endsWith(".html");
		// 路径逃逸检查 + 文件存在性；文档请求缺失时回退内嵌页，资源请求 404。
		if (!filePath.startsWith(normalize(this.rendererRoot)) || !existsSync(filePath)) {
			if (isResourceRequest) {
				this.sendError(response, 404, "webError.apiNotFound", "Not found: " + requestedPath);
			} else {
				this.sendHtml(response, this.renderPage());
			}
			return;
		}
		// web.html 单独出口：相对资源引用改写为绝对路径（/s/<id> 路由下 ./assets 会解析成
		// /s/assets/... 而 404 白屏）；sendHtml 的 no-store 保证发版后壳不驻留。
		if (normalize(webEntry) === filePath) {
			this.sendHtml(response, this.loadWebEntryHtml(webEntry));
			return;
		}
		await this.sendFile(filePath, response);
	}

	/** web.html 服务出口：相对资源引用改写为绝对路径（/s/<id> 路由下 ./assets 会 404 白屏，见 webHtmlAssetUrls.ts）。按 mtime 缓存改写结果。 */
	private loadWebEntryHtml(webEntry: string): string {
		const mtimeMs = statSync(webEntry).mtimeMs;
		if (this.webEntryHtmlCache && this.webEntryHtmlCache.mtimeMs === mtimeMs) return this.webEntryHtmlCache.html;
		const html = rewriteWebHtmlAssetUrls(readFileSync(webEntry, "utf8"));
		this.webEntryHtmlCache = { mtimeMs, html };
		return html;
	}

	/**
	 * dev 模式静态资源代理：把请求转发到 vite dev server 对应路径，响应流式回传。
	 * 根路径/无扩展名路径映射到 /web.html（外部端入口，而非桌面端 index.html）。
	 */
	private async proxyDevRenderer(url: URL, response: ServerResponse) {
		const requestedPath = url.pathname;
		// 路径安全：仅允许站内相对路径，禁止 .. 逃逸与绝对路径之外的形式。
		if (!requestedPath.startsWith("/") || requestedPath.includes("..")) {
			this.sendError(response, 400, "webError.apiNotFound", "Invalid path");
			return;
		}
		// 无扩展名路径默认映射 /web.html；但 /@*（vite 内部模块）与 /api/* 必须原样转发——
		// 否则 /@vite/client 会被换成 web.html 的 HTML，浏览器按 module script 执行
		// 报 "MIME text/html" 错误，整个页面空白。query 也要保留：vite 依赖预构建/
		// HMR 模块 URL 依赖 ?v= / ?t= / ?import 参数，丢弃会 404 或失去缓存失效语义。
		const passthrough = requestedPath.startsWith("/@") || requestedPath.startsWith("/api/");
		const targetPath = passthrough ? `${requestedPath}${url.search}` : requestedPath === "/" || !extname(requestedPath) ? "/web.html" : `${requestedPath}${url.search}`;
		// 文档请求（HTML 页面）判定：根路径/无扩展名路径或 .html 结尾；
		// /@* 是 vite 内部模块（/@vite/client、/@fs/...），即便无扩展名也必须是模块请求，
		// 对模块请求绝不能回退/转发 HTML——浏览器按 module script 解析会报 "MIME text/html"，
		// 整页白屏且不自动恢复。
		const isDocumentRequest = !requestedPath.startsWith("/@") && (requestedPath === "/" || !extname(requestedPath) || requestedPath.endsWith(".html"));
		let upstream: Response;
		try {
			upstream = await fetch(`${this.devRendererUrl}${targetPath}`);
		} catch {
			// dev server 未就绪（如只启动了主进程）：文档请求回退内嵌页保证不白屏；
			// 模块/资源请求返回 503，避免把 HTML 冒充 JS 导致 MIME 报错。
			if (isDocumentRequest) {
				this.sendHtml(response, this.renderPage());
			} else {
				this.sendError(response, 503, "webError.internal", "Renderer dev server not ready");
			}
			return;
		}
		const status = upstream.status;
		const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
		// 上游非 200（如 vite 504 Outdated Optimize Dep——deps 重新优化期间旧 URL 失效）：
		// 文档请求回退 A1 内嵌页；模块请求透传上游状态。绝不能对模块请求回退 HTML。
		if (status !== 200 || !upstream.body) {
			if (isDocumentRequest) {
				this.sendHtml(response, this.renderPage());
			} else {
				response.writeHead(status, {
					"content-type": contentType,
					"cache-control": "no-store",
				});
				response.end();
			}
			return;
		}
		// vite 对不存在的路径按 SPA fallback 返回 200 + index.html：模块请求拿到 HTML
		// 说明资源不存在（旧 chunk 名/缓存过期），返回 404 而不是转发 HTML，避免 MIME 错误。
		if (!isDocumentRequest && contentType.includes("text/html")) {
			this.sendError(response, 404, "webError.apiNotFound", "Not found: " + requestedPath);
			return;
		}
		response.writeHead(status, {
			"content-type": contentType,
			"cache-control": "no-store",
		});
		// 流式转发 body，避免整包缓冲大体积 vendor chunk。
		// 上游中断（vite 重启/浏览器取消）时销毁响应而不是让 error 冒泡崩掉进程。
		const bodyStream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
		bodyStream.on("error", () => response.destroy());
		response.on("error", () => bodyStream.destroy());
		bodyStream.pipe(response);
	}

	/**
	 * dev 模式 WebSocket 代理（vite HMR 热更新）：把浏览器的 upgrade 请求原样转发到
	 * dev server（含原始头，vite 会计算 Sec-WebSocket-Accept），拿到 101 后回写
	 * 状态行与响应头，再双向管道透传帧数据。失败时直接销毁 socket，浏览器侧
	 * 会自动重连（vite client 内置重连逻辑），不影响页面本身。
	 */
	private proxyDevWebSocket(request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) {
		const devUrl = new URL(this.devRendererUrl);
		// 劫持 socket 追踪：客户端侧 socket 一进入代理就登记，stop() 统一销毁（见 hijackedSockets 注释）。
		this.hijackedSockets.add(socket);
		socket.on("close", () => this.hijackedSockets.delete(socket));
		// vite 会校验 HMR 握手的 Host/Origin：把两者改写为 dev server 自身，
		// 否则外部端口访问时 vite 按「跨源请求」拒绝 403，HMR 连不上。
		const headers = {
			...request.headers,
			host: devUrl.host,
			origin: devUrl.origin,
		};
		const upstream = httpRequest({
			hostname: devUrl.hostname,
			port: devUrl.port,
			path: request.url ?? "/",
			headers,
			method: "GET",
		});
		upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
			this.hijackedSockets.add(upstreamSocket);
			upstreamSocket.on("close", () => this.hijackedSockets.delete(upstreamSocket));
			const headerLines = Object.entries(upstreamResponse.headers)
				.map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
				.join("\r\n");
			socket.write(`HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? "Switching Protocols"}\r\n${headerLines}\r\n\r\n`);
			// 双向管道；任一端异常时关闭另一端，避免悬挂连接。
			upstreamSocket.pipe(socket).pipe(upstreamSocket);
			upstreamSocket.on("error", () => socket.destroy());
			socket.on("error", () => upstreamSocket.destroy());
			if (upstreamHead?.length) socket.write(upstreamHead);
			if (head?.length) upstreamSocket.write(head);
		});
		upstream.on("error", () => socket.destroy());
		upstream.end();
	}

	private async sendFile(filePath: string, response: ServerResponse) {
		const body = await readFile(filePath);
		response.writeHead(200, {
			"content-type": this.contentType(filePath),
			// HTML 入口（index.html / web.html）必须 no-store：PWA/SW 发新版后不能拿到旧壳引用旧 bundle；
			// sw.js 主脚本浏览器按规范绕过 HTTP 缓存检查更新，不受 immutable 影响
			"cache-control": filePath.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable",
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
			case ".webmanifest":
				return "application/manifest+json; charset=utf-8";
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
		response.end(serializePublicWebPayload(body));
	}

	/**
	 * SSE 流式响应：把 pi agent 事件以 AI SDK UIMessageStream 协议推送给指定 session 的订阅者。
	 * 连接保持到 agent_end（或客户端断开）；断开时由 response close 事件清理路由注册。
	 */
	private handleStream(sessionId: string, request: IncomingMessage, response: ServerResponse): void {
		// 写入 SSE 响应头；AI SDK 前端（useChat）靠 x-vercel-ai-ui-message-stream: v1 识别协议。
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
			"access-control-allow-origin": "*",
			"x-vercel-ai-ui-message-stream": "v1",
		});
		response.flushHeaders?.();

		// 写出原始 wire 文本（帧或 [DONE]）；返回 false 表示连接已断开。
		const writeRaw = (wire: string): boolean => {
			if (response.writableEnded || response.destroyed) return false;
			try {
				response.write(wire);
				return true;
			} catch {
				return false;
			}
		};

		// 注册连接；onClose 在客户端断开/服务停止时被调，确保不再向失效 socket 写数据。
		const close = this.eventStreamRouter.add(
			sessionId,
			writeRaw,
			() => {
				if (!response.writableEnded) {
					try {
						response.end();
					} catch {
						// 已销毁的连接 end() 抛错可忽略
					}
				}
			},
			() => {
				if (!response.writableEnded) response.end();
			},
		);

		// 客户端断开（页面刷新/关闭）时清理；对已结束的请求忽略重复事件。
		const onClientClose = () => close();
		response.once("close", onClientClose);
		request.once("close", onClientClose);

		// 心跳：部分代理/浏览器会因空闲断开长连接；每 15s 发一个注释帧保持活跃。
		const heartbeat = setInterval(() => {
			if (response.writableEnded || response.destroyed) {
				clearInterval(heartbeat);
				close();
				return;
			}
			try {
				response.write(": ping\n\n");
			} catch {
				clearInterval(heartbeat);
				close();
			}
		}, 15_000);

		// 连接关闭时清理心跳与监听器。
		response.once("close", () => {
			clearInterval(heartbeat);
			response.removeListener("close", onClientClose);
			request.removeListener("close", onClientClose);
		});
	}

	/**
	 * 向已打开的 SSE 响应写入 AI SDK 错误帧 + finish + [DONE]。
	 * 用于 prompt 预检被拒时（useChat 收到 error 帧进入 error 状态）。
	 */
	private writeStreamError(response: ServerResponse, errorText: string): void {
		if (response.writableEnded || response.destroyed) return;
		try {
			response.write(serializeSseFrame({ type: "error", errorText }));
			response.write(serializeSseFrame({ type: "finish" }));
			response.end("data: [DONE]\n\n");
		} catch {
			// 连接已失效则忽略
		}
	}

	/**
	 * 鉴权：Authorization: Bearer 对所有方法生效；?token= 查询参数仅限 GET/SSE
	 * （EventSource 无法携带 header），写操作必须走 Bearer，避免令牌进代理/访问日志。
	 */
	private isAuthorized(request: IncomingMessage, url: URL): boolean {
		// 过期检查先于令牌比对：过期后即使令牌匹配也拒绝（用户显式设置了有效期，到期应强制重新分发）。
		if (this.tokenExpiresInMs > 0 && Date.now() > this.tokenGeneratedAt + this.tokenExpiresInMs) return false;
		if (request.headers.authorization === `Bearer ${this.authToken}`) return true;
		if (request.method !== "GET") return false;
		return url.searchParams.get("token") === this.authToken;
	}

	private sendError(response: ServerResponse, statusCode: number, code: string, error: string, params?: Record<string, string | number>) {
		response.writeHead(statusCode, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"access-control-allow-origin": "*",
		});
		response.end(
			JSON.stringify({
				code,
				error,
				...(params ? { params } : {}),
			}),
		);
	}

	private sendNoContent(response: ServerResponse) {
		response.writeHead(204, {
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET,POST,OPTIONS",
			"access-control-allow-headers": "content-type",
		});
		response.end();
	}

	/** 读取 JSON body。maxBytes：单请求逻辑上限（默认 2MB；/api/chat 带图片时放宽到 8MB）。 */
	private async readJson<T>(request: IncomingMessage, maxBytes: number = MAX_JSON_BODY_BYTES) {
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		let oversized = false;
		for await (const chunk of request) {
			totalBytes += chunk.length;
			if (totalBytes > HARD_BODY_ABORT_BYTES) {
				// 硬上限：直接断连（此分支下 413 可能来不及送达，属预期）
				request.destroy();
				throw new WebBodyTooLargeError();
			}
			if (totalBytes > maxBytes) {
				// 逻辑上限：丢弃超限 chunk 但继续排空连接，保证 413 响应能送达客户端
				oversized = true;
				continue;
			}
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		if (oversized) throw new WebBodyTooLargeError();
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
			throw new Error("WEB_SERVICE_INVALID_PORT");
		}
		return port;
	}
}
