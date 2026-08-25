/**
 * Cloud sync shared contract.
 *
 * This is the cross-process pure type layer for PiDeck cloud sync. It mirrors
 * the Netcatty design but the payload is PiDeck-shaped: a project tree with
 * per-project resources and individually selected sessions.
 *
 * PiDeck owns the master key, encryption, merge and provider adapters in the
 * main process; renderer only sees state snapshots and calls cloudSync IPC.
 */

// ---------------------------------------------------------------------------
// Cloud provider identities
// ---------------------------------------------------------------------------

export const BUILTIN_CLOUD_PROVIDERS = [
	"github",
	"google",
	"onedrive",
	"webdav",
	"s3",
	"local",
] as const;

export type BuiltinCloudProvider = (typeof BUILTIN_CLOUD_PROVIDERS)[number];

export type CloudProvider = BuiltinCloudProvider;

export function isBuiltinCloudProvider(provider: string): provider is BuiltinCloudProvider {
	return (BUILTIN_CLOUD_PROVIDERS as readonly string[]).includes(provider);
}

// ---------------------------------------------------------------------------
// Unified provider model: upload-method taxonomy
// ---------------------------------------------------------------------------
//
// 所有 provider（含第 6 类"本地同步文件夹"）统一走 PiDeckCloudObjectStorage
// 对象读写接口，加密/索引/合并/冲突/缩水保护全部 provider 无关；差异只收敛在
// "文件如何上传到云端" 的连接方式上，供设置页文案与能力提示使用。
//
// - oauth  ：浏览器授权后经官方 API 直连（OneDrive 已实现，Google Drive 规划中）；
// - config ：用户填写服务商地址与凭据（WebDAV / S3 / GitHub Gist，已实现）；
// - folder ：本地同步文件夹，上传交给用户已有的网盘客户端（第 6 类，已实现）。

export const CLOUD_PROVIDER_KINDS = ["oauth", "config", "folder"] as const;

export type CloudProviderKind = (typeof CLOUD_PROVIDER_KINDS)[number];

export const CLOUD_PROVIDER_KIND: Record<BuiltinCloudProvider, CloudProviderKind> = {
	github: "config",
	google: "oauth",
	onedrive: "oauth",
	webdav: "config",
	s3: "config",
	local: "folder",
};

// ---------------------------------------------------------------------------
// Provider connection config
// ---------------------------------------------------------------------------

export type WebDAVAuthType = "basic" | "digest" | "token";

export interface WebDAVConfig {
	endpoint: string;
	authType: WebDAVAuthType;
	username?: string;
	password?: string;
	token?: string;
	allowInsecure?: boolean;
}

export interface S3Config {
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	prefix?: string;
	forcePathStyle?: boolean;
	allowInsecure?: boolean;
}

export interface OAuthTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
	tokenType: string;
	scope?: string;
}

/** GitHub Gist 同步目标：token 经主密钥加密落盘；clientId 用于 Device Flow 换 token。 */
export interface GithubGistConfig {
	/** OAuth access token（仅主进程持有）。 */
	token?: string;
	/** 复用已有 Gist；缺省自动创建命名 Gist。 */
	gistId?: string;
	/** GitHub OAuth App 的 Client ID（Device Flow 必需，用户自备）。 */
	clientId?: string;
}

/** 第 6 类 provider：本地同步文件夹。文件写入后由用户已有的网盘客户端负责上云。 */
export interface LocalFolderConfig {
	/** 本地文件夹绝对路径（连接时自动创建）。 */
	folderPath: string;
}

/**
 * OneDrive（Microsoft Graph）直连配置（oauth 类）。
 * clientId 由用户在 Azure 注册「移动和桌面应用」后自备（与 GitHub Gist 同模式）；
 * token 仅在主进程流转并随主密码密封落盘，永不进 renderer。
 */
