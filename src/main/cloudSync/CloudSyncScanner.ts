import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { Project, SessionRecord } from "../../shared/types.ts";
import type {
	CloudSyncCustomPath,
	CloudSyncProjectSelectionNode,
	CloudSyncResourceCandidate,
	CloudSyncResourceCategory,
	CloudSyncScanRootStatus,
	CloudSyncSelectionPreferences,
	CloudSyncSelectionTree,
	CloudSyncSessionCandidate,
} from "../../shared/types/cloudSync.ts";
import { GLOBAL_SYNC_PROJECT_ID } from "./payload.ts";

const SESSION_ROOT_RELATIVE = join(".pi", "agent", "sessions");
const MAX_FILES_PER_ROOT = 5_000;
const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;
const MAX_SESSION_BYTES = 512 * 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set([".pideck-archive", ".trash", "subagent-artifacts", "node_modules"]);

/**
 * 内置扫描排除模式（M9，§12.4）：后缀/文件名/目录名匹配。
 * 与用户黑名单（glob）合并后统一应用；`*` 匹配任意字符。
 */
export const DEFAULT_SCAN_EXCLUSIONS = [
	"*.bak*",
	"*.log",
	"*-events.jsonl",
	"node_modules",
	".trash",
	".pideck-archive",
	"subagent-artifacts",
] as const;

/** 全局「配置」类别白名单：~/.pi/agent 顶层散落配置文件（trust.json 明确排除，settings.json 归 settings 类别）。 */
export const GLOBAL_CONFIG_FILE_WHITELIST = ["auth.json", "models.json", "models-store.json"] as const;

export type CloudSyncInternalSession = {
	candidate: CloudSyncSessionCandidate;
	filePath: string;
	rootPath: string;
};

export type CloudSyncInternalResource = {
	candidate: CloudSyncResourceCandidate;
	filePath: string;
	rootPath: string;
};

export type CloudSyncScanSnapshot = {
	tree: CloudSyncSelectionTree;
	sessions: Map<string, CloudSyncInternalSession>;
	resources: Map<string, CloudSyncInternalResource>;
	recordsBySessionId: Map<string, SessionRecord>;
};

type RootScanResult<T> = {
	items: T[];
	status: CloudSyncScanRootStatus;
};

type FileEntry = {
	filePath: string;
	relativePath: string;
	size: number;
	mtimeMs: number;
};

export interface CloudSyncScannerOptions {
	homeDir: string;
	listProjects: () => Project[];
	listSessionRecords: () => SessionRecord[];
}

/** scan() 的可选输入（M9）：用户黑名单 glob + 自选同步路径。 */
export interface CloudSyncScanOptions {
	/** 用户黑名单（glob），与内置排除合并。 */
	exclusions?: string[];
	/** 用户自选同步路径（点「添加」选中的文件/文件夹）。 */
	customPaths?: CloudSyncCustomPath[];
}

function normalizePath(value: string): string {
	const result = resolve(value);
	return process.platform === "win32" ? result.toLowerCase() : result;
}

