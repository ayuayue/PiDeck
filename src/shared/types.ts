export type Project = {
	id: string;
	name: string;
	path: string;
	lastOpenedAt: number;
	pinned?: boolean;
	sortOrder?: number;
	kind?: "chat";
	/** 是否启用 git worktree 工作区模式，开启后侧栏显示分支子项 */
	worktreeEnabled?: boolean;
	/** 如果是 worktree 子项目，指向父项目的 id */
	worktreeParentId?: string;
};

export const SUPPORTED_EXTERNAL_EDITORS = [
	{ id: "vscode", name: "Visual Studio Code" },
	{ id: "cursor", name: "Cursor" },
	{ id: "zed", name: "Zed" },
	{ id: "idea", name: "IntelliJ IDEA" },
	{ id: "webstorm", name: "WebStorm" },
	{ id: "phpstorm", name: "PhpStorm" },
	{ id: "pycharm", name: "PyCharm" },
] as const;

export type ExternalEditorId = typeof SUPPORTED_EXTERNAL_EDITORS[number]["id"];

export type ExternalEditorDetectedFrom = "path" | "common-path" | "manual";

export type ExternalEditorSetting = {
	enabled: boolean;
	command: string;
	detectedFrom?: ExternalEditorDetectedFrom;
	updatedAt?: number;
};

export type ExternalEditorSettings = Record<ExternalEditorId, ExternalEditorSetting>;

export function createDefaultExternalEditorSettings(): ExternalEditorSettings {
	return Object.fromEntries(
		SUPPORTED_EXTERNAL_EDITORS.map((editor) => [
			editor.id,
			{ enabled: false, command: "" },
		]),
	) as ExternalEditorSettings;
}

export type ExternalEditor = {
	id: ExternalEditorId;
	name: string;
	command: string;
	args?: string[];
	detectedFrom: ExternalEditorDetectedFrom;
};

export type AgentStatus = "starting" | "idle" | "running" | "error" | "closed";

export type AgentTab = {
	id: string;
	projectId: string;
	cwd: string;
	title: string;
	status: AgentStatus;
	sessionId?: string;
	sessionPath?: string;
	createdAt: number;
};

export type TerminalShell = "pwsh" | "powershell" | "cmd" | "zsh" | "bash" | "fish" | "sh";

export type TerminalTab = {
	id: string;
	agentId: string;
	title: string;
	cwd: string;
	shell: TerminalShell;
	createdAt: number;
	exited?: boolean;
	exitCode?: number;
	buffer?: string;
};

export type TerminalDataEvent = {
	tabId: string;
	data: string;
};

export type TerminalExitEvent = {
	tabId: string;
	exitCode?: number;
};

export type ChatRole = "user" | "assistant" | "tool" | "system" | "error";

export type ChatMessage = {
	id: string;
	agentId: string;
	role: ChatRole;
	text: string;
	timestamp: number;
	meta?: Record<string, unknown>;
	images?: ImageContent[]; // 用户消息中附加的图片
	/** 思考内容：来自 thinking 内容块，用于展示模型推理过程 */
	thinking?: string;
};

export type FileTreeNode = {
	name: string;
	path: string;
	relativePath: string;
	type: "file" | "directory";
	children?: FileTreeNode[];
};

export type SessionSummary = {
	id: string;
	filePath: string;
	projectPath?: string;
	name?: string;
	/** 子会话：关联的父会话文件路径。有该字段时不在会话列表顶层显示，而是嵌套在父会话下。 */
	parentSessionPath?: string;
	preview: string;
	updatedAt: number;
	messageCount: number;
	/** 会话来源：pi 原生、Codex 导入、Claude 导入、OpenCode 导入 */
	source?: "pi" | "codex" | "claude" | "opencode";
	codexSessionId?: string;
	codexThreadSource?: "user" | "subagent";
	codexParentThreadId?: string;
	codexAgentRole?: string;
	codexAgentNickname?: string;
};

export type CodexImportStatus = "new" | "current" | "outdated";