export interface OneDriveConfig {
	/** Azure 应用 Client ID（必填）。 */
	clientId: string;
	/** 缺省 "consumers"（个人账号）；企业账号可填租户 id/域名。 */
	tenant?: string;
	/** OAuth 完成后密封落盘（仅主进程持有）。 */
	accessToken?: string;
	refreshToken?: string;
	/** accessToken 过期时间（epoch ms）。 */
	expiresAt?: number;
}

/** OneDrive 浏览器授权启动结果：verificationUrl 用系统浏览器打开。 */
export interface CloudSyncOneDriveFlowStart {
	verificationUrl: string;
	port: number;
}

/**
 * Google Drive（Drive API v3）直连配置（oauth 类）。
 * clientId 由用户在 Google Cloud Console 创建「桌面应用」后自备；
 * clientSecret 对桌面应用非机密，PKCE 流程可省略，token 刷新时按需携带；
 * token 仅在主进程流转并随主密码密封落盘，永不进 renderer。
 */
export interface GoogleDriveConfig {
	/** Google Cloud OAuth 客户端 ID（必填）。 */
	clientId: string;
	/** 桌面应用类型客户端密钥（可选）。 */
	clientSecret?: string;
	/** OAuth 完成后密封落盘（仅主进程持有）。 */
	accessToken?: string;
	refreshToken?: string;
	/** accessToken 过期时间（epoch ms）。 */
	expiresAt?: number;
}

/** Google 浏览器授权启动结果：verificationUrl 用系统浏览器打开。 */
export interface CloudSyncGoogleFlowStart {
	verificationUrl: string;
	port: number;
}


export interface ProviderAccount {
	id: string;
	email?: string;
	name?: string;
	avatarUrl?: string;
}

export type ProviderConnectionStatus =
	| "disconnected"
	| "connecting"
	| "connected"
	| "syncing"
	| "error";

export interface ProviderConnection {
	provider: CloudProvider;
	status: ProviderConnectionStatus;
	account?: ProviderAccount;
	tokens?: OAuthTokens;
	config?: WebDAVConfig | S3Config;
	lastSync?: number;
	lastSyncVersion?: number;
	resourceId?: string;
	error?: string;
}

/** Renderer-safe provider state. Credentials, tokens and raw provider config never cross IPC. */
export interface CloudSyncProviderSnapshot {
	provider: CloudProvider;
	status: ProviderConnectionStatus;
	configured: boolean;
	account?: ProviderAccount;
	lastSync?: number;
	lastSyncVersion?: number;
	error?: string;
}

// ---------------------------------------------------------------------------
// Encrypted sync file schema
// ---------------------------------------------------------------------------

export interface SyncFileMeta {
	version: number;
	updatedAt: number;
	deviceId: string;
	deviceName?: string;
	appVersion: string;
	iv: string;
	salt: string;
	algorithm: "AES-256-GCM";
	kdf: "PBKDF2";
	kdfIterations?: number;
	/** 对象正文压缩格式；缺省表示明文即 UTF-8 文本（向后兼容旧对象）。 */
	compressed?: "gzip";
}

export interface SyncedFile {
	meta: SyncFileMeta;
	payload: string;
}

/** Local-only master key configuration; the derived key is never persisted. */
export interface CloudSyncMasterKeyConfig {
	version: 1;
	verificationHash: string;
	salt: string;
	kdf: "PBKDF2";
	kdfIterations: number;
	createdAt: number;
}

// ---------------------------------------------------------------------------
// PiDeck sync payload (unified project tree)
// ---------------------------------------------------------------------------

/** A file-level resource carried in the encrypted payload or as an object. */
export interface CloudSyncFileBundle {
	relativePath: string;
	contentHash: string;
	/** Inline content for small files. */
	content?: string;
	/** Object key when the content is stored as a separate encrypted object. */
	objectKey?: string;
}

/** A selected session reference. Full content lives in a separate object. */
export interface CloudSyncSessionRef {
	sessionId: string;
	/** dsh：$DSH_HOME/sessions 下的会话（relativePath 相对 $DSH_HOME/sessions）。 */
	scope: "global" | "project" | "dsh";
	projectId?: string;
	relativePath: string;
	size: number;
	mtimeMs: number;
	contentHash: string;
	objectKey: string;
}

