import { ipcMain, shell } from "electron";
import { readFile, stat, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { projectLocatorFromLegacy } from "../../shared/locationAdapters";
import { ipcChannels } from "../../shared/ipc";
import { FILE_TREE_ABSOLUTE_MAX_DEPTH } from "../../shared/fileTree";
import type { ProjectFileAccessScope, ProjectFileTarget } from "../../shared/types/project";
import type { FileSearchResult } from "../../shared/types";
import { registerFilesSystemIpc } from "./filesSystemIpc";
import { createProjectFileReadBoundary, resolveProjectFileReadPath, type ProjectFileReadBoundary } from "../files/projectFileAccess";
import { parseProjectFileTarget, resolveLocalProjectFileTarget } from "../files/projectFileTarget";
import { LocalProjectFileBackend } from "../files/LocalProjectFileBackend";
import { LocalFileMutationAdapter } from "../files/LocalFileMutationAdapter";
import { ProjectFileBackendRouter } from "../files/ProjectFileBackend";
import type { FileSystemService } from "../fs/FileSystemService";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AppLogger } from "../logging/AppLogger";
import { parseWslUncPath, toWindowsHostPath } from "../wsl/WslPaths";

export type FilesIpcDeps = {
	fileSystemService: FileSystemService;
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	appLogger: Pick<AppLogger, "info" | "error">;
	openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFilePathInput(value: unknown): string | ProjectFileTarget {
	if (typeof value === "string") {
		if (!value.trim() || value.length > 32_768) throw new Error("Invalid file path");
		return value;
	}
	return parseProjectFileTarget(value);
}

function parseFilePathInputs(value: unknown): Array<string | ProjectFileTarget> {
	if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid file path list");
	const inputs: Array<string | ProjectFileTarget> = [];
	for (const path of value) inputs.push(parseFilePathInput(path));
	return inputs;
}

function parseOptionalMaxDepth(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > FILE_TREE_ABSOLUTE_MAX_DEPTH) throw new Error("INVALID_FILE_LIST_OPTIONS");
	return value;
}

function parseOptionalMaxBytes(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("INVALID_FILE_SIZE_LIMIT");
	return value;
}