export type CodexSessionSummary = {
	id: string;
	sourcePath: string;
	targetPath: string;
	cwd: string;
	title: string;
	preview: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	status: CodexImportStatus;
	sourceSize: number;
	importedSourceMtime?: number;
	threadSource?: "user" | "subagent";
	parentThreadId?: string;
	agentRole?: string;
	agentNickname?: string;
};

export type CodexImportResult = {
	id: string;
	sourcePath: string;
	targetPath?: string;
	title?: string;
	success: boolean;
	overwritten?: boolean;
	messageCount?: number;
	error?: string;
};

export type CodexImportReport = {
	results: CodexImportResult[];
	imported: number;
	failed: number;
};

export type ClaudeImportStatus = "new" | "current" | "outdated";

export type ClaudeSessionSummary = {
	id: string;
	sourcePath: string;
	targetPath: string;
	cwd: string;
	title: string;
	preview: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	status: ClaudeImportStatus;
	sourceSize: number;
	importedSourceMtime?: number;
};

export type ClaudeImportResult = {
	id: string;
	sourcePath: string;
	targetPath?: string;
	title?: string;
	success: boolean;
	overwritten?: boolean;
	messageCount?: number;
	error?: string;
};

export type ClaudeImportReport = {
	results: ClaudeImportResult[];
	imported: number;
	failed: number;
};

export type OpenCodeImportStatus = "new" | "current" | "outdated";

export type OpenCodeSessionSummary = {
	id: string;
	sourcePath: string;
	targetPath: string;
	cwd: string;
	title: string;
	preview: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	status: OpenCodeImportStatus;
	sourceSize: number;
	importedSourceMtime?: number;
};

export type OpenCodeImportResult = {
	id: string;
	sourcePath: string;
	targetPath?: string;
	title?: string;
	success: boolean;
	overwritten?: boolean;
	messageCount?: number;
	error?: string;
};

export type OpenCodeImportReport = {
	results: OpenCodeImportResult[];
	imported: number;
	failed: number;
};

export type PiCommand = {
	name: string;
	description?: string;
	source?: string;
};

export type AgentRuntimeState = {
	modelName?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	/** 是否正在执行工具调用（read/write/bash 等） */
	isExecutingTool?: boolean;
	/** 当前正在执行的工具名称，如 read、write、bash */
	executingToolName?: string;
	/** 工具状态事件的单调序号，用于忽略晚到的异步完整状态。 */
	toolStateSequence?: number;
	contextTokens?: number | null;
	contextWindow?: number | null;
	contextPercent?: number | null;
	inputTokens?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheTotal?: number;
	cacheHitPercent?: number | null;
	cost?: number;
};

export type AvailableModel = {
	id: string;
	name?: string;
	provider: string;
	contextWindow?: number;
	reasoning?: boolean;
};

export type SendShortcutMode =
	| "enter-send"
	| "ctrl-enter-send"
	| "shift-enter-send";

export type AppThemeMode = "system" | "light" | "dark";
export type LightBackgroundMode = "white" | "warm" | "paper" | "blue" | "green";
export type AppLanguageMode = "system" | "zh-CN" | "en-US" | "pseudo";
export type LinkOpenMode = "external" | "internal";
export type AppFontSizeMode = "compact" | "default" | "medium" | "large" | "xlarge";
export type AppFontBaseMode = "system" | "sans" | "serif" | "custom";
export type AppFontMonoMode = "commit-mono" | "system-mono" | "custom";

