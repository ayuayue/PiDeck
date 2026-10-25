/** PiDeck's optional, local-only MCP host. Management is desktop-only, never an MCP tool. */
import type { AgentModelRef, AgentProfileBackend, AgentProfileCategory } from "./agentProfile";
import type { AutomationRunStatus, AutomationRunTrigger, AutomationSchedule, AutomationTask, AutomationTaskMode, NormalizedAutomationBudget } from "./automation";
import type { McpConfigFile } from "./mcp";
import type { AppSettings } from "./settings";

export type PiDeckMcpAccess = {
	enabled: boolean;
	projectIds: string[];
	/**
	 * 通配授权：所有项目（含今后新建）都可读，`projectIds` 不再参与判定。
	 * 与显式白名单的差别是「跟随」——新增项目自动进入，改项目列表不用重新应用，
	 * 因此令牌也不会因为加了项目而轮换。
	 */
	allProjects: boolean;
	/** 写能力开关（默认关）：开启后客户端可中断进行中的回答（当前仅 sessions_abort）。 */
	allowControl: boolean;
	/**
	 * 智能体写能力开关（默认关）：开启后客户端可创建/编辑/删除智能体、绑定会话与智能体。
	 * 角色设定（systemPrompt）是**只写不读**：创建/编辑可传，但任何工具都不返回它。
	 */
	allowAgentWrite: boolean;
	/**
	 * 定时任务写能力开关（默认关）：开启后客户端可创建/编辑/删除任务、立即运行、中止运行。
	 * 任务属于具体项目，读写都按项目白名单校验；任务提示词随任务详情返回（项目范围内可见）。
	 */
	allowAutomationWrite: boolean;
	/**
	 * 收藏写能力开关（默认关）：开启后客户端可新增/删除本机收藏（含任意文本）。
	 * 收藏是本机快照：列表只返回「未关联项目」或「已授权项目」的条目，避免借收藏绕过项目授权。
	 */
	allowFavoritesWrite: boolean;
};
export type PiDeckMcpProject = { id: string; name: string };
export type PiDeckMcpState = PiDeckMcpAccess & {
	running: boolean;
	projects: PiDeckMcpProject[];
	endpoint?: string;
	/** Stable, non-sensitive error code; credentials are only returned by connection(). */
	error?: string;
};
/**
 * 宿主级只读视图：与项目白名单无关（设置/内置扩展不属于任何项目）。
 * 只暴露显式允许清单里的字段——凭据、令牌、代理 URL、绝对路径、插件私有存储一律不进来。
 */
export type PiDeckMcpSettingsView = {
	app: { language: AppSettings["language"]; theme: AppSettings["theme"] };
	agent: {
		backend: AppSettings["defaultAgentBackend"];
		offline: boolean;
		noExtensions: boolean;
		noSkills: boolean;
		lastUsedModel: AppSettings["lastUsedModel"] | null;
		favoriteModels: string[];
		showThinking: boolean;
		autoSessionTitle: boolean;
	};
	workspace: {
		gitManagement: boolean;
		cuaEnabled: boolean;
		cuaAutoApprove: boolean;
		wslEnabled: boolean;
		wslDistro: string;
	};
};

/** 单个内置扩展的加载状态；`id` 是 basename，不含磁盘路径。 */
export type PiDeckMcpBuiltInExtension = {
	id: string;
	/** 按当前设置是否会注入 pi 进程（不含「文件是否存在」与 `piRpcNoExtensions` 整段关闭） */
	enabled: boolean;
	/** 内部适配器：不受用户移除影响 */
	internal: boolean;
};

export type PiDeckMcpExtensionsView = {
	/** 生效的内置扩展包版本（`extensions-manifest.json`，覆盖层优先）；清单缺失为 null */
	builtInVersion: string | null;
	/** `piRpcNoExtensions`：整段不注入内置扩展，此时 `builtIn[].enabled` 不生效 */
	injectionDisabled: boolean;
	builtIn: PiDeckMcpBuiltInExtension[];
	removedBuiltInExtensions: string[];
	disabledExtensions: AppSettings["disabledExtensions"];
};

