/** Owns consent, credentials and listener lifecycle; never activates or commands a pi runtime. */
import { randomBytes } from "node:crypto";
import type { PiDeckMcpAccess, PiDeckMcpProject, PiDeckMcpState } from "../../shared/types/piDeckMcp";
import type { McpConfigFile } from "../../shared/types/mcp";
import type { AgentProfile, BindAgentSessionInput, CreateAgentProfileInput } from "../../shared/types/agentProfile";
import type { AutomationRun, AutomationTask, AutomationTaskSummary, CreateAutomationTaskInput, UpdateAutomationTaskInput } from "../../shared/types/automation";
import type { SessionCommandResult, SessionRuntimeInfo, SessionRuntimeTarget } from "../../shared/types/session";
import type { FavoriteEntry } from "../../shared/types/favorites";
import type { NormalizedFavoriteInput } from "../favorites/favoriteInput";
import type { AppSettings } from "../../shared/types/settings";
import type { AgentProfilePatch } from "../agents/AgentProfileStore";
import { emptyPiDeckMcpConfig, piDeckMcpAccessSchema, readPiDeckMcpConfig, writePiDeckMcpConfig, type PiDeckMcpConfig } from "../config/piDeckMcpConfig";
import type { HostPluginSessions } from "../plugins/HostPluginSessions";
import { buildPiDeckMcpExtensionsView, buildPiDeckMcpRuntimeView, buildPiDeckMcpSettingsView } from "./piDeckMcpViews";
import type { PiDeckMcpHttpServer } from "./PiDeckMcpHttpServer";

export class PiDeckMcpService {
	private config: PiDeckMcpConfig = emptyPiDeckMcpConfig();
	private listener?: PiDeckMcpHttpServer;
	private endpoint?: string;
	private error?: string;
	private epoch = 0;
	private disposed = false;
	private pending: Promise<unknown>;
	constructor(
		private readonly deps: {
			configPath: string;
			projects: () => PiDeckMcpProject[];
			sessions: Pick<HostPluginSessions, "list" | "get" | "search" | "entries">;
			/** 宿主级端口：设置存储晚于本服务构造，闭包只在请求时求值；未就绪返回 null。 */
			settings: () => AppSettings | null;
			builtInExtensionsVersion: () => string | null;
			/** 在跑的会话运行时（coordinator 侧）；宿主未就绪时返回空数组。 */
			runtimes: () => SessionRuntimeInfo[];
			/** 中断一个 agent 正在产生的回答；只由 sessions_abort 调用。target 的 runtimeGeneration 由 coordinator 校验。 */
			abortRuntime: (target: SessionRuntimeTarget) => Promise<SessionCommandResult<unknown>>;
			/**
			 * 智能体目录（宿主级）。agent-profiles 在启动后段才装配，闭包在请求时求值；
			 * 写工具是否注册由配置里的 allowAgentWrite 决定，不在这里做判断。
			 */
			agents: {
				list: () => AgentProfile[];
				get: (agentId: string) => AgentProfile | undefined;
				create: (input: CreateAgentProfileInput) => Promise<AgentProfile>;
				update: (agentId: string, patch: AgentProfilePatch) => Promise<AgentProfile>;
				delete: (agentId: string) => Promise<boolean>;
				bindSession: (input: BindAgentSessionInput) => Promise<unknown>;
			};
			/**
			 * 定时任务目录（项目作用域）。automation.json 在启动后段才装配，闭包在请求时求值；
			 * 写工具是否注册由配置里的 allowAutomationWrite 决定。
			 */
			/**
			 * 收藏（本机快照，宿主级）。读只在服务层按项目授权过滤后下发；
			 * 写工具是否注册由配置里的 allowFavoritesWrite 决定。
			 */
			favorites: {
				list: () => FavoriteEntry[];
				get: (favoriteId: string) => FavoriteEntry | undefined;
				add: (input: NormalizedFavoriteInput) => Promise<FavoriteEntry>;
				remove: (favoriteId: string) => Promise<boolean>;
			};
			automation: {
				listTasks: (projectId: string) => AutomationTaskSummary[];
				getTask: (taskId: string) => AutomationTaskSummary | undefined;
				listRuns: (projectId: string) => AutomationRun[];
				getRun: (runId: string) => AutomationRun | undefined;
				createTask: (input: CreateAutomationTaskInput) => Promise<AutomationTask>;
				updateTask: (taskId: string, patch: UpdateAutomationTaskInput) => Promise<AutomationTask>;
				deleteTask: (taskId: string) => Promise<boolean>;
				runNow: (taskId: string) => Promise<AutomationRun>;
				abortRun: (runId: string) => Promise<boolean>;
			};
			warn: (code: string) => void;
		},
	) {
		// Startup failures are isolated from the desktop and visible on the management page.
		this.pending = this.initialize();
	}