/** Declared package extension source, not the installed node_modules. */
export interface CloudSyncExtensionSource {
	source: string;
	scope: "user" | "project";
	version?: string;
	lockContent?: string;
}

export interface CloudSyncProjectResources {
	piSettings?: Record<string, unknown>;
	prompts?: CloudSyncFileBundle[];
	skills?: CloudSyncFileBundle[];
	localExtensions?: CloudSyncFileBundle[];
	extensionSources?: CloudSyncExtensionSource[];
	/** M9：全局配置/自选路径资源（category=config，相对 agentRoot 或 home 的 portable path）。 */
	config?: CloudSyncFileBundle[];
}

export interface CloudSyncProject {
	projectId: string;
	name: string;
	kind?: "normal" | "chat" | "external";
	pathHint?: string;
	environment?: "windows" | "wsl";
	metadata?: {
		pinned?: boolean;
		sortOrder?: number;
		worktreeEnabled?: boolean;
		worktreeParentId?: string;
	};
	resources?: CloudSyncProjectResources;
	sessions?: CloudSyncSessionRef[];
	catalogEntries?: Array<Record<string, unknown>>;
}

export interface PiDeckSyncIndexV1 {
	schemaVersion: 1;
	meta: {
		deviceId: string;
		deviceName?: string;
		appVersion: string;
		syncedAt: number;
	};
	settings?: Record<string, unknown>;
	pi?: {
		models?: Record<string, unknown>;
		auth?: Record<string, { type?: string; key?: string }>;
		settings?: Record<string, unknown>;
	};
	dsh?: {
		settingsYaml?: string;
		credentials?: Record<string, string>;
	};
	projects?: CloudSyncProject[];
	imageGen?: {
		activeProviderId?: string;
		activeModel?: string;
		providers?: Array<Record<string, unknown>>;
	};
	extensionState?: {
		removedBuiltInExtensions?: string[];
		disabledExtensions?: Array<{ scope: string; source: string }>;
		disableExtensionWhitelist?: boolean;
	};
	syncedAt: number;
}

export type CloudSyncResourceCategory = "settings" | "prompts" | "skills" | "extensions" | "config";

export type CloudSyncCandidateStatus = "available" | "unavailable";

/** Session/resource candidates are read-only server snapshots; paths are never exposed. */
export interface CloudSyncSessionCandidate {
	selectionId: string;
	sessionId: string;
	title: string;
	projectId: string;
	scope: "global" | "project" | "dsh";
	relativePath: string;
	size: number;
	mtimeMs: number;
	source: string;
	environment: "native" | "wsl";
	selected: boolean;
	status: CloudSyncCandidateStatus;
	reason?: string;
}

export interface CloudSyncResourceCandidate {
	selectionId: string;
	projectId: string;
	category: CloudSyncResourceCategory;
	relativePath: string;
	size: number;
	mtimeMs: number;
	selected: boolean;
	status: CloudSyncCandidateStatus;
	reason?: string;
}

export interface CloudSyncScanRootStatus {
	id: string;
	label: string;
	kind: "global-sessions" | "project-sessions" | "global-resources" | "project-resources" | "dsh-sessions";
	projectId?: string;
	ok: boolean;
	count: number;
	error?: string;
}

export interface CloudSyncProjectSelectionNode {
	projectId: string;
	name: string;
	kind?: "normal" | "chat" | "external";
	environment?: "windows" | "wsl";
	pathHint?: string;
	missing?: boolean;
	sessions: CloudSyncSessionCandidate[];
	resources: CloudSyncResourceCandidate[];
}

export interface CloudSyncSelectionTree {
	scannedAt: number;
	projects: CloudSyncProjectSelectionNode[];
	roots: CloudSyncScanRootStatus[];
	totalSessions: number;
	selectedSessions: number;
	totalResources: number;
	selectedResources: number;
	/** 当前生效的内容分类偏好（密钥/模型/生图等开关），供 UI 绑定与切换。 */
	content: CloudSyncContentPreferences;
}

