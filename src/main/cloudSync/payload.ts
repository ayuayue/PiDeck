import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	AppSettings,
	Project,
	SessionRecord,
} from "../../shared/types.ts";
import type {
	CloudSyncFileBundle,
	CloudSyncExtensionSource,
	CloudSyncProject,
	CloudSyncProjectResources,
	CloudSyncSessionRef,
	PiDeckSyncIndexV1,
} from "../../shared/types/cloudSync.ts";

export const GLOBAL_SYNC_PROJECT_ID = "__global__";
export const GLOBAL_SYNC_PROJECT_NAME = "Global";
/** DSH 会话 selectionId 的命名空间（会话本身按所属项目归组，不再单列 __dsh__ 项目节点）。 */
export const DSH_SYNC_PROJECT_ID = "__dsh__";
export const DSH_SESSION_OBJECT_KEY_PREFIX = "pideck-dsh-sessions";
export const SESSION_OBJECT_KEY_PREFIX = "pideck-sessions";
export const FILE_OBJECT_KEY_PREFIX = "pideck-files";
export const DEFAULT_INLINE_FILE_BYTES = 256 * 1024;

/** DSH 会话对象 key：内容始终以解压后的文本 JSONL 形式加密上传。 */
export function dshSessionObjectKey(sessionId: string): string {
	assertStableSessionId(sessionId);
	return `${DSH_SESSION_OBJECT_KEY_PREFIX}/${sessionId}.jsonl.enc`;
}

/** Device-local runtime and path fields are intentionally absent from this list. */
export const SYNCABLE_DESKTOP_SETTING_KEYS = [
	"theme",
	"themeScheduleLightStart",
	"themeScheduleDarkStart",
	"accent",
	"themeSkin",
	"customThemeOverrides",
	"language",
	"sendShortcut",
	"busySendDelivery",
	"sessionTabOpenMode",
	"fontSize",
	"uiFontSize",
	"chatFontSize",
	"inputFontSize",
	"fontFamilyBase",
	"fontFamilyBaseCustom",
	"fontFamilyMono",
	"fontFamilyMonoCustom",
	"favoriteModels",
	"enableGitManagement",
	"gitCommitMessagePrompt",
	"gitCommitMessageProvider",
	"gitCommitMessageModel",
	"imageGenSize",
	"imageGenWatermark",
	"imageGenOutputFormat",
	"removedBuiltInExtensions",
	"disabledExtensions",
	"disableExtensionWhitelist",
	"defaultAgentBackend",
	"dshApprovalAutoAllow",
	"dshAutoImportSessions",
	"securityConfig",
] satisfies readonly (keyof AppSettings)[];

const SYNCABLE_DESKTOP_SETTING_KEY_SET = new Set<string>(SYNCABLE_DESKTOP_SETTING_KEYS);

export type SyncableDesktopSettingKey = (typeof SYNCABLE_DESKTOP_SETTING_KEYS)[number];

export function isSyncableDesktopSettingKey(value: string): value is SyncableDesktopSettingKey {
	return SYNCABLE_DESKTOP_SETTING_KEY_SET.has(value);
}

/** Pick only user preferences that are portable across machines. */
export function pickSyncableDesktopSettings(settings: AppSettings): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of SYNCABLE_DESKTOP_SETTING_KEYS) {
		const value = settings[key];
		if (value !== undefined) result[key] = value;
	}
	return result;
}

/** Filter an untrusted remote settings object before handing it to SettingsStore. */
export function filterSyncableDesktopSettings(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const source = Object.entries(value);
	const result: Record<string, unknown> = {};
	for (const [key, entry] of source) {
		if (isSyncableDesktopSettingKey(key)) result[key] = entry;
	}
	return result;
}

function normalizeRelativePath(value: string, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
		throw new TypeError(`${label} is invalid`);
	}
	if (value.includes("\\") || value.includes("\0") || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new TypeError(`${label} contains unsafe characters`);
	}
	if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
		throw new TypeError(`${label} must be relative`);
	}
	const segments = value.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		throw new TypeError(`${label} contains an unsafe path segment`);
	}
	return value;
}

