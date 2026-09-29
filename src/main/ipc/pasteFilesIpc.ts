import { app, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import { isLocalProject } from "../../shared/projectLocation";
import type { PasteFileWriteInput, PasteFileWriteResult } from "../../shared/types";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AppLogger } from "../logging/AppLogger";
import { parseWslUncPath, toWindowsHostPath } from "../wsl/WslPaths";

export type PasteFilesIpcDeps = {
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	appLogger: Pick<AppLogger, "info" | "error">;
};

/** 历史项目内粘贴目录名（仅用于清理/删除白名单；新写入不再落这里，避免污染仓库）。 */
export const PROJECT_PASTE_DIR = ".pideck-paste";
/** 粘贴文件落盘目录（userData 下，与日志同属应用数据；发送时折叠为原样文本内联）。 */
export const USER_PASTE_DIR = "paste-files";
/** 启动清理保留期：超过 7 天的粘贴文件视为失效（会话结束后一般不再需要）。 */
const PASTE_FILE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function isSamePath(left: string, right: string): boolean {
	return resolve(left) === resolve(right);
}

export function registerPasteFilesIpc({ projectStore, settingsStore, appLogger }: PasteFilesIpcDeps): () => Promise<number> {
	// 与 filesIpc 同一套 WSL 路径转换：WSL 会话的 projectPath 是 Linux 路径，
	// 落盘必须转成当前发行版可挂载的主机 UNC；返回给渲染层/p做 @ 引用的仍是原路径。
	const toWindowsPath = (path: string): string => {
		if (!path || process.platform !== "win32") return path;
		const settings = settingsStore.get();
		if (!settings.wslEnabled || !settings.wslDistro) return path;
		if (!path.startsWith("/") && !parseWslUncPath(path)) return path;
		return toWindowsHostPath(path, { distro: settings.wslDistro });
	};

	const userPasteRoot = (): string => join(app.getPath("userData"), USER_PASTE_DIR);

	/**
	 * 校验 projectPath：空串=匿名；非空必须是已登记项目根（防任意路径写入）。
	 * 新写入一律落到 userData/paste-files——项目内 .pideck-paste 会进 git 状态、
	 * 也没有设置页清理入口；userData 与日志同目录，可由设置统一清理。
	 */
	const resolvePasteRoot = (projectPath: string): string => {
		if (projectPath) {
			const registered = projectStore.list().some((project) => isLocalProject(project) && isSamePath(project.path, projectPath));
			if (!registered) {
				throw new Error(`Invalid paste target: project path is not registered: ${projectPath}`);
			}
		}
		return userPasteRoot();
	};

	/** userData 新目录 + 各已登记项目遗留的 .pideck-paste（清理/删文件白名单）。远端项目不在本机，排除。 */
	const listManagedPasteRoots = (): string[] => [
		userPasteRoot(),
		...projectStore
			.list()
			.filter(isLocalProject)
			.map((project) => join(project.path, PROJECT_PASTE_DIR)),
	];

	/** 路径必须落在某个受管粘贴根内（防渲染层越权删除任意文件）。 */
	const isInsideManagedPasteRoot = (path: string): boolean => {
		const roots = listManagedPasteRoots();
		// 两侧都转主机路径再比较：WSL 会话的 path 是 Linux 路径（/home/...），
		// 直接 resolve 会落到当前盘符根（D:\home\...）永远匹配不上 UNC 根。
		const resolved = resolve(toWindowsPath(path));
		return roots.some((root) => {
			const rootResolved = resolve(toWindowsPath(root));
			return resolved === rootResolved || resolved.startsWith(rootResolved + sep);
		});
	};

	/** 遍历两个受管根下的 paste-* 文件；目录不存在则跳过。 */
	const walkPasteFiles = async (visit: (full: string) => Promise<void>): Promise<void> => {
		for (const root of listManagedPasteRoots()) {
			let names: string[] = [];
			try {
				names = await readdir(toWindowsPath(root));
			} catch {
				continue; // 目录不存在（多数项目没有粘贴文件），跳过
			}
			for (const name of names) {
				if (!name.startsWith("paste-")) continue;
				await visit(join(root, name));
			}
		}
	};

	/** 粘贴文件命名：paste-YYYYMMDD-HHmmss-<rand>.md（时间戳可读、随机后缀防并发覆盖）。 */
	const generatePasteFileName = (): string => {
		const now = new Date();
		const stamp = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"), "-", String(now.getHours()).padStart(2, "0"), String(now.getMinutes()).padStart(2, "0"), String(now.getSeconds()).padStart(2, "0")].join("");
		return `paste-${stamp}-${randomUUID().slice(0, 4)}.md`;
	};

	ipcMain.handle(ipcChannels.pasteFilesWrite, async (_event, input: PasteFileWriteInput): Promise<PasteFileWriteResult> => {
		if (!input || typeof input.content !== "string") {
			throw new Error("Invalid paste-file input");
		}
		const root = resolvePasteRoot(input.projectPath ?? "");
		await mkdir(toWindowsPath(root), { recursive: true });
		const fileName = generatePasteFileName();
		const path = join(root, fileName);
		await writeFile(toWindowsPath(path), input.content, "utf8");
		void appLogger.info("paste-file", "Pasted text written to file", {
			path,
			bytes: Buffer.byteLength(input.content, "utf8"),
		});
		// 新写入一律在 userData，pi 工作区读不到，发送必须内联原文（inProject=false）。
		return { path, fileName, bytes: Buffer.byteLength(input.content, "utf8"), inProject: false };
	});

	ipcMain.handle(ipcChannels.pasteFilesDelete, async (_event, path: string): Promise<void> => {
		if (!path || !isInsideManagedPasteRoot(path)) {
			throw new Error(`Refusing to delete outside managed paste dir: ${path}`);
		}
		try {
			await rm(toWindowsPath(path), { force: true });
			void appLogger.info("paste-file", "Paste file removed", { path });
		} catch (error) {
			void appLogger.error("paste-file", "Paste file delete failed", {
				path,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});

	/** 启动清理：删除超过保留期的粘贴文件，避免受管目录无限堆积。
	 *  同时是 pasteFilesCleanup IPC handler 与启动 fire-and-forget 的共用实现。 */
	const cleanupStalePasteFiles = async (): Promise<number> => {
		const now = Date.now();
		let removed = 0;
		await walkPasteFiles(async (full) => {
			try {
				const fileStat = await stat(toWindowsPath(full));
				if (!fileStat.isFile()) return;
				if (now - fileStat.mtimeMs > PASTE_FILE_RETENTION_MS) {
					await rm(toWindowsPath(full), { force: true });
					removed += 1;
				}
			} catch {
				// 竞态删除/权限不足：跳过该文件，下次启动再试
			}
		});
		if (removed > 0) {
			void appLogger.info("paste-file", "Startup cleanup removed stale paste files", { removed });
		}
		return removed;
	};

	/** 设置页展示占用：userData 新文件 + 各项目遗留 .pideck-paste。 */
	const getPasteFilesSize = async (): Promise<number> => {
		let total = 0;
		await walkPasteFiles(async (full) => {
			try {
				const fileStat = await stat(toWindowsPath(full));
				if (fileStat.isFile()) total += fileStat.size;
			} catch {
				// 竞态删除/权限不足：跳过该文件
			}
		});
		return total;
	};

	/** 设置页一键清空：两个受管根下的 paste-* 全部删除（不看保留期）。 */
	const clearAllPasteFiles = async (): Promise<number> => {
		let removed = 0;
		await walkPasteFiles(async (full) => {
			try {
				const fileStat = await stat(toWindowsPath(full));
				if (!fileStat.isFile()) return;
				await rm(toWindowsPath(full), { force: true });
				removed += 1;
			} catch (error) {
				void appLogger.error("paste-file", "Paste file clear failed", {
					path: full,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		if (removed > 0) {
			void appLogger.info("paste-file", "Cleared paste files", { removed });
		}
		return removed;
	};

	ipcMain.handle(ipcChannels.pasteFilesCleanup, cleanupStalePasteFiles);
	ipcMain.handle(ipcChannels.pasteFilesGetSize, getPasteFilesSize);
	ipcMain.handle(ipcChannels.pasteFilesClearAll, clearAllPasteFiles);

	// 启动清理：app ready 后由 index.ts 调用（fire-and-forget，不挡首帧）。
	return cleanupStalePasteFiles;
}
