import { ipcMain, shell } from "electron";
import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { projectLocatorFromLegacy } from "../../shared/locationAdapters";
import { isRemoteProject } from "../../shared/projectLocation";
import { codeOf, opFailFromCode, opOk } from "../../shared/op";
import { ipcChannels } from "../../shared/ipc";
import { FILE_TREE_ABSOLUTE_MAX_DEPTH } from "../../shared/fileTree";
import type { ProjectFileAccessScope, ProjectFileTarget } from "../../shared/types/project";
import type { ProjectDirectoryPageResult, ProjectFileStatResult, ProjectPathsExistResult } from "../../shared/types/projectFiles";
import type { FileContentSearchResult, FileSearchResult } from "../../shared/types";
import { detectFileManager, openFileManagerAt } from "../files/FileManager";
import { localTextRevision } from "../files/LocalProjectFileBackend";
import { expandHomeForFileAccess } from "../fs/homePathExpansion";
import { openSystemPath } from "../fs/openPath";
import type { FileIndexService } from "../files/FileIndexService";
import { registerFilesSystemIpc } from "./filesSystemIpc";
import { createProjectFileReadBoundary, resolveProjectFileReadPath, type ProjectFileReadBoundary } from "../files/projectFileAccess";
import { parseProjectFileTarget, resolveLocalProjectFileTarget } from "../files/projectFileTarget";
import { LocalProjectFileBackend } from "../files/LocalProjectFileBackend";
import { WslProjectFileBackend } from "../files/WslProjectFileBackend";
import { assertTrustedStatSize, readTextFileGuarded } from "../files/textFileRead";
import { writeTextFileGuarded } from "../files/textFileWrite";
import { LocalFileMutationAdapter } from "../files/LocalFileMutationAdapter";
import { ProjectFileBackendRouter } from "../files/ProjectFileBackend";
import type { FileSystemService } from "../fs/FileSystemService";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AppLogger } from "../logging/AppLogger";
import { parseWslUncPath, toWslLinuxPath, toWindowsHostPath } from "../wsl/WslPaths";
import { resolveProjectWslIdentity } from "../wsl/WslProjectEnvironment";
import type { WslHelperSessionPool, WslHelperSessionTarget } from "../wsl/WslHelperSession";

/** 二进制预览缺省 64MiB：base64 跨 IPC 会放大内存，必须在主进程限制。 */
const MAX_BINARY_PREVIEW_BYTES = 64 * 1024 * 1024;