	private async initialize(): Promise<void> {
		const epoch = this.epoch;
		try {
			this.config = await readPiDeckMcpConfig(this.deps.configPath);
			if (this.config.enabled && !this.disposed && epoch === this.epoch) await this.start(this.config, epoch);
		} catch (error) {
			// Preserve saved consent on bind failure so the UI can still revoke it on disk.
			this.error = error instanceof Error && error.message === "config-read-failed" ? "config-read-failed" : "listen-failed";
			this.deps.warn(this.error);
		}
	}

	async getState(): Promise<PiDeckMcpState> {
		await this.pending;
		return this.snapshot();
	}
	private snapshot(): PiDeckMcpState {
		return {
			enabled: this.config.enabled,
			projectIds: [...this.config.projectIds],
			allProjects: this.config.allProjects,
			allowControl: this.config.allowControl,
			allowAgentWrite: this.config.allowAgentWrite,
			allowAutomationWrite: this.config.allowAutomationWrite,
			allowFavoritesWrite: this.config.allowFavoritesWrite,
			running: Boolean(this.endpoint),
			endpoint: this.endpoint,
			projects: this.deps.projects(),
			error: this.error,
		};
	}

	/**
	 * 项目授权的唯一判定点：setAccess 校验、请求期 authorize 与工具列表过滤必须同口径，
	 * 否则会出现「列表里看得到但读不了」或反过来的越权。
	 * 通配模式仍要求项目当前存在——已删除项目的 id 不再放行。
	 */
	private isProjectAuthorized(projectId: string): boolean {
		if (!this.deps.projects().some((project) => project.id === projectId)) return false;
		return this.config.allProjects || this.config.projectIds.includes(projectId);
	}

	/** Serialize writes; invalidate prior requests immediately, not after disk IO completes. */
	setAccess(input: PiDeckMcpAccess): Promise<PiDeckMcpState> {
		const access = piDeckMcpAccessSchema.parse(input);
		// enabled 必须至少有一块可读区域。通配模式下 projectIds 只是「切回显式授权」时用的草稿，
		// 既不参与判定，也不应该因为里面留着已删除的项目而让整次保存失败。
		if (access.enabled && !access.projectIds.length && !access.allProjects) return Promise.reject(new Error("project-required"));
		if (!access.allProjects && access.projectIds.some((id) => !this.deps.projects().some((p) => p.id === id))) return Promise.reject(new Error("project-not-authorized"));
		const epoch = ++this.epoch;
		const operation = this.pending.then(async () => {
			if (this.disposed || epoch !== this.epoch) throw new Error("access-revoked");
			// Retain saved consent until the replacement is durable; a failed revoke must
			// remain retryable in the UI. The epoch/endpoint already deny live access.
			this.endpoint = undefined;
			await this.stopListener();
			this.error = undefined;
			const next: PiDeckMcpConfig = { ...this.config, ...access, projectIds: [...new Set(access.projectIds)], token: access.enabled ? randomBytes(32).toString("hex") : "" };
			try {
				if (next.enabled) await this.start(next, epoch);
				if (this.disposed || epoch !== this.epoch) throw new Error("access-revoked");
				await writePiDeckMcpConfig(this.deps.configPath, next);
				if (this.disposed || epoch !== this.epoch) throw new Error("access-revoked");
				this.config = next;
				return this.snapshot();
			} catch (error) {
				this.endpoint = undefined;
				await this.stopListener();
				this.error = error instanceof Error && ["access-revoked", "config-write-failed"].includes(error.message) ? error.message : "listen-failed";
				this.deps.warn(this.error);
				throw new Error(this.error);
			}
		});
		this.pending = operation.catch(() => undefined);
		return operation;
	}

	/** Detach the owned instance before awaiting so TS and concurrent shutdown agree on ownership. */
	private async stopListener(): Promise<void> {
		const listener = this.listener;
		this.listener = undefined;
		await listener?.stop();
	}