export function registerFilesIpc({ fileSystemService, projectStore, settingsStore, appLogger, openExternalUrl }: FilesIpcDeps): void {
	registerFilesSystemIpc({ settingsStore, openExternalUrl });
	// Windows Node / Electron 边界不能直接消费 WSL Linux 路径：统一走 WslPaths 转成当前发行版的主机 UNC。
	// 已经是普通 Windows/非 WSL 网络盘的输入保持不变，避免误伤非 WSL 路径。
	const toWindowsPath = (path: string): string => {
		if (!path || process.platform !== "win32") return path;
		const settings = settingsStore.get();
		if (!settings.wslEnabled || !settings.wslDistro) return path;
		if (!path.startsWith("/") && !parseWslUncPath(path)) return path;
		return toWindowsHostPath(path, { distro: settings.wslDistro });
	};

	const localProjectFileBackend = new LocalProjectFileBackend({
		fileSystemService,
		resolveProjectRoot: (projectId) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error("PROJECT_NOT_FOUND");
			return toWindowsPath(project.path);
		},
	});
	const projectFileBackendRouter = new ProjectFileBackendRouter(localProjectFileBackend, (projectId) => {
		const project = projectStore.get(projectId);
		return project ? projectLocatorFromLegacy(project) : undefined;
	});

	const fileBackendForTargets = (targets: ProjectFileTarget[]) => {
		const backends = targets.map((target) => projectFileBackendRouter.forProject(target.projectId));
		const backend = backends[0];
		if (backend && backends.some((candidate) => candidate !== backend)) throw new Error("CROSS_BACKEND_FILE_OPERATION_UNSUPPORTED");
		return backend;
	};

	const isProjectFileAccessScope = (value: unknown): value is ProjectFileAccessScope => {
		if (typeof value !== "object" || value === null || !("projectId" in value)) return false;
		return typeof value.projectId === "string" && value.projectId.trim().length > 0;
	};

	/**
	 * renderer 可选携带 projectId 收窄读取权限；根路径只从 ProjectStore 获取，
	 * 再经 realpath 校验 symlink，不能由 renderer 自报一个任意“可信根”。
	 */
	const resolveProjectReadBoundary = async (rawScope?: unknown): Promise<ProjectFileReadBoundary | undefined> => {
		if (rawScope === undefined) return undefined;
		if (!isProjectFileAccessScope(rawScope)) {
			throw new Error("INVALID_PROJECT_FILE_ACCESS_SCOPE");
		}
		const project = projectStore.get(rawScope.projectId);
		if (!project) throw new Error("PROJECT_NOT_FOUND");
		return createProjectFileReadBoundary(toWindowsPath(project.path));
	};

	const resolveReadablePath = async (rawPath: unknown, boundary?: ProjectFileReadBoundary): Promise<string> => {
		if (isRecord(rawPath)) {
			if (boundary) throw new Error("INVALID_PROJECT_FILE_ACCESS_SCOPE");
			const target = parseProjectFileTarget(rawPath);
			const project = projectStore.get(target.projectId);
			if (!project) throw new Error("PROJECT_NOT_FOUND");
			const projectRoot = toWindowsPath(project.path);
			const targetPath = resolveLocalProjectFileTarget(projectRoot, target.relativePath);
			const targetBoundary = await createProjectFileReadBoundary(projectRoot);
			return resolveProjectFileReadPath(targetBoundary, targetPath);
		}
		if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.length > 32_768) {
			throw new Error("Invalid file path");
		}
		const hostPath = toWindowsPath(rawPath);
		return boundary ? resolveProjectFileReadPath(boundary, hostPath) : hostPath;
	};

	const localFileMutationAdapter = new LocalFileMutationAdapter(resolveReadablePath, appLogger);

	ipcMain.handle(ipcChannels.filesList, async (_event, projectOrTarget: unknown, options?: unknown) => {
		let target: ProjectFileTarget | undefined;
		let projectId: string;
		if (typeof projectOrTarget === "string") {
			if (!projectOrTarget.trim() || projectOrTarget.length > 256) throw new Error("INVALID_PROJECT_FILE_TARGET");
			projectId = projectOrTarget;
		} else {
			target = parseProjectFileTarget(projectOrTarget);
			projectId = target.projectId;
		}
		if (options !== undefined && !isRecord(options)) throw new Error("INVALID_FILE_LIST_OPTIONS");
		const listOptions = options === undefined ? {} : options;
		if (Object.keys(listOptions).some((key) => key !== "directory" && key !== "maxDepth")) throw new Error("INVALID_FILE_LIST_OPTIONS");
		if (target && "directory" in listOptions && listOptions.directory !== undefined) throw new Error("INVALID_FILE_LIST_OPTIONS");
		const maxDepth = parseOptionalMaxDepth(listOptions.maxDepth);
		if ("directory" in listOptions && listOptions.directory !== undefined && typeof listOptions.directory !== "string") {
			throw new Error("INVALID_FILE_LIST_OPTIONS");
		}
		const legacyDirectory = typeof listOptions.directory === "string" && listOptions.directory.trim() ? listOptions.directory.trim() : undefined;
		const backend = projectFileBackendRouter.forProject(projectId);
		if (target) return backend.list(target, maxDepth);
		let relativePath = "";
		if (legacyDirectory) {
			const project = projectStore.get(projectId);
			if (!project) throw new Error("PROJECT_NOT_FOUND");
			const boundary = await createProjectFileReadBoundary(toWindowsPath(project.path));
			const directory = await resolveProjectFileReadPath(boundary, toWindowsPath(legacyDirectory));
			relativePath = relative(boundary.canonicalRoot, directory).replace(/\\/g, "/");
		}
		return backend.list({ projectId, relativePath }, maxDepth);
	});

	// 渲染层不可信：查询词必须是有限长度的非空字符串；结果上限与共享常量对齐，防大包滥用。
	const parseFileSearchQuery = (query: unknown): string => {
		if (typeof query !== "string" || query.trim().length === 0 || query.length > 256) {
			throw new Error("Invalid search query");
		}
		return query;
	};

	ipcMain.handle(ipcChannels.filesSearch, async (_event, rawProjectId: unknown, query: unknown): Promise<FileSearchResult[]> => {
		if (typeof rawProjectId !== "string" || !rawProjectId.trim() || rawProjectId.length > 256) throw new Error("INVALID_PROJECT_FILE_TARGET");
		const normalizedQuery = parseFileSearchQuery(query);
		const target = { projectId: rawProjectId, relativePath: "" };
		return projectFileBackendRouter.forProject(rawProjectId).search(target, normalizedQuery);
	});

	ipcMain.handle(ipcChannels.filesOpen, async (_event, path: unknown, scope?: unknown) => {
		const input = parseFilePathInput(path);
		if (typeof input !== "string" && projectFileBackendRouter.forProject(input.projectId).locationKind !== "local") throw new Error("UNSUPPORTED_CAPABILITY");
		const boundary = await resolveProjectReadBoundary(scope);
		const readablePath = await resolveReadablePath(input, boundary);
		const error = await shell.openPath(readablePath);
		// Electron 通过返回字符串报告打开失败；显式抛出后前端才能提示路径不存在或系统无法打开。
		if (error) throw new Error(error);
	});

	ipcMain.handle(ipcChannels.filesShowInFolder, async (_event, path: unknown, scope?: unknown) => {
		const input = parseFilePathInput(path);
		if (typeof input !== "string" && projectFileBackendRouter.forProject(input.projectId).locationKind !== "local") throw new Error("UNSUPPORTED_CAPABILITY");
		// 项目来源必须按 ProjectStore 中的注册根目录重新授权，不能信任 renderer 自报路径。
		const boundary = await resolveProjectReadBoundary(scope);
		const readablePath = await resolveReadablePath(input, boundary);
		shell.showItemInFolder(readablePath);
	});

	ipcMain.handle(ipcChannels.filesReadContent, async (_event, path: unknown, maxBytes?: unknown, scope?: unknown) => {
		const input = parseFilePathInput(path);
		const limit = parseOptionalMaxBytes(maxBytes);
		if (typeof input !== "string") {
			if (scope !== undefined) throw new Error("INVALID_PROJECT_FILE_ACCESS_SCOPE");
			return projectFileBackendRouter.forProject(input.projectId).readContent(input, limit);
		}
		try {
			const boundary = await resolveProjectReadBoundary(scope);
			const readablePath = await resolveReadablePath(input, boundary);
			if (limit !== undefined) {
				const fileStat = await stat(readablePath);
				if (fileStat.size > limit) throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(limit)}`);
			}
			return await readFile(readablePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
			throw error;
		}
	});

	ipcMain.handle(ipcChannels.filesPathsExist, async (_event, paths: unknown, scope?: unknown): Promise<boolean[]> => {
		// 渲染层输入不可信：仅接受字符串数组且限量限长，防大包/超长路径滥用 stat。
		// 上限与渲染层 verdict store 的 BATCH_MAX(96) 对齐并留余量。
		if (!Array.isArray(paths) || paths.length === 0 || paths.length > 128) {
			throw new Error("paths must be a non-empty array (max 128)");
		}
		const normalized: Array<string | ProjectFileTarget> = [];
		for (const raw of paths) {
			if (typeof raw === "string") {
				if (!raw.trim() || raw.length > 1024) throw new Error("each path must be a non-empty string (max 1024 chars)");
				normalized.push(raw);
				continue;
			}
			if (isRecord(raw)) {
				normalized.push(parseProjectFileTarget(raw));
				continue;
			}
			throw new Error("each path must be a local path or ProjectFileTarget");
		}
		if (scope !== undefined && normalized.some((path) => typeof path !== "string")) throw new Error("INVALID_PROJECT_FILE_ACCESS_SCOPE");
		// 项目根 realpath 每批只解析一次；每个目标仍独立 realpath，逐项越界按 false 计。
		const boundary = await resolveProjectReadBoundary(scope);
		return Promise.all(
			normalized.map(async (path) => {
				if (typeof path !== "string") {
					const backend = projectFileBackendRouter.forProject(path.projectId);
					try {
						const [exists] = await backend.pathsExist([path]);
						return exists ?? false;
					} catch {
						return false;
					}
				}
				try {
					const readablePath = await resolveReadablePath(path, boundary);
					const fileStat = await stat(readablePath);
					return fileStat.isFile() || fileStat.isDirectory();
				} catch {
					return false;
				}
			}),
		);
	});

	ipcMain.handle(ipcChannels.filesStat, async (_event, path: unknown, scope?: unknown): Promise<{ exists: boolean; isDirectory: boolean }> => {
		// 会话内文件链接点击路由用：verdict store 只回答「存在与否」，区分不了目录，
		// 而编辑器 readContent 对目录会抛 EISDIR（用户看到的 "illegal operation on a
		// directory" 就是目录链接被当文件读）。这里补一次带边界的 stat 给渲染层分流。
		const input = parseFilePathInput(path);
		if (typeof input !== "string") {
			if (scope !== undefined) throw new Error("INVALID_PROJECT_FILE_ACCESS_SCOPE");
			return projectFileBackendRouter.forProject(input.projectId).stat(input);
		}
		const boundary = await resolveProjectReadBoundary(scope);
		try {
			const readablePath = await resolveReadablePath(input, boundary);
			const fileStat = await stat(readablePath);
			return { exists: true, isDirectory: fileStat.isDirectory() };
		} catch {
			return { exists: false, isDirectory: false };
		}
	});

	ipcMain.handle(ipcChannels.filesWriteContent, async (_event, path: unknown, content: unknown, scope?: unknown) => {
		if (typeof content !== "string") throw new Error("Invalid file content");
		const input = parseFilePathInput(path);
		if (typeof input !== "string") {
			if (scope !== undefined) throw new Error("INVALID_PROJECT_FILE_ACCESS_SCOPE");
			await projectFileBackendRouter.forProject(input.projectId).writeContent(input, content);
			void appLogger.info("file", "Project file written", { target: input, bytes: Buffer.byteLength(content, "utf8") });
			return;
		}
		const boundary = await resolveProjectReadBoundary(scope);
		const writablePath = await resolveReadablePath(input, boundary);
		await writeFile(writablePath, content, "utf8");
		void appLogger.info("file", "File written", {
			path: writablePath,
			bytes: Buffer.byteLength(content, "utf8"),
		});
	});

	ipcMain.handle(ipcChannels.filesReadBase64, async (_event, path: unknown, maxBytes?: unknown, scope?: unknown) => {
		const input = parseFilePathInput(path);
		const limit = parseOptionalMaxBytes(maxBytes);
		if (typeof input !== "string") {
			if (scope !== undefined) throw new Error("INVALID_PROJECT_FILE_ACCESS_SCOPE");
			return projectFileBackendRouter.forProject(input.projectId).readBase64(input, limit);
		}
		try {
			const boundary = await resolveProjectReadBoundary(scope);
			const readablePath = await resolveReadablePath(input, boundary);
			if (limit !== undefined) {
				const fileStat = await stat(readablePath);
				if (fileStat.size > limit) throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(limit)}`);
			}
			return (await readFile(readablePath)).toString("base64");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
			throw error;
		}
	});

	ipcMain.handle(ipcChannels.filesCreate, async (_event, rawParentDir: unknown, name: unknown, type: unknown) => {
		const parentInput = parseFilePathInput(rawParentDir);
		if (typeof name !== "string" || !name.trim() || name.length > 255) throw new Error("Invalid file name");
		if (type !== "file" && type !== "directory") throw new Error("Invalid file type");
		if (typeof parentInput !== "string") {
			const result = await projectFileBackendRouter.forProject(parentInput.projectId).create(parentInput, name, type);
			void appLogger.info("file", "Project file/folder created", { target: result, type });
			return result;
		}
		const parentDir = await resolveReadablePath(parentInput);
		const result = await fileSystemService.create(parentDir, name, type);
		void appLogger.info("file", "File/folder created", { parentDir, name, type, result });
		return result;
	});

	ipcMain.handle(ipcChannels.filesDelete, async (_event, rawPath: unknown, recursive?: unknown) => {
		const pathInput = parseFilePathInput(rawPath);
		if (recursive !== undefined && typeof recursive !== "boolean") throw new Error("Invalid recursive flag");
		try {
			if (typeof pathInput !== "string") {
				await projectFileBackendRouter.forProject(pathInput.projectId).delete(pathInput, recursive);
				void appLogger.info("file", "Project file deleted", { target: pathInput, recursive: Boolean(recursive) });
				return;
			}
			const path = await resolveReadablePath(pathInput);
			await fileSystemService.delete(path, recursive);
			void appLogger.info("file", "File deleted", { path, recursive: Boolean(recursive) });
		} catch (error) {
			void appLogger.error("file", "File delete failed", {
				...(typeof pathInput === "string" ? { path: pathInput } : { target: pathInput }),
				recursive: Boolean(recursive),
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});

	ipcMain.handle(ipcChannels.filesRename, async (_event, rawPath: unknown, newName: unknown) => {
		const pathInput = parseFilePathInput(rawPath);
		if (typeof newName !== "string" || !newName.trim() || newName.length > 255) throw new Error("Invalid file name");
		if (typeof pathInput !== "string") {
			const result = await projectFileBackendRouter.forProject(pathInput.projectId).rename(pathInput, newName);
			void appLogger.info("file", "Project file renamed", { target: pathInput, newName, result });
			return result;
		}
		const path = await resolveReadablePath(pathInput);
		const result = await fileSystemService.rename(path, newName);
		void appLogger.info("file", "File renamed", { path, newName, result });
		return result;
	});

	ipcMain.handle(ipcChannels.filesCopy, async (_event, rawSourcePaths: unknown, rawTargetDir: unknown) => {
		const sourceInputs = parseFilePathInputs(rawSourcePaths);
		const targetDirInput = parseFilePathInput(rawTargetDir);
		const targetSources = sourceInputs.filter((source): source is ProjectFileTarget => typeof source !== "string");
		const targets = [...targetSources, ...(typeof targetDirInput === "string" ? [] : [targetDirInput])];
		const backend = fileBackendForTargets(targets);
		if (typeof targetDirInput !== "string" && targetSources.length === sourceInputs.length) {
			if (!backend) throw new Error("PROJECT_NOT_FOUND");
			return backend.copy(targetSources, targetDirInput);
		}
		if (backend && backend.locationKind !== "local") throw new Error("UNSUPPORTED_CAPABILITY");
		return localFileMutationAdapter.copy(sourceInputs, targetDirInput);
	});

	ipcMain.handle(ipcChannels.filesMove, async (_event, rawSourcePaths: unknown, rawTargetDir: unknown) => {
		const sourceInputs = parseFilePathInputs(rawSourcePaths);
		const targetDirInput = parseFilePathInput(rawTargetDir);
		const targetSources = sourceInputs.filter((source): source is ProjectFileTarget => typeof source !== "string");
		const targets = [...targetSources, ...(typeof targetDirInput === "string" ? [] : [targetDirInput])];
		const backend = fileBackendForTargets(targets);
		if (typeof targetDirInput !== "string" && targetSources.length === sourceInputs.length) {
			if (!backend) throw new Error("PROJECT_NOT_FOUND");
			return backend.move(targetSources, targetDirInput);
		}
		if (backend && backend.locationKind !== "local") throw new Error("UNSUPPORTED_CAPABILITY");
		return localFileMutationAdapter.move(sourceInputs, targetDirInput);
	});
}