export interface CloudSyncContentPreferences {
	desktopSettings: boolean;
	piModels: boolean;
	piCredentials: boolean;
	dshSettings: boolean;
	dshCredentials: boolean;
	projects: boolean;
	catalog: boolean;
	prompts: boolean;
	skills: boolean;
	extensions: boolean;
	security: boolean;
	/** 生图供应商配置（imagegen.json，含 apiKey，默认同步）。 */
	imageGen: boolean;
}

export interface CloudSyncSelectionPreferences {
	selectedSessionIds: string[];
	selectedResourceIds: string[];
	content: CloudSyncContentPreferences;
}

export interface CloudSyncSelectionUpdate {
	selectedSessionIds: string[];
	selectedResourceIds: string[];
	content?: Partial<CloudSyncContentPreferences>;
}

// ---------------------------------------------------------------------------
// M9: 排除名单 / 自选同步 / 挂载映射（第二轮评审 §12）
// ---------------------------------------------------------------------------

/** 扫描排除规则（内置默认 + 用户黑名单）；pattern 为 glob 或相对路径片段。 */
export interface CloudSyncExclusion {
	id: string;
	pattern: string;
}

/** 自选同步路径（用户点「添加」手动选中的文件/文件夹）。 */
export interface CloudSyncCustomPath {
	id: string;
	filePath: string;
	/** 存储基准：项目内相对 / home 相对 / 绝对路径（仅本机）。 */
	relativeTo: "project" | "home" | "absolute";
	/** 相对基准的路径（absolute 时为完整路径）。 */
	relativePath: string;
	/** relativeTo=project 时归属的项目 id。 */
	projectId?: string;
	label: string;
}

/** 云端项目 → 本地目录的手动挂载映射（全手动策略，§12.5）。 */
export interface CloudSyncMount {
	remoteProjectId: string;
	remoteProjectName: string;
	localPath: string;
	mountedAt: number;
}

/** 类别节点批量勾选请求（UI 用；选择集合仍以 selectedSessionIds/selectedResourceIds 为准）。 */
export interface CloudSyncCategoryToggle {
	/** 节点所属项目（__global__ 为全局节点）。 */
	projectId: string;
	/** sessions 或资源类别。 */
	category: "sessions" | CloudSyncResourceCategory;
	/** 批量设为选中（false = 取消全选）。 */
	selected: boolean;
}

// ---------------------------------------------------------------------------
// Three-way merge / conflict model (M6)
// ---------------------------------------------------------------------------

export type CloudSyncConflictKind =
	| "session"
	| "resource"
	| "settings"
	| "catalog"
	| "project";

/** One side of a conflicted entity; hashes are optional for non-file entities. */
export interface CloudSyncConflictSide {
	hash?: string;
	updatedAt?: number;
}

export interface CloudSyncConflict {
	/** Stable id: `session:<sessionId>` / `settings:<field>` / `resource:<projectId>:<category>:<path>` … */
	id: string;
	kind: CloudSyncConflictKind;
	label: string;
	projectId?: string;
	entityId?: string;
	local: CloudSyncConflictSide;
	remote: CloudSyncConflictSide;
}

export interface CloudSyncConflictResolution {
	id: string;
	choice: "local" | "remote";
}

/** 已声明但本机未安装/安装失败的包扩展（恢复后按声明触发 pi install）。 */
export interface CloudSyncMissingExtension {
	source: string;
	scope: "user" | "project";
	error?: string;
}

export type CloudSyncProviderConfigInput =
	| { provider: "webdav"; config: WebDAVConfig }
	| { provider: "s3"; config: S3Config }
	| { provider: "github"; config: GithubGistConfig }
	| { provider: "local"; config: LocalFolderConfig }
	| { provider: "onedrive"; config: OneDriveConfig }
	| { provider: "google"; config: GoogleDriveConfig };


