/**
 * 外部会话导入 IPC：codex / claude / qoder / opencode / zcode / workbuddy / codebuddy / cursor /
 * kimi / kimi-work / minimax / 外置目录。
 * 从 sessionIpc.ts 按通道域拆出（纯搬迁：通道常量、入参校验、错误文案与注册顺序不变）。
 */

import { isAbsolute } from "node:path";
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { isLocalProject } from "../../shared/projectLocation";
import { DIRECTORY_IMPORT_MAX_SUMMARIES } from "../sessions/directorySessionImport";
import type { SessionIpcDeps } from "./sessionIpc";

/** 本组 handler 真正用到的依赖：项目/设置读取 + 各导入器 + 日志 + 主窗口。 */
export type SessionImportersIpcDeps = Pick<
	SessionIpcDeps,
	| "projectStore"
	| "settingsStore"
	| "codexSessionImporter"
	| "claudeSessionImporter"
	| "qoderSessionImporter"
	| "openCodeSessionImporter"
	| "zcodeSessionImporter"
	| "workbuddySessionImporter"
	| "codebuddySessionImporter"
	| "cursorSessionImporter"
	| "kimiSessionImporter"
	| "kimiWorkSessionImporter"
	| "minimaxSessionImporter"
	| "directorySessionImporter"
	| "appLogger"
	| "getMainWindow"
>;