	private async start(config: PiDeckMcpConfig, epoch: number): Promise<void> {
		const authorize = (projectId?: string) => {
			if (this.disposed || epoch !== this.epoch || !this.config.enabled || !this.endpoint) throw new Error("access-revoked");
			if (projectId && !this.isProjectAuthorized(projectId)) throw new Error("project-not-authorized");
		};
		// 按需加载（2026-10 启动审计）：`@modelcontextprotocol/sdk` 冷 require 实测 ≈100ms，是启动路径上
		// 最重的静态第三方依赖；而 PiDeck MCP 默认不开启（config.enabled=false 时 initialize 不会进这里）。
		// 改成动态 import 后，未开启的启动不再加载 SDK；开启时在 start() 一次性付加载延迟。
		const [{ PiDeckMcpHttpServer: PiDeckMcpHttpServerCtor }, { createPiDeckMcpServer }] = await Promise.all([import("./PiDeckMcpHttpServer"), import("./piDeckMcpTools")]);
		const listener = new PiDeckMcpHttpServerCtor(
			config.token,
			() =>
				createPiDeckMcpServer({
					sessions: this.deps.sessions,
					projects: () => this.deps.projects().filter((p) => this.isProjectAuthorized(p.id)),
					// 宿主级视图每次请求现算：设置改完无需重启服务即生效，也不会缓存敏感快照。
					settings: () => {
						const current = this.deps.settings();
						return current ? buildPiDeckMcpSettingsView(current) : null;
					},
					extensions: () => {
						const current = this.deps.settings();
						return current ? buildPiDeckMcpExtensionsView({ settings: current, builtInVersion: this.deps.builtInExtensionsVersion() }) : null;
					},
					// 运行时先按授权过滤再投影：未授权项目里在跑的会话不能借计数或列表漏出去。
					runtimes: () =>
						buildPiDeckMcpRuntimeView({
							runtimes: this.deps.runtimes().filter((runtime) => this.isProjectAuthorized(runtime.projectId)),
							authorizedProjectCount: this.deps.projects().filter((project) => this.isProjectAuthorized(project.id)).length,
						}),
					// 会话 → 运行中 agent。授权在解析之后做，所以「未授权项目里的会话」与「不存在/没在跑」
					// 在会话 id 上是可区分的：id 本身不可猜（随机），换来的是客户端能拿到可行动的报错
					// （project-not-authorized）而不是误导性的 session-not-running。
					resolveRuntime: (sessionId) => {
						const runtime = this.deps.runtimes().find((candidate) => candidate.sessionId === sessionId);
						if (!runtime) return null;
						authorize(runtime.projectId);
						return { sessionId: runtime.sessionId, agentId: runtime.agentId, projectId: runtime.projectId, runtimeGeneration: runtime.runtimeGeneration };
					},
					controlEnabled: () => this.config.allowControl,
					agents: this.deps.agents,
					agentWriteEnabled: () => this.config.allowAgentWrite,
					automation: this.deps.automation,
					automationWriteEnabled: () => this.config.allowAutomationWrite,
					// 收藏是本机快照：读接口在这里按项目授权过滤，工具层拿不到未授权项目的正文。
					favorites: {
						list: () => this.deps.favorites.list().filter((entry) => !entry.projectId || this.isProjectAuthorized(entry.projectId)),
						get: (favoriteId) => {
							const entry = this.deps.favorites.get(favoriteId);
							return entry && (!entry.projectId || this.isProjectAuthorized(entry.projectId)) ? entry : undefined;
						},
						add: (input) => this.deps.favorites.add(input),
						remove: (favoriteId) => this.deps.favorites.remove(favoriteId),
					},
					favoriteWriteEnabled: () => this.config.allowFavoritesWrite,
					abort: async (target) => {
						// 开关在请求开始后才被关掉时（工具已注册）也必须拒绝，所以每次调用都复查。
						if (!this.config.allowControl) throw new Error("control-disabled");
						const result = await this.deps.abortRuntime(target);
						// resolve 与 abort 之间 runtime 换了人（重启/换绑）时 coordinator 会拒；其余失败都
						// 等价于「这个会话现在没有可中断的运行」。
						if (!result.ok) throw new Error(result.error.code === "SESSION_RUNTIME_CHANGED" ? "runtime-changed" : "session-not-running");
					},
					authorize,
				}),
			this.deps.warn,
		);
		this.listener = listener;
		try {
			config.port = await listener.start(config.port);
			if (this.disposed || epoch !== this.epoch) throw new Error("access-revoked");
			this.endpoint = `http://127.0.0.1:${config.port}/mcp`;
		} catch (error) {
			await listener.stop();
			throw error;
		}
	}

	/** Export is explicit, sensitive and disabled by default; never overwrites a user's mcp.json. */
	async connection(): Promise<McpConfigFile> {
		await this.pending;
		if (!this.config.enabled || !this.endpoint || this.disposed) throw new Error("service-disabled");
		// 能力描述随开关变化：客户端/用户能一眼看出当前是否允许多于只读。
		const capabilities = ["Read-only access to explicitly authorized PiDeck projects and saved sessions."];
		if (this.config.allowControl) capabilities.push("Runtime control: abort the response a running session is producing.");
		if (this.config.allowAgentWrite) capabilities.push("Agent management: create/edit/delete agent presets and bind them to sessions (role prompts are write-only).");
		if (this.config.allowAutomationWrite) capabilities.push("Scheduled-task management: create/edit/delete tasks, start or abort runs (runs consume model budget).");
		if (this.config.allowFavoritesWrite) capabilities.push("Favorites: save arbitrary text or message snapshots and delete favorites (host-local snapshots).");
		return { mcpServers: { pideck: { url: this.endpoint, headers: { Authorization: `Bearer ${this.config.token}` }, enabled: false, exposure: "codemode", description: capabilities.join(" ") } } };
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.epoch++;
		this.endpoint = undefined;
		await this.stopListener();
		await this.pending;
		await this.stopListener();
	}
}
