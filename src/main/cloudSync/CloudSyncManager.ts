import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AppSettings, Project, SessionRecord } from "../../shared/types.ts";
import type {
	CloudProvider,
	CloudSyncConflict,
	CloudSyncConflictResolution,
	CloudSyncCustomPath,
	CloudSyncExclusion,
	CloudSyncExportResult,
	CloudSyncImportInput,
	CloudSyncImportMode,
	CloudSyncImportResult,
	CloudSyncMasterKeyConfig,
	CloudSyncMissingExtension,
	CloudSyncOneDriveFlowStart,
	CloudSyncGoogleFlowStart,
	CloudSyncGithubPollResult,
	CloudSyncProviderConfigInput,
	CloudSyncProviderSnapshot,
	CloudSyncSelectionPreferences,
	CloudSyncSelectionTree,
	CloudSyncSelectionUpdate,
	CloudSyncSessionRef,
	CloudSyncState,
	CloudSyncStateSnapshot,
	CloudSyncStrategy,
	GithubGistConfig,
	GoogleDriveConfig,
	LocalFolderConfig,
	OneDriveConfig,
	PiDeckSyncIndexV1,
	ProviderAccount,
	ProviderConnectionStatus,
	SyncedFile,
	WebDAVConfig,
	S3Config,
} from "../../shared/types/cloudSync.ts";
import { CLOUD_SYNC_CONSTANTS } from "../../shared/types/cloudSync.ts";
import { localProjectPath } from "../../shared/projectLocation.ts";
import { createMasterKeyConfig, changeMasterPassword, decrypt, decryptPayload, deriveKey, encrypt, encryptPayload, isCloudSyncMasterKeyConfig, unlockMasterKey, verifyPassword } from "./EncryptionService.ts";
import type { GithubDeviceFlowStart, GithubDeviceFlowToken } from "./adapters/GithubGistObjectStorage.ts";
import { CloudSyncScanner, type CloudSyncInternalResource, type CloudSyncInternalSession, type CloudSyncScanOptions, type CloudSyncScanSnapshot } from "./CloudSyncScanner.ts";
import type { PiDeckCloudObjectStorage } from "./objectStorage.ts";
import { createCloudSyncObjectStorage } from "./adapters/index.ts";
import { normalizeGithubGistConfig, normalizeGoogleDriveConfig, normalizeLocalFolderConfig, normalizeOneDriveConfig, normalizeS3Config, normalizeWebDAVConfig } from "./providerConfig.ts";
import { createMountRegistry } from "./cloudSyncMounts.ts";
import { OAUTH_BUILTIN_CREDENTIALS, type OAuthBuiltinCredentials } from "./oauthCredentials.ts";
import { filterSyncableDesktopSettings, GLOBAL_SYNC_PROJECT_ID } from "./payload.ts";
import { mergeSyncIndexes, type CloudSyncMergeResult } from "./merge.ts";
import { decodeBase64, decryptObjectWith, encodeBase64, ensureNoSymlinkEscape, writeFileAtomic } from "./manager/objectIo.ts";
import { CloudSyncGithubDeviceFlow } from "./manager/githubDeviceFlow.ts";
import { CloudSyncProviderOAuthFlows } from "./manager/providerOAuthFlows.ts";
import { CloudSyncLocalIndexBuilder } from "./manager/localIndexBuilder.ts";
import { CloudSyncSessionObjectTransfer } from "./manager/sessionObjectTransfer.ts";
import { CloudSyncBackupTransfer } from "./manager/backupTransfer.ts";

type PersistedProviderEntry = { configured: true; sealed: string } | null;

type CloudSyncPersistedState = {
	version: 1;
	deviceId: string;
	deviceName: string;
	masterKeyConfig: CloudSyncMasterKeyConfig | null;
	providers: Record<string, PersistedProviderEntry>;
	selection: CloudSyncSelectionPreferences;
	autoSync: { enabled: boolean; intervalMinutes: number };
	strategy: CloudSyncStrategy;
	localVersion: number;
	remoteVersion: number;
	lastSyncAt: number | null;
	lastSyncDeviceId: string | null;
	/** 上一次成功同步的索引（三路合并的 base）。 */
	lastSyncedIndex: PiDeckSyncIndexV1 | null;
	/** 已声明但尚未安装成功的包扩展（M5 恢复检查）。 */
	missingExtensions: CloudSyncMissingExtension[];
	/** M9：用户扫描排除规则（黑名单 glob）。 */
	exclusions: CloudSyncExclusion[];
	/** M9：自选同步路径清单。 */
	customPaths: CloudSyncCustomPath[];
	/** 上一次成功同步时的选中会话/资源数量（缩水保护基线）。 */
	lastSyncedSessionCount: number;
	lastSyncedResourceCount: number;
};

const DEFAULT_CONTENT_PREFERENCES = (): CloudSyncSelectionPreferences["content"] => ({
	desktopSettings: true,
	piModels: true,
	piCredentials: true,
	dshSettings: true,
	dshCredentials: true,
	projects: true,
	catalog: true,
	prompts: true,
	skills: true,
	extensions: true,
	security: true,
	imageGen: true,
});

function createDefaultState(): CloudSyncPersistedState {
	return {
		version: 1,
		deviceId: randomUUID(),
		deviceName: "",
		masterKeyConfig: null,
		providers: {},
		selection: {
			selectedSessionIds: [],
			selectedResourceIds: [],
			content: DEFAULT_CONTENT_PREFERENCES(),
		},
		autoSync: { enabled: false, intervalMinutes: 5 },
		strategy: "smartMerge",
		localVersion: 0,
		remoteVersion: 0,
		lastSyncAt: null,
		lastSyncDeviceId: null,
		lastSyncedIndex: null,
		missingExtensions: [],
		exclusions: [],
		customPaths: [],
		lastSyncedSessionCount: 0,
		lastSyncedResourceCount: 0,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function isPermissionError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && ((error as { code?: unknown }).code === "EACCES" || (error as { code?: unknown }).code === "EPERM"));
}

function isSafeSelectionId(value: string): boolean {
	return typeof value === "string" && value.length > 0 && value.length <= 512 && (value.startsWith("session:") || value.startsWith("resource:"));
}

export interface CloudSyncManagerOptions {
	userDataDir: string;
	homeDir: string;
	/** $DSH_HOME（可选）：提供时扫描/恢复 DSH 会话（$DSH_HOME/sessions）。 */
	dshHomeDir?: string;
	deviceName: string;
	appVersion: string;
	listProjects: () => Project[];
	listSessionRecords: () => SessionRecord[];
	getDesktopSettings: () => AppSettings;
	updateDesktopSettings: (patch: Record<string, unknown>) => Promise<void>;
	/** 测试注入点：默认走 createCloudSyncObjectStorage（真实 WebDAV/S3）。 */
	createAdapter?: (provider: CloudProvider, config: WebDAVConfig | S3Config | GithubGistConfig | LocalFolderConfig | OneDriveConfig | GoogleDriveConfig) => PiDeckCloudObjectStorage;
	/** 包扩展安装（M5）：默认未注入时不自动安装，只记录缺失清单。 */
	installExtension?: (source: string, scope: "user" | "project") => Promise<{ ok: boolean; error?: string }>;
	/** 已安装扩展清单（source + scope），用于判断声明是否缺失。 */
	listExtensions?: () => Promise<Array<{ source: string; scope?: string }>>;
	/** OneDrive OAuth 测试注入点：缺省走真实 Graph token 端点（全局 fetch）。 */
	exchangeOneDriveCode?: (input: { clientId: string; tenant: string; code: string; codeVerifier: string; redirectUri: string }) => Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }>;
	/** Google OAuth 测试注入点：缺省走真实 Google token 端点（全局 fetch）。 */
	exchangeGoogleCode?: (input: { clientId: string; clientSecret?: string; code: string; codeVerifier: string; redirectUri: string }) => Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }>;
	/** GitHub Device Flow 测试注入点：缺省走真实 GitHub 端点（全局 fetch）。 */
	startGithubDeviceFlowImpl?: (clientId: string) => Promise<GithubDeviceFlowStart>;
	/** GitHub Device Flow 轮询测试注入点：缺省走真实 GitHub 端点（全局 fetch）。 */
	pollGithubDeviceFlowImpl?: (clientId: string, deviceCode: string) => Promise<GithubDeviceFlowToken>;
	/** 内置 OAuth 凭据（对齐 Netcatty：构建期 env 注入，缺省读 VITE_SYNC_* 环境变量）。 */
	oauthBuiltins?: OAuthBuiltinCredentials;
	onStateChanged?: (snapshot: CloudSyncStateSnapshot) => void;
	log?: (domain: string, message: string, details?: Record<string, unknown>) => void;
}