export function registerSessionImportersIpc(deps: SessionImportersIpcDeps): void {
	const {
		projectStore,
		settingsStore,
		codexSessionImporter,
		claudeSessionImporter,
		qoderSessionImporter,
		openCodeSessionImporter,
		zcodeSessionImporter,
		workbuddySessionImporter,
		codebuddySessionImporter,
		cursorSessionImporter,
		kimiSessionImporter,
		kimiWorkSessionImporter,
		minimaxSessionImporter,
		directorySessionImporter,
		appLogger,
		getMainWindow,
	} = deps;
	ipcMain.handle(ipcChannels.codexSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await codexSessionImporter.scan(project.path);
		void appLogger.debug("session", "Codex sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.codexSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await codexSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "Codex sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.claudeSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await claudeSessionImporter.scan(project.path);
		void appLogger.debug("session", "Claude sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.claudeSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await claudeSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "Claude sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.qoderSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		// Qoder 导入只对本地目录成立：远端项目没有本机 path（与上面 Claude/OpenCode 同口径）。
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await qoderSessionImporter.scan(project.path);
		void appLogger.debug("session", "Qoder sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.qoderSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await qoderSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "Qoder sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.openCodeSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await openCodeSessionImporter.scan(project.path);
		void appLogger.debug("session", "OpenCode sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.openCodeSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await openCodeSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "OpenCode sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.zcodeSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await zcodeSessionImporter.scan(project.path);
		void appLogger.debug("session", "ZCode sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.zcodeSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await zcodeSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "ZCode sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.workbuddySessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await workbuddySessionImporter.scan(project.path);
		void appLogger.debug("session", "WorkBuddy sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.workbuddySessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await workbuddySessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "WorkBuddy sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.codebuddySessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await codebuddySessionImporter.scan(project.path);
		void appLogger.debug("session", "CodeBuddy sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.codebuddySessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await codebuddySessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "CodeBuddy sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.cursorSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await cursorSessionImporter.scan(project.path);
		void appLogger.debug("session", "Cursor sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.cursorSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await cursorSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "Cursor sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.kimiSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await kimiSessionImporter.scan(project.path);
		void appLogger.debug("session", "Kimi sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.kimiSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await kimiSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "Kimi sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	// ── Kimi Work（kimi-desktop 桌面版）会话导入 ─────────────────────────────
	// 与 CLI 版（上方）的差异：数据目录不固定——先 describe 探测（settings 手动指定 >
	// daimon-storage.json 记录的自定义位置 > 默认安装位置），弹窗把探测结果展示给用户。
	// scan/import 全部走探测链，用户改 Kimi Work 数据位置后 PiDeck 无需改设置。
	ipcMain.handle(ipcChannels.kimiWorkSessionsDescribe, async () => {
		const customRoot = settingsStore.get().kimiWorkShareRoot;
		const result = await kimiWorkSessionImporter.describeShareRoot(customRoot);
		void appLogger.debug("session", "Kimi Work share root described", { origin: result.origin });
		return result;
	});
	ipcMain.handle(ipcChannels.kimiWorkSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const customRoot = settingsStore.get().kimiWorkShareRoot;
		const result = await kimiWorkSessionImporter.scan(project.path, customRoot);
		void appLogger.debug("session", "Kimi Work sessions scanned", { projectId, count: result.length });
		return result;
	});
	ipcMain.handle(ipcChannels.kimiWorkSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const customRoot = settingsStore.get().kimiWorkShareRoot;
		const result = await kimiWorkSessionImporter.import(project.path, sourcePaths, customRoot);
		void appLogger.info("session", "Kimi Work sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
			imported: result.imported,
		});
		return result;
	});
	// ── MinimaxCode（CLI）会话导入 ─────────────────────────────────────
	// 数据目录固定 ~/.minimax/v2/sessions（无 describe/探测链）；cwd 取自每个会话
	// 目录 llm-call.json 的 systemPrompt（working directory 行），与项目路径匹配才列出。
	ipcMain.handle(ipcChannels.minimaxSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await minimaxSessionImporter.scan(project.path);
		void appLogger.debug("session", "MinimaxCode sessions scanned", { projectId, count: result.length });
		return result;
	});
	ipcMain.handle(ipcChannels.minimaxSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await minimaxSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "MinimaxCode sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
			imported: result.imported,
		});
		return result;
	});
	// ── 外置目录会话导入（项目目录移动/改名后找回历史）──────────────────────
	// 与其它导入源的区别：源目录由用户现选，且不复制文件——只把 catalog 记录的项目归属
	// 改成当前项目（原文件原地不动），所以导入后要广播 catalog 刷新让侧栏立即出现这批历史。
	// 「现有会话目录」列表（弹窗首屏默认内容）：只列真的有会话的分组目录，选中即必有结果。
	ipcMain.handle(ipcChannels.directorySessionsListSources, async () => {
		const sources = await directorySessionImporter.listSourceDirectories();
		void appLogger.debug("session", "Directory session sources listed", { count: sources.length });
		return sources;
	});
	ipcMain.handle(ipcChannels.directorySessionsScan, async (_event, projectId: string, dir: unknown) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await directorySessionImporter.scan(requireImportDirectory(dir));
		void appLogger.debug("session", "Directory sessions scanned", {
			projectId,
			count: result.sessions.length,
			// kind=ancestor 说明用户选到了会话树的祖先目录（~/.pi 等），弹窗会提示改选。
			kind: result.kind,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.directorySessionsImport, async (_event, projectId: string, dir: unknown, sourcePaths: unknown) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const report = await directorySessionImporter.import(projectId, requireImportDirectory(dir), requireImportSourcePaths(sourcePaths));
		void appLogger.info("session", "Directory sessions imported", {
			projectId,
			imported: report.imported,
			failed: report.failed,
		});
		if (report.imported > 0) {
			const window = getMainWindow();
			if (window && !window.isDestroyed()) {
				window.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId });
			}
		}
		return report;
	});
}

function requireImportDirectory(raw: unknown): string {
	if (typeof raw !== "string") throw new Error("Invalid directory path");
	const dir = raw.trim();
	if (!dir || dir.length > 32_768) throw new Error("Invalid directory path");
	// 兼容 Windows 盘符路径与 WSL/Linux 绝对路径；相对路径一律拒绝。
	if (!isAbsolute(dir) && !/^[A-Za-z]:[\\/]/.test(dir)) throw new Error("Invalid directory path");
	return dir;
}

/** 目录导入的选中路径校验：字符串数组 + 条数上限（单次扫描上限内）。 */
function requireImportSourcePaths(raw: unknown): string[] {
	if (!Array.isArray(raw)) throw new Error("Invalid source paths");
	if (raw.length > DIRECTORY_IMPORT_MAX_SUMMARIES * 2) throw new Error("Too many source paths");
	return raw.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}
