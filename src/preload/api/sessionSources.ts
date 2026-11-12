/**
 * preload sessionSources 域：外部会话来源：各 CLI / 桌面端的扫描 + 导入。
 *
 * 组装口 `src/preload/index.ts` 只做 spread；方法体 / 参数名 / 通道引用与拆分前逐字一致。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { ClaudeImportReport, ClaudeSessionSummary, CodeBuddyImportReport, CodeBuddySessionSummary, CodexImportReport, CodexSessionSummary, CursorImportReport, CursorSessionSummary, DirectoryImportReport, DirectorySessionScanResult, DirectorySessionSourceDir, KimiImportReport, KimiSessionSummary, KimiWorkImportReport, KimiWorkSessionSummary, KimiWorkShareRootInfo, MinimaxImportReport, MinimaxSessionSummary, OpenCodeImportReport, OpenCodeSessionSummary, QoderImportReport, QoderSessionSummary, WorkBuddyImportReport, WorkBuddySessionSummary, ZCodeImportReport, ZCodeSessionSummary } from "../../shared/types";

export const sessionSourcesApi = {
	codexSessions: {
		scan: (projectId: string) => ipcRenderer.invoke(ipcChannels.codexSessionsScan, projectId) as Promise<CodexSessionSummary[]>,
		import: (projectId: string, sourcePaths: string[]) => ipcRenderer.invoke(ipcChannels.codexSessionsImport, projectId, sourcePaths) as Promise<CodexImportReport>,
	},
	claudeSessions: {
		scan: (projectId: string) => ipcRenderer.invoke(ipcChannels.claudeSessionsScan, projectId) as Promise<ClaudeSessionSummary[]>,
		import: (projectId: string, sourcePaths: string[]) => ipcRenderer.invoke(ipcChannels.claudeSessionsImport, projectId, sourcePaths) as Promise<ClaudeImportReport>,
	},
	qoderSessions: {
		scan: (projectId: string) => ipcRenderer.invoke(ipcChannels.qoderSessionsScan, projectId) as Promise<QoderSessionSummary[]>,
		import: (projectId: string, sourcePaths: string[]) => ipcRenderer.invoke(ipcChannels.qoderSessionsImport, projectId, sourcePaths) as Promise<QoderImportReport>,
	},
	openCodeSessions: {
		scan: (projectId: string) => ipcRenderer.invoke(ipcChannels.openCodeSessionsScan, projectId) as Promise<OpenCodeSessionSummary[]>,
		import: (projectId: string, sourcePaths: string[]) => ipcRenderer.invoke(ipcChannels.openCodeSessionsImport, projectId, sourcePaths) as Promise<OpenCodeImportReport>,
	},
	zcodeSessions: {
		scan: (projectId: string) => ipcRenderer.invoke(ipcChannels.zcodeSessionsScan, projectId) as Promise<ZCodeSessionSummary[]>,
		import: (projectId: string, sourcePaths: string[]) => ipcRenderer.invoke(ipcChannels.zcodeSessionsImport, projectId, sourcePaths) as Promise<ZCodeImportReport>,
	},
	workbuddySessions: {
		scan: (projectId: string) => ipcRenderer.invoke(ipcChannels.workbuddySessionsScan, projectId) as Promise<WorkBuddySessionSummary[]>,
		import: (projectId: string, sourcePaths: string[]) => ipcRenderer.invoke(ipcChannels.workbuddySessionsImport, projectId, sourcePaths) as Promise<WorkBuddyImportReport>,
	},
	codebuddySessions: {
		scan: (projectId: string) => ipcRenderer.invoke(ipcChannels.codebuddySessionsScan, projectId) as Promise<CodeBuddySessionSummary[]>,
		import: (projectId: string, sourcePaths: string[]) => ipcRenderer.invoke(ipcChannels.codebuddySessionsImport, projectId, sourcePaths) as Promise<CodeBuddyImportReport>,
	},
	cursorSessions: {
		scan: (projectId: string) => ipcRenderer.invoke(ipcChannels.cursorSessionsScan, projectId) as Promise<CursorSessionSummary[]>,
		import: (projectId: string, sourcePaths: string[]) => ipcRenderer.invoke(ipcChannels.cursorSessionsImport, projectId, sourcePaths) as Promise<CursorImportReport>,
	},
	kimiSessions: {
		scan: (projectId: string) => ipcRenderer.invoke(ipcChannels.kimiSessionsScan, projectId) as Promise<KimiSessionSummary[]>,
		import: (projectId: string, sourcePaths: string[]) => ipcRenderer.invoke(ipcChannels.kimiSessionsImport, projectId, sourcePaths) as Promise<KimiImportReport>,
	},
	/** Kimi Work（kimi-desktop 桌面版）会话导入；数据目录位置由探测链决定（见 kimiWorkSource）。 */
	kimiWorkSessions: {
		describe: () => ipcRenderer.invoke(ipcChannels.kimiWorkSessionsDescribe) as Promise<KimiWorkShareRootInfo>,
		scan: (projectId: string) => ipcRenderer.invoke(ipcChannels.kimiWorkSessionsScan, projectId) as Promise<KimiWorkSessionSummary[]>,
		import: (projectId: string, sourcePaths: string[]) => ipcRenderer.invoke(ipcChannels.kimiWorkSessionsImport, projectId, sourcePaths) as Promise<KimiWorkImportReport>,
	},
	/** MinimaxCode（CLI）会话导入；数据目录固定 ~/.minimax/v2/sessions，按 cwd 归属项目。 */
	minimaxSessions: {
		scan: (projectId: string) => ipcRenderer.invoke(ipcChannels.minimaxSessionsScan, projectId) as Promise<MinimaxSessionSummary[]>,
		import: (projectId: string, sourcePaths: string[]) => ipcRenderer.invoke(ipcChannels.minimaxSessionsImport, projectId, sourcePaths) as Promise<MinimaxImportReport>,
	},
	/**
	 * 外置目录会话导入：源目录由用户现选（从「现有会话目录」列表点选，或手选任意目录），
	 * 导入 = 把会话挂到当前项目（catalog 归属改写），原文件不移动、不复制。
	 */
	directorySessions: {
		scan: (projectId: string, dir: string) => ipcRenderer.invoke(ipcChannels.directorySessionsScan, projectId, dir) as Promise<DirectorySessionScanResult>,
		listSources: () => ipcRenderer.invoke(ipcChannels.directorySessionsListSources) as Promise<DirectorySessionSourceDir[]>,
		import: (projectId: string, dir: string, sourcePaths: string[]) => ipcRenderer.invoke(ipcChannels.directorySessionsImport, projectId, dir, sourcePaths) as Promise<DirectoryImportReport>,
	},
};
