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
] as const;

export type BuiltinCloudProvider = (typeof BUILTIN_CLOUD_PROVIDERS)[number];

export type CloudProvider = BuiltinCloudProvider;

export function isBuiltinCloudProvider(provider: string): provider is BuiltinCloudProvider {
	return (BUILTIN_CLOUD_PROVIDERS as readonly string[]).includes(provider);
}

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
	scope: "global" | "project";
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

export type CloudSyncResourceCategory = "settings" | "prompts" | "skills" | "extensions";

export type CloudSyncCandidateStatus = "available" | "unavailable";

/** Session/resource candidates are read-only server snapshots; paths are never exposed. */
export interface CloudSyncSessionCandidate {
	selectionId: string;
	sessionId: string;
	title: string;
	projectId: string;
	scope: "global" | "project";
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
	kind: "global-sessions" | "project-sessions" | "global-resources" | "project-resources";
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
	| { provider: "s3"; config: S3Config };

export type CloudSyncSecurityState = "NO_KEY" | "LOCKED" | "UNLOCKED";

export type CloudSyncState = "IDLE" | "SYNCING" | "CONFLICT" | "BLOCKED" | "ERROR";

export type CloudSyncStrategy = "smartMerge" | "preferCloud" | "preferLocal";

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