/**
 * Main-process cloud sync orchestrator.
 *
 * The master password and derived keys live only in this process. Provider
 * credentials are sealed with the master-derived key at rest; renderer never
 * sees secrets (CloudSyncStateSnapshot strips tokens/config).
 */
export class CloudSyncManager {
	private readonly options: CloudSyncManagerOptions;
	/** 内置 OAuth 凭据（构建期注入；缺省读 VITE_SYNC_*）。 */
	private readonly oauthBuiltins: OAuthBuiltinCredentials;
	private readonly stateFile: string;
	private readonly scanner: CloudSyncScanner;
	private state: CloudSyncPersistedState = createDefaultState();
	private password: string | null = null;
	/** Unsealed provider configs, available only while unlocked. */
	private providerConfigs = new Map<CloudProvider, WebDAVConfig | S3Config | GithubGistConfig | LocalFolderConfig | OneDriveConfig | GoogleDriveConfig>();
	private adapters = new Map<CloudProvider, PiDeckCloudObjectStorage>();
	private syncState: CloudSyncState = "IDLE";
	private lastError: string | null = null;
	private pendingLocalSync = false;
	private lastTree: CloudSyncSelectionTree | null = null;
	/** CONFLICT 时的三方上下文与冲突清单（resolveConflicts 使用）。 */
	private pendingConflictContext: {
		base: PiDeckSyncIndexV1 | null;
		local: PiDeckSyncIndexV1;
		remote: PiDeckSyncIndexV1;
		conflicts: CloudSyncConflict[];
	} | null = null;
	/** Serialize state writes so a slower, older write cannot replace a newer one. */
	private statePersistQueue: Promise<void> = Promise.resolve();
	/** Serialize OAuth rotations through seal + durable write; the final callback wins. */
	private tokenPersistQueue: Promise<void> = Promise.resolve();
	private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
	private disposed = false;
	/** 浏览器授权流程（OneDrive/Google PKCE + 回环回调；token 只在主进程流转）。 */
	private readonly providerOAuth: CloudSyncProviderOAuthFlows;
	/** 本地索引构建（实现见 manager/localIndexBuilder.ts）。 */
	private readonly indexBuilder: CloudSyncLocalIndexBuilder;
	/** 对象传输（上传/下载/落位；实现见 manager/sessionObjectTransfer.ts）。 */
	private readonly transfer: CloudSyncSessionObjectTransfer;
	/** 离线备份导入/导出（实现见 manager/backupTransfer.ts）。 */
	private readonly backupTransfer: CloudSyncBackupTransfer;
	/** GitHub Device Flow（token 只在主进程流转，永不进 renderer）。 */
	private readonly githubFlow: CloudSyncGithubDeviceFlow;
	/** GitHub Device Flow 进行中的上下文（主进程持有，token 永不进 renderer）。
	 *  retryIntervalMs：当前轮询间隔（毫秒），slow_down 时累加 5s，服务端 interval 为基准。 */
	get githubDeviceFlow(): (GithubDeviceFlowStart & { clientId: string; retryIntervalMs: number }) | null {
		return this.githubFlow.pendingFlow;
	}
	/** M9：云端项目 → 本地目录挂载注册表（全手动策略）。 */
	private mounts: ReturnType<typeof createMountRegistry> | null = null;

	constructor(options: CloudSyncManagerOptions) {
		this.options = options;
		this.oauthBuiltins = options.oauthBuiltins ?? OAUTH_BUILTIN_CREDENTIALS;
		this.stateFile = join(options.userDataDir, "cloud-sync-state.json");
		this.scanner = new CloudSyncScanner({
			homeDir: options.homeDir,
			...(options.dshHomeDir ? { dshHomeDir: options.dshHomeDir } : {}),
			listProjects: options.listProjects,
			listSessionRecords: options.listSessionRecords,
		});
		this.githubFlow = new CloudSyncGithubDeviceFlow(this, options, this.oauthBuiltins);
		this.providerOAuth = new CloudSyncProviderOAuthFlows(this, options, this.oauthBuiltins);
		this.indexBuilder = new CloudSyncLocalIndexBuilder(
			{
				deviceId: () => this.state.deviceId,
				deviceName: () => this.state.deviceName,
				selectionContent: () => this.state.selection.content,
			},
			options,
		);
		this.transfer = new CloudSyncSessionObjectTransfer(
			{
				requirePassword: () => this.requirePassword(),
				deviceId: () => this.state.deviceId,
				deviceName: () => this.state.deviceName,
				mountEntry: (remoteProjectId) => this.mounts?.get(remoteProjectId),
			},
			options,
		);
		this.backupTransfer = new CloudSyncBackupTransfer(
			{
				securityState: () => this.securityState(),
				setupMasterKey: (password) => this.setupMasterKey(password),
				unlock: (password) => this.unlock(password),
				masterKeyConfig: () => this.state.masterKeyConfig,
				deviceId: () => this.state.deviceId,
				deviceName: () => this.state.deviceName,
				scan: () => this.scanSelectionSnapshot(),
				buildLocalIndex: (scan, sessions, resources) => this.buildLocalIndex(scan, sessions, resources),
				encryptObject: (content) => this.encryptObject(content),
				decryptObject: (bytes) => this.decryptObject(bytes),
				decryptObjectWith,
				checkAndRestoreExtensions: (index) => this.checkAndRestoreExtensions(index),
				restoreSensitiveContent: (merged, remote) => this.restoreSensitiveContent(merged, remote),
				resolveSessionTarget: (sessionRef) => this.resolveSessionTarget(sessionRef),
				sessionTargetRoot: (sessionRef) => this.sessionTargetRoot(sessionRef),
				readExistingHash: (filePath) => this.readExistingHash(filePath),
				resolveResourceTarget: (projectId, relativePath) => this.resolveResourceTarget(projectId, relativePath),
				commitImportedIndex: (index, counts) => this.commitImportedIndex(index, counts),
			},
			options,
		);
	}

	async initialize(): Promise<void> {
		await this.loadState();
		if (this.state.masterKeyConfig) {
			this.ensureDeviceName();
			await this.persist();
		}
		this.syncState = "IDLE";
		this.mounts = createMountRegistry(this.options.userDataDir);
		this.emitState();
		this.configureAutoSyncTimer();
	}