function normalizeRelativePath(value: string): string {
	return value.split("\\").join("/");
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

function stableOrphanSessionId(scope: "global" | "project", projectId: string, relativePath: string): string {
	const digest = createHash("sha256")
		.update(`${scope}\0${projectId}\0${relativePath}`, "utf8")
		.digest("hex")
		.slice(0, 32);
	return `orphan-${digest}`;
}

function selectionId(scope: "global" | "project", projectId: string, sessionId: string): string {
	return `session:${scope}:${projectId}:${sessionId}`;
}

function resourceSelectionId(projectId: string, category: CloudSyncResourceCategory, relativePath: string): string {
	return `resource:${projectId}:${category}:${relativePath}`;
}

function recordByPath(records: SessionRecord[]): Map<string, SessionRecord> {
	const result = new Map<string, SessionRecord>();
	for (const record of records) {
		if (!record.filePath) continue;
		result.set(normalizePath(record.filePath), record);
	}
	return result;
}

function safeRootRelativePath(rootPath: string, filePath: string): string {
	const value = normalizeRelativePath(relative(rootPath, filePath));
	if (!value || value === ".." || value.startsWith("../") || value.includes("\0")) {
		throw new Error("Cloud sync scanner produced an unsafe relative path");
	}
	return value;
}

/**
 * 把排除 pattern 编译为正则：双星斜杠 → 零层或多层目录，单星 → 段内任意字符，其余按字面量。
 * 仅用于匹配文件名/目录名与扫描相对路径，不做 shell 语义。
 */
function compileExclusionPattern(pattern: string): RegExp {
	let body = "";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				if (pattern[index + 2] === "/") {
					body += "(?:.*/)?";
					index += 2;
				} else {
					body += ".*";
					index += 1;
				}
			} else {
				body += "[^/]*";
			}
			continue;
		}
		body += SPECIAL_EXCLUSION_CHARS.has(char) ? `\\${char}` : char;
	}
	return new RegExp(`^(?:${body})$`);
}

/** 正则元字符集合（glob 编译转义用）。 */
const SPECIAL_EXCLUSION_CHARS = new Set([...".*+?^${}()|[]\\"]);

/**
 * Main-process scanner for the cloud sync selection tree.
 * It deliberately does not reuse the renderer project/session list: scan errors
 * are retained as root status, symlinks are skipped, and absolute paths stay
 * inside the internal snapshot only.
 */
export class CloudSyncScanner {
	private readonly options: CloudSyncScannerOptions;
	/** 合并后的排除正则（内置默认 + 用户黑名单）。 */
	private exclusionRegexps: RegExp[] = [];

	constructor(options: CloudSyncScannerOptions) {
		this.options = options;
	}

