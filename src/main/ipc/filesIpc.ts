import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import { homedir } from "node:os";
import { cp, readFile, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type { FileManagerInfo, ProjectFileAccessScope } from "../../shared/types/project";
import { detectFileManager, openFileManagerAt } from "../files/FileManager";
import {
	createProjectFileReadBoundary,
	resolveProjectFileReadPath,
	type ProjectFileReadBoundary,
} from "../files/projectFileAccess";
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
	getMainWindow: () => BrowserWindow | null;
	openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
};

export function registerFilesIpc({
	fileSystemService,
	projectStore,
	settingsStore,
	appLogger,
	getMainWindow,
	openExternalUrl,
}: FilesIpcDeps): void {
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
	const resolveProjectReadBoundary = async (
		rawScope?: unknown,
	): Promise<ProjectFileReadBoundary | undefined> => {
		if (rawScope === undefined) return undefined;
		if (!isProjectFileAccessScope(rawScope)) {
			throw new Error("INVALID_PROJECT_FILE_ACCESS_SCOPE");
		}
		const project = projectStore.get(rawScope.projectId);
		if (!project) throw new Error("PROJECT_NOT_FOUND");
		return createProjectFileReadBoundary(toWindowsPath(project.path));
	};

	const resolveReadablePath = async (
		rawPath: unknown,
		boundary?: ProjectFileReadBoundary,
	): Promise<string> => {
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
			properties: options?.includeDirectories
				? ["openFile", "openDirectory", "multiSelections"]
				: ["openFile", "multiSelections"],
		});
		return result.canceled ? [] : result.filePaths;
	});

	ipcMain.handle(
		ipcChannels.filesList,
		async (
			_event,
			projectId: string,
			options?: { maxDepth?: number; directory?: string },
		) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const maxDepth = typeof options?.maxDepth === "number" && Number.isFinite(options.maxDepth)
			? options.maxDepth
			: undefined;
		const directory = typeof options?.directory === "string" && options.directory.trim()
			? options.directory.trim()
			: undefined;
		// directory 必须落在项目内；越界由 FileSystemService.listTree 拒绝。
		const projectPath = toWindowsPath(project.path);
		try {
			return await fileSystemService.listTree(projectPath, maxDepth, directory);
		} catch (error) {
			// 项目根被外部删除时用稳定错误码替代 Node/Electron 的整段 ENOENT scandir，
			// 渲染层据此清空陈旧文件树、刷新项目 presence，并显示可操作的本地化提示。
			if (!directory && (error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new Error("PROJECT_DIRECTORY_MISSING");
			}
			throw error;
		}
	});

	ipcMain.handle(ipcChannels.filesOpen, async (_event, path: string) => {
		const error = await shell.openPath(toWindowsPath(path));
		// Electron 通过返回字符串报告打开失败；显式抛出后前端才能提示路径不存在或系统无法打开。
		if (error) throw new Error(error);
	});

	ipcMain.handle(ipcChannels.filesShowInFolder, async (_event, path: string) => {
		// 回归修复（30b6954b 误删）：渲染层「在文件夹中显示」依赖此通道，
		// 缺失时 invoke 会抛 No handler registered。WSL 路径先转 Windows 再定位。
		shell.showItemInFolder(toWindowsPath(path));
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
			const error = await shell.openPath(target);
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

	ipcMain.handle(
		ipcChannels.filesReadContent,
		async (_event, path: unknown, maxBytes?: number, scope?: unknown) => {
			try {
				const boundary = await resolveProjectReadBoundary(scope);
				const readablePath = await resolveReadablePath(path, boundary);
				// 编辑器场景传入 maxBytes（maxEditorFileSizeMB 设置项）：读取前先 stat 拦截，
				// 避免大文件全量读入主进程再经 IPC 传输（几百 MB 字符串会同时压垮两侧内存）。
				// 其他调用方（技能/提示词小文件）不传参，行为不变。
				if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0) {
					const fileStat = await stat(readablePath);
					if (fileStat.size > maxBytes) {
						// 结构化前缀供渲染层识别后走 i18n 文案；message 不直接展示给用户
						throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(maxBytes)}`);
					}
				}
				return await readFile(readablePath, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					return "";
				}
				throw error;
			}
		},
	);

	ipcMain.handle(
		ipcChannels.filesPathsExist,
		async (_event, paths: unknown, scope?: unknown): Promise<boolean[]> => {
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
			return Promise.all(normalized.map(async (path) => {
				try {
					const readablePath = await resolveReadablePath(path, boundary);
					const fileStat = await stat(readablePath);
					return fileStat.isFile() || fileStat.isDirectory();
				} catch {
					return false;
				}
			}));
		},
	);

	ipcMain.handle(
		ipcChannels.filesWriteContent,
		async (_event, path: unknown, content: unknown, scope?: unknown) => {
			if (typeof content !== "string") throw new Error("Invalid file content");
			const boundary = await resolveProjectReadBoundary(scope);
			// 已存在的项目文件沿用读取边界的 realpath 校验，阻止 tab 打开后替换 symlink 再保存越界。
			const writablePath = await resolveReadablePath(path, boundary);
			await writeFile(writablePath, content, "utf8");
			void appLogger.info("file", "File written", {
				path: writablePath,
				bytes: Buffer.byteLength(content, "utf8"),
			});
		},
	);

	ipcMain.handle(
		ipcChannels.filesReadBase64,
		async (_event, path: unknown, maxBytes?: number, scope?: unknown) => {
			try {
				const boundary = await resolveProjectReadBoundary(scope);
				const readablePath = await resolveReadablePath(path, boundary);
				// 粘贴图片等场景传入 maxBytes 预检：超大文件在 stat 层拦截，
				// 避免全量读入主进程再经 IPC 传输压垮两侧内存（与 filesReadContent 同一策略）。
				if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0) {
					const fileStat = await stat(readablePath);
					if (fileStat.size > maxBytes) {
						// 结构化前缀供渲染层识别后走回退逻辑；message 不直接展示给用户
						throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(maxBytes)}`);
					}
				}
				// 二进制预览（图片/PDF 等）：读为 base64 由渲染层转 Blob URL 显示。
				// 渲染层对空串（ENOENT）走「不支持」提示。
				const buffer = await readFile(readablePath);
				return buffer.toString("base64");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					return "";
				}
				throw error;
			}
		},
	);

	ipcMain.handle(
		ipcChannels.filesCreate,
		async (_event, parentDir: string, name: string, type: "file" | "directory") => {
			const result = await fileSystemService.create(toWindowsPath(parentDir), name, type);
			void appLogger.info("file", "File/folder created", { parentDir, name, type, result });
			return result;
		},
	);

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

	ipcMain.handle(
		ipcChannels.filesCopy,
		async (_event, sourcePaths: string[], targetDir: string) => {
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
		},
	);

	ipcMain.handle(
		ipcChannels.filesMove,
		async (_event, sourcePaths: string[], targetDir: string) => {
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
		},
	);

}
