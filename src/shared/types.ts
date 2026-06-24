export type Project = {
	id: string;
	name: string;
	path: string;
	lastOpenedAt: number;
	pinned?: boolean;
	sortOrder?: number;
	kind?: "chat";
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
	preview: string;
	updatedAt: number;
	messageCount: number;
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
	contextTokens?: number | null;
	contextWindow?: number | null;
	contextPercent?: number | null;
	cacheRead?: number;
	cacheWrite?: number;
	cacheTotal?: number;
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
export type AppLanguageMode = "system" | "zh-CN" | "en-US" | "pseudo";
export type LinkOpenMode = "external" | "internal";

export type AppSettings = {
	useNativeTitleBar: boolean;
	showNativeMenu: boolean;
	sendShortcut: SendShortcutMode;
	/** 界面主题，system 跟随系统浅色/暗色偏好 */
	theme: AppThemeMode;
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
	/** 编辑器最大文件大小（MB），超过此大小的文件不加载编辑器。默认 5MB。 */
	maxEditorFileSizeMB: number;
	/** 外部编辑器配置：首次异步检测后保存，用户可在设置中手动覆盖路径。 */
	externalEditors: ExternalEditorSettings;

	// ── 桌面宠物（全局聚合单宠，默认关闭，不破坏现状） ──
	/** 是否启用桌面宠物悬浮窗，默认 false：关闭后应用与现状完全一致 */
	petEnabled: boolean;
	/** 当前选中的宠物包 id，默认内置水獭 */
	petId: string;
	/** 宠物窗是否始终置顶，默认 true */
	petAlwaysOnTop: boolean;
	/** 宠物不透明度 0.5-1，默认 1（增强项，MVP 暂只用 1） */
	petOpacity: number;
};

// ── 桌面宠物类型 ──

/** 宠物聚合动画状态；映射到 spritesheet 的行号 */
export type PetMode = "idle" | "running" | "failed" | "waiting" | "waving" | "hidden";

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
	id: "pi-global" | "agents-global";
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

export type PiExtensionSummary = {
	id: string;
	source: string;
	path?: string;
	scope: "user" | "project" | "unknown";
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
};

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