	async scan(preferences: CloudSyncSelectionPreferences, scanOptions: CloudSyncScanOptions = {}): Promise<CloudSyncScanSnapshot> {
		this.exclusionRegexps = [...DEFAULT_SCAN_EXCLUSIONS, ...(scanOptions.exclusions ?? [])].map(compileExclusionPattern);
		const customPaths = scanOptions.customPaths ?? [];
		const projects = this.options.listProjects();
		const records = this.options.listSessionRecords();
		const recordsByPath = recordByPath(records);
		const recordsBySessionId = new Map(records.map((record) => [record.id, record]));
		const sessions = new Map<string, CloudSyncInternalSession>();
		const resources = new Map<string, CloudSyncInternalResource>();
		const roots: CloudSyncScanRootStatus[] = [];
		const projectNodes = new Map<string, CloudSyncProjectSelectionNode>();
		const globalNode: CloudSyncProjectSelectionNode = {
			projectId: GLOBAL_SYNC_PROJECT_ID,
			name: "Global",
			sessions: [],
			resources: [],
		};
		projectNodes.set(GLOBAL_SYNC_PROJECT_ID, globalNode);
		for (const project of projects) {
			projectNodes.set(project.id, {
				projectId: project.id,
				name: project.name,
				kind: project.kind === "chat" ? "chat" : "normal",
				environment: project.environment === "wsl" ? "wsl" : "windows",
				pathHint: project.path,
				missing: project.missing,
				sessions: [],
				resources: [],
			});
		}
		// Catalog 归属但本机未注册的项目：合成节点，会话选择仍可见、可恢复（落待映射区）。
		const syntheticProjectIds: string[] = [];
		for (const record of records) {
			if (record.projectId === GLOBAL_SYNC_PROJECT_ID || projectNodes.has(record.projectId)) continue;
			projectNodes.set(record.projectId, {
				projectId: record.projectId,
				name: record.projectId,
				kind: "normal",
				missing: true,
				sessions: [],
				resources: [],
			});
			syntheticProjectIds.push(record.projectId);
		}

		const globalSessionsRoot = join(this.options.homeDir, SESSION_ROOT_RELATIVE);
		const globalSessions = await this.scanSessionRoot(
			globalSessionsRoot,
			"global-sessions",
			"Global sessions",
			undefined,
			recordsByPath,
			preferences,
		);
		roots.push(globalSessions.status);
		for (const item of globalSessions.items) {
			const groupId = item.candidate.projectId === GLOBAL_SYNC_PROJECT_ID
				? GLOBAL_SYNC_PROJECT_ID
				: item.candidate.projectId;
			const node = projectNodes.get(groupId) ?? globalNode;
			node.sessions.push(item.candidate);
			sessions.set(item.candidate.selectionId, item);
		}

		const globalResources = await this.scanResourceRoots(
			this.globalResourceRoots(),
			GLOBAL_SYNC_PROJECT_ID,
			preferences,
		);
		roots.push(...globalResources.statuses);
		for (const item of globalResources.items) {
			globalNode.resources.push(item.candidate);
			resources.set(item.candidate.selectionId, item);
		}

		for (const project of projects) {
			const node = projectNodes.get(project.id);
			if (!node) continue;
			if (project.environment === "wsl" || project.path.startsWith("/")) {
				roots.push({
					id: `project-sessions:${project.id}`,
					label: `${project.name} sessions`,
					kind: "project-sessions",
					projectId: project.id,
					ok: false,
					count: 0,
					error: "WSL project scanning is unavailable until the WSL scanner bridge is configured",
				});
				roots.push({
					id: `project-resources:${project.id}`,
					label: `${project.name} resources`,
					kind: "project-resources",
					projectId: project.id,
					ok: false,
					count: 0,
					error: "WSL project scanning is unavailable until the WSL scanner bridge is configured",
				});
				continue;
			}
			const sessionRoot = join(project.path, ".pi", "sessions");
			const projectSessions = await this.scanSessionRoot(
				sessionRoot,
				"project-sessions",
				`${project.name} sessions`,
				project.id,
				recordsByPath,
				preferences,
			);
			roots.push(projectSessions.status);
			for (const item of projectSessions.items) {
				node.sessions.push(item.candidate);
				sessions.set(item.candidate.selectionId, item);
			}
			const projectResources = await this.scanResourceRoots(
				this.projectResourceRoots(project.path),
				project.id,
				preferences,
			);
			roots.push(...projectResources.statuses);
			for (const item of projectResources.items) {
				node.resources.push(item.candidate);
				resources.set(item.candidate.selectionId, item);
			}
		}

		// M9：自选同步路径（文件/文件夹）加入对应节点（category=config，供「自选」展示）。
		for (const customPath of customPaths) {
			const item = await this.scanCustomPath(customPath, preferences);
			if (!item) continue;
			const node = projectNodes.get(item.candidate.projectId) ?? globalNode;
			node.resources.push(item.candidate);
			resources.set(item.candidate.selectionId, item);
		}

		for (const node of projectNodes.values()) {
			node.sessions.sort((left, right) => right.mtimeMs - left.mtimeMs);
			node.resources.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
		}
		const orderedProjects = [
			globalNode,
			...projects
				.map((project) => projectNodes.get(project.id))
				.filter((node): node is CloudSyncProjectSelectionNode => Boolean(node)),
			...syntheticProjectIds
				.map((id) => projectNodes.get(id))
				.filter((node): node is CloudSyncProjectSelectionNode => Boolean(node)),
		];
		const tree: CloudSyncSelectionTree = {
			scannedAt: Date.now(),
			projects: orderedProjects,
			roots,
			totalSessions: orderedProjects.reduce((sum, project) => sum + project.sessions.length, 0),
			selectedSessions: orderedProjects.reduce((sum, project) => sum + project.sessions.filter((item) => item.selected).length, 0),
			totalResources: orderedProjects.reduce((sum, project) => sum + project.resources.length, 0),
			selectedResources: orderedProjects.reduce((sum, project) => sum + project.resources.filter((item) => item.selected).length, 0),
			content: { ...preferences.content },
		};
		return { tree, sessions, resources, recordsBySessionId };
	}