export type FilesIpcDeps = {
	fileSystemService: FileSystemService;
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	/** 文件索引 sidecar（可选：未装配时文件名搜索直接走现有 BFS 扫盘）。 */
	getFileIndexService?: () => FileIndexService | null;
	appLogger: Pick<AppLogger, "info" | "error">;
	openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
	/**
	 * 远端文件读的公共入口（T6）：目录页与批量存在性都走只读 fs 面，不经过 entry 令牌。
	 * 未装配时远端目标返回稳定码，不静默回退到本机。
	 */
	remoteFiles?: {
		directoryPage(projectId: string, path: string, force?: boolean): Promise<ProjectDirectoryPageResult>;
		pathsExist(projectId: string, paths: readonly string[]): Promise<ProjectPathsExistResult>;
		/**
		 * 远端内容搜索：按连接 hello 的 `fs.searchContent` 能力路由，旧 helper 返回 `{ok:true,value:null}`
		 * 而不是失败——"这个位置只支持文件名"是能力边界，不是错误。未装配该方法时同样按不支持处理。
		 */
		searchContent?(projectId: string, query: string): Promise<{ ok: true; value: FileContentSearchResult | null } | { ok: false; code: string }>;
	};
	/**
	 * WSL 项目的发行版内 helper 会话池（Wave 1a）。未装配时 WSL 项目保持今天的 UNC 本机行为，
	 * 便于单测与不启动 WSL 的场景维持既有语义。
	 */
	wslHelperPool?: WslHelperSessionPool;
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

export function registerFilesIpc({ fileSystemService, projectStore, settingsStore, getFileIndexService, appLogger, openExternalUrl, remoteFiles, wslHelperPool }: FilesIpcDeps): void {
	registerFilesSystemIpc({ settingsStore, openExternalUrl });
	// Windows Node / Electron 边界不能直接消费 WSL Linux 路径：统一走 WslPaths 转成当前发行版的主机 UNC。
	// 已经是普通 Windows/非 WSL 网络盘的输入保持不变，避免误伤非 WSL 路径。
	const toWindowsPath = (path: string, project?: { environment?: string; wslDistro?: string }): string => {
		if (!path || process.platform !== "win32") return path;
		if (!path.startsWith("/") && !parseWslUncPath(path)) return path;
		const unc = parseWslUncPath(path);
		const distro = unc?.distro ?? (project?.environment === "wsl" ? (project.wslDistro ?? settingsStore.get().wslDistro) : undefined);
		if (distro === undefined || distro.length === 0) return path;
		return toWindowsHostPath(path, { distro });
	};

	// ProjectStore currently returns legacy local records. A locator-bearing future record must
	// not be reinterpreted as local merely because it still has a compatibility `path` field.
	const localProject = (projectId: string) => {
		const project = projectStore.get(projectId);
		if (project && "locator" in project) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		return project;
	};
	const localProjectFileBackend = new LocalProjectFileBackend({
		fileSystemService,
		resolveProjectRoot: (projectId) => {
			const project = localProject(projectId);
			if (!project) throw new Error("PROJECT_NOT_FOUND");
			return toWindowsPath(project.path, project);
		},
	});
	// 文件抽屉的 skipGeneratedDirs 需要透传到 FileSystemService.listTree 的第 4 个选项；
	// 共享 ProjectFileBackend 契约暂不含 list options，这里用同一 local backend 的包装实例承接，
	// 只有 list 路径用得到它（远端 backend 尚未实现该开关，路由仍先经 forProject 拒绝非本地）。
	const localProjectFileBackendWithSkippedGeneratedDirs = new LocalProjectFileBackend({
		fileSystemService: {
			listTree: (root, maxDepth, directory) => fileSystemService.listTree(root, maxDepth, directory, { skipGeneratedDirs: true }),
			listTreePage: (root, maxDepth, directory) => fileSystemService.listTreePage(root, maxDepth, directory, { skipGeneratedDirs: true }),
			searchNames: (root, query) => fileSystemService.searchNames(root, query),
			create: (parentDir, name, type) => fileSystemService.create(parentDir, name, type),
			delete: (targetPath, recursive) => fileSystemService.delete(targetPath, recursive),
			rename: (targetPath, newName) => fileSystemService.rename(targetPath, newName),
		},
		resolveProjectRoot: (projectId) => {
			const project = localProject(projectId);
			if (!project) throw new Error("PROJECT_NOT_FOUND");
			return toWindowsPath(project.path, project);
		},
	});
	/**
	 * WSL 项目的发行版内身份：全部从 ProjectStore + SettingsStore 解析，renderer 不能自报发行版/用户/根。
	 * 档案不可用（非 WSL、未启用、路径不可转换）返回 undefined，读面按今天的 UNC 路径执行。
	 */
	const resolveWslSessionTarget = (projectId: string): WslHelperSessionTarget | undefined => {
		if (process.platform !== "win32") return undefined;
		const settings = settingsStore.get();
		if (settings.wslEnabled !== true) return undefined;
		const project = projectStore.get(projectId);
		if (!project || "locator" in project) return undefined;
		const identity = resolveProjectWslIdentity(project, settings);
		if (identity === undefined) return undefined;
		let root: string;
		try {
			root = toWslLinuxPath(project.path, { distro: identity.distro });
		} catch {
			return undefined;
		}
		// helper 的 --root 拒绝文件系统根：没有项目根就没有 containment 语义。
		if (root === "/") return undefined;
		return { distro: identity.distro, user: identity.user, root };
	};
	const wslProjectFileBackend = wslHelperPool === undefined ? undefined : new WslProjectFileBackend({ pool: wslHelperPool, resolveSessionTarget: resolveWslSessionTarget, fallback: localProjectFileBackend });
	// composer @ 引用的整树扫描额外跳过构建产物；与本地包装实例同源，回退也走同一个跳过口径。
	const wslProjectFileBackendSkipped = wslHelperPool === undefined ? undefined : new WslProjectFileBackend({ pool: wslHelperPool, resolveSessionTarget: resolveWslSessionTarget, fallback: localProjectFileBackendWithSkippedGeneratedDirs, skipGeneratedDirs: true });
	const projectFileBackendRouter = new ProjectFileBackendRouter(
		localProjectFileBackend,
		(projectId) => {
			const project = localProject(projectId);
			return project ? projectLocatorFromLegacy(project) : undefined;
		},
		wslProjectFileBackend,
	);

	/**
	 * issue #426：`~` 必须在落到 fs.* / shell.* 之前展开成家目录绝对路径。
	 * renderer 侧的裸路径可能直接来自模型回复（`~/桌面/x.html`），此前原样进 stat 必然 ENOENT。
	 * 顺序：先展开（WSL 下拿到发行版内 home），再 toWindowsPath 转 UNC。
	 */
	const expandHome = (path: string): string => expandHomeForFileAccess(path, settingsStore.get());

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
		const project = localProject(rawScope.projectId);
		if (!project) throw new Error("PROJECT_NOT_FOUND");
		return createProjectFileReadBoundary(toWindowsPath(project.path, project));
	};

	const resolveReadablePath = async (rawPath: unknown, boundary?: ProjectFileReadBoundary): Promise<string> => {
		if (isRecord(rawPath)) {
			if (boundary) throw new Error("INVALID_PROJECT_FILE_ACCESS_SCOPE");
			const target = parseProjectFileTarget(rawPath);
			const project = localProject(target.projectId);
			if (!project) throw new Error("PROJECT_NOT_FOUND");
			const projectRoot = toWindowsPath(project.path, project);
			const targetPath = resolveLocalProjectFileTarget(projectRoot, target.relativePath);
			const targetBoundary = await createProjectFileReadBoundary(projectRoot);
			return resolveProjectFileReadPath(targetBoundary, targetPath);
		}
		if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.length > 32_768) {
			throw new Error("Invalid file path");
		}
		const hostPath = toWindowsPath(expandHome(rawPath));
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
		if (Object.keys(listOptions).some((key) => key !== "directory" && key !== "maxDepth" && key !== "skipGeneratedDirs")) throw new Error("INVALID_FILE_LIST_OPTIONS");
		if ("skipGeneratedDirs" in listOptions && listOptions.skipGeneratedDirs !== undefined && typeof listOptions.skipGeneratedDirs !== "boolean") throw new Error("INVALID_FILE_LIST_OPTIONS");
		if (target && "directory" in listOptions && listOptions.directory !== undefined) throw new Error("INVALID_FILE_LIST_OPTIONS");
		const maxDepth = parseOptionalMaxDepth(listOptions.maxDepth);
		if ("directory" in listOptions && listOptions.directory !== undefined && typeof listOptions.directory !== "string") {
			throw new Error("INVALID_FILE_LIST_OPTIONS");
		}
		const legacyDirectory = typeof listOptions.directory === "string" && listOptions.directory.trim() ? listOptions.directory.trim() : undefined;
		const backend = projectFileBackendRouter.forProject(projectId);
		// skipGeneratedDirs 是 dev 文件抽屉的默认行为（node_modules/.git 等不展开）；
		// WSL 与本地各有跳过构建产物的包装实例，切换时必须留在同一 backend 家族内。
		const listBackend = listOptions.skipGeneratedDirs !== true ? backend : backend === wslProjectFileBackend && wslProjectFileBackendSkipped !== undefined ? wslProjectFileBackendSkipped : localProjectFileBackendWithSkippedGeneratedDirs;
		// 子目录 ENOENT 是常态竞态（pi-subagents 清理 artifacts/outputs 后，抽屉仍记住展开态）：
		// dev 语义是返回空子树让节点自然落空；backend 只给稳定码，按「是否子目录」在这里翻译。
		//
		// 这里是**唯一**翻译点，且只对 list 成立：根目录缺失必须继续冒泡成 PROJECT_DIRECTORY_MISSING
		// （useProjectSync/useProjectFileTreeController 靠它刷新项目 presence 并提示「目录不存在」）；
		// 而 stat/read/write 等按文件操作命中已消失的子目录时，用户动作指向的对象确实不见了，
		// 折叠成空在 UI 上会变成「静默成功」，因此不做同类翻译。
		const listOrEmpty = async (request: ProjectFileTarget) => {
			try {
				return await listBackend.list(request, maxDepth);
			} catch (error) {
				if (request.relativePath !== "" && error instanceof Error && error.message === "PROJECT_DIRECTORY_MISSING") return [];
				throw error;
			}
		};
		if (target) return await listOrEmpty(target);
		let relativePath = "";
		if (legacyDirectory) {
			const project = localProject(projectId);
			if (!project) throw new Error("PROJECT_NOT_FOUND");
			const boundary = await createProjectFileReadBoundary(toWindowsPath(project.path, project));
			const directory = await resolveProjectFileReadPath(boundary, toWindowsPath(legacyDirectory, project));
			relativePath = relative(boundary.canonicalRoot, directory).replace(/\\/g, "/");
		}
		return await listOrEmpty({ projectId, relativePath });
	});

	let localPageRevision = 0;
	// 公共目录页（T6）：本地/ssh 同一形状；显式 truncated/revision/generation，不伪造本地路径。
	ipcMain.handle(ipcChannels.filesDirectoryPage, async (_event, targetValue: unknown, options?: unknown): Promise<ProjectDirectoryPageResult> => {
		if (options !== undefined && (!isRecord(options) || Object.keys(options).some((key) => key !== "force") || (options.force !== undefined && typeof options.force !== "boolean"))) return opFailFromCode("INVALID_FILE_LIST_OPTIONS");
		let target: ProjectFileTarget;
		try {
			target = parseProjectFileTarget(targetValue);
		} catch (error) {
			return opFailFromCode(codeOf(error, "INVALID_PROJECT_FILE_TARGET"));
		}
		const project = projectStore.get(target.projectId);
		if (project && isRemoteProject(project)) {
			if (!remoteFiles) return opFailFromCode("UNSUPPORTED_PROJECT_LOCATION");
			return await remoteFiles.directoryPage(target.projectId, target.relativePath, isRecord(options) && options.force === true);
		}
		try {
			// 本地与 WSL 共用同一份目录页形状（单层、显式 truncated）；WSL 的读取由 backend 在发行版内完成。
			const backend = projectFileBackendRouter.forProject(target.projectId);
			if (backend.directoryPage === undefined) return opFailFromCode("UNSUPPORTED_PROJECT_LOCATION");
			const page = await backend.directoryPage(target, 2000);
			return opOk({ ...page, revision: (localPageRevision += 1), generation: backend === wslProjectFileBackend ? "wsl" : "local" });
		} catch (error) {
			return opFailFromCode(codeOf(error, "PROJECT_FILE_READ_FAILED"));
		}
	});

	// 渲染层不可信：查询词必须是有限长度的非空字符串；结果上限与共享常量对齐，防大包滥用。
	const parseFileSearchQuery = (query: unknown): string => {
		if (typeof query !== "string" || query.trim().length === 0 || query.length > 256) {
			throw new Error("Invalid search query");
		}
		return query;
	};

	// 文件索引 sidecar 的根：WSL 项目的根是 UNC 路径，宿主侧走 9p 扫盘既慢又容易踩权限，
	// 直接返回空让搜索回退 BFS（与跨会话正文搜索的 WSL 口径一致）。
	const indexRootsFor = (environment: string | undefined, windowsPath: string): string[] => (environment === "wsl" || !windowsPath ? [] : [windowsPath]);

	ipcMain.handle(ipcChannels.filesSearch, async (_event, rawProjectId: unknown, query: unknown): Promise<FileSearchResult[]> => {
		if (typeof rawProjectId !== "string" || !rawProjectId.trim() || rawProjectId.length > 256) throw new Error("INVALID_PROJECT_FILE_TARGET");
		const normalizedQuery = parseFileSearchQuery(query);
		const project = localProject(rawProjectId);
		if (!project) throw new Error("PROJECT_NOT_FOUND");
		const root = toWindowsPath(project.path, project);
		// 索引就绪时走 Go sidecar（评分排序 + 路径段命中）；否则回退实时 BFS 扫盘（fail-open）。
		const fileIndex = getFileIndexService?.() ?? null;
		const roots = fileIndex ? indexRootsFor(project.environment, root) : [];
		if (fileIndex && roots.length > 0) {
			try {
				if (fileIndex.isReady(roots)) {
					const result = await fileIndex.searchNames(roots, normalizedQuery);
					if (result.ok) {
						return result.value.hits.map((hit) => ({ name: hit.name, path: hit.path, relativePath: hit.relativePath, type: hit.type }));
					}
				} else {
					// 未就绪：这次先回退 BFS 保证有结果，同时后台建索引（下一次输入即走索引）。
					fileIndex.warmup(roots);
				}
			} catch (error) {
				void appLogger.error("file", "文件索引检索失败，已回退扫盘", error instanceof Error ? error.message : String(error));
			}
		}
		const target = { projectId: rawProjectId, relativePath: "" };
		return projectFileBackendRouter.forProject(rawProjectId).search(target, normalizedQuery);
	});

	ipcMain.handle(ipcChannels.filesSearchContent, async (_event, rawProjectId: unknown, query: unknown): Promise<FileContentSearchResult | null> => {
		if (typeof rawProjectId !== "string" || !rawProjectId.trim() || rawProjectId.length > 256) throw new Error("INVALID_PROJECT_FILE_TARGET");
		const normalizedQuery = parseFileSearchQuery(query);
		const project = projectStore.get(rawProjectId);
		if (!project) throw new Error("PROJECT_NOT_FOUND");
		// Remote project: the helper's content search is the only content source, and it is capability-gated
		// by the hello answer main already stored. `null` is the honest "this location has no content index"
		// answer the renderer already treats as the name-only fallback.
		if (isRemoteProject(project)) {
			// Optional on purpose: the main assembly adds it in one line, and an absent port means "no content
			// source" (name-only fallback) rather than a crashed handler.
			if (remoteFiles?.searchContent === undefined) return null;
			const remote = await remoteFiles.searchContent(rawProjectId, normalizedQuery);
			if (!remote.ok) {
				void appLogger.error("file", "远端文件内容检索失败", remote.code);
				return null;
			}
			return remote.value;
		}
		// A future non-local, non-ssh locator has no content source either; never reinterpret it as a local path.
		if ("locator" in project) return null;
		const fileIndex = getFileIndexService?.() ?? null;
		if (!fileIndex) return null;
		const roots = indexRootsFor(project.environment, toWindowsPath(project.path, project));
		if (roots.length === 0) return null;
		// 未就绪同样返回 null：渲染层不展示内容分区，索引建好后下一次输入自然出现。
		if (!fileIndex.isReady(roots)) {
			fileIndex.warmup(roots);
			return null;
		}
		try {
			const result = await fileIndex.searchContent(roots, normalizedQuery);
			return result.ok ? result.value : null;
		} catch (error) {
			void appLogger.error("file", "文件内容检索失败", error instanceof Error ? error.message : String(error));
			return null;
		}
	});

	ipcMain.handle(ipcChannels.filesOpen, async (_event, path: unknown, scope?: unknown) => {
		const input = parseFilePathInput(path);
		if (typeof input !== "string" && projectFileBackendRouter.forProject(input.projectId).locationKind !== "local") throw new Error("UNSUPPORTED_CAPABILITY");
		const boundary = await resolveProjectReadBoundary(scope);
		const readablePath = await resolveReadablePath(input, boundary);
		// 走受保护的统一入口：Linux 上 Electron 的 shell.openPath 永不 settle（issue #396），
		// 直接 await 会让本 handler 不回包，渲染层收到 "reply was never sent"。
		const error = await openSystemPath(readablePath);
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
		// 不传参也必须有上界（默认 16MiB；显式入参钳到 64MiB 天花板）。
		// 本地上界与 backend 读取共用同一个 effectiveMax，避免远端/本地两条路出现不同的读取预算。
		const MAX_DEFAULT_READ_BYTES = 16 * 1024 * 1024;
		const MAX_READ_BYTES_CEILING = 64 * 1024 * 1024;
		const requestedMax = typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_DEFAULT_READ_BYTES;
		const effectiveMax = Math.min(requestedMax, MAX_READ_BYTES_CEILING);
		if (typeof input !== "string") {
			if (scope !== undefined) throw new Error("INVALID_PROJECT_FILE_ACCESS_SCOPE");
			return projectFileBackendRouter.forProject(input.projectId).readContent(input, effectiveMax);
		}
		try {
			const boundary = await resolveProjectReadBoundary(scope);
			const readablePath = await resolveReadablePath(input, boundary);
			// 结构化前缀供渲染层识别后走 i18n 文案；message 不直接展示给用户。
			// 大小可信性与文本性判定统一收在 readTextFileGuarded，不将异常元数据直接当成普通大文件。
			return await readTextFileGuarded(readablePath, effectiveMax);
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
		// 远端目标走只读 statMany（≤64/帧，不签任何令牌）；本地目标仍走本地 fs。
		const remoteState = new Map<string, boolean>();
		if (remoteFiles !== undefined) {
			const byProject = new Map<string, ProjectFileTarget[]>();
			for (const path of normalized) {
				if (typeof path === "string") continue;
				const project = projectStore.get(path.projectId);
				if (project === undefined || !isRemoteProject(project)) continue;
				const targets = byProject.get(path.projectId) ?? [];
				targets.push(path);
				byProject.set(path.projectId, targets);
			}
			for (const [projectId, targets] of byProject) {
				const result = await remoteFiles.pathsExist(
					projectId,
					targets.map((target) => target.relativePath),
				);
				for (const target of targets) remoteState.set(projectId + "\u0000" + target.relativePath, result.ok ? (result.value.find((state) => state.target.relativePath === target.relativePath)?.exists ?? false) : false);
			}
		}
		// 项目根 realpath 每批只解析一次；每个目标仍独立 realpath，逐项越界按 false 计。
		const boundary = await resolveProjectReadBoundary(scope);
		return Promise.all(
			normalized.map(async (path) => {
				if (typeof path !== "string") {
					const remote = remoteState.get(path.projectId + "\u0000" + path.relativePath);
					if (remote !== undefined) return remote;
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

	ipcMain.handle(ipcChannels.filesStat, async (_event, path: unknown, scope?: unknown): Promise<ProjectFileStatResult> => {
		// 会话内文件链接点击路由用：verdict store 只回答「存在与否」，区分不了目录，
		// 而编辑器 readContent 对目录会抛 EISDIR（用户看到的 "illegal operation on a
		// directory" 就是目录链接被当文件读）。这里补一次带边界的 stat 给渲染层分流。
		const input = parseFilePathInput(path);
		if (typeof input !== "string") {
			if (scope !== undefined) throw new Error("INVALID_PROJECT_FILE_ACCESS_SCOPE");
			const project = projectStore.get(input.projectId);
			if (project !== undefined && isRemoteProject(project)) {
				if (!remoteFiles) return { availability: "unavailable", exists: false, isDirectory: false, code: "REMOTE_FILES_UNAVAILABLE" };
				const result = await remoteFiles.pathsExist(input.projectId, [input.relativePath]);
				if (!result.ok) return { availability: "unavailable", exists: false, isDirectory: false, code: result.code };
				const state = result.value[0];
				if (state === undefined) return { availability: "unavailable", exists: false, isDirectory: false, code: "PROJECT_FILE_STAT_UNAVAILABLE" };
				if (state.exists) return { availability: "present", exists: true, isDirectory: state.isDirectory };
				return { availability: "missing", exists: false, isDirectory: false, code: "PATH_NOT_FOUND" };
			}
			return projectFileBackendRouter.forProject(input.projectId).stat(input);
		}
		const boundary = await resolveProjectReadBoundary(scope);
		try {
			const readablePath = await resolveReadablePath(input, boundary);
			const fileStat = await stat(readablePath);
			return { availability: "present", exists: true, isDirectory: fileStat.isDirectory() };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { availability: "missing", exists: false, isDirectory: false, code: "ENOENT" };
			return { availability: "unavailable", exists: false, isDirectory: false, code: codeOf(error, "PROJECT_FILE_STAT_UNAVAILABLE") };
		}
	});

	ipcMain.handle(ipcChannels.filesWriteContent, async (_event, path: unknown, content: unknown, scope?: unknown, expectedRevision?: unknown) => {
		if (typeof content !== "string") throw new Error("Invalid file content");
		if (expectedRevision !== undefined && typeof expectedRevision !== "string") throw new Error("INVALID_FILE_REVISION");
		const revision = expectedRevision as string | undefined;
		const input = parseFilePathInput(path);
		if (typeof input !== "string") {
			if (scope !== undefined) throw new Error("INVALID_PROJECT_FILE_ACCESS_SCOPE");
			await projectFileBackendRouter.forProject(input.projectId).writeContent(input, content, revision);
			void appLogger.info("file", "Project file written", { target: input, bytes: Buffer.byteLength(content, "utf8") });
			return;
		}
		const boundary = await resolveProjectReadBoundary(scope);
		const writablePath = await resolveReadablePath(input, boundary);
		// 显式路径分支同样做乐观锁：调用方带了修订指纹就要求盘上仍是那一份。
		if (revision !== undefined && (await localTextRevision(writablePath)) !== revision) throw new Error("PROJECT_FILE_CHANGED");
		// 走共享写守卫：盘上当前字节不是文本（加密容器/二进制）时拒绝写，且原子替换不留半截文件。
		await writeTextFileGuarded(writablePath, content);
		void appLogger.info("file", "File written", {
			path: writablePath,
			bytes: Buffer.byteLength(content, "utf8"),
		});
	});

	ipcMain.handle(ipcChannels.filesReadBase64, async (_event, path: unknown, maxBytes?: unknown, scope?: unknown) => {
		const input = parseFilePathInput(path);
		const limit = parseOptionalMaxBytes(maxBytes);
		// 二进制预览（图片/PDF 等）读为 base64 由渲染层转 Blob URL 显示。粘贴图片等场景传
		// maxBytes 预检；未传时（文件抽屉预览）强制默认上限，两种都先 stat 拦截——base64 +
		// IPC 过桥会放大约 1.33 倍且两侧各持一份，不能无界读。
		const effectiveMaxBytes = limit ?? MAX_BINARY_PREVIEW_BYTES;
		if (typeof input !== "string") {
			if (scope !== undefined) throw new Error("INVALID_PROJECT_FILE_ACCESS_SCOPE");
			return projectFileBackendRouter.forProject(input.projectId).readBase64(input, effectiveMaxBytes);
		}
		try {
			const boundary = await resolveProjectReadBoundary(scope);
			const readablePath = await resolveReadablePath(input, boundary);
			const fileStat = await stat(readablePath);
			assertTrustedStatSize(fileStat.size);
			if (fileStat.size > effectiveMaxBytes) throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(effectiveMaxBytes)}`);
			// 渲染层对空串（ENOENT）走「不支持」提示。
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