	getStateSnapshot(): CloudSyncStateSnapshot {
		const providers = Object.fromEntries(Object.keys(this.providerSnapshots()).map((provider) => [provider, this.providerSnapshots()[provider as CloudProvider]])) as Record<CloudProvider, CloudSyncProviderSnapshot>;
		return {
			securityState: this.securityState(),
			syncState: this.syncState,
			providers,
			deviceId: this.state.deviceId,
			deviceName: this.state.deviceName,
			localVersion: this.state.localVersion,
			remoteVersion: this.state.remoteVersion,
			lastError: this.lastError,
			autoSyncEnabled: this.state.autoSync.enabled,
			autoSyncInterval: this.state.autoSync.intervalMinutes,
			syncStrategy: this.state.strategy,
			pendingLocalSync: this.pendingLocalSync,
			conflicts: this.pendingConflictContext?.conflicts ?? [],
			missingExtensions: this.state.missingExtensions,
			exclusions: this.state.exclusions.map((item) => ({ ...item })),
			customPaths: this.state.customPaths.map((item) => ({ ...item })),
			mounts: this.mounts?.list() ?? [],
			oauthBuiltins: {
				github: Boolean(this.oauthBuiltins.githubClientId),
				onedrive: Boolean(this.oauthBuiltins.onedriveClientId),
				google: Boolean(this.oauthBuiltins.googleClientId),
			},
		};
	}

	getSelectionPreferences(): CloudSyncSelectionPreferences {
		return {
			selectedSessionIds: [...this.state.selection.selectedSessionIds],
			selectedResourceIds: [...this.state.selection.selectedResourceIds],
			content: { ...this.state.selection.content },
		};
	}

	// ── Master key lifecycle ─────────────────────────────────────────

	securityState(): "NO_KEY" | "LOCKED" | "UNLOCKED" {
		if (!this.state.masterKeyConfig) return "NO_KEY";
		return this.password ? "UNLOCKED" : "LOCKED";
	}

	async setupMasterKey(password: string): Promise<void> {
		if (this.securityState() === "UNLOCKED") throw new Error("Cloud sync is already unlocked");
		if (typeof password !== "string" || password.length < 8) {
			throw new TypeError("Master password must contain at least 8 characters");
		}
		const config = await createMasterKeyConfig(password);
		// New key invalidates any previously sealed provider credentials.
		this.state.masterKeyConfig = config;
		this.state.providers = {};
		this.providerConfigs.clear();
		await this.disconnectAllAdapters();
		this.password = password;
		this.syncState = "IDLE";
		this.lastError = null;
		this.pendingLocalSync = true;
		await this.persist();
		this.emitState();
	}

	async unlock(password: string): Promise<boolean> {
		const config = this.state.masterKeyConfig;
		if (!config) throw new Error("No master key configured");
		const unlocked = await unlockMasterKey(password, config);
		if (!unlocked) return false;
		this.password = password;
		await this.unsealProviders();
		this.syncState = "IDLE";
		this.lastError = null;
		this.emitState();
		return true;
	}

	async lock(): Promise<void> {
		this.password = null;
		this.providerConfigs.clear();
		this.pendingConflictContext = null;
		await this.disconnectAllAdapters();
		this.syncState = "IDLE";
		this.emitState();
	}

	async changeMasterPassword(oldPassword: string, newPassword: string): Promise<boolean> {
		const config = this.state.masterKeyConfig;
		if (!config) throw new Error("No master key configured");
		if (!(await verifyPassword(oldPassword, config))) return false;
		const next = await changeMasterPassword(oldPassword, newPassword, config);
		if (!next) return false;
		// Re-seal provider credentials with the new key before swapping configs.
		const sealedProviders: Record<string, PersistedProviderEntry> = {};
		for (const [provider, sealed] of Object.entries(this.state.providers)) {
			if (!sealed) continue;
			try {
				const plain = this.providerConfigs.get(provider as CloudProvider);
				if (plain) {
					sealedProviders[provider] = { configured: true, sealed: await this.sealConfig(plain, newPassword, next) };
				}
			} catch {
				// Unrecoverable credentials stay sealed under the old key and are dropped.
			}
		}
		this.state.masterKeyConfig = next;
		this.state.providers = sealedProviders;
		this.providerConfigs.clear();
		this.password = newPassword;
		await this.unsealProviders();
		await this.persist();
		this.emitState();
		return true;
	}

	// ── Provider configuration ───────────────────────────────────────

	async configureProvider(input: CloudSyncProviderConfigInput): Promise<void> {
		if (this.securityState() !== "UNLOCKED") throw new Error("Cloud sync must be unlocked");
		const config = this.normalizeProviderInput(input);
		const sealed = await this.sealConfig(config, this.requirePassword(), this.state.masterKeyConfig!);
		this.state.providers[input.provider] = { configured: true, sealed };
		this.providerConfigs.set(input.provider, config);
		this.pendingLocalSync = true;
		await this.persist();
		// 「保存并连接」语义：持久化后尽力自动连接；连接失败不阻断配置，
		// 错误写入 lastError 供 UI 提示，并可用卡片「连接」按钮重试。
		try {
			await this.connectProvider(input.provider);
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
		}
		this.emitState();
	}

	async disconnectProvider(provider: CloudProvider): Promise<void> {
		const adapter = this.adapters.get(provider);
		if (adapter) {
			await adapter.disconnect().catch(() => undefined);
			this.adapters.delete(provider);
		}
		this.state.providers[provider] = null;
		this.providerConfigs.delete(provider);
		this.pendingLocalSync = true;
		await this.persist();
		this.emitState();
	}

	async connectProvider(provider: CloudProvider): Promise<ProviderAccount> {
		if (this.securityState() !== "UNLOCKED") throw new Error("Cloud sync must be unlocked");
		const config = this.providerConfigs.get(provider);
		if (!config) throw new Error(`Provider ${provider} is not configured`);
		// 只断开旧连接，不清除已加密的持久化配置。
		await this.disconnectProviderConnection(provider);
		const adapter = (this.options.createAdapter ?? createCloudSyncObjectStorage)(provider, config);
		// OAuth provider：token 轮换时持久化新 token（Microsoft consumer / Google 每次刷新轮换并作废旧值）。
		if (provider === "onedrive" || provider === "google") {
			const base = config as OneDriveConfig | GoogleDriveConfig;
			adapter.setOnTokensRefreshed?.((tokens) => this.queueRotatedTokens(provider, { ...base, ...tokens }));
		}
		const result = await adapter.connect();
		this.adapters.set(provider, adapter);
		this.emitState();
		return result.account;
	}

	private queueRotatedTokens(provider: "onedrive" | "google", config: OneDriveConfig | GoogleDriveConfig): Promise<void> {
		const persist = () => this.persistRotatedTokens(provider, config);
		const result = this.tokenPersistQueue.then(persist, persist);
		this.tokenPersistQueue = result;
		return result;
	}