export type AppSettings = {
	useNativeTitleBar: boolean;
	showNativeMenu: boolean;
	sendShortcut: SendShortcutMode;
	/** 界面主题，system 跟随系统浅色/暗色偏好 */
	theme: AppThemeMode;
	/** 浅色主题的工作台背景预设；暗色主题下忽略，便于用户快速试不同淡色底。 */
	lightBackground: LightBackgroundMode;
	/** 界面语言，system 跟随系统语言；pseudo 用于长文案布局压力测试 */
	language: AppLanguageMode;
	piEnvironmentChecked: boolean;
	/** 关闭窗口时隐藏到系统托盘而不是退出 */
	closeToTray: boolean;
	/** 会话结束时发送系统通知 */
	enableNotifications: boolean;
	/** 是否在会话中显示模型思考过程，默认开启 */
	showThinking: boolean;
	/** 是否开启开发者控制台（DevTools） */
	showDevTools: boolean;
	/** 是否给 pi agent 子进程注入代理环境变量，不影响 desktop 自身网络请求 */
	piProxyEnabled: boolean;
	/** pi agent 使用的代理地址，例如 http://127.0.0.1:7890 */
	piProxyUrl: string;
	/** pi agent 代理绕过列表，对应 NO_PROXY 环境变量 */
	piProxyBypass: string;
	/** 是否给桌面端自身网络请求启用代理，不影响已启动的 pi agent 子进程 */
	desktopProxyEnabled: boolean;
	/** 桌面端自身网络请求使用的代理地址，例如 http://127.0.0.1:7890 */
	desktopProxyUrl: string;
	/** 桌面端代理绕过列表，对应 Electron proxyBypassRules */
	desktopProxyBypass: string;
	/** 用户手动指定的 pi CLI 命令路径，自动检测不到时用于兜底 */
	customPiPath: string;
	/** WSL 中检测到的 pi 命令路径（只读缓存，由 PiLocator.check 回填） */
	wslPiCommand?: string;
	/** 是否发送匿名、低频、最小字段的使用统计 */
	telemetryEnabled: boolean;
	/** 是否开启局域网 Web 服务 */
	webServiceEnabled: boolean;
	/** Web 服务监听地址，默认 0.0.0.0 允许局域网访问 */
	webServiceHost: string;
	/** Web 服务监听端口 */
	webServicePort: number;
	/** 本地生成的匿名安装标识，不包含账号、路径或机器名 */
	telemetryInstallId?: string;
	/** 最近一次发送 app_heartbeat 的本地日期，格式 YYYY-MM-DD */
	telemetryLastHeartbeatDate?: string;
	/** 应用安装类型：portable（便携版）或 installed（安装版），启动时自动检测并持久化 */
	installationType?: "portable" | "installed";
	/** RPC 调用超时时间（毫秒），默认 600000（10 分钟），用于长时间运行的命令 */
	rpcTimeout: number;
	/** 外部链接打开方式：external 使用系统默认浏览器，internal 使用应用内独立窗口 */
	linkOpenMode: LinkOpenMode;
	/** 内容区最大宽度（px），0 表示不限制（填满 chat-pane）。用于限制消息行宽，左右留白。 */
	contentMaxWidth: number;
	/** 编辑器最大文件大小（MB），超过此大小的文件不加载编辑器。默认 5MB。 */
	maxEditorFileSizeMB: number;
	/** 外部编辑器配置：首次异步检测后保存，用户可在设置中手动覆盖路径。 */
	externalEditors: ExternalEditorSettings;
	/** 是否启用 WSL fallback：在 Windows 自动检测不到 pi 时，尝试从 WSL 启动 pi */
	wslEnabled: boolean;
	/** WSL 发行版名称，如 Debian、Ubuntu */
	wslDistro: string;
	/** WSL 用户名，如 piuser */
	wslUser: string;

	// ── 桌面宠物（全局聚合单宠，默认关闭，不破坏现状） ──
	/** 是否启用桌面宠物悬浮窗，默认 false：关闭后应用与现状完全一致 */
	petEnabled: boolean;
	/** 当前选中的宠物包 id，默认内置水獭 */
	petId: string;
	/** 宠物窗是否始终置顶，默认 true */
	petAlwaysOnTop: boolean;
	/** 宠物缩放比例 0.3-2.0，默认 1.0，控制窗口与 sprite 渲染尺寸 */
	petScale: number;
	/** 是否启用 idle 巡游（无任务时沿屏幕底部左右走动），默认 true；
	 *  巡游为低优先级 UI 行为，running/failed/review/逗弄 时自动让位。 */
	petPatrolEnabled: boolean;
	/** 巡游碰边后 idle 停顿时长（分钟），默认 5，范围 1–30 */
	petPatrolPauseMin: number;

	// ── 模型收藏：ModelPicker 中用 ☆ 标记，收藏的模型在列表中置顶 ──
	/** 收藏的模型 ID 列表 */
	favoriteModels: string[];

	// ── 字体配置：沿用主题机制实时生效，写入 documentElement token ──
	/** 全局字号基准档位；未单独设置各区域时，所有字号 token 均由此推导 */
	fontSize: AppFontSizeMode;
	/** UI 字号覆盖；null 表示跟随 fontSize。控制 sidebar、按钮、列表、弹窗等 */
	uiFontSize: AppFontSizeMode | null;
	/** 会话正文字号覆盖；null 表示跟随 fontSize。控制用户消息与助手回复 */
	chatFontSize: AppFontSizeMode | null;
	/** 输入框字号覆盖；null 表示跟随 fontSize。控制 composer 输入区 */
	inputFontSize: AppFontSizeMode | null;
	/** 全局窗口缩放比例，1 为 100%；通过 webContents.setZoomFactor 生效 */
	zoomFactor: number;
	/** UI 基础字体预设，system 为跨平台系统栈；custom 时使用 fontFamilyBaseCustom */
	fontFamilyBase: AppFontBaseMode;
	/** fontFamilyBase=custom 时的自定义字体族栈，原样写入 CSS font-family */
	fontFamilyBaseCustom: string;
	/** 等宽字体预设，commit-mono 为内置 PiDeckCommitMono；custom 时使用 fontFamilyMonoCustom */
	fontFamilyMono: AppFontMonoMode;
	/** fontFamilyMono=custom 时的自定义字体族栈，原样写入 CSS font-family */
	fontFamilyMonoCustom: string;
};

