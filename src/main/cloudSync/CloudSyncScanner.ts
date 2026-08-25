import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { Project, SessionRecord } from "../../shared/types.ts";
import type {
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
 * Main-process scanner for the cloud sync selection tree.
 * It deliberately does not reuse the renderer project/session list: scan errors
 * are retained as root status, symlinks are skipped, and absolute paths stay
 * inside the internal snapshot only.
 */
export class CloudSyncScanner {
	private readonly options: CloudSyncScannerOptions;

	constructor(options: CloudSyncScannerOptions) {
		this.options = options;
	}

	async scan(preferences: CloudSyncSelectionPreferences): Promise<CloudSyncScanSnapshot> {
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
		return [
			{ category: "settings", rootPath: join(agentRoot, "settings.json"), relativeBase: "" },
			{ category: "prompts", rootPath: join(agentRoot, "prompts"), relativeBase: "prompts" },
			{ category: "skills", rootPath: join(agentRoot, "skills"), relativeBase: "skills" },
			{ category: "extensions", rootPath: join(agentRoot, "extensions"), relativeBase: "extensions" },
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
			const isSingleFile = root.category === "settings";
			const files = isSingleFile
				? await this.listSingleFile(root.rootPath, root.relativeBase)
				: await this.listFiles(root.rootPath);
			for (const file of files.items) {
				const relativePath = root.category === "settings"
					? (projectId === GLOBAL_SYNC_PROJECT_ID ? "settings.json" : ".pi/settings.json")
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
				id: `${projectId}:${root.category}:${root.relativeBase || "settings"}`,
				label: `${projectId === GLOBAL_SYNC_PROJECT_ID ? "Global" : projectId} ${root.category}`,
				kind: projectId === GLOBAL_SYNC_PROJECT_ID ? "global-resources" : "project-resources",
				...(projectId === GLOBAL_SYNC_PROJECT_ID ? {} : { projectId }),
				ok: files.status.ok,
				count: files.items.length,
				...(files.status.error ? { error: files.status.error } : {}),
			});
		}
		return { items, statuses };
	}

	private async listSingleFile(filePath: string, relativeBase: string): Promise<RootScanResult<FileEntry>> {
		try {
			const info = await lstat(filePath);
			if (!info.isFile()) {
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
			if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
			const path = join(currentPath, entry.name);
			const info = await lstat(path);
			if (info.isSymbolicLink()) continue;
			if (info.isDirectory()) {
				await this.walk(rootPath, path, extension, items);
				continue;
			}
			if (!info.isFile() || (extension && !entry.name.toLowerCase().endsWith(extension))) continue;
			items.push({
				filePath: path,
				relativePath: safeRootRelativePath(rootPath, path),
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
