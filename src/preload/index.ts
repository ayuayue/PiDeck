import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels } from "../shared/ipc";
import type {
	YaoPromptListResult,
	YaoPromptDetailResult,
	AgentRuntimeState,
	AgentTab,
	AppInfo,
	AppLogEntry,
	AppLogLevel,
	AppLogQuery,
	AppSettings,
	AppUpdateDownloadProgress,
	AppUpdateDownloadResult,
	AppUpdateInfo,
	AvailableModel,
	ChatMessage,
	CodexImportReport,
	CodexSessionSummary,
	ClaudeImportReport,
	ClaudeSessionSummary,
	OpenCodeImportReport,
	OpenCodeSessionSummary,
	ConfigFileDiagnostic,
	DraftMeta,
	CreateAgentInput,
	CreatePiSkillInput,
	CreateProjectSkillInput,
	ProjectResourceListResult,
	PetAggregateState,
	PetManifest,
	PetNotification,
	PetWindowCaps,
	ExternalEditor,
	ExternalEditorId,
	ExternalEditorSetting,
	FeedbackEnvironment,
	FeishuBotConfig,
	FeishuBridgeStatus,
	FeishuChatBinding,
	FeishuChatMessage,
	FeishuConnectInput,
	FeishuTestResult,
	FileTreeNode,
	ForkMessage,
	GitBranchInfo,
	CommitDetail,
	GitCommitFileDiff,
	GitWorkspaceDiffGroup,
	GitWorkspaceFileDiff,
	CommitEntry,
	GitRef,
	BranchDiffResult,
	WorktreeEntry,
	PiCliUpdateResult,
	PiCommand,
	PiExtensionListResult,
	PiInstallStatus,
	PiInstallExecResult,
	NpmAvailabilityResult,
	PiPromptTemplateListResult,
	PiPromptTemplateSummary,
	CreatePiPromptTemplateInput,
	PiProxyTestResult,
	PiUpdateCheckResult,
	PiSkillListResult,
	PiSkillSummary,
	Project,
	PromptStoreSearchResult,
	PromptStoreItem,
	ScratchPadData,
	SendPromptInput,
	SendPromptResult,
	SessionSummary,
	TerminalDataEvent,
	TerminalExitEvent,
	TerminalTab,
	ThinkingUpdate,
} from "../shared/types";