	private globalResourceRoots(): Array<{ category: CloudSyncResourceCategory; rootPath: string; relativeBase: string }> {
		const agentRoot = join(this.options.homeDir, ".pi", "agent");
		const configRoots = GLOBAL_CONFIG_FILE_WHITELIST.map((name) => ({
			category: "config" as const,
			rootPath: join(agentRoot, name),
			relativeBase: name,
		}));
		return [
			{ category: "settings", rootPath: join(agentRoot, "settings.json"), relativeBase: "" },
			{ category: "prompts", rootPath: join(agentRoot, "prompts"), relativeBase: "prompts" },
			{ category: "skills", rootPath: join(agentRoot, "skills"), relativeBase: "skills" },
			{ category: "extensions", rootPath: join(agentRoot, "extensions"), relativeBase: "extensions" },
			...configRoots,
		];
	}

	private projectResourceRoots(projectPath: string): Array<{ category: CloudSyncResourceCategory; rootPath: string; relativeBase: string }> {
		return [
			{ category: "settings", rootPath: join(projectPath, ".pi", "settings.json"), relativeBase: ".pi" },
			{ category: "prompts", rootPath: join(projectPath, ".pi", "prompts"), relativeBase: ".pi/prompts" },
			{ category: "skills", rootPath: join(projectPath, ".pi", "skills"), relativeBase: ".pi/skills" },
			{ category: "skills", rootPath: join(projectPath, ".agents", "skills"), relativeBase: ".agents/skills" },
			{ category: "extensions", rootPath: join(projectPath, ".pi", "extensions"), relativeBase: ".pi/extensions" },
		];
	}

	private async scanSessionRoot(
		rootPath: string,
		kind: "global-sessions" | "project-sessions",
		label: string,
		projectId: string | undefined,
		recordsByPath: Map<string, SessionRecord>,
		preferences: CloudSyncSelectionPreferences,
	): Promise<RootScanResult<CloudSyncInternalSession>> {
		const files = await this.listFiles(rootPath, ".jsonl");
		const items: CloudSyncInternalSession[] = [];
		for (const file of files.items) {
			const record = recordsByPath.get(normalizePath(file.filePath));
			const groupId = projectId ?? record?.projectId ?? GLOBAL_SYNC_PROJECT_ID;
			const scope = projectId ? "project" : "global";
			const sessionId = record?.id ?? stableOrphanSessionId(scope, groupId, file.relativePath);
			const candidate: CloudSyncSessionCandidate = {
				selectionId: selectionId(scope, groupId, sessionId),
				sessionId,
				title: record?.title || basename(file.filePath, ".jsonl") || "Untitled",
				projectId: groupId,
				scope,
				relativePath: file.relativePath,
				size: file.size,
				mtimeMs: file.mtimeMs,
				source: record?.source ?? "pi",
				environment: projectId ? "native" : record?.environment === "wsl" ? "wsl" : "native",
				selected: preferences.selectedSessionIds.includes(selectionId(scope, groupId, sessionId)),
				status: file.size > MAX_SESSION_BYTES ? "unavailable" : "available",
				...(file.size > MAX_SESSION_BYTES ? { reason: `Session exceeds ${MAX_SESSION_BYTES} byte limit` } : {}),
			};
			items.push({ candidate, filePath: file.filePath, rootPath });
		}
		return {
			items,
			status: {
				id: `${kind}:${projectId ?? GLOBAL_SYNC_PROJECT_ID}`,
				label,
				kind,
				...(projectId ? { projectId } : {}),
				ok: files.status.ok,
				count: items.length,
				...(files.status.error ? { error: files.status.error } : {}),
			},
		};
	}

