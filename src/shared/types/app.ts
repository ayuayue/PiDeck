import type { PiSkillSummary } from "./skills";

// ── Pi / NPM / Config ──────────────────────────────────────────────────

export type PiCommand = {
	name: string;
	description?: string;
	source?: string;
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

// ── Project Resources / Extensions ─────────────────────────────────────

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
	/** 过滤式安装（pi list 的 "(filtered)" 标记）：包完整安装但只选择性加载指定资源 */
	filtered?: boolean;
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
	/** 检测到的扩展冲突：内置扩展因与三方扩展同名而被自动禁用 */
	conflicts?: { builtIn: string; thirdParty: string }[];
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

// ── App Info / Updates / Logging ───────────────────────────────────────

export type AppInfo = {
	version: string;
	releasesUrl: string;
	/** 当前运行平台：win32 / darwin / linux，用于 UI 中按平台条件渲染（如 WSL 选项仅在 Windows 显示） */
	platform: NodeJS.Platform;
	/** 用户 home 目录，供扩展读取本地文件（如 memory-store.json） */
	homeDir: string;
	/** PiDeck 数据目录（app.getPath("userData")）：配置、会话、诊断等数据所在，跨平台实际路径由主进程解析 */
	userDataDir: string;
	/** 开发态 git 分支名（多 worktree 并行时区分窗口）；正式包/共享分支为空。 */
	devBranch?: string;
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

/** 应用更新生命周期阶段（由 electron-updater 事件映射）。 */
export type AppUpdatePhase =
	| "idle"
	| "checking"
	| "available"
	| "downloading"
	| "ready"
	| "installing"
	| "error";

/** 更新交付能力：automatic=应用内下载/安装；manual=仅检测并引导至 Release。 */
export type AppUpdateDeliveryMode = "automatic" | "manual";

/**
 * 应用更新下载/安装状态（随 app:update-status-changed 快照推送）。
 * 语义对齐 Netcatty/electron-updater：检测到新版本后 autoDownload 开启时
 * 自动进入 checking→downloading→ready 全链路，UI 无需弹窗打断。
 */
export type AppUpdateDownloadState = {
	/** 当前阶段。idle = 无活动（已最新 / 从未检查）；error 时 error 字段有值。
	 * installing 表示已请求退出并等待安装器接管；ready + error 表示安装未启动，可重试。 */
	phase: AppUpdatePhase;
	/** 目标版本（available / downloading / ready 时存在）。 */
	version?: string;
	/** 下载进度 0-100（downloading 时存在）。 */
	percent?: number;
	bytesPerSecond?: number;
	transferred?: number;
	total?: number;
	/** 失败原因（phase=error，或 phase=ready 但上次安装启动失败）。 */
	error?: string;
};

/**
 * 主进程后台更新检查推送给渲染层的状态快照（齿轮角标 / toast / 设置页卡片用）。
 * 由主进程 UpdateService 定时检查后通过 app:update-status-changed 推送。
 */
export type AppUpdateStatusSnapshot = {
	/** 最后一次后台检查完成时间（毫秒时间戳）；缺省 = 尚未检查。 */
	lastCheckAt?: number;
	/** 当前平台的更新交付能力。macOS 无 Developer ID 签名时为 manual。 */
	deliveryMode: AppUpdateDeliveryMode;
	/** 自动下载偏好；manual 交付模式为 null（该开关不适用）。 */
	autoDownload?: boolean | null;
	/** PiDeck 应用更新状态；null = 尚未触发检查且无活动状态。 */
	app: {
		latestVersion?: string;
		hasUpdate: boolean;
		/** 用户跳过的版本（该版本不再主动提示，手动检测仍可查看）。 */
		skippedVersion?: string;
		/** 最近一次已提示过的版本（“每版本只提示一次”判定）。 */
		notifiedVersion?: string;
		/** 下载/安装状态机（electron-updater 事件驱动）。 */
		download: AppUpdateDownloadState;
	} | null;
	/** Pi CLI 更新状态；null = 尚未成功检查过。 */
	piCli: {
		currentVersion?: string;
		latestVersion?: string;
		hasUpdate: boolean;
		/** 最近一次已提示过的版本。 */
		notifiedVersion?: string;
		error?: string;
	} | null;
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
	/** 起始时间（含），毫秒时间戳 */
	from?: number;
	/** 截止时间（含），毫秒时间戳 */
	to?: number;
	/** 兼容旧调用：返回最近 N 条 */
	limit?: number;
	/** 分页页码（0 基），与 pageSize 同时传入时走分页模式 */
	page?: number;
	pageSize?: number;
};

/** 分页日志结果：服务端按过滤条件分页，避免一次性拉全量/截断旧日志。 */
export type AppLogPage = {
	/** 当前页条目（时间倒序，最新在前） */
	entries: AppLogEntry[];
	/** 符合过滤条件的总条数 */
	total: number;
	/** 当前页码（0 基） */
	page: number;
	pageSize: number;
	/** 是否还有下一页 */
	hasMore: boolean;
};

export type PiRuntimeEvent = {
	agentId: string;
	event: unknown;
};
