import { dialog, ipcMain, shell, type BrowserWindow } from "electron";
import { cp, readFile, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
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
	// Windows Node 的 fs/Electron 边界不能消费 WSL Linux 路径：/mnt/<drive> 要回到
	// 盘符，/home/... 与 UNC 则要统一为当前发行版的 canonical UNC。已经是普通
	// Windows/网络路径的输入保持不变，避免误把用户的非 WSL 网络盘当成 Linux 路径。
	const toWindowsPath = (path: string): string => {
		if (!path || process.platform !== "win32") return path;
		const settings = settingsStore.get();
		if (!settings.wslEnabled || !settings.wslDistro) return path;
		if (!path.startsWith("/") && !parseWslUncPath(path)) return path;
		return toWindowsHostPath(path, { distro: settings.wslDistro });
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

	ipcMain.handle(ipcChannels.filesList, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return fileSystemService.listTree(toWindowsPath(project.path));
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

	ipcMain.handle(ipcChannels.browserOpenExternal, async (_event, url: string) => {
		// This IPC is renderer-callable, so it must share the protocol gate used by
		// every other external-link path instead of passing arbitrary schemes to the OS.
		await openExternalUrl(url, true);
	});

	ipcMain.handle(ipcChannels.filesReadContent, async (_event, path: string, maxBytes?: number) => {
		try {
			// 编辑器场景传入 maxBytes（maxEditorFileSizeMB 设置项）：读取前先 stat 拦截，
			// 避免大文件全量读入主进程再经 IPC 传输（几百 MB 字符串会同时压垮两侧内存）。
			// 其他调用方（技能/提示词小文件）不传参，行为不变。
			if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0) {
				const fileStat = await stat(toWindowsPath(path));
				if (fileStat.size > maxBytes) {
					// 结构化前缀供渲染层识别后走 i18n 文案；message 不直接展示给用户
					throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(maxBytes)}`);
				}
			}
			return await readFile(toWindowsPath(path), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return "";
			}
			throw error;
		}
	});

	ipcMain.handle(ipcChannels.filesWriteContent, async (_event, path: string, content: string) => {
		await writeFile(toWindowsPath(path), content, "utf8");
		void appLogger.info("file", "File written", { path, bytes: Buffer.byteLength(content, "utf8") });
	});

	ipcMain.handle(ipcChannels.filesReadBase64, async (_event, path: string, maxBytes?: number) => {
		try {
			// 粘贴图片等场景传入 maxBytes 预检：超大文件在 stat 层拦截，
			// 避免全量读入主进程再经 IPC 传输压垮两侧内存（与 filesReadContent 同一策略）。
			if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0) {
				const fileStat = await stat(toWindowsPath(path));
				if (fileStat.size > maxBytes) {
					// 结构化前缀供渲染层识别后走回退逻辑；message 不直接展示给用户
					throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(maxBytes)}`);
				}
			}
			// 二进制预览（图片/PDF 等）：读为 base64 由渲染层转 Blob URL 显示。
			// 渲染层对空串（ENOENT）走「不支持」提示。
			const buffer = await readFile(toWindowsPath(path));
			return buffer.toString("base64");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return "";
			}
			throw error;
		}
	});

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