	private async scanResourceRoots(
		roots: Array<{ category: CloudSyncResourceCategory; rootPath: string; relativeBase: string }>,
		projectId: string,
		preferences: CloudSyncSelectionPreferences,
	): Promise<{ items: CloudSyncInternalResource[]; statuses: CloudSyncScanRootStatus[] }> {
		const items: CloudSyncInternalResource[] = [];
		const statuses: CloudSyncScanRootStatus[] = [];
		for (const root of roots) {
			const isSingleFile = root.category === "settings" || root.category === "config";
			const files = isSingleFile
				? await this.listSingleFile(root.rootPath, root.relativeBase)
				: await this.listFiles(root.rootPath);
			for (const file of files.items) {
				const relativePath = root.category === "settings"
					? (projectId === GLOBAL_SYNC_PROJECT_ID ? "settings.json" : ".pi/settings.json")
					: root.category === "config"
						? file.relativePath
						: normalizeRelativePath(join(root.relativeBase, file.relativePath));
				const id = resourceSelectionId(projectId, root.category, relativePath);
				const unavailable = file.size > MAX_RESOURCE_BYTES;
				const candidate: CloudSyncResourceCandidate = {
					selectionId: id,
					projectId,
					category: root.category,
					relativePath,
					size: file.size,
					mtimeMs: file.mtimeMs,
					selected: preferences.selectedResourceIds.includes(id),
					status: unavailable ? "unavailable" : "available",
					...(unavailable ? { reason: `Resource exceeds ${MAX_RESOURCE_BYTES} byte limit` } : {}),
				};
				items.push({ candidate, filePath: file.filePath, rootPath: isSingleFile ? root.rootPath : root.rootPath });
			}
			statuses.push({
				id: `${projectId}:${root.category}:${root.category === "config" ? root.relativeBase : root.relativeBase || "settings"}`,
				label: `${projectId === GLOBAL_SYNC_PROJECT_ID ? "Global" : projectId} ${root.category}${root.category === "config" ? `/${root.relativeBase}` : ""}`,
				kind: projectId === GLOBAL_SYNC_PROJECT_ID ? "global-resources" : "project-resources",
				...(projectId === GLOBAL_SYNC_PROJECT_ID ? {} : { projectId }),
				ok: files.status.ok,
				count: files.items.length,
				...(files.status.error ? { error: files.status.error } : {}),
			});
		}
		return { items, statuses };
	}

	/** 命中任一排除模式（内置默认 + 用户黑名单）。 */
	private isExcluded(nameOrRelativePath: string): boolean {
		for (const regexp of this.exclusionRegexps) {
			if (regexp.test(nameOrRelativePath)) return true;
		}
		return false;
	}

