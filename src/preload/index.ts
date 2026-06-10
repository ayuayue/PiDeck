import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels } from "../shared/ipc";
import type {
	AgentRuntimeState,
	AgentTab,
	AppInfo,
	AppSettings,
	AppUpdateInfo,
	FeedbackEnvironment,
	AvailableModel,
	ChatMessage,
	CodexImportReport,
	CodexSessionSummary,
	CreateAgentInput,
	FileTreeNode,
	ForkMessage,
	GitBranchInfo,
	PiCommand,
	PiInstallStatus,
	PiProxyTestResult,
	Project,
	SendPromptInput,
	SessionSummary,
	TerminalDataEvent,
	TerminalExitEvent,
	TerminalTab,
	ThinkingUpdate,
} from "../shared/types";

const api = {
	projects: {
		list: () =>
			ipcRenderer.invoke(ipcChannels.projectsList) as Promise<Project[]>,
		add: () =>
			ipcRenderer.invoke(ipcChannels.projectsAdd) as Promise<Project | null>,
		remove: (id: string) =>
			ipcRenderer.invoke(ipcChannels.projectsRemove, id) as Promise<Project[]>,
		reorder: (projectIds: string[]) =>
			ipcRenderer.invoke(
				ipcChannels.projectsReorder,
				projectIds,
			) as Promise<Project[]>,
		onChanged: (callback: (projects: Project[]) => void) =>
			subscribe(ipcChannels.projectsChanged, callback),
	},
	files: {
		list: (projectId: string) =>
			ipcRenderer.invoke(ipcChannels.filesList, projectId) as Promise<
				FileTreeNode[]
			>,
		open: (path: string) =>
			ipcRenderer.invoke(ipcChannels.filesOpen, path) as Promise<void>,
		showInFolder: (path: string) =>
			ipcRenderer.invoke(ipcChannels.filesShowInFolder, path) as Promise<void>,
	},
	sessions: {
		list: (projectId?: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsList, projectId) as Promise<
				SessionSummary[]
			>,
		rename: (filePath: string, newName: string) =>
			ipcRenderer.invoke(
				ipcChannels.sessionsRename,
				filePath,
				newName,
			) as Promise<void>,
		copy: (projectId: string, filePath: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsCopy, projectId, filePath) as Promise<{
				cancelled?: boolean;
				sessionPath?: string;
			}>,
		exportHtml: (projectId: string, filePath: string) =>
			ipcRenderer.invoke(
				ipcChannels.sessionsExportHtml,
				projectId,
				filePath,
			) as Promise<{
				path: string;
			}>,
		delete: (filePath: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsDelete, filePath) as Promise<void>,
	},
	codexSessions: {
		scan: (projectId: string) =>
			ipcRenderer.invoke(ipcChannels.codexSessionsScan, projectId) as Promise<
				CodexSessionSummary[]
			>,
		import: (projectId: string, sourcePaths: string[]) =>
			ipcRenderer.invoke(
				ipcChannels.codexSessionsImport,
				projectId,
				sourcePaths,
			) as Promise<CodexImportReport>,
	},
	git: {
		branches: (projectId: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitBranches,
				projectId,
			) as Promise<GitBranchInfo>,
		checkout: (projectId: string, branch: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitCheckout,
				projectId,
				branch,
			) as Promise<GitBranchInfo>,
	},
	pi: {
		check: () =>
			ipcRenderer.invoke(ipcChannels.piCheck) as Promise<PiInstallStatus>,
	},
	app: {
		info: () => ipcRenderer.invoke(ipcChannels.appInfo) as Promise<AppInfo>,
		checkUpdate: () =>
			ipcRenderer.invoke(ipcChannels.appCheckUpdate) as Promise<AppUpdateInfo>,
		feedbackEnvironment: () =>
			ipcRenderer.invoke(
				ipcChannels.appFeedbackEnvironment,
			) as Promise<FeedbackEnvironment>,
		openExternal: (url: string) =>
			ipcRenderer.invoke(ipcChannels.appOpenExternal, url) as Promise<void>,
		toggleDevTools: () =>
			ipcRenderer.invoke(ipcChannels.appToggleDevTools) as Promise<boolean>,
	},
	settings: {
		get: () =>
			ipcRenderer.invoke(ipcChannels.settingsGet) as Promise<AppSettings>,
		update: (patch: Partial<AppSettings>) =>
			ipcRenderer.invoke(
				ipcChannels.settingsUpdate,
				patch,
			) as Promise<AppSettings>,
		testPiProxy: () =>
			ipcRenderer.invoke(
				ipcChannels.settingsTestPiProxy,
			) as Promise<PiProxyTestResult>,
		onApplyWindow: (callback: (settings: AppSettings) => void) =>
			subscribe(ipcChannels.settingsApplyWindow, callback),
	},
	config: {
		getModels: () =>
			ipcRenderer.invoke(ipcChannels.configGetModels) as Promise<{
				raw: string;
				parsed: { providers: Record<string, unknown> };
			}>,
		getAuth: () =>
			ipcRenderer.invoke(ipcChannels.configGetAuth) as Promise<{
				raw: string;
				parsed: Record<string, unknown>;
			}>,
		getSettings: () =>
			ipcRenderer.invoke(ipcChannels.configGetSettings) as Promise<{
				raw: string;
				parsed: Record<string, unknown>;
			}>,
		saveModels: (data: unknown) =>
			ipcRenderer.invoke(ipcChannels.configSaveModels, data) as Promise<{
				valid: boolean;
				error?: string;
			}>,
		saveAuth: (data: unknown) =>
			ipcRenderer.invoke(ipcChannels.configSaveAuth, data) as Promise<{
				valid: boolean;
				error?: string;
			}>,
		saveSettings: (settings: Record<string, unknown>) =>
			ipcRenderer.invoke(ipcChannels.configSaveSettings, settings) as Promise<{
				valid: boolean;
				error?: string;
			}>,
		saveRaw: (fileName: string, rawJson: string) =>
			ipcRenderer.invoke(
				ipcChannels.configSaveRaw,
				fileName,
				rawJson,
			) as Promise<{ valid: boolean; error?: string }>,
		export: () =>
			ipcRenderer.invoke(ipcChannels.configExport) as Promise<string>,
		import: (packageJson: string) =>
			ipcRenderer.invoke(
				ipcChannels.configImport,
				packageJson,
			) as Promise<{ valid: boolean; error?: string }>,
		/** 从 provider 的 baseUrl + apiKey 拉取可用模型列表 */
		fetchModels: (baseUrl: string, apiKey: string, apiType?: string) =>
			ipcRenderer.invoke(
				ipcChannels.configFetchModels,
				{ baseUrl, apiKey, apiType },
			) as Promise<{
				success: boolean;
				models?: Array<{ id: string; name?: string }>;
				error?: string;
			}>,
		/** 快速测试 provider 连接：发送一条最小请求验证配置是否正常 */
		testProvider: (
			baseUrl: string,
			apiKey: string,
			modelId: string,
			apiType?: string,
			headers?: Record<string, string>,
		) =>
			ipcRenderer.invoke(
				ipcChannels.configTestProvider,
				{ baseUrl, apiKey, modelId, apiType, headers },
			) as Promise<{
				success: boolean;
				model?: string;
				snippet?: string;
				tokens?: { input?: number; output?: number };
				latencyMs?: number;
				error?: string;
				requestUrl?: string;
				requestBody?: string;
			}>,
	},
	agents: {
		list: () =>
			ipcRenderer.invoke(ipcChannels.agentsList) as Promise<AgentTab[]>,
		create: (input: CreateAgentInput) =>
			ipcRenderer.invoke(ipcChannels.agentsCreate, input) as Promise<AgentTab>,
		stop: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsStop, agentId) as Promise<void>,
		prompt: (input: SendPromptInput) =>
			ipcRenderer.invoke(ipcChannels.agentsPrompt, input) as Promise<void>,
		abort: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsAbort, agentId) as Promise<void>,
		exportHtml: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsExportHtml, agentId) as Promise<{
				path: string;
			}>,
		getForkMessages: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsForkMessages, agentId) as Promise<
				ForkMessage[]
			>,
		forkSession: (agentId: string, entryId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsForkSession,
				agentId,
				entryId,
			) as Promise<{ text?: string; cancelled?: boolean }>,
		cloneSession: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsCloneSession, agentId) as Promise<{
				cancelled?: boolean;
			}>,
		switchSession: (agentId: string, sessionPath: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsSwitchSession,
				agentId,
				sessionPath,
			) as Promise<{ cancelled?: boolean }>,
		reload: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsReload, agentId) as Promise<void>,
		restart: (agentId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsRestart,
				agentId,
			) as Promise<AgentTab>,
		compact: (agentId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsCompact,
				agentId,
			) as Promise<AgentRuntimeState>,
		runtimeState: (agentId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsRuntimeState,
				agentId,
			) as Promise<AgentRuntimeState>,
		cycleModel: (agentId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsCycleModel,
				agentId,
			) as Promise<AgentRuntimeState>,
		availableModels: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsAvailableModels, agentId) as Promise<
				AvailableModel[]
			>,
		setModel: (agentId: string, provider: string, modelId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsSetModel,
				agentId,
				provider,
				modelId,
			) as Promise<AgentRuntimeState>,
		cycleThinking: (agentId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsCycleThinking,
				agentId,
			) as Promise<AgentRuntimeState>,
		setThinking: (agentId: string, level: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsSetThinking,
				agentId,
				level,
			) as Promise<AgentRuntimeState>,
		commands: (agentId: string) =>
			ipcRenderer.invoke("agents:commands", agentId) as Promise<PiCommand[]>,
		onState: (callback: (tabs: AgentTab[]) => void) =>
			subscribe(ipcChannels.agentsState, callback),
		onMessages: (
			callback: (payload: { agentId: string; messages: ChatMessage[] }) => void,
		) => subscribe(ipcChannels.agentsMessage, callback),
		onLog: (callback: (payload: { agentId: string; text: string }) => void) =>
			subscribe(ipcChannels.agentsLog, callback),
		onThinking: (
			callback: (payload: ThinkingUpdate) => void,
		) => subscribe(ipcChannels.agentsThinking, callback),
		onRpcLog: (
			callback: (payload: { agentId: string; direction: string; summary: string; data: unknown }) => void,
		) => subscribe(ipcChannels.agentsRpcLog, callback),
		onRuntimeState: (
			callback: (payload: {
				agentId: string;
				state: AgentRuntimeState;
			}) => void,
		) => subscribe(ipcChannels.agentsRuntimeState, callback),
	},
	terminal: {
		list: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.terminalList, agentId) as Promise<
				TerminalTab[]
			>,
		ensure: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.terminalEnsure, agentId) as Promise<
				TerminalTab[]
			>,
		create: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.terminalCreate, agentId) as Promise<
				TerminalTab
			>,
		input: (tabId: string, data: string) =>
			ipcRenderer.invoke(ipcChannels.terminalInput, tabId, data) as Promise<void>,
		resize: (tabId: string, cols: number, rows: number) =>
			ipcRenderer.invoke(
				ipcChannels.terminalResize,
				tabId,
				cols,
				rows,
			) as Promise<void>,
		close: (tabId: string) =>
			ipcRenderer.invoke(ipcChannels.terminalClose, tabId) as Promise<void>,
		onData: (callback: (payload: TerminalDataEvent) => void) =>
			subscribe(ipcChannels.terminalData, callback),
		onExit: (callback: (payload: TerminalExitEvent) => void) =>
			subscribe(ipcChannels.terminalExit, callback),
	},
};

function subscribe<T>(channel: string, callback: (payload: T) => void) {
	const listener = (_event: Electron.IpcRendererEvent, payload: T) =>
		callback(payload);
	ipcRenderer.on(channel, listener);
	return () => {
		ipcRenderer.removeListener(channel, listener);
	};
}

contextBridge.exposeInMainWorld("piDesktop", api);

export type PiDesktopApi = typeof api;
