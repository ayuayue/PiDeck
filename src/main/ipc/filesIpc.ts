import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import { homedir } from "node:os";
import { cp, readFile, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type { FileManagerInfo, ProjectFileAccessScope } from "../../shared/types/project";
import type { FileContentSearchResult, FileSearchResult } from "../../shared/types";
import { detectFileManager, openFileManagerAt } from "../files/FileManager";
import { openSystemPath } from "../fs/openPath";
import type { FileIndexService } from "../files/FileIndexService";
import { createProjectFileReadBoundary, resolveProjectFileReadPath, type ProjectFileReadBoundary } from "../files/projectFileAccess";
import type { FileSystemService } from "../fs/FileSystemService";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AppLogger } from "../logging/AppLogger";
import { parseWslUncPath, toWindowsHostPath } from "../wsl/WslPaths";

/**
 * filesReadBase64 未显式传 maxBytes 时的默认读取上限（64MB）。
 * 文件抽屉二进制预览走的是无参调用，而 base64 + IPC 过桥会把体积放大约 1.33 倍且两侧各持
 * 一份；上限必须在主进程侧兜底（渲染层输入不可信），防单点无界读把内存推到数百 MB。
 */
const MAX_BINARY_PREVIEW_BYTES = 64 * 1024 * 1024;

export type FilesIpcDeps = {
	fileSystemService: FileSystemService;
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	/** 文件索引 sidecar（可选：未装配时文件名搜索直接走现有 BFS 扫盘）。 */
	getFileIndexService?: () => FileIndexService | null;
	appLogger: Pick<AppLogger, "info" | "error">;
	getMainWindow: () => BrowserWindow | null;
	openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
};