	/** 校验并扫描一个自选同步路径；不存在/超限/符号链接时静默跳过。 */
	private async scanCustomPath(
		customPath: CloudSyncCustomPath,
		preferences: CloudSyncSelectionPreferences,
	): Promise<CloudSyncInternalResource | null> {
		let info;
		try {
			info = await lstat(customPath.filePath);
		} catch {
			return null; // 不存在/无权限：跳过，不抛异常
		}
		if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) return null;
		if (info.size > MAX_RESOURCE_BYTES) return null;
		const relativePath = normalizeRelativePath(customPath.relativePath);
		if (!relativePath || relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) return null;
		if (this.isExcluded(relativePath) || this.isExcluded(basename(relativePath))) return null;
		const projectId = customPath.projectId ?? GLOBAL_SYNC_PROJECT_ID;
		const id = resourceSelectionId(projectId, "config", relativePath);
		const candidate: CloudSyncResourceCandidate = {
			selectionId: id,
			projectId,
			category: "config",
			relativePath,
			size: info.size,
			mtimeMs: info.mtimeMs,
			selected: preferences.selectedResourceIds.includes(id),
			status: "available",
		};
		return { candidate, filePath: customPath.filePath, rootPath: customPath.filePath };
	}

	private async listSingleFile(filePath: string, relativeBase: string): Promise<RootScanResult<FileEntry>> {
		try {
			const info = await lstat(filePath);
			if (!info.isFile() || this.isExcluded(basename(filePath))) {
				return { items: [], status: { id: filePath, label: relativeBase || "settings", kind: "global-resources", ok: true, count: 0 } };
			}
			return {
				items: [{ filePath, relativePath: basename(filePath), size: info.size, mtimeMs: info.mtimeMs }],
				status: { id: filePath, label: relativeBase || "settings", kind: "global-resources", ok: true, count: 1 },
			};
		} catch (error) {
			if (isMissingError(error)) {
				return { items: [], status: { id: filePath, label: relativeBase || "settings", kind: "global-resources", ok: true, count: 0 } };
			}
			return {
				items: [],
				status: {
					id: filePath,
					label: relativeBase || "settings",
					kind: "global-resources",
					ok: false,
					count: 0,
					error: isPermissionError(error) ? "Permission denied" : "Unable to scan resource",
				},
			};
		}
	}

	private async listFiles(rootPath: string, extension?: string): Promise<RootScanResult<FileEntry>> {
		const items: FileEntry[] = [];
		try {
			const info = await lstat(rootPath);
			if (!info.isDirectory()) {
				return { items: [], status: { id: rootPath, label: rootPath, kind: "project-resources", ok: true, count: 0 } };
			}
			await this.walk(rootPath, rootPath, extension, items);
			return { items, status: { id: rootPath, label: rootPath, kind: "project-resources", ok: true, count: items.length } };
		} catch (error) {
			if (isMissingError(error)) {
				return { items: [], status: { id: rootPath, label: rootPath, kind: "project-resources", ok: true, count: 0 } };
			}
			return {
				items,
				status: {
					id: rootPath,
					label: rootPath,
					kind: "project-resources",
					ok: false,
					count: items.length,
					error: isPermissionError(error) ? "Permission denied" : "Unable to scan directory",
				},
			};
		}
	}

	private async walk(rootPath: string, currentPath: string, extension: string | undefined, items: FileEntry[]): Promise<void> {
		if (items.length >= MAX_FILES_PER_ROOT) throw new Error("Cloud sync scan file limit exceeded");
		const entries = await readdir(currentPath, { withFileTypes: true });
		for (const entry of entries) {
			if (items.length >= MAX_FILES_PER_ROOT) throw new Error("Cloud sync scan file limit exceeded");
			if (entry.name.startsWith(".") && entry.name !== ".pi" && entry.name !== ".agents") continue;
			// M9：内置默认 + 用户黑名单按文件名/目录名排除（命中即不递归、不入候选）。
			if (this.isExcluded(entry.name)) continue;
			if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
			const path = join(currentPath, entry.name);
			const info = await lstat(path);
			if (info.isSymbolicLink()) continue;
			if (info.isDirectory()) {
				// 目录的相对路径也过一遍排除（支持 `**/secret*` 这类跨目录模式）。
				if (this.isExcluded(safeRootRelativePath(rootPath, path))) continue;
				await this.walk(rootPath, path, extension, items);
				continue;
			}
			if (!info.isFile() || (extension && !entry.name.toLowerCase().endsWith(extension))) continue;
			const relativePath = safeRootRelativePath(rootPath, path);
			// 相对路径再匹配一遍，支持 `**/secret*` 这类跨目录黑名单。
			if (this.isExcluded(relativePath)) continue;
			items.push({
				filePath: path,
				relativePath,
				size: info.size,
				mtimeMs: info.mtimeMs,
			});
		}
	}
}

export const CLOUD_SYNC_SCANNER_LIMITS = {
	maxFilesPerRoot: MAX_FILES_PER_ROOT,
	maxResourceBytes: MAX_RESOURCE_BYTES,
	maxSessionBytes: MAX_SESSION_BYTES,
};