	/** OAuth token 轮换持久化：重新密封落盘（不触发连接重建，避免刷新期间抖动）。 */
	private async persistRotatedTokens(provider: "onedrive" | "google", config: OneDriveConfig | GoogleDriveConfig): Promise<void> {
		if (this.securityState() !== "UNLOCKED") return; // 锁定时无法密封，解锁后下次刷新失败会提示重连
		try {
			const sealed = await this.sealConfig(config, this.requirePassword(), this.state.masterKeyConfig!);
			this.state.providers[provider] = { configured: true, sealed };
			await this.persist();
			if (this.securityState() === "UNLOCKED") this.providerConfigs.set(provider, config);
		} catch (error) {
			// 持久化尽力而为：本次会话的新 token 仍可用，失败不阻断同步（Netcatty 同策略）。
			if (this.securityState() === "UNLOCKED") this.providerConfigs.set(provider, config);
			this.options.log?.("cloudSync", `Failed to persist rotated tokens for ${provider}`, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async disconnectProviderConnection(provider: CloudProvider): Promise<void> {
		const adapter = this.adapters.get(provider);
		if (!adapter) return;
		await adapter.disconnect().catch(() => undefined);
		this.adapters.delete(provider);
		this.emitState();
	}

	// ── GitHub Device Flow（token 只在主进程流转） ───────────────────
	// 实现：manager/githubDeviceFlow.ts（宿主只保留公开方法转发）。

	async startGithubDeviceFlow(clientId: string): Promise<GithubDeviceFlowStart> {
		return this.githubFlow.startGithubDeviceFlow(clientId);
	}

	async pollGithubDeviceFlow(): Promise<CloudSyncGithubPollResult> {
		return this.githubFlow.pollGithubDeviceFlow();
	}

	// ── OneDrive 浏览器授权（PKCE + 回环回调，token 只在主进程流转） ──
	// 实现：manager/providerOAuthFlows.ts（宿主只保留公开方法转发）。

	async startOneDriveOAuth(clientId: string): Promise<CloudSyncOneDriveFlowStart> {
		return this.providerOAuth.startOneDriveOAuth(clientId);
	}

	/** 轮询 OneDrive 授权；拿到 code 后换 token 并完成 provider 配置。 */
	async pollOneDriveOAuth(): Promise<{ status: "ok" | "pending" | "error"; error?: string }> {
		return this.providerOAuth.pollOneDriveOAuth();
	}

	// ── Google Drive 浏览器授权（PKCE + 回环回调，镜像 OneDrive 流程） ─────
	// 实现：manager/providerOAuthFlows.ts（宿主只保留公开方法转发）。

	async startGoogleOAuth(clientId: string, clientSecret?: string): Promise<CloudSyncGoogleFlowStart> {
		return this.providerOAuth.startGoogleOAuth(clientId, clientSecret);
	}

	/** 轮询 Google 授权；拿到 code 后换 token 并完成 provider 配置。 */
	async pollGoogleOAuth(): Promise<{ status: "ok" | "pending" | "error"; error?: string }> {
		return this.providerOAuth.pollGoogleOAuth();
	}

	// ── Selection & scanning ─────────────────────────────────────────

	/** M9：扫描器选项 —— 用户排除黑名单（glob）+ 自选同步路径（否则两者只存 state、不进扫描树）。 */
	private scanOptions(): CloudSyncScanOptions {
		return {
			exclusions: this.state.exclusions.map((item) => item.pattern),
			customPaths: this.state.customPaths.map((item) => ({ ...item })),
		};
	}

	async scanSelection(): Promise<CloudSyncSelectionTree> {
		const snapshot = await this.scanner.scan(this.getSelectionPreferences(), this.scanOptions());
		this.lastTree = snapshot.tree;
		return snapshot.tree;
	}

	async updateSelection(update: CloudSyncSelectionUpdate): Promise<CloudSyncSelectionTree> {
		const sessionIds = this.sanitizeIdList(update.selectedSessionIds);
		const resourceIds = this.sanitizeIdList(update.selectedResourceIds);
		this.state.selection.selectedSessionIds = sessionIds;
		this.state.selection.selectedResourceIds = resourceIds;
		if (update.content) {
			this.state.selection.content = { ...this.state.selection.content, ...update.content };
		}
		this.pendingLocalSync = true;
		await this.persist();
		return this.scanSelection();
	}

	async setAutoSync(enabled: boolean, intervalMinutes?: number): Promise<void> {
		this.state.autoSync.enabled = Boolean(enabled);
		if (typeof intervalMinutes === "number" && Number.isFinite(intervalMinutes) && intervalMinutes > 0) {
			this.state.autoSync.intervalMinutes = Math.min(1440, Math.max(1, Math.round(intervalMinutes)));
		}
		await this.persist();
		this.configureAutoSyncTimer();
		this.emitState();
	}

	async setStrategy(strategy: CloudSyncStrategy): Promise<void> {
		if (strategy !== "smartMerge" && strategy !== "preferCloud" && strategy !== "preferLocal") {
			throw new TypeError("Unknown cloud sync strategy");
		}
		this.state.strategy = strategy;
		await this.persist();
		this.emitState();
	}

	// ── M9: exclusions / custom paths / mounts ─────────────────────────

	/** 替换用户扫描排除黑名单（glob 列表，去重、限长、trim）。 */
	async setExclusions(patterns: string[]): Promise<void> {
		const clean = Array.isArray(patterns) ? patterns.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item.length > 0 && item.length <= 512) : [];
		this.state.exclusions = [...new Set(clean)].map((pattern, index) => ({ id: `ex-${Date.now()}-${index}`, pattern }));
		await this.persist();
		this.emitState();
	}

	/** 添加自选同步路径（用户点「添加」手动选中）；校验入参后入清单。 */
	async addCustomPath(input: { filePath: string; relativeTo: "project" | "home" | "absolute"; relativePath: string; projectId?: string; label?: string }): Promise<void> {
		if (!input || typeof input.filePath !== "string" || input.filePath.trim().length === 0 || input.filePath.length > 4096) {
			throw new TypeError("Custom path is invalid");
		}
		const entry: CloudSyncCustomPath = {
			id: `cp-${randomUUID()}`,
			filePath: input.filePath,
			relativeTo: input.relativeTo === "project" ? "project" : input.relativeTo === "home" ? "home" : "absolute",
			relativePath: input.relativePath,
			...(input.projectId ? { projectId: input.projectId } : {}),
			label: input.label?.trim() || input.relativePath,
		};
		this.state.customPaths = [...this.state.customPaths, entry];
		await this.persist();
		this.emitState();
	}

	/** 移除自选同步路径。 */
	async removeCustomPath(id: string): Promise<void> {
		this.state.customPaths = this.state.customPaths.filter((item) => item.id !== id);
		await this.persist();
		this.emitState();
	}

	/** 云端项目手动挂载到本地目录（全手动策略）；挂载映射持久化在 registry。 */
	async mountProject(input: { remoteProjectId: string; remoteProjectName: string; localPath: string }): Promise<void> {
		if (!this.mounts) throw new Error("Mount registry is not initialized");
		this.mounts.mount(input);
		await this.persist();
		this.emitState();
	}

	/** 解除云端项目挂载；未挂载时静默。 */
	async unmountProject(remoteProjectId: string): Promise<void> {
		this.mounts?.unmount(remoteProjectId);
		await this.persist();
		this.emitState();
	}

	// ── Sync orchestration ───────────────────────────────────────────

	/**
	 * Guarded push/pull with a version counter, shrink protection and a
	 * three-way merge (base = last synced index). Entities changed on one side
	 * only are applied automatically; entities changed on both sides become
	 * conflicts that must be resolved by the user before the next write.
	 */
	async syncNow(options?: { allowShrink?: boolean }): Promise<{ pushed: boolean; pulled: boolean; reason?: string }> {
		if (this.securityState() !== "UNLOCKED") throw new Error("Cloud sync must be unlocked");
		if (this.adapters.size === 0) throw new Error("Connect a cloud provider first");
		if (this.syncState === "SYNCING") throw new Error("Cloud sync is already running");

		this.syncState = "SYNCING";
		this.lastError = null;
		this.emitState();
		try {
			const scan = await this.scanner.scan(this.getSelectionPreferences(), this.scanOptions());
			const selectedSessions = [...scan.sessions.values()].filter((item) => item.candidate.selected);
			const selectedResources = [...scan.resources.values()].filter((item) => item.candidate.selected);

			// Shrink guard: an explicitly empty selection is not the same as data loss.
			const shrinkGuard = await this.evaluateShrinkGuard(scan, options?.allowShrink === true);
			if (!shrinkGuard.allowed) {
				this.syncState = "BLOCKED";
				this.lastError = shrinkGuard.reason ?? "Cloud sync selection is empty";
				this.emitState();
				return { pushed: false, pulled: false, reason: this.lastError };
			}

			const remote = await this.readRemoteIndex();
			// 本地是否有待推送变更：只有用户改选择/配置或解锁后首推才置位，避免每次重启重传。
			const localDirty = this.pendingLocalSync;

			if (!remote.found) {
				if (!localDirty) {
					this.syncState = "IDLE";
					this.emitState();
					return { pushed: false, pulled: false, reason: "Nothing to sync" };
				}
				await this.push(scan, selectedSessions, selectedResources, undefined, undefined);
				return { pushed: true, pulled: false };
			}

			const remoteIndex = await this.decryptRemoteIndex(remote.file);
			const remoteVersion = remote.file.meta.version;
			const remoteAhead = remoteVersion > this.state.localVersion;

			if (remoteAhead && localDirty) {
				const base = this.state.lastSyncedIndex;
				if (!base) {
					// 首次交锋没有 base，无法安全三路合并：
					// 本地未选任何内容 → 直接恢复云端；否则按策略决定，绝不静默丢弃远端。
					if (selectedSessions.length === 0 && selectedResources.length === 0) {
						await this.pull(remoteIndex, scan, remoteVersion);
						return { pushed: false, pulled: true };
					}
					if (this.state.strategy === "preferLocal") {
						await this.push(scan, selectedSessions, selectedResources, remote.revision, remoteVersion);
						return { pushed: true, pulled: false };
					}
					if (this.state.strategy === "preferCloud") {
						await this.pull(remoteIndex, scan, remoteVersion);
						return { pushed: false, pulled: true };
					}
					this.syncState = "CONFLICT";
					this.lastError = "首次同步前本地与云端都有数据，请选择冲突策略后重试";
					this.emitState();
					return { pushed: false, pulled: false, reason: this.lastError };
				}

				const localIndex = await this.buildLocalIndex(scan, selectedSessions, selectedResources);
				const mergeResult = mergeSyncIndexes(base, localIndex, remoteIndex, this.state.strategy);
				if (mergeResult.conflicts.length > 0) {
					this.pendingConflictContext = {
						base,
						local: localIndex,
						remote: remoteIndex,
						conflicts: mergeResult.conflicts,
					};
					this.syncState = "CONFLICT";
					this.lastError = null;
					this.emitState();
					return { pushed: false, pulled: false, reason: "conflicts" };
				}
				await this.applyMerged(scan, mergeResult, remoteIndex, remoteVersion, remote.revision);
				return {
					pushed: mergeResult.transfers.sessionUpload.length > 0 || mergeResult.transfers.resourceUpload.length > 0,
					pulled: mergeResult.transfers.sessionDownload.length > 0 || mergeResult.transfers.resourceDownload.length > 0,
				};
			}

			if (remoteAhead) {
				await this.pull(remoteIndex, scan, remoteVersion);
				return { pushed: false, pulled: true };
			}

			if (localDirty) {
				await this.push(scan, selectedSessions, selectedResources, remote.revision, remoteVersion);
				return { pushed: true, pulled: false };
			}

			this.syncState = "IDLE";
			this.emitState();
			return { pushed: false, pulled: false, reason: "Already up to date" };
		} catch (error) {
			this.syncState = "ERROR";
			this.lastError = error instanceof Error ? error.message : String(error);
			this.emitState();
			throw error;
		}
	}

	/** 按用户对每个冲突的选择重跑合并并落地（选择必须覆盖全部待解冲突）。 */
	async resolveConflicts(resolutions: CloudSyncConflictResolution[]): Promise<{ pushed: boolean; pulled: boolean }> {
		const context = this.pendingConflictContext;
		if (!context) throw new Error("No pending conflicts");
		if (this.adapters.size === 0) throw new Error("Connect a cloud provider first");
		const conflictIds = new Set(context.conflicts.map((conflict) => conflict.id));
		const choices = new Map<string, "local" | "remote">();
		for (const resolution of resolutions) {
			if (!conflictIds.has(resolution.id) || (resolution.choice !== "local" && resolution.choice !== "remote")) {
				throw new TypeError(`Invalid conflict resolution: ${resolution.id}`);
			}
			choices.set(resolution.id, resolution.choice);
		}
		if (choices.size !== conflictIds.size) {
			throw new TypeError("All conflicts must be resolved before continuing");
		}
		const mergeResult = mergeSyncIndexes(context.base, context.local, context.remote, this.state.strategy, choices);
		this.pendingConflictContext = null;
		const scan = await this.scanner.scan(this.getSelectionPreferences(), this.scanOptions());
		const remote = await this.readRemoteIndex();
		const remoteVersion = remote.found ? remote.file.meta.version : this.state.remoteVersion;
		await this.applyMerged(scan, mergeResult, context.remote, remoteVersion, remote.found ? remote.revision : undefined);
		return {
			pushed: mergeResult.transfers.sessionUpload.length > 0 || mergeResult.transfers.resourceUpload.length > 0,
			pulled: mergeResult.transfers.sessionDownload.length > 0 || mergeResult.transfers.resourceDownload.length > 0,
		};
	}

	// ── Internal helpers ─────────────────────────────────────────────

	private providerSnapshots(): Record<CloudProvider, CloudSyncProviderSnapshot> {
		const result = {} as Record<CloudProvider, CloudSyncProviderSnapshot>;
		for (const provider of ["webdav", "s3", "github", "local", "onedrive", "google"] as const) {
			const entry = this.state.providers[provider];
			const adapter = this.adapters.get(provider);
			const status: ProviderConnectionStatus = adapter ? "connected" : "disconnected";
			result[provider] = {
				provider,
				status,
				configured: Boolean(entry?.configured),
				lastSync: this.state.lastSyncAt ?? undefined,
				lastSyncVersion: this.state.remoteVersion || undefined,
				...(this.lastError && this.syncState === "ERROR" ? { error: this.lastError } : {}),
			};
		}
		return result;
	}

	private async evaluateShrinkGuard(scan: CloudSyncScanSnapshot, allowShrink: boolean): Promise<{ allowed: boolean; reason?: string }> {
		const selectedSessions = [...scan.sessions.values()].filter((item) => item.candidate.selected).length;
		const selectedResources = [...scan.resources.values()].filter((item) => item.candidate.selected).length;
		const failedRoots = scan.tree.roots.filter((root) => !root.ok);
		if (failedRoots.length > 0 && !allowShrink) {
			const labels = failedRoots
				.map((root) => root.label)
				.slice(0, 3)
				.join(", ");
			return {
				allowed: false,
				reason: `Cannot sync: scan failed for ${labels}`,
			};
		}
		if (!allowShrink && (this.state.lastSyncedSessionCount > 0 || this.state.lastSyncedResourceCount > 0) && selectedSessions === 0 && selectedResources === 0) {
			return {
				allowed: false,
				reason: "Selection is empty; confirm to clear the cloud copy",
			};
		}
		return { allowed: true };
	}

	private async readRemoteIndex(): Promise<{ found: false } | { found: true; file: SyncedFile; revision?: string }> {
		const provider = this.firstAdapter();
		if (!provider) return { found: false };
		const result = await provider.readObject(CLOUD_SYNC_CONSTANTS.SYNC_INDEX_OBJECT_KEY);
		if (!result.found || !result.bytes) return { found: false };
		const raw = Buffer.from(result.bytes).toString("utf8");
		let file: SyncedFile;
		try {
			file = JSON.parse(raw) as SyncedFile;
		} catch {
			throw new Error("Remote sync index is not valid JSON");
		}
		return { found: true, file, revision: result.revision };
	}

	private async decryptRemoteIndex(file: SyncedFile): Promise<PiDeckSyncIndexV1> {
		return decryptPayload(file, this.requirePassword());
	}

	private async push(scan: CloudSyncScanSnapshot, selectedSessions: CloudSyncInternalSession[], selectedResources: CloudSyncInternalResource[], expectedRevisionArg: string | undefined, remoteVersionArg?: number): Promise<void> {
		const provider = this.firstAdapter();
		if (!provider) throw new Error("No connected provider");

		// Upload session objects first so the index never references a missing object.
		for (const item of selectedSessions) {
			await this.uploadSessionObject(item, provider);
		}
		for (const item of selectedResources) {
			await this.uploadResourceObject(item, provider);
		}

		const index = await this.buildLocalIndex(scan, selectedSessions, selectedResources);
		// M5：按本地声明检查/安装缺失包扩展（失败只记录，不阻断推送）。
		await this.checkAndRestoreExtensions(index);
		// 版本号取 max(local, remote)，防止覆盖远端时把版本计数器回退。
		const existingVersion = Math.max(this.state.localVersion, remoteVersionArg ?? this.state.localVersion);
		const file = await encryptPayload(index, this.requirePassword(), this.state.deviceId, this.state.deviceName, this.options.appVersion, existingVersion);
		const capabilities = await provider.getCapabilities();
		// WebDAV has no conditional writes; only S3-style providers guard with a revision.
		const conditionalRevision = capabilities.conditionalWrites ? expectedRevisionArg : undefined;
		await provider.writeObject(CLOUD_SYNC_CONSTANTS.SYNC_INDEX_OBJECT_KEY, Buffer.from(JSON.stringify(file), "utf8"), {
			expectedRevision: conditionalRevision,
		});
		const nextVersion = existingVersion + 1;
		this.state.localVersion = nextVersion;
		this.state.remoteVersion = nextVersion;
		this.state.lastSyncAt = Date.now();
		this.state.lastSyncDeviceId = this.state.deviceId;
		this.state.lastSyncedSessionCount = selectedSessions.length;
		this.state.lastSyncedResourceCount = selectedResources.length;
		this.state.lastSyncedIndex = index;
		this.pendingLocalSync = false;
		this.pendingConflictContext = null;
		await this.persist();
		this.syncState = "IDLE";
		this.emitState();
	}

	/** 合并结果落地：按传输计划上传/下载对象，写回合并索引为新的 base。 */
	private async applyMerged(scan: CloudSyncScanSnapshot, result: CloudSyncMergeResult, remoteIndex: PiDeckSyncIndexV1, remoteVersion: number, expectedRevisionArg: string | undefined): Promise<void> {
		const provider = this.firstAdapter();
		if (!provider) throw new Error("No connected provider");

		for (const ref of result.transfers.sessionUpload) {
			const local = this.sessionByRef(scan, ref.sessionId);
			if (local) await this.uploadSessionObject(local, provider);
		}
		for (const item of result.transfers.resourceUpload) {
			const local = this.resourceByRef(scan, item.projectId, item.bundle.relativePath);
			if (local) await this.uploadResourceObject(local, provider);
		}
		for (const ref of result.transfers.sessionDownload) {
			await this.downloadSessionRef(ref, provider);
		}
		for (const item of result.transfers.resourceDownload) {
			await this.downloadResourceBundle(item.projectId, item.bundle, provider);
		}

		const file = await encryptPayload(result.merged, this.requirePassword(), this.state.deviceId, this.state.deviceName, this.options.appVersion, remoteVersion);
		const capabilities = await provider.getCapabilities();
		const conditionalRevision = capabilities.conditionalWrites ? expectedRevisionArg : undefined;
		await provider.writeObject(CLOUD_SYNC_CONSTANTS.SYNC_INDEX_OBJECT_KEY, Buffer.from(JSON.stringify(file), "utf8"), {
			expectedRevision: conditionalRevision,
		});

		if (result.settingsAdoptedFromRemote && result.merged.settings) {
			const filtered = filterSyncableDesktopSettings(result.merged.settings);
			if (Object.keys(filtered).length > 0) {
				await this.options.updateDesktopSettings(filtered);
			}
		}

		// M5：按合并后的声明检查/安装缺失包扩展（失败只记录，不阻断同步）。
		await this.checkAndRestoreExtensions(result.merged);
		// M8：pi auth/models 与 ImageGen 配置按分类开关恢复（本地优先，缺失取远端）。
		await this.restoreSensitiveContent(result.merged, remoteIndex);

		this.state.localVersion = remoteVersion + 1;
		this.state.remoteVersion = remoteVersion + 1;
		this.state.lastSyncAt = Date.now();
		this.state.lastSyncDeviceId = this.state.deviceId;
		this.state.lastSyncedIndex = result.merged;
		this.state.lastSyncedSessionCount = result.merged.projects?.reduce((sum, project) => sum + (project.sessions?.length ?? 0), 0) ?? 0;
		this.state.lastSyncedResourceCount = result.merged.projects?.reduce((sum, project) => sum + (project.resources ? Object.keys(project.resources).length : 0), 0) ?? 0;
		this.pendingLocalSync = false;
		this.pendingConflictContext = null;
		await this.persist();
		this.syncState = "IDLE";
		this.emitState();
	}

	/**
	 * M5：按声明检查包扩展。缺失的尝试自动安装；失败记入 missingExtensions
	 * （启动保护由 enabledExtensionResolver 白名单兜底，缺失扩展不阻断 pi 启动）。
	 */
	private async checkAndRestoreExtensions(index: PiDeckSyncIndexV1): Promise<void> {
		if (!this.options.installExtension || !this.options.listExtensions) {
			// 未注入安装能力（如测试环境）：清空缺失清单，不产生虚假告警。
			this.state.missingExtensions = [];
			await this.persist();
			this.emitState();
			return;
		}
		const declared = this.collectDeclaredExtensions(index);
		if (declared.length === 0) {
			this.state.missingExtensions = [];
			await this.persist();
			this.emitState();
			return;
		}
		let installed: Array<{ source: string; scope?: string }> = [];
		try {
			installed = await this.options.listExtensions();
		} catch {
			// 列表失败时无法判断缺失，保守不自动安装。
		}
		const installedSources = new Set(installed.map((item) => item.source));
		const missing: CloudSyncMissingExtension[] = [];
		for (const source of declared) {
			if (installedSources.has(source.source)) continue;
			try {
				const result = await this.options.installExtension(source.source, source.scope);
				if (!result.ok) missing.push({ source: source.source, scope: source.scope, error: result.error });
			} catch (error) {
				missing.push({ source: source.source, scope: source.scope, error: error instanceof Error ? error.message : String(error) });
			}
		}
		this.state.missingExtensions = missing;
		await this.persist();
		this.emitState();
	}

	/** 手动重试缺失扩展安装（设置页「重试安装」）。 */
	async retryMissingExtensions(): Promise<CloudSyncMissingExtension[]> {
		const index = this.state.lastSyncedIndex;
		if (!index) return this.state.missingExtensions;
		const declared = this.collectDeclaredExtensions(index);
		if (declared.length === 0 || !this.options.installExtension) {
			this.state.missingExtensions = [];
			await this.persist();
			this.emitState();
			return [];
		}
		const missing: CloudSyncMissingExtension[] = [];
		for (const source of declared) {
			try {
				const result = await this.options.installExtension(source.source, source.scope);
				if (!result.ok) missing.push({ source: source.source, scope: source.scope, error: result.error });
			} catch (error) {
				missing.push({ source: source.source, scope: source.scope, error: error instanceof Error ? error.message : String(error) });
			}
		}
		this.state.missingExtensions = missing;
		await this.persist();
		this.emitState();
		return missing;
	}

	private collectDeclaredExtensions(index: PiDeckSyncIndexV1): Array<{ source: string; scope: "user" | "project" }> {
		const result: Array<{ source: string; scope: "user" | "project" }> = [];
		const seen = new Set<string>();
		for (const project of index.projects ?? []) {
			const sources = project.resources?.extensionSources ?? [];
			for (const source of sources) {
				const key = `${source.scope}:${source.source}`;
				if (seen.has(key)) continue;
				seen.add(key);
				result.push({ source: source.source, scope: source.scope });
			}
		}
		return result;
	}

	private sessionByRef(scan: CloudSyncScanSnapshot, sessionId: string): CloudSyncInternalSession | null {
		for (const item of scan.sessions.values()) {
			if (item.candidate.sessionId === sessionId) return item;
		}
		return null;
	}

	private resourceByRef(scan: CloudSyncScanSnapshot, projectId: string, relativePath: string): CloudSyncInternalResource | null {
		for (const item of scan.resources.values()) {
			if (item.candidate.projectId === projectId && item.candidate.relativePath === relativePath) return item;
		}
		return null;
	}

	// 对象传输：上传/下载、加解密信封、落位路径（实现见 manager/sessionObjectTransfer.ts）。

	private async uploadSessionObject(item: CloudSyncInternalSession, provider: PiDeckCloudObjectStorage): Promise<void> {
		return this.transfer.uploadSessionObject(item, provider);
	}

	private async uploadResourceObject(item: CloudSyncInternalResource, provider: PiDeckCloudObjectStorage): Promise<void> {
		return this.transfer.uploadResourceObject(item, provider);
	}

	private async encryptObject(content: string): Promise<SyncedFile> {
		return this.transfer.encryptObject(content);
	}

	private async decryptObject(bytes: Uint8Array): Promise<string> {
		return this.transfer.decryptObject(bytes);
	}

	/** 本地索引构建（实现见 manager/localIndexBuilder.ts）。 */
	private async buildLocalIndex(scan: CloudSyncScanSnapshot, selectedSessions: CloudSyncInternalSession[], selectedResources: CloudSyncInternalResource[]): Promise<PiDeckSyncIndexV1> {
		return this.indexBuilder.build(scan, selectedSessions, selectedResources);
	}

	/** M8：按分类开关恢复 pi auth/models 与 ImageGen 配置（实现见 manager/localIndexBuilder.ts）。 */
	private async restoreSensitiveContent(merged: PiDeckSyncIndexV1, remote: PiDeckSyncIndexV1): Promise<void> {
		return this.indexBuilder.restoreSensitiveContent(merged, remote);
	}

	private async pull(remoteIndex: PiDeckSyncIndexV1, scan: CloudSyncScanSnapshot, remoteVersion: number): Promise<void> {
		const provider = this.firstAdapter();
		if (!provider) throw new Error("No connected provider");

		// Restore session objects referenced by the remote index.
		for (const project of remoteIndex.projects ?? []) {
			for (const sessionRef of project.sessions ?? []) {
				await this.downloadSessionRef(sessionRef, provider);
			}
		}

		// Restore resource bundles.
		for (const project of remoteIndex.projects ?? []) {
			const resources = project.resources;
			if (!resources) continue;
			for (const bundle of [...(resources.prompts ?? []), ...(resources.skills ?? []), ...(resources.localExtensions ?? []), ...(resources.config ?? [])]) {
				await this.downloadResourceBundle(project.projectId, bundle, provider);
			}
			if (resources.piSettings) {
				const scopeRoot = project.projectId === GLOBAL_SYNC_PROJECT_ID ? join(this.options.homeDir, ".pi", "agent") : this.options.listProjects().find((candidate) => candidate.id === project.projectId)?.path;
				if (scopeRoot) {
					const target = project.projectId === GLOBAL_SYNC_PROJECT_ID ? join(scopeRoot, "settings.json") : join(scopeRoot, ".pi", "settings.json");
					await mkdir(dirname(target), { recursive: true });
					await ensureNoSymlinkEscape(scopeRoot, target);
					await writeFileAtomic(target, JSON.stringify(resources.piSettings, null, 2));
				}
			}
		}

		// Desktop settings are the only content applied automatically; other
		// domains (projects/catalog/credentials) land in M5 with confirmation.
		if (remoteIndex.settings) {
			const filtered = filterSyncableDesktopSettings(remoteIndex.settings);
			if (Object.keys(filtered).length > 0) {
				await this.options.updateDesktopSettings(filtered);
			}
		}

		// M5：按恢复后的声明检查/安装缺失包扩展。
		await this.checkAndRestoreExtensions(remoteIndex);
		// M8：pi auth/models 与 ImageGen 配置按分类开关恢复。
		await this.restoreSensitiveContent(remoteIndex, remoteIndex);

		this.state.remoteVersion = remoteVersion;
		this.state.localVersion = remoteVersion;
		this.state.lastSyncAt = Date.now();
		this.state.lastSyncDeviceId = remoteIndex.meta.deviceId;
		this.state.lastSyncedSessionCount = (remoteIndex.projects ?? []).reduce((sum, project) => sum + (project.sessions?.length ?? 0), 0);
		this.state.lastSyncedResourceCount = (remoteIndex.projects ?? []).reduce((sum, project) => sum + (project.resources ? Object.keys(project.resources).length : 0), 0);
		this.state.lastSyncedIndex = remoteIndex;
		this.pendingLocalSync = false;
		this.pendingConflictContext = null;
		await this.persist();
		this.syncState = "IDLE";
		this.emitState();
	}

	/** 会话对象下载（实现见 manager/sessionObjectTransfer.ts）。 */
	private async downloadSessionRef(sessionRef: import("../../shared/types/cloudSync.ts").CloudSyncSessionRef, provider: PiDeckCloudObjectStorage): Promise<void> {
		return this.transfer.downloadSessionRef(sessionRef, provider);
	}

	private async downloadResourceBundle(projectId: string, bundle: import("../../shared/types/cloudSync.ts").CloudSyncFileBundle, provider: PiDeckCloudObjectStorage): Promise<void> {
		return this.transfer.downloadResourceBundle(projectId, bundle, provider);
	}

	private resolveResourceTarget(projectId: string, relativePath: string): { root: string; relative: string } | null {
		return this.transfer.resolveResourceTarget(projectId, relativePath);
	}

	private async resolveSessionTarget(sessionRef: import("../../shared/types/cloudSync.ts").CloudSyncSessionRef): Promise<string | null> {
		return this.transfer.resolveSessionTarget(sessionRef);
	}

	private sessionTargetRoot(sessionRef: import("../../shared/types/cloudSync.ts").CloudSyncSessionRef): string | null {
		return this.transfer.sessionTargetRoot(sessionRef);
	}

	private async readExistingHash(filePath: string): Promise<string | null> {
		return this.transfer.readExistingHash(filePath);
	}

	// ── Local one-click import/export（离线备份，无需任何云服务） ──────────
	// 实现：manager/backupTransfer.ts（宿主只保留公开方法转发与状态推进）。

	async exportBackup(options?: { outputPath?: string }): Promise<CloudSyncExportResult> {
		return this.backupTransfer.exportBackup(options);
	}

	async importBackup(input: CloudSyncImportInput): Promise<CloudSyncImportResult> {
		return this.backupTransfer.importBackup(input);
	}

	/** 按当前选择偏好与排除规则扫描一次（与云端同步同一入口）。 */
	private scanSelectionSnapshot(): Promise<CloudSyncScanSnapshot> {
		return this.scanner.scan(this.getSelectionPreferences(), this.scanOptions());
	}

	/** 备份导入落地后的状态推进（与云端 pull 同语义）：base/计数/时间/设备 + 持久化 + 广播。 */
	private async commitImportedIndex(index: PiDeckSyncIndexV1, counts: { sessions: number; resources: number; deviceId: string }): Promise<CloudSyncMissingExtension[]> {
		this.state.lastSyncedIndex = index;
		this.state.lastSyncedSessionCount = counts.sessions;
		this.state.lastSyncedResourceCount = counts.resources;
		this.state.lastSyncAt = Date.now();
		this.state.lastSyncDeviceId = counts.deviceId;
		this.pendingLocalSync = false;
		await this.persist();
		this.emitState();
		return [...this.state.missingExtensions];
	}

	// ── Provider / adapter internals ─────────────────────────────────

	private firstAdapter(): PiDeckCloudObjectStorage | null {
		return this.adapters.values().next().value ?? null;
	}

	private normalizeProviderInput(input: CloudSyncProviderConfigInput): WebDAVConfig | S3Config | GithubGistConfig | LocalFolderConfig | OneDriveConfig | GoogleDriveConfig {
		if (input.provider === "webdav") return normalizeWebDAVConfig(input.config);
		if (input.provider === "s3") return normalizeS3Config(input.config);
		if (input.provider === "github") return normalizeGithubGistConfig(input.config);
		if (input.provider === "local") return normalizeLocalFolderConfig(input.config);
		if (input.provider === "onedrive") return normalizeOneDriveConfig(input.config);
		if (input.provider === "google") return normalizeGoogleDriveConfig(input.config);
		throw new TypeError(`Unsupported cloud provider: ${String((input as { provider?: unknown }).provider)}`);
	}

	private async sealConfig(config: WebDAVConfig | S3Config | GithubGistConfig | LocalFolderConfig | OneDriveConfig | GoogleDriveConfig, password: string, masterConfig: CloudSyncMasterKeyConfig): Promise<string> {
		const salt = Buffer.from(masterConfig.salt, "base64");
		const key = await deriveKey(password, salt, masterConfig.kdfIterations);
		const encrypted = encrypt(JSON.stringify(config), key, salt);
		return JSON.stringify({
			v: 1,
			iv: encodeBase64(encrypted.iv),
			ct: encodeBase64(encrypted.ciphertext),
		});
	}

	private async unsealProviders(): Promise<void> {
		this.providerConfigs.clear();
		const password = this.requirePassword();
		const masterConfig = this.state.masterKeyConfig;
		if (!masterConfig) return;
		const salt = Buffer.from(masterConfig.salt, "base64");
		const key = await deriveKey(password, salt, masterConfig.kdfIterations);
		for (const [provider, entry] of Object.entries(this.state.providers)) {
			if (!entry) continue;
			try {
				const sealed = JSON.parse(entry.sealed) as { v: number; iv: string; ct: string };
				const plaintext = decrypt(
					{
						ciphertext: decodeBase64(sealed.ct),
						iv: decodeBase64(sealed.iv),
						salt,
						kdf: "PBKDF2",
						kdfIterations: masterConfig.kdfIterations,
					},
					key,
				);
				this.providerConfigs.set(provider as CloudProvider, JSON.parse(plaintext) as WebDAVConfig | S3Config | GithubGistConfig | LocalFolderConfig | OneDriveConfig | GoogleDriveConfig);
			} catch {
				// A corrupt sealed entry is dropped; the user can reconfigure the provider.
				this.state.providers[provider] = null;
			}
		}
	}

	private async disconnectAllAdapters(): Promise<void> {
		for (const adapter of this.adapters.values()) {
			await adapter.disconnect().catch(() => undefined);
		}
		this.adapters.clear();
	}

	private requirePassword(): string {
		if (!this.password) throw new Error("Cloud sync is locked");
		return this.password;
	}

	private sanitizeIdList(values: string[]): string[] {
		if (!Array.isArray(values)) return [];
		const seen = new Set<string>();
		const result: string[] = [];
		for (const value of values) {
			if (typeof value !== "string" || !isSafeSelectionId(value) || value.length > 512) continue;
			if (seen.has(value)) continue;
			seen.add(value);
			result.push(value);
		}
		return result.slice(0, 20_000);
	}

	private ensureDeviceName(): void {
		if (!this.state.deviceName) this.state.deviceName = this.options.deviceName;
	}

	// ── Persistence ──────────────────────────────────────────────────

	private async loadState(): Promise<void> {
		try {
			const raw = await readFile(this.stateFile, "utf8");
			const parsed = JSON.parse(raw) as Partial<CloudSyncPersistedState>;
			this.state = {
				...createDefaultState(),
				...parsed,
				selection: {
					...createDefaultState().selection,
					...(parsed.selection ?? {}),
					content: {
						...DEFAULT_CONTENT_PREFERENCES(),
						...(parsed.selection?.content ?? {}),
					},
				},
				autoSync: {
					...createDefaultState().autoSync,
					...(parsed.autoSync ?? {}),
				},
			};
			if (parsed.masterKeyConfig !== undefined && !isCloudSyncMasterKeyConfig(parsed.masterKeyConfig)) {
				this.state.masterKeyConfig = null;
				this.state.providers = {};
			}
			if (!Array.isArray(this.state.exclusions)) this.state.exclusions = [];
			if (!Array.isArray(this.state.customPaths)) this.state.customPaths = [];
		} catch (error) {
			if (isMissingError(error)) {
				this.state = createDefaultState();
			} else {
				this.state = createDefaultState();
				this.options.log?.("cloud-sync", "Cloud sync state file is corrupt; reset to defaults", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	private async persist(): Promise<void> {
		const serialized = JSON.stringify(this.state, null, 2);
		const write = this.statePersistQueue.then(() => writeFileAtomic(this.stateFile, serialized));
		this.statePersistQueue = write.catch(() => undefined);
		await write;
	}

	private emitState(): void {
		if (this.disposed) return;
		this.options.onStateChanged?.(this.getStateSnapshot());
	}

	private configureAutoSyncTimer(): void {
		if (this.autoSyncTimer) {
			clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = null;
		}
		if (!this.state.autoSync.enabled) return;
		const intervalMs = Math.max(60_000, this.state.autoSync.intervalMinutes * 60_000);
		this.autoSyncTimer = setInterval(() => {
			if (this.securityState() !== "UNLOCKED" || this.adapters.size === 0) return;
			void this.syncNow().catch((error: unknown) => {
				this.options.log?.("cloud-sync", "Auto sync failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, intervalMs);
		this.autoSyncTimer.unref?.();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.tokenPersistQueue;
		await this.statePersistQueue;
		if (this.autoSyncTimer) {
			clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = null;
		}
		this.providerOAuth.dispose();
		await this.disconnectAllAdapters();
		this.password = null;
		this.providerConfigs.clear();
	}
}