/** Convert a local absolute file path into a portable slash-separated path. */
export function toPortableRelativePath(root: string, filePath: string): string {
	const rootPath = resolve(root);
	const targetPath = resolve(filePath);
	const value = relative(rootPath, targetPath);
	if (!value || isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`)) {
		throw new TypeError("File path is outside the sync root");
	}
	return normalizeRelativePath(value.split(sep).join("/"), "relativePath");
}

/** Resolve a remote relative path only after validating it against a local root. */
export function resolvePortablePath(root: string, relativePath: string): string {
	const normalized = normalizeRelativePath(relativePath, "relativePath");
	const rootPath = resolve(root);
	const targetPath = resolve(rootPath, ...normalized.split("/"));
	const back = relative(rootPath, targetPath);
	if (!back || isAbsolute(back) || back === ".." || back.startsWith(`..${sep}`)) {
		throw new TypeError("Resolved path escapes the sync root");
	}
	return targetPath;
}

export function resolveGlobalSessionPath(homeDir: string, relativePath: string): string {
	return resolvePortablePath(join(homeDir, ".pi", "agent", "sessions"), relativePath);
}

export function resolveProjectSessionPath(
	projectPath: string,
	relativePath: string,
	sessionDirectory = ".pi/sessions",
): string {
	const sessionRoot = resolvePortablePath(projectPath, normalizeRelativePath(sessionDirectory, "sessionDirectory"));
	return resolvePortablePath(sessionRoot, relativePath);
}

function assertStableSessionId(sessionId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(sessionId)) {
		throw new TypeError("Session id is invalid for cloud object storage");
	}
}

export function sessionObjectKey(sessionId: string): string {
	assertStableSessionId(sessionId);
	return `${SESSION_OBJECT_KEY_PREFIX}/${sessionId}.jsonl.enc`;
}

function hashText(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Build a text resource bundle; large content becomes a separately uploaded object. */
/** 从 pi settings.json 提取包扩展声明（packages 数组：字符串或 {source,...} 对象）。 */
export function extractExtensionSources(
	piSettings: unknown,
	scope: "user" | "project",
): CloudSyncExtensionSource[] {
	if (typeof piSettings !== "object" || piSettings === null || Array.isArray(piSettings)) return [];
	const packages = (piSettings as Record<string, unknown>).packages;
	if (!Array.isArray(packages) || packages.length > 500) return [];
	const result: CloudSyncExtensionSource[] = [];
	const seen = new Set<string>();
	for (const entry of packages) {
		let source: unknown = entry;
		let version: unknown;
		if (entry && typeof entry === "object" && !Array.isArray(entry)) {
			source = (entry as Record<string, unknown>).source;
			version = (entry as Record<string, unknown>).version;
		}
		if (typeof source !== "string" || !source.trim() || source.length > 2048) continue;
		if (seen.has(source)) continue;
		seen.add(source);
		result.push({
			source,
			scope,
			...(typeof version === "string" && version.length > 0 && version.length <= 512 ? { version } : {}),
		});
	}
	return result;
}

export function createTextFileBundle(
	relativePath: string,
	content: string,
	inlineLimit = DEFAULT_INLINE_FILE_BYTES,
): CloudSyncFileBundle {
	const normalizedPath = normalizeRelativePath(relativePath, "resource relativePath");
	const contentHash = hashText(content);
	const bytes = Buffer.byteLength(content, "utf8");
	if (!Number.isSafeInteger(inlineLimit) || inlineLimit < 0) {
		throw new RangeError("Inline file limit is invalid");
	}
	if (bytes <= inlineLimit) {
		return { relativePath: normalizedPath, contentHash, content };
	}
	return {
		relativePath: normalizedPath,
		contentHash,
		objectKey: `${FILE_OBJECT_KEY_PREFIX}/${contentHash}.enc`,
	};
}

export interface SessionRefInput {
	sessionId: string;
	scope: "global" | "project" | "dsh";
	projectId?: string;
	filePath: string;
	rootPath: string;
	size: number;
	mtimeMs: number;
	contentHash: string;
}

/** Create a selected-session reference without serializing an absolute path. */
export function createSessionRef(input: SessionRefInput): CloudSyncSessionRef {
	assertStableSessionId(input.sessionId);
	if (!Number.isSafeInteger(input.size) || input.size < 0) throw new RangeError("Session size is invalid");
	if (!Number.isFinite(input.mtimeMs) || input.mtimeMs < 0) throw new RangeError("Session mtime is invalid");
	if (typeof input.contentHash !== "string" || input.contentHash.length === 0) {
		throw new TypeError("Session content hash is invalid");
	}
	if (input.scope === "project" && (!input.projectId || input.projectId === GLOBAL_SYNC_PROJECT_ID)) {
		throw new TypeError("Project session must have a project id");
	}
	if (input.scope === "global" && input.projectId !== undefined) {
		throw new TypeError("Global session must not have a project id");
	}
	return {
		sessionId: input.sessionId,
		scope: input.scope,
		...(input.projectId ? { projectId: input.projectId } : {}),
		relativePath: toPortableRelativePath(input.rootPath, input.filePath),
		size: input.size,
		mtimeMs: input.mtimeMs,
		contentHash: input.contentHash,
		objectKey: input.scope === "dsh" ? dshSessionObjectKey(input.sessionId) : sessionObjectKey(input.sessionId),
	};
}

export interface CloudSyncProjectOptions {
	resources?: CloudSyncProjectResources;
	sessions?: CloudSyncSessionRef[];
	catalogEntries?: Array<Record<string, unknown>>;
}

/** Convert a local Project record into the portable project-tree node. */
export function buildCloudSyncProject(
	project: Project,
	options: CloudSyncProjectOptions = {},
): CloudSyncProject {
	return {
		projectId: project.id,
		name: project.name,
		kind: project.kind === "chat" ? "chat" : "normal",
		pathHint: project.path,
		environment: project.environment ?? "windows",
		metadata: {
			...(project.pinned !== undefined ? { pinned: project.pinned } : {}),
			...(project.sortOrder !== undefined ? { sortOrder: project.sortOrder } : {}),
			...(project.worktreeEnabled !== undefined ? { worktreeEnabled: project.worktreeEnabled } : {}),
			...(project.worktreeParentId ? { worktreeParentId: project.worktreeParentId } : {}),
		},
		...(options.resources ? { resources: options.resources } : {}),
		...(options.sessions ? { sessions: options.sessions } : {}),
		...(options.catalogEntries ? { catalogEntries: options.catalogEntries } : {}),
	};
}

export function buildGlobalCloudSyncProject(options: CloudSyncProjectOptions = {}): CloudSyncProject {
	return {
		projectId: GLOBAL_SYNC_PROJECT_ID,
		name: GLOBAL_SYNC_PROJECT_NAME,
		kind: "normal",
		...(options.resources ? { resources: options.resources } : {}),
		...(options.sessions ? { sessions: options.sessions } : {}),
		...(options.catalogEntries ? { catalogEntries: options.catalogEntries } : {}),
	};
}

/** 合成项目节点：本机未注册的归属项目（DSH 工作区目录等），只作载荷组织维度。 */
export function buildSyntheticCloudSyncProject(
	projectId: string,
	name: string,
	options: CloudSyncProjectOptions = {},
): CloudSyncProject {
	return {
		projectId,
		name,
		kind: "normal",
		...(options.resources ? { resources: options.resources } : {}),
		...(options.sessions ? { sessions: options.sessions } : {}),
		...(options.catalogEntries ? { catalogEntries: options.catalogEntries } : {}),
	};
}

/** Catalog entry shape used by sync: identity/metadata only, never an absolute file path. */
export function buildCatalogSyncEntry(
	record: SessionRecord,
	relativePath?: string,
	parentRelativePath?: string,
): Record<string, unknown> {
	const result: Record<string, unknown> = {
		id: record.id,
		projectId: record.projectId,
		title: record.title,
		source: record.source,
		environment: record.environment,
		status: record.status,
		preview: record.preview,
		messageCount: record.messageCount,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
	if (record.backend !== undefined) result.backend = record.backend;
	if (record.noSession !== undefined) result.noSession = record.noSession;
	if (record.parentSessionId !== undefined) result.parentSessionId = record.parentSessionId;
	if (parentRelativePath !== undefined) {
		result.parentSessionPath = normalizeRelativePath(parentRelativePath, "catalog parent relativePath");
	}
	if (record.model !== undefined) result.model = record.model;
	if (record.thinkingLevel !== undefined) result.thinkingLevel = record.thinkingLevel;
	if (record.permissionPreset !== undefined) result.permissionPreset = record.permissionPreset;
	if (record.proxy !== undefined) result.proxy = record.proxy;
	if (record.importedSourceId !== undefined) result.importedSourceId = record.importedSourceId;
	if (record.dshSessionId !== undefined) result.dshSessionId = record.dshSessionId;
	if (record.codexSessionId !== undefined) result.codexSessionId = record.codexSessionId;
	if (record.codexThreadSource !== undefined) result.codexThreadSource = record.codexThreadSource;
	if (record.codexParentThreadId !== undefined) result.codexParentThreadId = record.codexParentThreadId;
	if (record.codexAgentRole !== undefined) result.codexAgentRole = record.codexAgentRole;
	if (record.codexAgentNickname !== undefined) result.codexAgentNickname = record.codexAgentNickname;
	if (relativePath !== undefined) result.relativePath = normalizeRelativePath(relativePath, "catalog relativePath");
	return result;
}

export interface BuildIndexInput {
	deviceId: string;
	deviceName?: string;
	appVersion: string;
	syncedAt: number;
	settings?: AppSettings;
	pi?: PiDeckSyncIndexV1["pi"];
	dsh?: PiDeckSyncIndexV1["dsh"];
	projects: CloudSyncProject[];
	imageGen?: PiDeckSyncIndexV1["imageGen"];
	extensionState?: PiDeckSyncIndexV1["extensionState"];
}

/** Build the versioned index envelope consumed by EncryptionService. */
export function buildPiDeckSyncIndex(input: BuildIndexInput): PiDeckSyncIndexV1 {
	if (!input.deviceId.trim() || !input.appVersion.trim()) throw new TypeError("Sync device metadata is invalid");
	if (!Number.isFinite(input.syncedAt)) throw new TypeError("Sync timestamp is invalid");
	return {
		schemaVersion: 1,
		meta: {
			deviceId: input.deviceId,
			...(input.deviceName ? { deviceName: input.deviceName } : {}),
			appVersion: input.appVersion,
			syncedAt: input.syncedAt,
		},
		...(input.settings ? { settings: pickSyncableDesktopSettings(input.settings) } : {}),
		...(input.pi ? { pi: input.pi } : {}),
		...(input.dsh ? { dsh: input.dsh } : {}),
		projects: input.projects,
		...(input.imageGen ? { imageGen: input.imageGen } : {}),
		...(input.extensionState ? { extensionState: input.extensionState } : {}),
		syncedAt: input.syncedAt,
	};
}