export function registerFilesIpc({ fileSystemService, projectStore, settingsStore, getFileIndexService, appLogger, getMainWindow, openExternalUrl }: FilesIpcDeps): void {
	// Windows Node / Electron 边界不能直接消费 WSL Linux 路径：统一走 WslPaths 转成当前发行版的主机 UNC。
	// 已经是普通 Windows/非 WSL 网络盘的输入保持不变，避免误伤非 WSL 路径。
	const toWindowsPath = (path: string): string => {
		if (!path || process.platform !== "win32") return path;
		const settings = settingsStore.get();
		if (!settings.wslEnabled || !settings.wslDistro) return path;
		if (!path.startsWith("/") && !parseWslUncPath(path)) return path;
		return toWindowsHostPath(path, { distro: settings.wslDistro });
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
		if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.length > 32_768) {
			throw new Error("Invalid file path");
		}
		const hostPath = toWindowsPath(rawPath);
		return boundary ? resolveProjectFileReadPath(boundary, hostPath) : hostPath;
	};

	ipcMain.handle(ipcChannels.dialogPickFiles, async (_event, options?: { title?: string; includeDirectories?: boolean }) => {
		const result = await dialog.showOpenDialog({
			// 调用方传入经过 i18n 的标题；缺省时交由系统使用平台默认文案。
			title: options?.title,
			// Windows 上 openFile 与 openDirectory 并存会退化为「只选文件夹」（FOS_PICKFOLDERS），
			// 附件引用场景以选文件为主，默认只开文件；目录选择由调用方显式开启。
			properties: options?.includeDirectories ? ["openFile", "openDirectory", "multiSelections"] : ["openFile", "multiSelections"],
		});
		return result.canceled ? [] : result.filePaths;
	});

	ipcMain.handle(ipcChannels.filesList, async (_event, projectId: string, options?: { maxDepth?: number; directory?: string; skipGeneratedDirs?: boolean }) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const maxDepth = typeof options?.maxDepth === "number" && Number.isFinite(options.maxDepth) ? options.maxDepth : undefined;
		const directory = typeof options?.directory === "string" && options.directory.trim() ? options.directory.trim() : undefined;
		// directory 必须落在项目内；越界由 FileSystemService.listTree 拒绝。
		const projectPath = toWindowsPath(project.path);
		try {
			return await fileSystemService.listTree(projectPath, maxDepth, directory, { skipGeneratedDirs: options?.skipGeneratedDirs === true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// 项目根被外部删除时用稳定错误码替代 Node/Electron 的整段 ENOENT scandir，
			// 渲染层据此清空陈旧文件树、刷新项目 presence，并显示可操作的本地化提示。
			if (!directory) throw new Error("PROJECT_DIRECTORY_MISSING");
			// 子目录 ENOENT 是常态竞态而非异常：典型如 pi-subagents 运行后清理 artifacts/outputs，
			// 而文件抽屉记住的展开态仍指向它。返回空子树让节点自然落空；裸抛会在每次打开
			// 会话时打主进程 handler 报错，且抽屉把节点标成「加载失败」误导用户以为文件丢了。
			return [];
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

	ipcMain.handle(ipcChannels.filesSearch, async (_event, projectId: string, query: string): Promise<FileSearchResult[]> => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const normalizedQuery = parseFileSearchQuery(query);
		const root = toWindowsPath(project.path);
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
		return fileSystemService.searchNames(root, normalizedQuery);
	});

	ipcMain.handle(ipcChannels.filesSearchContent, async (_event, projectId: string, query: string): Promise<FileContentSearchResult | null> => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const normalizedQuery = parseFileSearchQuery(query);
		const fileIndex = getFileIndexService?.() ?? null;
		if (!fileIndex) return null;
		const roots = indexRootsFor(project.environment, toWindowsPath(project.path));
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
		const boundary = await resolveProjectReadBoundary(scope);
		const readablePath = await resolveReadablePath(path, boundary);
		// 走受保护的统一入口：Linux 上 Electron 的 shell.openPath 永不 settle（issue #396），
		// 直接 await 会让本 handler 不回包，渲染层收到 "reply was never sent"。
		const error = await openSystemPath(readablePath);
		// Electron 通过返回字符串报告打开失败；显式抛出后前端才能提示路径不存在或系统无法打开。
		if (error) throw new Error(error);
	});

	ipcMain.handle(ipcChannels.filesShowInFolder, async (_event, path: unknown, scope?: unknown) => {
		// 项目来源必须按 ProjectStore 中的注册根目录重新授权，不能信任 renderer 自报路径。
		const boundary = await resolveProjectReadBoundary(scope);
		const readablePath = await resolveReadablePath(path, boundary);
		shell.showItemInFolder(readablePath);
	});

	ipcMain.handle(ipcChannels.filesDetectFileManager, async (): Promise<FileManagerInfo | null> => {
		// 「打开方式」下拉补充入口：返回当前平台可用的文件管理器信息（含 logo id 与启动命令）。
		// Windows 用系统资源管理器真实图标（explorer.exe 的 ICO），渲染层直接展示。
		const info = detectFileManager();
		if (info?.id === "windows-explorer") {
			const explorerPath = join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe");
			const icon = await app.getFileIcon(explorerPath, { size: "large" });
			if (!icon.isEmpty()) info.iconDataUrl = icon.toDataURL();
		}
		return info;
	});

	ipcMain.handle(ipcChannels.filesOpenFileManager, async (_event, path: string) => {
		// 打开方式 → 文件管理器：目录交给系统文件管理器（explorer / Finder 等）。
		// 空路径（未绑定激活项目）回退用户主目录：文件管理器是常驻快捷入口，不依赖项目。
		// Windows/macOS 必须走 shell.openPath：直接 spawn explorer.exe 时，新进程把
		// 「打开目录」转交给已在运行的 Explorer shell，既不继承前台激活权限也不弹窗，
		// 窗口落在后台/根本不出现（表现就是「点了没反应」，用户侧还会越点堆越多
		// 后台窗口）；shell.openPath 经 ShellExecute 打开，前台语义正确。
		// Linux 保留检测到的文件管理器直启（xdg-open 可能被 MIME 误路由到浏览器）。
		const target = typeof path === "string" && path.trim() ? toWindowsPath(path) : homedir();
		if (process.platform !== "linux") {
			const error = await openSystemPath(target);
			if (error) throw new Error(error);
			return;
		}
		await openFileManagerAt(target);
	});

	ipcMain.handle(ipcChannels.browserOpenExternal, async (_event, url: string) => {
		// This IPC is renderer-callable, so it must share the protocol gate used by
		// every other external-link path instead of passing arbitrary schemes to the OS.
		await openExternalUrl(url, true);
	});

	ipcMain.handle(ipcChannels.filesReadContent, async (_event, path: unknown, maxBytes?: number, scope?: unknown) => {
		try {
			const boundary = await resolveProjectReadBoundary(scope);
			const readablePath = await resolveReadablePath(path, boundary);
			// 编辑器场景传入 maxBytes（maxEditorFileSizeMB 设置项，默认 5MiB）：读取前先 stat 拦截，
			// 避免大文件全量读入主进程再经 IPC 传输（几百 MB 字符串会同时压垮两侧内存）。
			// 不传参的调用方（技能/提示词/DSH 配置小文件）过去完全没有上界——渲染层一旦
			// 指到任意大文件就会把主进程内存打爆（与会话文件「大会话闪退」同族）；
			// 这里给默认 16MiB（远超技能/提示词真实体量），显式入参再钳到 64MiB 天花板
			// （JS 字符串超 64MiB 渲染层本身也吃不消，与二进制预览同族预算）。
			const MAX_DEFAULT_READ_BYTES = 16 * 1024 * 1024;
			const MAX_READ_BYTES_CEILING = 64 * 1024 * 1024;
			const requestedMax = typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_DEFAULT_READ_BYTES;
			const effectiveMax = Math.min(requestedMax, MAX_READ_BYTES_CEILING);
			{
				const fileStat = await stat(readablePath);
				if (fileStat.size > effectiveMax) {
					// 结构化前缀供渲染层识别后走 i18n 文案；message 不直接展示给用户
					throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(effectiveMax)}`);
				}
			}
			return await readFile(readablePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return "";
			}
			throw error;
		}
	});

	ipcMain.handle(ipcChannels.filesPathsExist, async (_event, paths: unknown, scope?: unknown): Promise<boolean[]> => {
		// 渲染层输入不可信：仅接受字符串数组且限量限长，防大包/超长路径滥用 stat。
		// 上限与渲染层 verdict store 的 BATCH_MAX(96) 对齐并留余量。
		if (!Array.isArray(paths) || paths.length === 0 || paths.length > 128) {
			throw new Error("paths must be a non-empty array (max 128)");
		}
		const normalized: string[] = [];
		for (const raw of paths) {
			if (typeof raw !== "string" || !raw.trim() || raw.length > 1024) {
				throw new Error("each path must be a non-empty string (max 1024 chars)");
			}
			normalized.push(raw);
		}
		// 项目根 realpath 每批只解析一次；每个目标仍独立 realpath，逐项越界按 false 计。
		const boundary = await resolveProjectReadBoundary(scope);
		return Promise.all(
			normalized.map(async (path) => {
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
		const boundary = await resolveProjectReadBoundary(scope);
		const readablePath = await resolveReadablePath(path, boundary);
		try {
			const fileStat = await stat(readablePath);
			return { exists: true, isDirectory: fileStat.isDirectory() };
		} catch {
			return { exists: false, isDirectory: false };
		}
	});

	ipcMain.handle(ipcChannels.filesWriteContent, async (_event, path: unknown, content: unknown, scope?: unknown) => {
		if (typeof content !== "string") throw new Error("Invalid file content");
		const boundary = await resolveProjectReadBoundary(scope);
		// 已存在的项目文件沿用读取边界的 realpath 校验，阻止 tab 打开后替换 symlink 再保存越界。
		const writablePath = await resolveReadablePath(path, boundary);
		await writeFile(writablePath, content, "utf8");
		void appLogger.info("file", "File written", {
			path: writablePath,
			bytes: Buffer.byteLength(content, "utf8"),
		});
	});

	ipcMain.handle(ipcChannels.filesReadBase64, async (_event, path: unknown, maxBytes?: number, scope?: unknown) => {
		try {
			const boundary = await resolveProjectReadBoundary(scope);
			const readablePath = await resolveReadablePath(path, boundary);
			// 二进制预览（图片/PDF 等）读为 base64 由渲染层转 Blob URL 显示。粘贴图片等场景
			// 传 maxBytes 预检；未传时（文件抽屉预览）强制默认上限，两种都先 stat 拦截，
			// 避免全量读入主进程再经 IPC 传输压垮两侧内存（与 filesReadContent 同一策略）。
			const effectiveMaxBytes = typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_BINARY_PREVIEW_BYTES;
			const fileStat = await stat(readablePath);
			if (fileStat.size > effectiveMaxBytes) {
				// 结构化前缀供渲染层识别后走 i18n 文案；message 不直接展示给用户
				throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(effectiveMaxBytes)}`);
			}
			// 渲染层对空串（ENOENT）走「不支持」提示。
			const buffer = await readFile(readablePath);
			return buffer.toString("base64");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return "";
			}
			throw error;
		}
	});

	ipcMain.handle(ipcChannels.filesCreate, async (_event, parentDir: string, name: string, type: "file" | "directory") => {
		const result = await fileSystemService.create(toWindowsPath(parentDir), name, type);
		void appLogger.info("file", "File/folder created", { parentDir, name, type, result });
		return result;
	});

	ipcMain.handle(ipcChannels.filesDelete, async (_event, path: string, recursive?: boolean) => {
		try {
			await fileSystemService.delete(toWindowsPath(path), recursive);
			void appLogger.info("file", "File deleted", { path, recursive: Boolean(recursive) });
		} catch (error) {
			// 删除失败同样留痕（回收站不可用/权限不足/路径不存在等），
			// 保证"谁发起的删除、为什么没删掉"可事后审计。
			void appLogger.error("file", "File delete failed", {
				path,
				recursive: Boolean(recursive),
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});

	ipcMain.handle(ipcChannels.filesRename, async (_event, path: string, newName: string) => {
		const result = await fileSystemService.rename(toWindowsPath(path), newName);
		void appLogger.info("file", "File renamed", { path, newName, result });
		return result;
	});

	ipcMain.handle(ipcChannels.filesCopy, async (_event, sourcePaths: string[], targetDir: string) => {
		const hostTargetDir = toWindowsPath(targetDir);
		const results: string[] = [];
		for (const src of sourcePaths) {
			try {
				const hostSrc = toWindowsPath(src);
				const name = basename(hostSrc);
				const dest = join(hostTargetDir, name);
				// 递归复制目录/文件；同名已存在时跳过覆盖（errorOnExist: false 反而报错，
				// 这里语义为「已存在则不重复复制」——与资源管理器粘贴行为一致）
				await cp(hostSrc, dest, { recursive: true, errorOnExist: false });
				results.push(dest);
				void appLogger.info("file", "File/folder copied", { src, dest });
			} catch (error) {
				void appLogger.info("file", "File copy failed", { src, targetDir, error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		}
		return results;
	});

	ipcMain.handle(ipcChannels.filesMove, async (_event, sourcePaths: string[], targetDir: string) => {
		const hostTargetDir = toWindowsPath(targetDir);
		const results: string[] = [];
		for (const src of sourcePaths) {
			try {
				const hostSrc = toWindowsPath(src);
				const name = basename(hostSrc);
				const dest = join(hostTargetDir, name);
				// 同设备优先 rename（瞬时）；跨设备/跨盘 rename 会报 EXDEV，回退 cp + rm
				try {
					await fsRename(hostSrc, dest);
				} catch {
					await cp(hostSrc, dest, { recursive: true });
					await rm(hostSrc, { recursive: true, force: true });
				}
				results.push(dest);
				void appLogger.info("file", "File/folder moved", { src, dest });
			} catch (error) {
				void appLogger.info("file", "File move failed", { src, targetDir, error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		}
		return results;
	});
}