// ── 桌面宠物类型 ──

/** 宠物聚合动画状态；映射到 spritesheet 的行号。
 *  前 7 个为业务态（由 PetStateBridge 聚合 Agent 状态产出）；
 *  running-right / running-left / review 为本期启用的预留行——
 *  巡游方向帧由 PetPatrol 引擎直接推送，review 由「任务完成」转换触发。 */
export type PetMode =
	| "idle"
	| "running"
	| "failed"
	| "waiting"
	| "waving"
	| "hidden"
	| "jumping"
	| "running-right" // 行1 巡游向右（PetPatrol 驱动）
	| "running-left" // 行2 巡游向左（PetPatrol 驱动）
	| "review"; // 行8 任务完成庆祝（running→idle 转换触发）

/** 多 Agent 聚合后的全局宠物状态，由 PetStateBridge 计算并推送给宠物窗 */
export type PetAggregateState = {
	mode: PetMode;
	/** 当前 running 的 Agent 数 */
	runningCount: number;
	/** 当前 error 的 Agent 数（>0 则 mode=failed，优先级最高） */
	errorCount: number;
	/** 点击宠物跳转目标 Agent id；无活跃 Agent 时为 null */
	activeAgentId: string | null;
	timestamp: number;
};

/** 宠物包清单项，合并内置包与 petdex 社区包后去重得到 */
export type PetManifest = {
	id: string;
	displayName: string;
	description?: string;
	/** 来源：builtin 随应用打包，petdex 扫描自 ~/.codex/pets/ */
	source: "builtin" | "petdex";
	/** 渲染层可加载的 spritesheet URL（内置走打包资源，petdex 走 file://） */
	spritesheetUrl: string;
};


/** 三端宠物窗能力探测结果（设计文档第 5.2 节降级形态） */
export type PetWindowCaps = {
	/** 是否支持透明背景（Linux 部分 WM 不支持） */
	transparent: boolean;
	/** 是否支持点击穿透（MVP 不用，预留） */
	clickThrough: boolean;
	/** 是否支持自由绝对坐标定位（Wayland 受限） */
	freePosition: boolean;
};

