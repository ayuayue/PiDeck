import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
	AppSettings,
	Project,
	SessionRecord,
} from "../../shared/types.ts";
import type {
	CloudProvider,
	CloudSyncConflict,
	CloudSyncConflictResolution,
	CloudSyncMasterKeyConfig,
	CloudSyncProviderConfigInput,
	CloudSyncProviderSnapshot,
	CloudSyncSelectionPreferences,
	CloudSyncSelectionTree,
	CloudSyncSelectionUpdate,
	CloudSyncState,
	CloudSyncStateSnapshot,
	CloudSyncStrategy,
	PiDeckSyncIndexV1,
	ProviderAccount,
	ProviderConnectionStatus,
	SyncedFile,
	WebDAVConfig,
	S3Config,
} from "../../shared/types/cloudSync.ts";
import { CLOUD_SYNC_CONSTANTS } from "../../shared/types/cloudSync.ts";
import {
	createMasterKeyConfig,
	changeMasterPassword,
	decrypt,
	decryptPayload,
	deriveKey,
	encrypt,
	encryptPayload,
	generateRandomBytes,
	isCloudSyncMasterKeyConfig,
	unlockMasterKey,
	verifyPassword,
} from "./EncryptionService.ts";
import {
	CloudSyncScanner,
	CLOUD_SYNC_SCANNER_LIMITS,
	type CloudSyncInternalResource,
	type CloudSyncInternalSession,
	type CloudSyncScanSnapshot,
} from "./CloudSyncScanner.ts";
import type { PiDeckCloudObjectStorage } from "./objectStorage.ts";
import { createCloudSyncObjectStorage } from "./adapters/index.ts";
import { normalizeS3Config, normalizeWebDAVConfig } from "./providerConfig.ts";
import {
	buildCatalogSyncEntry,
	buildCloudSyncProject,
	buildGlobalCloudSyncProject,
	buildPiDeckSyncIndex,
	createSessionRef,
	createTextFileBundle,
	filterSyncableDesktopSettings,
	GLOBAL_SYNC_PROJECT_ID,
	resolveGlobalSessionPath,
	resolveProjectSessionPath,
	sessionObjectKey,
	toPortableRelativePath,
	type CloudSyncProjectOptions,
} from "./payload.ts";
import {
	mergeSyncIndexes,
	type CloudSyncMergeResult,
} from "./merge.ts";

type PersistedProviderEntry =
	| { configured: true; sealed: string }
	| null;

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
		lastSyncedSessionCount: 0,
		lastSyncedResourceCount: 0,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingError(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "code" in error &&
		(error as { code?: unknown }).code === "ENOENT",
	);
}

function isPermissionError(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "code" in error &&
		((error as { code?: unknown }).code === "EACCES" || (error as { code?: unknown }).code === "EPERM"),
	);
}

function encodeBase64(value: Uint8Array): string {
	return Buffer.from(value).toString("base64");
}

function decodeBase64(value: string): Buffer {
	if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
		throw new TypeError("Provider sealed payload is not valid base64");
	}
	return Buffer.from(value, "base64");
}

function isSafeSelectionId(value: string): boolean {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 512 &&
		(value.startsWith("session:") || value.startsWith("resource:"))
	);
}

