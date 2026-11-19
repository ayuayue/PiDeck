/**
 * Web 服务装配契约：`WebServiceDependencies`（宿主注入的能力面）与 ACP 工具投影形状。
 *
 * 独立成文件的原因：WebServiceManager 是存量巨文件（行数只准降不准升），
 * 而变化最频繁的其实是「装配层能注入什么」这份契约；路由与生命周期逻辑留在 manager 里。
 */
import type {
	AgentRuntimeState,
	AvailableModel,
	ChatMessage,
	CreateAnonymousSessionInput,
	CreateAnonymousSessionResult,
	CreateSessionDraftInput,
	ImageContent,
	PiCommand,
	Project,
	ProviderUsageResult,
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
	SecurityConfig,
	UpdateSessionRecordInput,
	UsageProbeBackend,
} from "../../shared/types";
import type { PendingUiRequestSnapshot } from "../sessions/SessionRuntimeCoordinator";
import type { SessionForkResult } from "../sessions/sessionForkCommands";
import type { AgentChannelEventSource, PiEvent } from "./WebEventStream";

/** Web 端可见的 ACP 工具条目：只下发渲染选择器需要的 id/name（command/args/env 不外发）。 */
export type WebAcpToolInfo = { id: string; name: string };

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
	/**
	 * 订阅 ACP 的 agent 通道事件（agents:message 投影快照 / agents:runtime-state 回合终态）。
	 * 未注入时 ACP 会话在 Web 端退化为「状态轮询 + 磁盘重拉」（fail-safe）。
	 */
	subscribeAcpChannelEvents?: AgentChannelEventSource;
	/**
	 * 可选的 ACP 工具清单（AcpToolConfig 的 id/name，已按 acpEnabled + enabled 门控）。
	 * Web 端后端选择器据此列出 ACP 入口；未注入或为空即完全不提供 ACP 选项。
	 */
	listAcpTools?: () => WebAcpToolInfo[];
	/**
	 * 宿主应用版本号（/api/state 的 version 投影，Web 端侧栏底栏展示）。
	 * 未注入时不下发该字段，Web 端不渲染版本位。
	 */
	getAppVersion?: () => string;
	/**
	 * 会话当前正在生成的正文（已剥 ANSI）；无 live 缓冲返回空串。
	 * 供 PiDeck Lite 手机端轮询 `/api/session/{id}` 时看到打字机效果。
	 */
	getLiveText?: (sessionId: string) => string;
	/**
	 * EasyTier 托管配置的 TOML 文本（手机端「导入配置」用）。
	 * 未配置托管网络时返回空串，路由据此返回 404；文件含网络密钥，因此只在 /api/* 鉴权链之后暴露。
	 */
	getEasyTierConfigToml?: () => string;
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
	/**
	 * 智能体目录（AgentProfileStore 投影，与桌面「智能体」页同源）。
	 * 未装配时不提供 Web 端「智能体」入口（避免出现能点却点不开的空面板）。
	 */
	listAgentProfiles?: () => import("../../shared/types/agentProfile").AgentProfile[] | undefined;
	/**
	 * 会话 → 智能体绑定（只读投影，随 /api/state 下发，Web 会话页据此显示已绑定角色设定）。
	 * 目录未装配时返回 undefined：状态投影省掉该字段，Web 端也就不渲染提示条。
	 */
	getSessionAgentBindings?: () => Record<string, string> | undefined;
	/**
	 * 会话 ↔ 智能体绑定（写）：Web 端「使用」建好草稿后落绑定，之后该会话首轮发送
	 * 由主进程把角色设定拼进隐藏载荷（与桌面 sessions:bindAgentSession 同一份存储）。
	 * agentId=null 表示解绑。
	 */
	bindSessionAgent?: (sessionId: string, agentId: string | null) => Promise<void>;
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
	/**
	 * 安全配置读取（/api/state 的 security 投影与 Web 端等级菜单）。
	 * 未装配时不向 Web 端暴露安全入口——避免出现「能点但改不了」的假控件。
	 */
	getSecurityConfig?: () => SecurityConfig;
	/**
	 * 会话安全等级切换：服务端校验会话/等级后写 SecurityStore（levelId=null 清除覆盖）。
	 * 返回切换后的完整配置，路由层投影成 Web 形状。
	 */
	setSessionSecurityLevel?: (sessionId: string, levelId: string | null) => Promise<SecurityConfig>;
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