/** 宠物通知气泡：出错/完成时在宠物头顶弹出 */
export type PetNotification = {
	type: "error" | "done";
	text: string;
	/** 出错时关联的 Agent id */
	agentId?: string;
	timestamp: number;
};

export type PiInstallStatus = {
	installed: boolean;
	command?: string;
	version?: string;
	searchedDirs: string[];
	error?: string;
};

/** 安装命令执行结果 */
export type PiInstallExecResult = {
	success: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
};

/** npm 可用性检测结果 */
export type NpmAvailabilityResult = {
	available: boolean;
	version?: string;
	error?: string;
};

export type ConfigFileDiagnostic = {
	fileName: string;
	message: string;
	line?: number;
	column?: number;
	snippet?: string;
	docsUrl: string;
};

export type ConfigFileReadResult<T> = {
	raw: string;
	parsed: T;
	diagnostic?: ConfigFileDiagnostic;
};

export type PiSkillLocation = {
	id: "pi-global" | "agents-global" | "project-pi" | "project-agents";
	label: string;
	path: string;
	rootMarkdownEnabled: boolean;
};

export type PiSkillSummary = {
	id: string;
	name: string;
	description: string;
	path: string;
	dir: string;
	sourceId: PiSkillLocation["id"];
	sourceLabel: string;
	type: "directory" | "markdown";
	enabled: boolean;
	valid: boolean;
	warnings: string[];
};

export type PiSkillListResult = {
	locations: PiSkillLocation[];
	skills: PiSkillSummary[];
};

export type CreatePiSkillInput = {
	name: string;
	description: string;
	locationId: PiSkillLocation["id"];
};

/** pi Prompt Template，对应 ~/.pi/agent/prompts/<name>.md */
export type PiPromptTemplateSummary = {
	name: string;
	path: string;
	description: string;
	content: string;
	userCreated: boolean;
	/** 模板范围：global (~/.pi/agent/prompts/) 或 project (.pi/prompts/) */
	scope?: "global" | "project";
};

export type PiPromptTemplateListResult = {
	templates: PiPromptTemplateSummary[];
	globalDir: string;
};

export type CreatePiPromptTemplateInput = {
	name: string;
	description: string;
};

// ── Prompt Store (prompts.chat) ─────────────────────────────────────────

/** prompts.chat API 返回的原始 prompt 条目（完整字段） */
export interface PromptStoreRawItem {
	id: string;
	title: string;
	slug: string;
	description: string;
	content: string;
	type: string;
	author: { id: string; name: string; username: string; avatar?: string; verified?: boolean };
	category: { id: string; name: string; slug: string } | null;
	tags: Array<{ promptId: string; tagId: string; tag: { id: string; name: string; slug: string; color?: string } }>;
	voteCount: number;
	viewCount: number;
	createdAt: string;
}

/** UI 消费的扁平化 prompt 条目 */
export interface PromptStoreItem {
	id: string;
	title: string;
	description: string;
	content: string;
	type: string;
	author: string;
	category: string;
	tags: string[];
	votes: number;
	createdAt: string;
}

/** prompts.chat REST API 搜索响应（/api/prompts?q=...） */
export interface PromptStoreSearchResponse {
	prompts: PromptStoreRawItem[];
	total: number;
	page: number;
	perPage: number;
	totalPages: number;
}

/** IPC 返回给渲染进程的搜索结果 */
export interface PromptStoreSearchResult {
	query: string;
	count: number;
	prompts: PromptStoreItem[];
}

export type PromptStoreSearchType = "TEXT" | "STRUCTURED" | "IMAGE" | "VIDEO" | "AUDIO";

// ── Skill Store ────────────────────────────────────────────────────────

/** 从 prompts.chat 通过 get_skill 获取的 skill 详情 */
export interface SkillStoreDetail {
	id: string;
	title: string;
	description: string;
	files: Array<{ filename: string; content: string }>;
}