/** Stream a file into a SHA-256 hex digest without loading it into memory. */
async function hashFile(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(filePath);
		stream.on("data", (chunk) => hash.update(chunk as Buffer));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

async function readTextBounded(filePath: string, maxBytes: number): Promise<string> {
	const buffer = await readFile(filePath);
	if (buffer.byteLength > maxBytes) {
		throw new RangeError(`File exceeds ${maxBytes} byte limit`);
	}
	return buffer.toString("utf8");
}

/**
 * Walk the path chain from the target up to the sync root and reject any
 * intermediate symlink. This blocks a remote relative path from being routed
 * through an attacker-placed junction inside the sync directory.
 */
async function ensureNoSymlinkEscape(rootPath: string, targetPath: string): Promise<void> {
	const root = resolve(rootPath);
	const target = resolve(targetPath);
	if (target === root) return;
	let current = target;
	while (current !== root) {
		const parent = dirname(current);
		if (parent === current) break;
		const info = await lstat(parent).catch(() => null);
		if (info && info.isSymbolicLink()) {
			throw new Error(`Cloud sync refuses to write through symlink: ${parent}`);
		}
		current = parent;
	}
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const temporary = `${filePath}.tmp-${randomUUID()}`;
	await writeFile(temporary, content, "utf8");
	await rename(temporary, filePath);
}

export interface CloudSyncManagerOptions {
	userDataDir: string;
	homeDir: string;
	deviceName: string;
	appVersion: string;
	listProjects: () => Project[];
	listSessionRecords: () => SessionRecord[];
	getDesktopSettings: () => AppSettings;
	updateDesktopSettings: (patch: Record<string, unknown>) => Promise<void>;
	/** 测试注入点：默认走 createCloudSyncObjectStorage（真实 WebDAV/S3）。 */
	createAdapter?: (provider: CloudProvider, config: WebDAVConfig | S3Config) => PiDeckCloudObjectStorage;
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
	private readonly stateFile: string;
	private readonly scanner: CloudSyncScanner;
	private state: CloudSyncPersistedState = createDefaultState();
	private password: string | null = null;
	/** Unsealed provider configs, available only while unlocked. */
	private providerConfigs = new Map<CloudProvider, WebDAVConfig | S3Config>();
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
	private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
	private disposed = false;

	constructor(options: CloudSyncManagerOptions) {
		this.options = options;
		this.stateFile = join(options.userDataDir, "cloud-sync-state.json");
		this.scanner = new CloudSyncScanner({
			homeDir: options.homeDir,
			listProjects: options.listProjects,
			listSessionRecords: options.listSessionRecords,
		});
	}

	async initialize(): Promise<void> {
		await this.loadState();
		if (this.state.masterKeyConfig) {
			this.ensureDeviceName();
			await this.persist();
		}
		this.syncState = "IDLE";
		this.emitState();
		this.configureAutoSyncTimer();
	}

	getStateSnapshot(): CloudSyncStateSnapshot {
		const providers = Object.fromEntries(
			Object.keys(this.providerSnapshots()).map((provider) => [provider, this.providerSnapshots()[provider as CloudProvider]]),
		) as Record<CloudProvider, CloudSyncProviderSnapshot>;
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
		const result = await adapter.connect();
		this.adapters.set(provider, adapter);
		this.emitState();
		return result.account;
	}

	async disconnectProviderConnection(provider: CloudProvider): Promise<void> {
		const adapter = this.adapters.get(provider);
		if (!adapter) return;
		await adapter.disconnect().catch(() => undefined);
		this.adapters.delete(provider);
		this.emitState();
	}

	// ── Selection & scanning ─────────────────────────────────────────

	async scanSelection(): Promise<CloudSyncSelectionTree> {
		const snapshot = await this.scanner.scan(this.getSelectionPreferences());
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
			const scan = await this.scanner.scan(this.getSelectionPreferences());
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
				await this.applyMerged(scan, mergeResult, remoteVersion, remote.revision);
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
		const mergeResult = mergeSyncIndexes(
			context.base,
			context.local,
			context.remote,
			this.state.strategy,
			choices,
		);
		this.pendingConflictContext = null;
		const scan = await this.scanner.scan(this.getSelectionPreferences());
		const remote = await this.readRemoteIndex();
		const remoteVersion = remote.found ? remote.file.meta.version : this.state.remoteVersion;
		await this.applyMerged(scan, mergeResult, remoteVersion, remote.found ? remote.revision : undefined);
		return {
			pushed: mergeResult.transfers.sessionUpload.length > 0 || mergeResult.transfers.resourceUpload.length > 0,
			pulled: mergeResult.transfers.sessionDownload.length > 0 || mergeResult.transfers.resourceDownload.length > 0,
		};
	}

	// ── Internal helpers ─────────────────────────────────────────────

	private providerSnapshots(): Record<CloudProvider, CloudSyncProviderSnapshot> {
		const result = {} as Record<CloudProvider, CloudSyncProviderSnapshot>;
		for (const provider of ["webdav", "s3"] as const) {
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

	private async evaluateShrinkGuard(
		scan: CloudSyncScanSnapshot,
		allowShrink: boolean,
	): Promise<{ allowed: boolean; reason?: string }> {
		const selectedSessions = [...scan.sessions.values()].filter((item) => item.candidate.selected).length;
		const selectedResources = [...scan.resources.values()].filter((item) => item.candidate.selected).length;
		const failedRoots = scan.tree.roots.filter((root) => !root.ok);
		if (failedRoots.length > 0 && !allowShrink) {
			const labels = failedRoots.map((root) => root.label).slice(0, 3).join(", ");
			return {
				allowed: false,
				reason: `Cannot sync: scan failed for ${labels}`,
			};
		}
		if (
			!allowShrink &&
			(this.state.lastSyncedSessionCount > 0 || this.state.lastSyncedResourceCount > 0) &&
			selectedSessions === 0 &&
			selectedResources === 0
		) {
			return {
				allowed: false,
				reason: "Selection is empty; confirm to clear the cloud copy",
			};
		}
		return { allowed: true };
	}

	private async readRemoteIndex(): Promise<
		{ found: false } | { found: true; file: SyncedFile; revision?: string }
	> {
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

	private async push(
		scan: CloudSyncScanSnapshot,
		selectedSessions: CloudSyncInternalSession[],
		selectedResources: CloudSyncInternalResource[],
		expectedRevisionArg: string | undefined,
		remoteVersionArg?: number,
	): Promise<void> {
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
		// 版本号取 max(local, remote)，防止覆盖远端时把版本计数器回退。
		const existingVersion = Math.max(this.state.localVersion, remoteVersionArg ?? this.state.localVersion);
		const file = await encryptPayload(
			index,
			this.requirePassword(),
			this.state.deviceId,
			this.state.deviceName,
			this.options.appVersion,
			existingVersion,
		);
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
	private async applyMerged(
		scan: CloudSyncScanSnapshot,
		result: CloudSyncMergeResult,
		remoteVersion: number,
		expectedRevisionArg: string | undefined,
	): Promise<void> {
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

		const file = await encryptPayload(
			result.merged,
			this.requirePassword(),
			this.state.deviceId,
			this.state.deviceName,
			this.options.appVersion,
			remoteVersion,
		);
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

		this.state.localVersion = remoteVersion + 1;
		this.state.remoteVersion = remoteVersion + 1;
		this.state.lastSyncAt = Date.now();
		this.state.lastSyncDeviceId = this.state.deviceId;
		this.state.lastSyncedIndex = result.merged;
		this.state.lastSyncedSessionCount = result.merged.projects?.reduce((sum, project) => sum + (project.sessions?.length ?? 0), 0) ?? 0;
		this.state.lastSyncedResourceCount = result.merged.projects?.reduce(
			(sum, project) => sum + (project.resources ? Object.keys(project.resources).length : 0),
			0,
		) ?? 0;
		this.pendingLocalSync = false;
		this.pendingConflictContext = null;
		await this.persist();
		this.syncState = "IDLE";
		this.emitState();
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

	private async uploadSessionObject(item: CloudSyncInternalSession, provider: PiDeckCloudObjectStorage): Promise<void> {
		const content = await readTextBounded(item.filePath, CLOUD_SYNC_SCANNER_LIMITS.maxSessionBytes);
		const key = sessionObjectKey(item.candidate.sessionId);
		const file = await this.encryptObject(content);
		await provider.writeObject(key, Buffer.from(JSON.stringify(file), "utf8"));
	}

	private async uploadResourceObject(item: CloudSyncInternalResource, provider: PiDeckCloudObjectStorage): Promise<void> {
		const content = await readTextBounded(item.filePath, CLOUD_SYNC_SCANNER_LIMITS.maxResourceBytes);
		const hash = createHash("sha256").update(content, "utf8").digest("hex");
		const key = `pideck-files/${hash}.enc`;
		const file = await this.encryptObject(content);
		await provider.writeObject(key, Buffer.from(JSON.stringify(file), "utf8"));
	}

	private async encryptObject(content: string): Promise<SyncedFile> {
		const salt = generateRandomBytes(CLOUD_SYNC_CONSTANTS.SALT_LENGTH);
		const key = await deriveKey(this.requirePassword(), salt, CLOUD_SYNC_CONSTANTS.PBKDF2_ITERATIONS);
		const encrypted = encrypt(content, key, salt);
		return {
			meta: {
				version: 1,
				updatedAt: Date.now(),
				deviceId: this.state.deviceId,
				deviceName: this.state.deviceName,
				appVersion: this.options.appVersion,
				iv: encodeBase64(encrypted.iv),
				salt: encodeBase64(encrypted.salt),
				algorithm: "AES-256-GCM",
				kdf: "PBKDF2",
				kdfIterations: encrypted.kdfIterations,
			},
			payload: encodeBase64(encrypted.ciphertext),
		};
	}

	private async decryptObject(bytes: Uint8Array): Promise<string> {
		const raw = Buffer.from(bytes).toString("utf8");
		const file = JSON.parse(raw) as SyncedFile;
		const { meta } = file;
		if (meta.algorithm !== "AES-256-GCM" || meta.kdf !== "PBKDF2") throw new TypeError("Unsupported object format");
		const iv = decodeBase64(meta.iv);
		const salt = decodeBase64(meta.salt);
		const key = await deriveKey(this.requirePassword(), salt, meta.kdfIterations ?? CLOUD_SYNC_CONSTANTS.PBKDF2_ITERATIONS);
		return decrypt(
			{ ciphertext: decodeBase64(file.payload), iv, salt, kdf: "PBKDF2", kdfIterations: meta.kdfIterations ?? CLOUD_SYNC_CONSTANTS.PBKDF2_ITERATIONS },
			key,
		);
	}

	private async buildLocalIndex(
		scan: CloudSyncScanSnapshot,
		selectedSessions: CloudSyncInternalSession[],
		selectedResources: CloudSyncInternalResource[],
	): Promise<PiDeckSyncIndexV1> {
		const settings = this.options.getDesktopSettings();
		const content = this.state.selection.content;
		const sessionsByProject = new Map<string, CloudSyncInternalSession[]>();
		for (const item of selectedSessions) {
			const group = item.candidate.scope === "project" ? item.candidate.projectId : GLOBAL_SYNC_PROJECT_ID;
			const list = sessionsByProject.get(group) ?? [];
			list.push(item);
			sessionsByProject.set(group, list);
		}
		const resourcesByProject = new Map<string, CloudSyncInternalResource[]>();
		for (const item of selectedResources) {
			const list = resourcesByProject.get(item.candidate.projectId) ?? [];
			list.push(item);
			resourcesByProject.set(item.candidate.projectId, list);
		}

		const projects: PiDeckSyncIndexV1["projects"] = [];
		const projectRecords = scan.recordsBySessionId;
		for (const project of this.options.listProjects()) {
			const sessions = sessionsByProject.get(project.id) ?? [];
			const resources = resourcesByProject.get(project.id) ?? [];
			const options: CloudSyncProjectOptions = {};
			const resourceBundles = await this.buildResourceBundles(resources);
			if (Object.keys(resourceBundles).length > 0 || content.prompts || content.skills || content.extensions) {
				options.resources = resourceBundles;
			}
			if (sessions.length > 0) {
				options.sessions = await Promise.all(sessions.map((item) => this.buildSessionRef(item)));
				if (content.catalog) {
					options.catalogEntries = sessions
						.map((item) => scan.recordsBySessionId.get(item.candidate.sessionId))
						.filter((record): record is SessionRecord => Boolean(record))
						.map((record) => buildCatalogSyncEntry(record, this.relativePathOf(record, project.id)));
				}
			}
			projects.push(buildCloudSyncProject(project, options));
		}
		// Global root: resources (global prompts/skills/extensions) + global sessions.
		const globalSessions = sessionsByProject.get(GLOBAL_SYNC_PROJECT_ID) ?? [];
		const globalResources = resourcesByProject.get(GLOBAL_SYNC_PROJECT_ID) ?? [];
		const globalOptions: CloudSyncProjectOptions = {};
		const globalBundles = await this.buildResourceBundles(globalResources);
		if (Object.keys(globalBundles).length > 0) globalOptions.resources = globalBundles;
		if (globalSessions.length > 0) {
			globalOptions.sessions = await Promise.all(globalSessions.map((item) => this.buildSessionRef(item)));
			if (content.catalog) {
				globalOptions.catalogEntries = globalSessions
					.map((item) => scan.recordsBySessionId.get(item.candidate.sessionId))
					.filter((record): record is SessionRecord => Boolean(record))
					.map((record) => buildCatalogSyncEntry(record, this.relativePathOf(record, GLOBAL_SYNC_PROJECT_ID)));
			}
		}
		projects.unshift(buildGlobalCloudSyncProject(globalOptions));

		return buildPiDeckSyncIndex({
			deviceId: this.state.deviceId,
			deviceName: this.state.deviceName,
			appVersion: this.options.appVersion,
			syncedAt: Date.now(),
			...(content.desktopSettings ? { settings } : {}),
			projects,
		});
	}

	private async buildSessionRef(item: CloudSyncInternalSession): Promise<import("../../shared/types/cloudSync.ts").CloudSyncSessionRef> {
		const contentHash = await hashFile(item.filePath);
		return createSessionRef({
			sessionId: item.candidate.sessionId,
			scope: item.candidate.scope,
			...(item.candidate.projectId && item.candidate.scope === "project" ? { projectId: item.candidate.projectId } : {}),
			filePath: item.filePath,
			rootPath: item.rootPath,
			size: item.candidate.size,
			mtimeMs: item.candidate.mtimeMs,
			contentHash,
		});
	}

	private async buildResourceBundles(
		resources: CloudSyncInternalResource[],
	): Promise<NonNullable<import("../../shared/types/cloudSync.ts").CloudSyncProject["resources"]>> {
		const result: NonNullable<import("../../shared/types/cloudSync.ts").CloudSyncProject["resources"]> = {};
		const byCategory = new Map<string, CloudSyncInternalResource[]>();
		for (const item of resources) {
			const list = byCategory.get(item.candidate.category) ?? [];
			list.push(item);
			byCategory.set(item.candidate.category, list);
		}
		const settingsItems = byCategory.get("settings") ?? [];
		if (settingsItems.length > 0) {
			const content = await readTextBounded(settingsItems[0].filePath, CLOUD_SYNC_SCANNER_LIMITS.maxResourceBytes);
			try {
				result.piSettings = JSON.parse(content) as Record<string, unknown>;
			} catch {
				// A broken local settings.json is skipped rather than crashing the sync.
			}
		}
		for (const [category, items] of byCategory) {
			if (category === "settings") continue;
			const bundles = [];
			for (const item of items) {
				const content = await readTextBounded(item.filePath, CLOUD_SYNC_SCANNER_LIMITS.maxResourceBytes);
				bundles.push(createTextFileBundle(item.candidate.relativePath, content));
			}
			if (category === "prompts") result.prompts = bundles;
			else if (category === "skills") result.skills = bundles;
			else if (category === "extensions") result.localExtensions = bundles;
		}
		return result;
	}

	private relativePathOf(record: SessionRecord, projectId: string): string | undefined {
		if (!record.filePath) return undefined;
		try {
			if (projectId === GLOBAL_SYNC_PROJECT_ID) {
				return toPortableRelativePath(join(this.options.homeDir, ".pi", "agent", "sessions"), record.filePath);
			}
			const project = this.options.listProjects().find((candidate) => candidate.id === projectId);
			if (!project) return undefined;
			return toPortableRelativePath(join(project.path, ".pi", "sessions"), record.filePath);
		} catch {
			return undefined;
		}
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
			for (const bundle of [...(resources.prompts ?? []), ...(resources.skills ?? []), ...(resources.localExtensions ?? [])]) {
				await this.downloadResourceBundle(project.projectId, bundle, provider);
			}
			if (resources.piSettings) {
				const scopeRoot = project.projectId === GLOBAL_SYNC_PROJECT_ID
					? join(this.options.homeDir, ".pi", "agent")
					: this.options.listProjects().find((candidate) => candidate.id === project.projectId)?.path;
				if (scopeRoot) {
					const target = project.projectId === GLOBAL_SYNC_PROJECT_ID
						? join(scopeRoot, "settings.json")
						: join(scopeRoot, ".pi", "settings.json");
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

		this.state.remoteVersion = remoteVersion;
		this.state.localVersion = remoteVersion;
		this.state.lastSyncAt = Date.now();
		this.state.lastSyncDeviceId = remoteIndex.meta.deviceId;
		this.state.lastSyncedSessionCount = (remoteIndex.projects ?? []).reduce((sum, project) => sum + (project.sessions?.length ?? 0), 0);
		this.state.lastSyncedResourceCount = (remoteIndex.projects ?? []).reduce(
			(sum, project) => sum + (project.resources ? Object.keys(project.resources).length : 0),
			0,
		);
		this.state.lastSyncedIndex = remoteIndex;
		this.pendingLocalSync = false;
		this.pendingConflictContext = null;
		await this.persist();
		this.syncState = "IDLE";
		this.emitState();
	}

	/** 下载单个会话对象并写入目标路径（hash 相同则跳过）。 */
	private async downloadSessionRef(
		sessionRef: import("../../shared/types/cloudSync.ts").CloudSyncSessionRef,
		provider: PiDeckCloudObjectStorage,
	): Promise<void> {
		const target = await this.resolveSessionTarget(sessionRef);
		const root = this.sessionTargetRoot(sessionRef);
		if (!target || !root) return;
		await mkdir(dirname(target), { recursive: true });
		await ensureNoSymlinkEscape(root, target);
		const object = await provider.readObject(sessionRef.objectKey);
		if (!object.found || !object.bytes) return;
		const existing = await this.readExistingHash(target);
		if (existing === sessionRef.contentHash) return;
		const content = await this.decryptObject(object.bytes);
		await writeFileAtomic(target, content);
	}

	/** 下载单个资源 bundle 并写入对应作用域目录。 */
	private async downloadResourceBundle(
		projectId: string,
		bundle: import("../../shared/types/cloudSync.ts").CloudSyncFileBundle,
		provider: PiDeckCloudObjectStorage,
	): Promise<void> {
		const scopeRoot = projectId === GLOBAL_SYNC_PROJECT_ID
			? join(this.options.homeDir, ".pi", "agent")
			: this.options.listProjects().find((candidate) => candidate.id === projectId)?.path;
		if (!scopeRoot) return;
		const content = bundle.content ?? await this.readObjectText(provider, bundle.objectKey ?? "");
		if (content === undefined) return;
		const target = join(scopeRoot, bundle.relativePath);
		await mkdir(dirname(target), { recursive: true });
		await ensureNoSymlinkEscape(scopeRoot, target);
		await writeFileAtomic(target, content);
	}

	private async resolveSessionTarget(
		sessionRef: import("../../shared/types/cloudSync.ts").CloudSyncSessionRef,
	): Promise<string | null> {
		if (sessionRef.scope === "global") {
			return resolveGlobalSessionPath(this.options.homeDir, sessionRef.relativePath);
		}
		const project = this.options.listProjects().find((candidate) => candidate.id === sessionRef.projectId);
		if (!project) {
			// No matching local project: land in the pending folder for later mapping.
			return join(this.options.userDataDir, "cloud-sync-pending", sessionRef.projectId ?? "unknown", sessionRef.relativePath);
		}
		return resolveProjectSessionPath(project.path, sessionRef.relativePath, ".pi/sessions");
	}

	private sessionTargetRoot(
		sessionRef: import("../../shared/types/cloudSync.ts").CloudSyncSessionRef,
	): string | null {
		if (sessionRef.scope === "global") {
			return join(this.options.homeDir, ".pi", "agent", "sessions");
		}
		const project = this.options.listProjects().find((candidate) => candidate.id === sessionRef.projectId);
		if (!project) return null;
		return join(project.path, ".pi", "sessions");
	}

	private async readExistingHash(filePath: string): Promise<string | null> {
		try {
			return await hashFile(filePath);
		} catch {
			return null;
		}
	}

	private async readObjectText(provider: PiDeckCloudObjectStorage, key: string): Promise<string | undefined> {
		if (!key) return undefined;
		const result = await provider.readObject(key);
		if (!result.found || !result.bytes) return undefined;
		return this.decryptObject(result.bytes);
	}

	// ── Provider / adapter internals ─────────────────────────────────

	private firstAdapter(): PiDeckCloudObjectStorage | null {
		return this.adapters.values().next().value ?? null;
	}

	private normalizeProviderInput(input: CloudSyncProviderConfigInput): WebDAVConfig | S3Config {
		if (input.provider === "webdav") return normalizeWebDAVConfig(input.config);
		if (input.provider === "s3") return normalizeS3Config(input.config);
		throw new TypeError(`Unsupported cloud provider: ${String((input as { provider?: unknown }).provider)}`);
	}

	private async sealConfig(
		config: WebDAVConfig | S3Config,
		password: string,
		masterConfig: CloudSyncMasterKeyConfig,
	): Promise<string> {
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
				this.providerConfigs.set(provider as CloudProvider, JSON.parse(plaintext) as WebDAVConfig | S3Config);
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
		await writeFileAtomic(this.stateFile, JSON.stringify(this.state, null, 2));
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
		if (this.autoSyncTimer) {
			clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = null;
		}
		await this.disconnectAllAdapters();
		this.password = null;
		this.providerConfigs.clear();
	}
}