/**
 * 单个在跑的会话运行时；`cwd`/`sessionPath`/agentId 等既不必要也不暴露。
 * `busy` 只是标签页级状态推导——会话在工具结果收尾的瞬间可能短暂报 idle，
 * 所以它是「值不值得等」的提示，不是精确的流式信号。
 */
export type PiDeckMcpRuntimeEntry = {
	sessionId: string;
	projectId: string;
	/** 会话重启后代会 +1；客户端先读它再传给 `sessions_abort`，避免误停新的一轮。 */
	runtimeGeneration: number;
	/** Tab-level AgentStatus：starting | idle | running | error | closed */
	status: string;
	busy: boolean;
	createdAt: number;
};

/** 已授权范围内的运行时概览，只含在跑的会话，不含磁盘路径。 */
export type PiDeckMcpRuntimeView = {
	runtimes: PiDeckMcpRuntimeEntry[];
	/** = runtimes.length，显式给出便于客户端不必遍历 */
	runningCount: number;
	/** 当前有运行时会话的已授权项目数 */
	activeProjectCount: number;
	/** 已授权项目数（通配模式下随项目增删变化） */
	authorizedProjectCount: number;
};

/**
 * 宿主级智能体元信息投影（与项目白名单无关）。
 * **刻意不含 systemPrompt**：角色设定只写不读，留在主进程内解析；
 * 只输出显式允许清单，不含文件路径、会话绑定表等私有状态。
 */
export type PiDeckMcpAgentSummary = {
	id: string;
	name: string;
	description: string;
	icon: string;
	category: AgentProfileCategory;
	/** 内置智能体（可编辑、不可删除） */
	builtin: boolean;
	/** 首选模型；null = 跟随会话/设置链 */
	model: AgentModelRef | null;
	/** 「使用」新建会话时的后端；null = 跟随设置默认 */
	backend: AgentProfileBackend | null;
	usageCount: number;
	lastUsedAt: number | null;
	createdAt: number;
	updatedAt: number;
};

/**
 * 定时任务元信息（项目作用域）：不含任务提示词，列表用它控制体积；
 * 详情 `PiDeckMcpAutomationTaskDetail` 才带 prompt。
 */
export type PiDeckMcpAutomationTaskSummary = {
	id: string;
	name: string;
	projectId: string;
	schedule: AutomationSchedule;
	enabled: boolean;
	backend: AutomationTask["backend"] | null;
	model: AgentModelRef | null;
	thinkingLevel: string | null;
	mode: AutomationTaskMode | null;
	permissionPreset: string | null;
	budget: NormalizedAutomationBudget;
	createdAt: number;
	updatedAt: number;
	lastScheduledAt: number | null;
	nextRunAt: number | null;
};

export type PiDeckMcpAutomationTaskDetail = PiDeckMcpAutomationTaskSummary & {
	/** 任务提示词（用户自写文本，只在已授权项目范围内返回）。 */
	prompt: string;
};

/** 一次运行的结果投影：不含 events 明细（体积大、对客户端决策无用）。 */
export type PiDeckMcpAutomationRunSummary = {
	id: string;
	taskId: string;
	taskName: string;
	projectId: string;
	trigger: AutomationRunTrigger;
	status: AutomationRunStatus;
	scheduledFor: number | null;
	sessionId: string | null;
	queuedAt: number;
	startedAt: number | null;
	endedAt: number | null;
	durationMs: number | null;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	stepCount: number;
	changedFiles: number | null;
	/** 截断到 2000 字符，避免把超长堆栈整段塞进 MCP 响应。 */
	error: string | null;
	skippedReason: string | null;
	budgetReason: string | null;
};

export type PiDeckMcpResult<T> = { ok: true; value: T } | { ok: false; code: string };
export type PiDeckMcpDesktopApi = {
	getState: () => Promise<PiDeckMcpResult<PiDeckMcpState>>;
	setAccess: (input: PiDeckMcpAccess) => Promise<PiDeckMcpResult<PiDeckMcpState>>;
	connection: () => Promise<PiDeckMcpResult<McpConfigFile>>;
};