export interface SkillStoreSearchResult {
	query: string;
	count: number;
	items: PromptStoreItem[];
}

// ── Yao Open Prompts（中文提示词精选） ─────────────────────────────────

export type YaoPromptCategory = {
	slug: string;
	name: string;
	count: number;
};

export type YaoPromptItem = {
	/** 文件名（不含 .md） */
	slug: string;
	title: string;
	category: string;
	subcategory: string;
	tags: string[];
	description: string;
	/** 文件绝对路径 */
	path: string;
};

export type YaoPromptListResult = {
	categories: YaoPromptCategory[];
	prompts: YaoPromptItem[];
	repoPath: string;
};

export type YaoPromptDetailResult = {
	title: string;
	description: string;
	promptContent: string;
	fullContent: string;
};

export type ProjectResourceListResult = {
	skills: PiSkillSummary[];
	extensions: PiExtensionSummary[];
};

export type CreateProjectSkillInput = {
	projectId: string;
	name: string;
	description: string;
};

	export type PiExtensionSummary = {
	id: string;
	source: string;
	path?: string;
	/** 非 npm/git 安装的本地文件扩展，通过文件系统自动发现 */
	scope: "user" | "project" | "unknown";
	/** PiDeck 内置扩展，不可卸载 */
	builtIn?: boolean;
	/** 是否启用（未在 disabledExtensions 列表中） */
	enabled?: boolean;
	currentVersion?: string;
	latestVersion?: string;
	hasUpdate?: boolean;
	updateError?: string;
};

export type PiPackageInfo = {
	name: string;
	description: string;
	installCmd: string;
	tags: string[];
	downloads: string;
	updated: string;
	npmUrl: string;
	repoUrl?: string;
	/** pi.dev 详情页的 name 查询参数；部分包名和扩展展示名不完全一致。 */
	piPackageName?: string;
};

export type PiExtensionListResult = {
	extensions: PiExtensionSummary[];
	raw: string;
};

export type PiCliUpdateResult = {
	command: string;
	output: string;
	updated: boolean;
};

export type PiUpdateCheckResult = {
	currentVersion?: string;
	latestVersion?: string;
	hasUpdate: boolean;
	error?: string;
};

export type PiProxyTestResult = {
	success: boolean;
	url: string;
	elapsedMs: number;
	statusCode?: number;
	message?: string;
	error?: string;
	bypassed?: boolean;
};

export type AppInfo = {
	version: string;
	releasesUrl: string;
};

export type FeedbackEnvironment = {
	appVersion: string;
	platform: NodeJS.Platform;
	arch: string;
	electronVersion: string;
	chromeVersion: string;
	nodeVersion: string;
	pi: PiInstallStatus;
};

export type AppUpdateAsset = {
	name: string;
	url: string;
	size: number;
};

export type AppUpdateInfo = {
	currentVersion: string;
	latestVersion: string;
	hasUpdate: boolean;
	releaseName: string;
	releaseNotes: string;
	releaseUrl: string;
	publishedAt?: string;
	assets: AppUpdateAsset[];
	recommendedAsset?: AppUpdateAsset;
};

export type AppUpdateDownloadProgress = {
	assetName: string;
	receivedBytes: number;
	totalBytes?: number;
	percent?: number;
	bytesPerSecond?: number;
	state: "downloading" | "completed" | "failed";
	filePath?: string;
	error?: string;
};

export type AppUpdateDownloadResult = {
	filePath: string;
	assetName: string;
};

export type AppLogLevel = "debug" | "info" | "warn" | "error";

export type AppLogEntry = {
	id: string;
	time: number;
	level: AppLogLevel;
	scope: string;
	message: string;
	detail?: unknown;
};

export type AppLogQuery = {
	level?: AppLogLevel | "all";
	search?: string;
	from?: number;
	to?: number;
	limit?: number;
};

export type PiRuntimeEvent = {
	agentId: string;
	event: unknown;
};