export type CloudSyncSecurityState = "NO_KEY" | "LOCKED" | "UNLOCKED";

export type CloudSyncState = "IDLE" | "SYNCING" | "CONFLICT" | "BLOCKED" | "ERROR";

export type CloudSyncStrategy = "smartMerge" | "preferCloud" | "preferLocal";

// ---------------------------------------------------------------------------
// Local one-click import/export (offline backup, no cloud required)
// ---------------------------------------------------------------------------

/** 导入模式：merge 本地优先（已有且不同则保留本地）；overwrite 以备份为准；restoreMissing 只补缺失。 */
export type CloudSyncImportMode = "merge" | "overwrite" | "restoreMissing";

export interface CloudSyncExportResult {
	filePath: string;
	createdAt: number;
	sessionCount: number;
	resourceCount: number;
	entryCount: number;
	bytes: number;
}

export interface CloudSyncImportResult {
	filePath: string;
	sessionCount: number;
	resourceCount: number;
	sessionsRestored: number;
	resourcesRestored: number;
	sessionsSkipped: number;
	resourcesSkipped: number;
	/** 目标机没有对应项目、落入待映射区的项目 id 列表。 */
	pendingProjects: string[];
	missingExtensions: CloudSyncMissingExtension[];
}

export interface CloudSyncImportInput {
	filePath: string;
	password: string;
	mode: CloudSyncImportMode;
}

export interface CloudSyncStateSnapshot {
	securityState: CloudSyncSecurityState;
	syncState: CloudSyncState;
	providers: Record<CloudProvider, CloudSyncProviderSnapshot>;
	deviceId: string;
	deviceName: string;
	localVersion: number;
	remoteVersion: number;
	lastError: string | null;
	autoSyncEnabled: boolean;
	autoSyncInterval: number;
	syncStrategy: CloudSyncStrategy;
	pendingLocalSync: boolean;
	/** 待解决的冲突（三路合并产物）；为空表示无冲突。 */
	conflicts: CloudSyncConflict[];
	/** 已声明但尚未安装成功的包扩展。 */
	missingExtensions: CloudSyncMissingExtension[];
	/** M9：用户扫描排除规则（黑名单）。 */
	exclusions: CloudSyncExclusion[];
	/** M9：自选同步路径清单。 */
	customPaths: CloudSyncCustomPath[];
	/** M9：云端项目 → 本地目录挂载映射（全手动策略）。 */
	mounts: CloudSyncMount[];
}

export const CLOUD_SYNC_STORAGE_KEYS = {
	MASTER_KEY_CONFIG: "pideck_master_key_config_v1",
	DEVICE_ID: "pideck_device_id_v1",
	DEVICE_NAME: "pideck_device_name_v1",
	SYNC_CONFIG: "pideck_sync_config_v1",
	SYNC_PREFERENCES: "pideck_sync_preferences_v1",
	PROVIDER_GITHUB: "pideck_provider_github_v1",
	PROVIDER_GOOGLE: "pideck_provider_google_v1",
	PROVIDER_ONEDRIVE: "pideck_provider_onedrive_v1",
	PROVIDER_WEBDAV: "pideck_provider_webdav_v1",
	PROVIDER_S3: "pideck_provider_s3_v1",
} as const;

export const CLOUD_SYNC_CONSTANTS = {
	SYNC_INDEX_OBJECT_KEY: "pideck-index.json",
	SYNC_FILE_NAME: "pideck-index.json",
	PBKDF2_ITERATIONS: 600_000,
	MIN_PBKDF2_ITERATIONS: 100_000,
	MAX_PBKDF2_ITERATIONS: 2_000_000,
	MASTER_KEY_CONFIG_VERSION: 1,
	PBKDF2_HASH: "SHA-256",
	AES_KEY_LENGTH: 256,
	GCM_IV_LENGTH: 12,
	GCM_TAG_LENGTH: 128,
	SALT_LENGTH: 32,
} as const;