const api = {
	editors: {
		list: () => ipcRenderer.invoke(ipcChannels.editorsList) as Promise<ExternalEditor[]>,
		redetect: () =>
			ipcRenderer.invoke(ipcChannels.editorsRedetect) as Promise<AppSettings>,
		update: (editorId: ExternalEditorId, patch: Partial<ExternalEditorSetting>) =>
			ipcRenderer.invoke(
				ipcChannels.editorsUpdate,
				editorId,
				patch,
			) as Promise<AppSettings>,
		chooseExecutable: () =>
			ipcRenderer.invoke(ipcChannels.editorsChooseExecutable) as Promise<string | null>,
		openProject: (editor: ExternalEditor, projectPath: string) =>
			ipcRenderer.invoke(
				ipcChannels.editorsOpenProject,
				editor,
				projectPath,
			) as Promise<void>,
	},
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
		// 仅返回顶级项目（不含 worktree 子项目）
		listRoot: () =>
			ipcRenderer.invoke(ipcChannels.projectsListRoot) as Promise<Project[]>,
		// 获取指定父项目的所有 worktree 子项目
		listWorktreeChildren: (parentId: string) =>
			ipcRenderer.invoke(
				ipcChannels.projectsListWorktreeChildren,
				parentId,
			) as Promise<Project[]>,
		// 切换 worktree 模式开关
		toggleWorktreeEnabled: (projectId: string) =>
			ipcRenderer.invoke(
				ipcChannels.projectsToggleWorktreeEnabled,
				projectId,
			) as Promise<Project | null>,
		// 选择聊天记录目录（系统文件选择器，默认当前目录）
		chooseChatPath: () =>
			ipcRenderer.invoke(ipcChannels.projectsChooseChatPath) as Promise<string | null>,
		// 设置聊天记录目录
		setChatPath: (path: string) =>
			ipcRenderer.invoke(ipcChannels.projectsSetChatPath, path) as Promise<Project | null>,
		// 通过 pi --list-models 获取可用模型列表（无需启动 agent）
		listModels: (projectId?: string) =>
			ipcRenderer.invoke(ipcChannels.projectsListModels, projectId) as Promise<
				AvailableModel[]
			>,
	},
	projectResources: {
		list: (projectId: string) =>
			ipcRenderer.invoke(ipcChannels.projectResourcesList, projectId) as Promise<ProjectResourceListResult>,
		createSkill: (input: CreateProjectSkillInput) =>
			ipcRenderer.invoke(ipcChannels.projectResourcesCreateSkill, input) as Promise<PiSkillSummary>,
		deleteSkill: (projectId: string, skillPath: string) =>
			ipcRenderer.invoke(ipcChannels.projectResourcesDeleteSkill, projectId, skillPath) as Promise<void>,
		deleteExtension: (projectId: string, extensionPath: string) =>
			ipcRenderer.invoke(ipcChannels.projectResourcesDeleteExtension, projectId, extensionPath) as Promise<void>,
		toggleExtension: (projectId: string, extensionPath: string, enabled: boolean) =>
			ipcRenderer.invoke(ipcChannels.projectResourcesToggleExtension, projectId, extensionPath, enabled) as Promise<void>,
		toggleSkill: (projectId: string, skillPath: string, enabled: boolean) =>
			ipcRenderer.invoke(ipcChannels.projectResourcesToggleSkill, projectId, skillPath, enabled) as Promise<PiSkillSummary>,
		renameSkill: (projectId: string, skillPath: string, newName: string) =>
			ipcRenderer.invoke(ipcChannels.projectResourcesRenameSkill, projectId, skillPath, newName) as Promise<PiSkillSummary>,
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
		readContent: (path: string) =>
			ipcRenderer.invoke(ipcChannels.filesReadContent, path) as Promise<string>,
		writeContent: (path: string, content: string) =>
			ipcRenderer.invoke(ipcChannels.filesWriteContent, path, content) as Promise<void>,
		delete: (path: string, recursive?: boolean) =>
			ipcRenderer.invoke(ipcChannels.filesDelete, path, recursive) as Promise<void>,
		rename: (path: string, newName: string) =>
			ipcRenderer.invoke(ipcChannels.filesRename, path, newName) as Promise<string>,
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
		readMessages: (filePath: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsReadMessages, filePath) as Promise<
				Array<{ role: string; content: string; timestamp: number }>
			>,
		readSessionMeta: (filePath: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsReadMeta, filePath) as Promise<{
				provider?: string;
				modelId?: string;
				thinkingLevel?: string;
			}>,
		readChatMessages: (filePath: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsReadChatMessages, filePath) as Promise<
				import("../shared/types").ChatMessage[]
			>,
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
	claudeSessions: {
		scan: (projectId: string) =>
			ipcRenderer.invoke(ipcChannels.claudeSessionsScan, projectId) as Promise<
				ClaudeSessionSummary[]
			>,
		import: (projectId: string, sourcePaths: string[]) =>
			ipcRenderer.invoke(
				ipcChannels.claudeSessionsImport,
				projectId,
				sourcePaths,
			) as Promise<ClaudeImportReport>,
	},
	openCodeSessions: {
		scan: (projectId: string) =>
			ipcRenderer.invoke(ipcChannels.openCodeSessionsScan, projectId) as Promise<
				OpenCodeSessionSummary[]
			>,
		import: (projectId: string, sourcePaths: string[]) =>
			ipcRenderer.invoke(
				ipcChannels.openCodeSessionsImport,
				projectId,
				sourcePaths,
			) as Promise<OpenCodeImportReport>,
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
		createBranch: (projectId: string, branchName: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitCreateBranch,
				projectId,
				branchName,
			) as Promise<GitBranchInfo>,
		// 读取文件的 Git HEAD 原始内容，供差异编辑器左侧基准列使用。
		originalContent: (filePath: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitOriginalContent,
				filePath,
			) as Promise<string>,
		// 列出项目的 git worktree（排除主工作区）
		worktreeList: (projectId: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitWorktreeList,
				projectId,
			) as Promise<WorktreeEntry[]>,
		// 创建新的 worktree
		worktreeCreate: (projectId: string, branchName: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitWorktreeCreate,
				projectId,
				branchName,
			) as Promise<{ path: string; branch: string }>,
		// 删除 worktree
		worktreeRemove: (projectId: string, worktreePath: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitWorktreeRemove,
				projectId,
				worktreePath,
			) as Promise<boolean>,
		// Git 增强：提交历史、分支对比、Graph
		commitLog: (projectId: string, options?: { maxEntries?: number; ref?: string; path?: string; allBranches?: boolean }) =>
			ipcRenderer.invoke(
				ipcChannels.gitCommitLog,
				projectId,
				options,
			) as Promise<CommitEntry[]>,
		// Git 引用（分支 / 远程分支 / Tag）
		refs: (projectId: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitRefs,
				projectId,
			) as Promise<GitRef[]>,
		// 分支对比概要（变更文件 + ahead/behind）
		branchCompare: (projectId: string, base: string, target: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitBranchCompare,
				projectId,
				base,
				target,
			) as Promise<BranchDiffResult>,
		// 单个 commit 详情
		commitDetail: (projectId: string, ref: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitCommitDetail,
				projectId,
				ref,
			) as Promise<CommitDetail | null>,
		// 提交历史中单个文件相对第一父提交的两侧内容
		commitFileDiff: (projectId: string, ref: string, filePath: string, originalPath?: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitCommitFileDiff,
				projectId,
				ref,
				filePath,
				originalPath,
			) as Promise<GitCommitFileDiff | null>,
		// 两个 ref 间单个文件的 diff
		diffFileBetween: (projectId: string, ref1: string, ref2: string, filePath: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitDiffFileBetween,
				projectId,
				ref1,
				ref2,
				filePath,
			) as Promise<string>,
		// Git 工作区状态（VS Code 风格分组：Staged/Unstaged/Untracked/Merge）
		status: (projectId: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitStatus,
				projectId,
			) as Promise<import("../shared/types").GitResourceGroups>,
		// Git Changes 中单个文件的两侧快照（按点击惰性读取）
		workspaceFileDiff: (projectId: string, group: GitWorkspaceDiffGroup, filePath: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitWorkspaceFileDiff,
				projectId,
				group,
				filePath,
			) as Promise<GitWorkspaceFileDiff | null>,
		// Stage 文件
		stage: (projectId: string, paths: string[]) =>
			ipcRenderer.invoke(
				ipcChannels.gitStage,
				projectId,
				paths,
			) as Promise<void>,
		// Unstage 文件
		unstage: (projectId: string, paths: string[]) =>
			ipcRenderer.invoke(
				ipcChannels.gitUnstage,
				projectId,
				paths,
			) as Promise<void>,
		// 丢弃单个未暂存文件；主进程会按最新 status 再次验证 group 与路径。
		discard: (projectId: string, group: "workingTree" | "untracked", filePath: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitDiscard,
				projectId,
				group,
				filePath,
			) as Promise<void>,
		// Commit
		commit: (projectId: string, message: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitCommit,
				projectId,
				message,
			) as Promise<void>,
	},
	pi: {
		check: () =>
			ipcRenderer.invoke(ipcChannels.piCheck) as Promise<PiInstallStatus>,
		/** 验证用户手动输入的 pi 路径，通过后主进程会自动保存到 settings.customPiPath */
		checkCustom: (customPath: string) =>
			ipcRenderer.invoke(
				ipcChannels.piCheckCustom,
				customPath,
			) as Promise<PiInstallStatus>,
		checkUpdate: () =>
			ipcRenderer.invoke(ipcChannels.piUpdateCheck) as Promise<PiUpdateCheckResult>,
		update: () =>
			ipcRenderer.invoke(ipcChannels.piUpdate) as Promise<PiCliUpdateResult>,
		/** 执行安装命令（如 npm install -g pi）并返回执行结果 */
		execInstall: (command: string) =>
			ipcRenderer.invoke(ipcChannels.piExecInstall, command) as Promise<PiInstallExecResult>,
		/** 检查 npm 是否可用 */
		checkNpm: () =>
			ipcRenderer.invoke(ipcChannels.piCheckNpm) as Promise<NpmAvailabilityResult>,
	},
	/** WSL 相关操作（仅 Windows 有效） */
	wsl: {
		/** 获取已安装的 WSL 发行版列表 */
		listDistros: () =>
			ipcRenderer.invoke(ipcChannels.wslListDistros) as Promise<string[]>,
		/** 验证 WSL 连接：检查 distro + user 是否可达，以及 pi 是否已安装 */
		validateConnection: (distro: string, user: string) =>
			ipcRenderer.invoke(ipcChannels.wslValidateConnection, distro, user) as Promise<{
				ok: boolean;
				whoami: string;
				piVersion: string;
				error: string;
			}>,
	},
	logs: {
		list: (query?: AppLogQuery) =>
			ipcRenderer.invoke(ipcChannels.logsList, query ?? {}) as Promise<AppLogEntry[]>,
		clear: () => ipcRenderer.invoke(ipcChannels.logsClear) as Promise<void>,
		openFolder: () => ipcRenderer.invoke(ipcChannels.logsOpenFolder) as Promise<void>,
		getSize: () =>
			ipcRenderer.invoke(ipcChannels.logsSize) as Promise<number>,
	},
	rpcLogs: {
		getSize: (agentId?: string) =>
			ipcRenderer.invoke(ipcChannels.rpcLogsGetSize, agentId) as Promise<number>,
		get: (options?: { agentId?: string; days?: number; limit?: number }) =>
			ipcRenderer.invoke(ipcChannels.rpcLogsGet, options) as Promise<Array<{ id: string; agentId: string; direction: string; summary: string; time: number; data?: unknown }>>,
		clear: (agentId?: string) =>
			ipcRenderer.invoke(ipcChannels.rpcLogsClear, agentId) as Promise<void>,
		setLogging: (agentId: string, enabled: boolean) =>
			ipcRenderer.invoke(ipcChannels.rpcLoggingSet, agentId, enabled) as Promise<boolean>,
		getLogging: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.rpcLoggingGet, agentId) as Promise<boolean>,
		openFile: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.rpcLogsOpenFile, agentId) as Promise<void>,
	},
	app: {
		info: () => ipcRenderer.invoke(ipcChannels.appInfo) as Promise<AppInfo>,
		preferredSystemLanguages: () =>
			ipcRenderer.invoke(ipcChannels.appPreferredSystemLanguages) as Promise<string[]>,
		checkUpdate: () =>
			ipcRenderer.invoke(ipcChannels.appCheckUpdate) as Promise<AppUpdateInfo>,
		downloadUpdate: (asset: { name: string; url: string }) =>
			ipcRenderer.invoke(
				ipcChannels.appDownloadUpdate,
				asset,
			) as Promise<AppUpdateDownloadResult>,
		installUpdate: (filePath: string) =>
			ipcRenderer.invoke(ipcChannels.appInstallUpdate, filePath) as Promise<void>,
		onUpdateProgress: (callback: (progress: AppUpdateDownloadProgress) => void) =>
			subscribe(ipcChannels.appUpdateProgress, callback),
		feedbackEnvironment: () =>
			ipcRenderer.invoke(
				ipcChannels.appFeedbackEnvironment,
			) as Promise<FeedbackEnvironment>,
		openExternal: (url: string) =>
			ipcRenderer.invoke(ipcChannels.appOpenExternal, url) as Promise<void>,
		onOpenInBrowser: (callback: (url: string) => void) =>
			subscribe(ipcChannels.appOpenInBrowser, callback),
		restart: () => ipcRenderer.invoke(ipcChannels.appRestart) as Promise<void>,
		rendererLog: (
			level: AppLogLevel,
			scope: string,
			message: string,
			detail?: unknown,
		) =>
			ipcRenderer.invoke(
				ipcChannels.rendererLog,
				level,
				scope,
				message,
				detail,
			) as Promise<void>,
		minimizeWindow: () =>
			ipcRenderer.invoke(ipcChannels.appWindowMinimize) as Promise<void>,
		toggleMaximizeWindow: () =>
			ipcRenderer.invoke(ipcChannels.appWindowToggleMaximize) as Promise<void>,
		toggleAlwaysOnTopWindow: () =>
			ipcRenderer.invoke(
				ipcChannels.appWindowToggleAlwaysOnTop,
			) as Promise<boolean>,
		closeWindow: () =>
			ipcRenderer.invoke(ipcChannels.appWindowClose) as Promise<void>,
		toggleDevTools: () =>
			ipcRenderer.invoke(ipcChannels.appToggleDevTools) as Promise<boolean>,
	},
	skills: {
		list: () =>
			ipcRenderer.invoke(ipcChannels.skillsList) as Promise<PiSkillListResult>,
		create: (input: CreatePiSkillInput) =>
			ipcRenderer.invoke(ipcChannels.skillsCreate, input) as Promise<PiSkillSummary>,
		toggle: (path: string, enabled: boolean) =>
			ipcRenderer.invoke(
				ipcChannels.skillsToggle,
				path,
				enabled,
			) as Promise<PiSkillSummary>,
		delete: (path: string) =>
			ipcRenderer.invoke(ipcChannels.skillsDelete, path) as Promise<void>,
		openFolder: (path?: string) =>
			ipcRenderer.invoke(ipcChannels.skillsOpenFolder, path) as Promise<void>,
		rename: (skillPath: string, newName: string) =>
			ipcRenderer.invoke(ipcChannels.skillsRename, skillPath, newName) as Promise<PiSkillSummary>,
	},
	prompts: {
		list: () =>
			ipcRenderer.invoke(ipcChannels.promptsList) as Promise<PiPromptTemplateListResult>,
		create: (input: CreatePiPromptTemplateInput) =>
			ipcRenderer.invoke(ipcChannels.promptsCreate, input) as Promise<PiPromptTemplateSummary>,
		delete: (filePath: string) =>
			ipcRenderer.invoke(ipcChannels.promptsDelete, filePath) as Promise<void>,
		openFolder: () =>
			ipcRenderer.invoke(ipcChannels.promptsOpenFolder) as Promise<void>,
		edit: (filePath: string, content?: string) =>
			ipcRenderer.invoke(ipcChannels.promptsEdit, filePath, content) as Promise<string | void>,
		listByProject: (projectPath: string) =>
			ipcRenderer.invoke(ipcChannels.promptsListByProject, projectPath) as Promise<PiPromptTemplateListResult>,
		createInProject: (projectPath: string, input: CreatePiPromptTemplateInput) =>
			ipcRenderer.invoke(ipcChannels.promptsCreateInProject, projectPath, input) as Promise<PiPromptTemplateSummary>,
		deleteFromProject: (projectPath: string, fileName: string) =>
			ipcRenderer.invoke(ipcChannels.promptsDeleteInProject, projectPath, fileName) as Promise<void>,
		rename: (oldName: string, newName: string) =>
			ipcRenderer.invoke(ipcChannels.promptsRename, oldName, newName) as Promise<PiPromptTemplateSummary>,
		renameInProject: (projectPath: string, oldName: string, newName: string) =>
			ipcRenderer.invoke(ipcChannels.promptsRenameInProject, projectPath, oldName, newName) as Promise<PiPromptTemplateSummary>,
	},
	promptStore: {
		search: (query: string, options?: { limit?: number; type?: string; category?: string; tag?: string }) =>
			ipcRenderer.invoke(ipcChannels.promptStoreSearch, query, options) as Promise<PromptStoreSearchResult>,
		get: (id: string) =>
			ipcRenderer.invoke(ipcChannels.promptStoreGet, id) as Promise<PromptStoreItem>,
		import: (data: { title: string; description: string; content: string }) =>
			ipcRenderer.invoke(ipcChannels.promptStoreImport, data) as Promise<PiPromptTemplateSummary>,
	},
	skillStore: {
		search: (query: string) =>
			ipcRenderer.invoke(ipcChannels.skillStoreSearch, query) as Promise<PromptStoreSearchResult>,
		import: (item: PromptStoreItem, locationId?: string) =>
			ipcRenderer.invoke(ipcChannels.skillStoreImport, item, locationId) as Promise<PiSkillSummary>,
	},
	skillHub: {
		search: (query: string, page?: number) =>
			ipcRenderer.invoke(ipcChannels.skillHubSearch, query, page ?? 1) as Promise<import("../shared/types").SkillHubSearchResult>,
		detail: (slug: string) =>
			ipcRenderer.invoke(ipcChannels.skillHubDetail, slug) as Promise<import("../shared/types").SkillHubDetail | null>,
		install: (slug: string, installDir: string) =>
			ipcRenderer.invoke(ipcChannels.skillHubInstall, slug, installDir) as Promise<import("../shared/types").SkillHubInstallResult>,
	},
	yaoPrompts: {
		list: () =>
			ipcRenderer.invoke(ipcChannels.yaoPromptsList) as Promise<YaoPromptListResult>,
		detail: (slug: string, category: string) =>
			ipcRenderer.invoke(ipcChannels.yaoPromptsDetail, slug, category) as Promise<YaoPromptDetailResult>,
		import: (slug: string, category: string) =>
			ipcRenderer.invoke(ipcChannels.yaoPromptsImport, slug, category) as Promise<PiPromptTemplateSummary>,
	},
	extensions: {
		list: () =>
			ipcRenderer.invoke(ipcChannels.extensionsList) as Promise<PiExtensionListResult>,
		uninstall: (source: string, scope?: "user" | "project" | "unknown") =>
			ipcRenderer.invoke(ipcChannels.extensionsUninstall, source, scope) as Promise<void>,
		install: (source: string) =>
			ipcRenderer.invoke(ipcChannels.extensionsInstall, source) as Promise<string>,
		toggle: (source: string, enabled: boolean) =>
			ipcRenderer.invoke(ipcChannels.extensionsToggle, source, enabled) as Promise<void>,
		update: () =>
			ipcRenderer.invoke(ipcChannels.extensionsUpdate) as Promise<PiCliUpdateResult>,
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
				diagnostic?: ConfigFileDiagnostic;
			}>,
		getAuth: () =>
			ipcRenderer.invoke(ipcChannels.configGetAuth) as Promise<{
				raw: string;
				parsed: Record<string, unknown>;
				diagnostic?: ConfigFileDiagnostic;
			}>,
		getSettings: () =>
			ipcRenderer.invoke(ipcChannels.configGetSettings) as Promise<{
				raw: string;
				parsed: Record<string, unknown>;
				diagnostic?: ConfigFileDiagnostic;
			}>,
		getTrust: () =>
			ipcRenderer.invoke(ipcChannels.configGetTrust) as Promise<{
				raw: string;
				parsed: Record<string, unknown>;
				diagnostic?: ConfigFileDiagnostic;
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
		rename: (agentId: string, name: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsRename,
				agentId,
				name,
			) as Promise<AgentTab>,
		stop: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsStop, agentId) as Promise<void>,
		prompt: (input: SendPromptInput) =>
			ipcRenderer.invoke(ipcChannels.agentsPrompt, input) as Promise<SendPromptResult>,
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
		editMessage: (agentId: string, messageId: string, text: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsEditMessage,
				agentId,
				messageId,
				text,
			) as Promise<void>,
		deleteMessage: (agentId: string, messageId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsDeleteMessage,
				agentId,
				messageId,
			) as Promise<void>,
		reload: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsReload, agentId) as Promise<void>,
		restart: (agentId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsRestart,
				agentId,
			) as Promise<AgentTab>,
		compact: (agentId: string, prompt?: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsCompact,
				agentId,
				prompt,
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
		/** 刷新模型配置，让运行中的 agent 重新加载 models.json */
		refreshModels: (agentId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsRefreshModels,
				agentId,
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
		/** 桌面宠物点击跳转：主进程通知主窗切换到活跃 Agent tab */
		onFocusTarget: (callback: (target: { agentId: string }) => void) =>
			subscribe(ipcChannels.petFocusAgentTarget, callback),
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
		/** 向 Agent 发送扩展 UI 响应（用户回答了 select/confirm/input/editor 对话框） */
		sendUiResponse: (agentId: string, requestId: string, response: { value?: string | boolean; cancelled?: boolean; confirmed?: boolean }) =>
			ipcRenderer.invoke(ipcChannels.agentsUiResponse, agentId, requestId, response) as Promise<void>,
		/** 监听 Agent 扩展 UI 请求（模型通过扩展调用了 ctx.ui.select/confirm/input/editor） */
		onUiRequest: (callback: (request: { agentId: string; requestId: string; method: string; title: string; options?: string[]; placeholder?: string; prefill?: string; allowOther?: boolean; completed?: boolean; value?: string; cancelled?: boolean; message?: string; notifyType?: "info" | "warning" | "error"; text?: string; widgetKey?: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor" }) => void) =>
			subscribe(ipcChannels.agentsUiRequest, callback),
		/** 监听项目信任确认请求（主进程在启动 Agent 前对含 .pi 资源的项目发起） */
		onTrustRequest: (callback: (request: { requestId: string; cwd: string; projectName: string }) => void) =>
			subscribe(ipcChannels.agentsTrustRequest, callback),
		/** 回传用户对项目信任确认弹窗的选择（trust-remember/trust-session/deny） */
		respondTrustRequest: (requestId: string, choice: "trust-remember" | "trust-session" | "deny") =>
			ipcRenderer.invoke(ipcChannels.agentsTrustResponse, requestId, choice) as Promise<void>,
	},
	pet: {
		/** 宠物窗监听主进程推送的聚合状态 */
		onState: (callback: (state: PetAggregateState) => void) =>
			subscribe(ipcChannels.petState, callback),
		/** 列出可用宠物包（内置 + petdex） */
		list: () =>
			ipcRenderer.invoke(ipcChannels.petList) as Promise<PetManifest[]>,
		/** 开关宠物 */
		setEnabled: (value: boolean) =>
			ipcRenderer.invoke(ipcChannels.petSetEnabled, value) as Promise<void>,
		/** 切换当前宠物 */
		setId: (id: string) =>
			ipcRenderer.invoke(ipcChannels.petSetId, id) as Promise<void>,
		/** 拖拽移动宠物窗 */
		moveWindow: (pos: { x: number; y: number }) =>
			ipcRenderer.invoke(ipcChannels.petMoveWindow, pos) as Promise<void>,
		/** 点击宠物跳转活跃 Agent */
		focusAgent: () =>
			ipcRenderer.invoke(ipcChannels.petFocusAgent) as Promise<void>,
		/** 主进程推送当前选中宠物的 manifest，据此加载 spritesheet */
		onSprite: (callback: (manifest: PetManifest) => void) =>
			subscribe(ipcChannels.petCurrentSprite, callback),
		/** 挂载时主动拉取当前选中宠物 manifest（避免推送竞态） */
		getCurrent: () =>
			ipcRenderer.invoke(ipcChannels.petGetCurrent) as Promise<PetManifest | null>,
		/** 主进程推送通知气泡（出错/完成） */
		onNotify: (callback: (n: PetNotification) => void) =>
			subscribe(ipcChannels.petNotify, callback),
		setPreviewMode: (mode: string) =>
			ipcRenderer.invoke(ipcChannels.petPreviewMode, mode) as Promise<void>,
		onPreviewMode: (callback: (mode: string) => void) =>
			subscribe(ipcChannels.petPreviewMode, callback),
		onCaps: (callback: (caps: PetWindowCaps) => void) =>
			subscribe(ipcChannels.petCaps, callback),
		/** 调试：发送测试通知弹窗 */
		testNotify: (type: "error" | "done") =>
			ipcRenderer.invoke(ipcChannels.petTestNotify, type) as Promise<void>,
		/** 双击宠物触发逗弄：主进程注入一次 jumping 后恢复真实聚合态 */
		tease: () =>
			ipcRenderer.invoke(ipcChannels.petTease) as Promise<void>,
		/** 通知主进程拖拽起止：开始时暂停巡游，结束时若处于 idle 则恢复巡游 */
		setDragging: (dragging: boolean) =>
			ipcRenderer.invoke(ipcChannels.petDragState, dragging) as Promise<void>,
		/** 拖拽相对位移（连续 screenX 差值），主进程读取当前窗口位置 + 增量 */
		moveBy: (delta: { dx: number; dy: number }) =>
			ipcRenderer.invoke(ipcChannels.petMoveBy, delta) as Promise<void>,
		/** 通知主进程：宠物窗 React 已挂载，IPC 监听器已注册，可以安全推送初始状态 */
		ready: () => ipcRenderer.send(ipcChannels.petReady),
		/** 右键上下文菜单 */
		contextMenu: () => ipcRenderer.invoke(ipcChannels.petContextMenu) as Promise<void>,
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

	// ===== 飞书桥接 =====
	feishu: {
		connect: (input: FeishuConnectInput) =>
			ipcRenderer.invoke(ipcChannels.feishuConnect, input) as Promise<{
				success: boolean;
				message: string;
			}>,
		connectTemp: (input: FeishuConnectInput) =>
			ipcRenderer.invoke(ipcChannels.feishuConnectTemp, input) as Promise<{
				success: boolean;
				message: string;
				botInfo?: { id: string; name: string };
			}>,
		disconnect: () =>
			ipcRenderer.invoke(ipcChannels.feishuDisconnect) as Promise<{ success: boolean }>,
		connectByBot: (botId: string) =>
			ipcRenderer.invoke(ipcChannels.feishuConnectByBot, botId) as Promise<{
				success: boolean;
				message: string;
			}>,
		statusRequest: () =>
			ipcRenderer.invoke(ipcChannels.feishuStatusRequest) as Promise<FeishuBridgeStatus>,
		onStatus: (callback: (status: FeishuBridgeStatus) => void) =>
			subscribe(ipcChannels.feishuStatus, callback),
		botsList: () =>
			ipcRenderer.invoke(ipcChannels.feishuBotsList) as Promise<FeishuBotConfig[]>,
		botAdd: (input: FeishuConnectInput) =>
			ipcRenderer.invoke(ipcChannels.feishuBotAdd, input) as Promise<{
				success: boolean;
				bot?: FeishuBotConfig;
				error?: string;
			}>,
		botRemove: (botId: string) =>
			ipcRenderer.invoke(ipcChannels.feishuBotRemove, botId) as Promise<boolean>,
		botConfig: (botId: string, patch: Partial<FeishuBotConfig>) =>
			ipcRenderer.invoke(ipcChannels.feishuBotConfig, botId, patch) as Promise<FeishuBotConfig | undefined>,
		botSecret: (botId: string) =>
			ipcRenderer.invoke(ipcChannels.feishuBotSecret, botId) as Promise<string>,
		testConnection: (appId: string, appSecret: string) =>
			ipcRenderer.invoke(ipcChannels.feishuTestConnection, appId, appSecret) as Promise<FeishuTestResult>,
		bindingsList: () =>
			ipcRenderer.invoke(ipcChannels.feishuBindingsList) as Promise<FeishuChatBinding[]>,
		bindingRemove: (chatId: string) =>
			ipcRenderer.invoke(ipcChannels.feishuBindingRemove, chatId) as Promise<boolean>,
		bindingUpdate: (chatId: string, patch: Partial<FeishuChatBinding>) =>
			ipcRenderer.invoke(ipcChannels.feishuBindingUpdate, chatId, patch) as Promise<FeishuChatBinding | undefined>,
		onMessages: (callback: (message: FeishuChatMessage) => void) =>
			subscribe(ipcChannels.feishuMessages, callback),
		onBindingsChanged: (callback: (bindings: FeishuChatBinding[]) => void) =>
			subscribe(ipcChannels.feishuBindingsChanged, callback),
		onWhoamiResult: (callback: (openId: string) => void) =>
			subscribe(ipcChannels.feishuWhoamiResult, callback),
		onBotsChanged: (callback: (bots: FeishuBotConfig[]) => void) =>
			subscribe(ipcChannels.feishuBotsChanged, callback),
		sessionBotGet: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.feishuSessionBotGet, agentId) as Promise<string | null>,
		sessionBotSet: (agentId: string, botId: string | null) =>
			ipcRenderer.invoke(ipcChannels.feishuSessionBotSet, agentId, botId) as Promise<void>,
	},

	// ===== 内置浏览器 =====
	browser: {
		/** 在系统默认浏览器中打开外部链接。
		 *  用于 webview 不支持或需要另开浏览器查看的场景。 */
		openExternal: (url: string) =>
			ipcRenderer.invoke(ipcChannels.browserOpenExternal, url) as Promise<void>,
	},

	scratchPad: {
		list: () =>
			ipcRenderer.invoke(ipcChannels.scratchPadList) as Promise<DraftMeta[]>,
		create: () =>
			ipcRenderer.invoke(ipcChannels.scratchPadCreate) as Promise<DraftMeta>,
		delete: (draftPath: string) =>
			ipcRenderer.invoke(ipcChannels.scratchPadDelete, draftPath) as Promise<void>,
		load: (draftPath?: string) =>
			ipcRenderer.invoke(ipcChannels.scratchPadLoad, draftPath) as Promise<ScratchPadData>,
		save: (draftPath: string, content: string, cursorPosition: number) =>
			ipcRenderer.invoke(ipcChannels.scratchPadSave, draftPath, content, cursorPosition) as Promise<void>,
		export: (draftPath: string) =>
			ipcRenderer.invoke(ipcChannels.scratchPadExport, draftPath) as Promise<boolean>,
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

try {
	contextBridge.exposeInMainWorld("piDesktop", api);
	ipcRenderer.send(ipcChannels.preloadReady);
} catch (error) {
	const detail =
		error instanceof Error
			? { message: error.message, stack: error.stack }
			: { message: String(error) };
	console.error("[PiDeck preload] Failed to expose desktop API", detail);
	ipcRenderer.send(ipcChannels.preloadError, detail);
}

export type PiDesktopApi = typeof api;