export type GitBranchInfo = {
	current: string | null;
	branches: string[];
};

export type GitFileStatus = "modified" | "added" | "deleted" | "renamed";

export type GitChangedFile = {
	path: string;
	status: GitFileStatus;
};

/** git worktree --porcelain 输出解析出的单条工作树信息 */
export type WorktreeEntry = {
	path: string;
	branch: string;
};

export type CreateAgentInput = {
	projectId: string;
	title?: string;
	sessionPath?: string;
};

export type ForkMessage = {
	entryId: string;
	text: string;
};

/** 图片内容格式，与 pi RPC 的 ImageContent 一致 */
export type ImageContent = {
	type: "image";
	data: string; // base64 编码的图片数据
	mimeType: string; // 如 "image/png", "image/jpeg", "image/gif", "image/webp"
};

export type SendPromptInput = {
	agentId: string;
	message: string;
	images?: ImageContent[]; // 可选的图片列表
	streamingBehavior?: "steer" | "followUp";
	/** 仅发给 Agent 的内部提示，不显示在聊天 UI 中。 */
	agentMessage?: string;
	/** 提示的简短描述/摘要，发给 pi agent 用于标识本次 prompt 的意图。
	 *  从模板 description、用户输入首行自动提取；飞书/WebService 等外部来源可不传。 */
	description?: string;
};

/** 主进程完成 pi prompt 预检后的明确接收结果。 */
export type SendPromptResult =
	| { accepted: true }
	| { accepted: false; error: string; delivery?: "rejected" }
	| { accepted: false; error: string; delivery: "unknown" };

/** 实时思考内容更新，用于流式展示模型推理过程 */
export type ThinkingUpdate = {
	agentId: string;
	/** 累积的思考文本 */
	thinking: string;
};

// ===== 飞书桥接类型 =====

export type FeishuBotConfig = {
	id: string;
	name: string;
	enabled: boolean;
	appId: string;
	appSecret: string; // 加密存储
	defaultWorkspaceId?: string;
	defaultChannelId?: string;
	defaultModelId?: string;
	requireMention?: boolean;
	/** 用户自己的 open_id（用于自动拉群时加入 user_id_list）。在飞书中给 Bot 发 /whoami 即可获取 */
	defaultUserOpenId?: string;
};

export type FeishuBridgeStatus = {
	status: "disconnected" | "connecting" | "connected" | "error";
	activeBindings: number;
	connectedAt?: number;
	errorMessage?: string;
	/** 当前 bridge 连接的 Bot 配置 ID，用于配置页精确标记连接状态 */
	botId?: string;
	botOpenId?: string;
	botName?: string;
};

export type FeishuChatBinding = {
	chatId: string;
	botId: string;
	userId: string;
	sessionId: string;
	sessionPath?: string;
	workspaceId: string;
	channelId?: string;
	modelId?: string;
	source: "feishu" | "session-mirror";
	chatType: "p2p" | "group";
	groupName?: string;
	createdAt: number;
};

/** 草稿元信息，对应 drafts 目录中的单个 .md 文件 */
export type DraftMeta = {
	id: string;
	name: string;
	path: string;
	createdAt: number;
	updatedAt: number;
};

export type ScratchPadData = {
	content: string;
	lastEditedAt: number;
	cursorPosition: number;
};

export type FeishuChatMessage = {
	chatId: string;
	messageId: string;
	senderOpenId: string;
	senderName?: string;
	chatType: "p2p" | "group";
	groupName?: string;
	messageType: "text" | "image" | "post" | "file";
	text: string;
	imageKeys: string[];
	fileKeys: string[];
	timestamp: number;
};

export type FeishuConnectInput = {
	appId: string;
	appSecret: string;
	name?: string;
	defaultUserOpenId?: string;
};

export type FeishuTestResult = {
	success: boolean;
	message: string;
	botName?: string;
};

/** 输入框发送模式，决定消息直接执行还是以只读方式触发生成计划。 */
export type ComposerAgentMode = "normal" | "plan";
