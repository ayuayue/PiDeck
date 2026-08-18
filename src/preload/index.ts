import { clipboard, contextBridge, ipcRenderer, webUtils } from "electron";
import { ipcChannels } from "../shared/ipc";
import type { RpcLogBatch, RpcLogEntry } from "../shared/types/rpcLog";
import type { ImageGenRequest, ImageGenResult } from "../shared/types/imagegen";
import type {
	YaoPromptListResult,
	YaoPromptDetailResult,
	AgentRuntimeState,
	AppInfo,
	AppLogEntry,
	AppLogLevel,
	AppLogPage,
	AppLogQuery,
	ProcessMetricsSnapshot,
	AppSettings,
	AppUpdateDownloadProgress,
	AppUpdateDownloadResult,
	AppUpdateInfo,
	AvailableModel,
	ChatMessage,
	ModelSpec,
	CodexImportReport,
	CodexSessionSummary,
	ClaudeImportReport,
	ClaudeSessionSummary,
	OpenCodeImportReport,
	OpenCodeSessionSummary,
	ConfigFileDiagnostic,
	DraftMeta,
	CreateSessionDraftInput,
	CreateAnonymousSessionInput,
	CreateAnonymousSessionResult,
	UpdateSessionRecordInput,
	SessionRecord,
	SessionProcessEvent,
	VisionBridgeConfig,
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
	FeishuSessionBotResult,
	FeishuTestResult,
	FileTreeNode,
	GitBranchInfo,
	ImageContent,
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
	SecurityConfig,
	SendSessionPromptInput,
	SendSessionPromptResult,
	SessionCommandResult,
	SessionRuntimeEvent,
	SessionRuntimeInfo,
	SessionRuntimeReplacement,
	SessionRuntimeTarget,
	SessionTargetedValue,
	SessionUiResponseInput,
	SessionSummary,
	TerminalDataEvent,
	TerminalExitEvent,
	TerminalShell,
	TerminalTab,
	TerminalTarget,
	WebNetworkAddress,
} from "../shared/types";

/**
 * 解析 Windows CF_HDROP 剪贴板缓冲，得到资源管理器复制的多文件路径。
 * DROPFILES 头 20 字节后是以双空结尾的路径列表（宽字符或 ANSI）。
 */
function parseCfHdrop(buffer: Buffer): string[] {
	if (buffer.length < 20) return [];
	const pFiles = buffer.readUInt32LE(0);
	const fWide = buffer.readUInt32LE(16) !== 0;
	if (pFiles <= 0 || pFiles >= buffer.length) return [];

	const paths: string[] = [];
	let offset = pFiles;
	if (fWide) {
		// UTF-16LE：条目以 \0\0 分隔，列表以 \0\0\0\0 结束
		while (offset + 2 <= buffer.length) {
			let end = offset;
			while (end + 1 < buffer.length && !(buffer[end] === 0 && buffer[end + 1] === 0)) {
				end += 2;
			}
			if (end === offset) break;
			paths.push(buffer.toString("utf16le", offset, end));
			offset = end + 2;
		}
	} else {
		while (offset < buffer.length) {
			let end = offset;
			while (end < buffer.length && buffer[end] !== 0) end++;
			if (end === offset) break;
			paths.push(buffer.toString("utf8", offset, end));
			offset = end + 1;
		}
	}
	return paths.map((p) => p.trim()).filter(Boolean);
}

/** 将 file:// URI 转为本地路径（兼容 Windows 盘符与 URL 编码）。 */
function fileUrlToPath(uri: string): string {
	const trimmed = uri.trim();
	if (!trimmed) return "";
	let path = trimmed.replace(/^file:\/\//i, "");
	// Windows: /C:/Users/... → C:/Users/...
	if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
	try {
		path = decodeURIComponent(path);
	} catch {
		// 保留原始字符串
	}
	return path;
}

/**
 * 从系统剪贴板读取「资源管理器复制文件」的本地路径列表。
 * 浏览器 ClipboardEvent 在复制文件时通常拿不到 kind=file，必须走 Electron clipboard。
 * 同步实现，便于粘贴事件里立刻 preventDefault。
 */
function readClipboardFilePaths(): string[] {
	try {
		if (process.platform === "win32") {
			// 优先 CF_HDROP：支持多选复制
			try {
				const drop = clipboard.readBuffer("CF_HDROP");
				if (drop && drop.length > 0) {
					const paths = parseCfHdrop(drop);
					if (paths.length > 0) return paths;
				}
			} catch {
				// 部分环境无 CF_HDROP，回退 FileNameW
			}
			if (clipboard.has("FileNameW")) {
				const raw = clipboard.readBuffer("FileNameW").toString("ucs2");
				const path = raw.replace(/\0/g, "").trim();
				if (path) return [path];
			}
			return [];
		}

		if (process.platform === "darwin") {
			const url = clipboard.read("public.file-url");
			if (url) {
				const path = fileUrlToPath(url);
				return path ? [path] : [];
			}
			return [];
		}

		// Linux：text/uri-list 或 GNOME 专用格式
		if (clipboard.has("text/uri-list")) {
			const text = clipboard.read("text/uri-list");
			return text
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line.startsWith("file://") && !line.startsWith("#"))
				.map(fileUrlToPath)
				.filter(Boolean);
		}
		if (clipboard.has("x-special/gnome-copied-files")) {
			const text = clipboard.read("x-special/gnome-copied-files");
			return text
				.split(/\r?\n/)
				.slice(1) // 首行是 copy/cut
				.map((line) => line.trim())
				.filter((line) => line.startsWith("file://"))
				.map(fileUrlToPath)
				.filter(Boolean);
		}
	} catch {
		// 剪贴板格式不可用时静默失败，回退为普通文本粘贴
	}
	return [];
}

const api = {
	clipboard: {
		// 同步读取剪贴板（主进程 clipboard 模块），供输入框右键“粘贴”菜单使用：
		// readText 读纯文本；readHtml 读富文本（无 HTML 时返回空串，调用方降级纯文本）
		readText: () => clipboard.readText(),
		readHtml: () => clipboard.readHTML(),
		// 读剪贴板位图槽（截图/复制图片），无图返回空串；PNG data URL
		readImage: () => {
			const image = clipboard.readImage();
			return image.isEmpty() ? "" : image.toDataURL();
		},
	},
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
		// 查询模型规格（context window / 能力，内置 model-specs.db，中转站按 id 匹配）
		getModelSpec: (providerName: string, modelId: string) =>
			ipcRenderer.invoke(ipcChannels.projectsGetModelSpec, providerName, modelId) as Promise<
				ModelSpec | null
			>,
		onTrustRequest: (callback: (request: {
			requestId: string;
			cwd: string;
			projectName: string;
		}) => void) => subscribe(ipcChannels.projectsTrustRequest, callback),
		respondTrustRequest: (
			requestId: string,
			choice: "trust-remember" | "trust-session" | "deny",
		) => ipcRenderer.invoke(ipcChannels.projectsTrustResponse, requestId, choice) as Promise<void>,
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
		readContent: (path: string, maxBytes?: number) =>
			ipcRenderer.invoke(ipcChannels.filesReadContent, path, maxBytes) as Promise<string>,
		/** 读取二进制文件为 data URL（粘贴资源管理器图片文件时用；maxBytes 可预检拦截超大文件） */
		readBase64: (path: string, maxBytes?: number) =>
			ipcRenderer.invoke(ipcChannels.filesReadBase64, path, maxBytes) as Promise<string>,
		writeContent: (path: string, content: string) =>
			ipcRenderer.invoke(ipcChannels.filesWriteContent, path, content) as Promise<void>,
		delete: (path: string, recursive?: boolean) =>
			ipcRenderer.invoke(ipcChannels.filesDelete, path, recursive) as Promise<void>,
		/** 复制来源路径到目标目录（支持文件和目录递归），返回目标路径列表 */
		copy: (sourcePaths: string[], targetDir: string) =>
			ipcRenderer.invoke(ipcChannels.filesCopy, sourcePaths, targetDir) as Promise<string[]>,
		/** 移动来源路径到目标目录（同设备 rename，跨设备 cp+rm） */
		move: (sourcePaths: string[], targetDir: string) =>
			ipcRenderer.invoke(ipcChannels.filesMove, sourcePaths, targetDir) as Promise<string[]>,
		create: (parentDir: string, name: string, type: "file" | "directory") =>
			ipcRenderer.invoke(ipcChannels.filesCreate, parentDir, name, type) as Promise<string>,
		rename: (path: string, newName: string) =>
			ipcRenderer.invoke(ipcChannels.filesRename, path, newName) as Promise<string>,
		/**
		 * Electron 32+ 已移除 File.path，拖拽/粘贴得到的 File 必须经 webUtils 解析本地路径。
		 * 同步返回，可在 drop/paste 事件中立即使用。
		 */
		getPathForFile: (file: File) => {
			try {
				return webUtils.getPathForFile(file) || "";
			} catch {
				return "";
			}
		},
		/**
		 * 读取资源管理器「复制文件」到剪贴板的路径列表。
		 * 浏览器 ClipboardEvent 通常暴露不出 kind=file，粘贴文件引用依赖此同步 API。
		 */
		getClipboardPaths: () => readClipboardFilePaths(),
	},
	dialog: {
		/**
		 * 打开系统原生文件选择器（默认仅文件；includeDirectories 时文件+目录），支持多选。
		 * 返回选中路径列表，取消时返回空数组。
		 */
		pickFiles: (options?: { title?: string; includeDirectories?: boolean }) =>
			ipcRenderer.invoke(ipcChannels.dialogPickFiles, options) as Promise<string[]>,
		/** 换肤背景图：选图并复制到 userData/backgrounds/，返回文件名（空串=取消） */
		pickBackgroundImage: () =>
			ipcRenderer.invoke(ipcChannels.pickBackgroundImage) as Promise<string>,
		/** 删除背景图文件（清空背景设置时调用） */
		removeBackgroundImage: (name: string) =>
			ipcRenderer.invoke(ipcChannels.removeBackgroundImage, name) as Promise<void>,
	},
	sessions: {
		list: (projectId?: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsList, projectId) as Promise<
				SessionSummary[]
			>,
		listCatalog: (projectId: string, options?: { scan?: boolean }) =>
			ipcRenderer.invoke(ipcChannels.sessionsCatalogList, projectId, options) as Promise<
				SessionRecord[]
			>,
		/** 后台扫描完成推送：目录缓存已合并，监听方应以 scan:false 重新拉取。返回退订函数。 */
		onCatalogRefreshed: (listener: (input: { projectId: string }) => void) => {
			const handler = (_event: unknown, payload: { projectId: string }) => listener(payload);
			ipcRenderer.on(ipcChannels.sessionsCatalogRefreshed, handler);
			return () => {
				ipcRenderer.removeListener(ipcChannels.sessionsCatalogRefreshed, handler);
			};
		},
		createDraft: (input: CreateSessionDraftInput) =>
			ipcRenderer.invoke(ipcChannels.sessionsCatalogCreateDraft, input) as Promise<SessionRecord>,
		createAnonymous: (input: CreateAnonymousSessionInput) =>
			ipcRenderer.invoke(ipcChannels.sessionsCreateAnonymous, input) as Promise<CreateAnonymousSessionResult>,
		updateRecord: (sessionId: string, patch: UpdateSessionRecordInput) =>
			ipcRenderer.invoke(
				ipcChannels.sessionsCatalogUpdate,
				sessionId,
				patch,
			) as Promise<SessionRecord>,
		/** DSH host 级模型目录（llm.models），未装配时返回空列表。 */
		listDshModels: () =>
			ipcRenderer.invoke(ipcChannels.dshListModels) as Promise<AvailableModel[]>,
		/** DSH 可配置提供方目录（llm.providers：内置 catalog + 已注册路由）。 */
		listDshProviders: () =>
			ipcRenderer.invoke(ipcChannels.dshListProviders) as Promise<Array<{
				provider: string;
				displayName: string;
				active: boolean;
				declared?: boolean;
			}>>,
		/** DSH agent 预设目录（agentPreset.list），未装配时返回空列表。 */
		listDshAgentPresets: () =>
			ipcRenderer.invoke(ipcChannels.dshAgentPresets) as Promise<Array<{
				id: string;
				trust: "system" | "user";
				isDefault: boolean;
				name?: string;
				description?: string;
				broken?: string;
			}>>,
		/** DSH 部署默认模型选择（settings.yaml agent-default-model），未装配/不可读时 undefined。 */
		getDshDefaultModel: () =>
			ipcRenderer.invoke(ipcChannels.dshDefaultModel) as Promise<{
				provider: string;
				model: string;
				reasoningEffort?: string;
			} | undefined>,
		/** DSH 配置管理页状态（host 启动状态 + DSH_HOME 目录）。 */
		getDshStatus: () =>
			ipcRenderer.invoke(ipcChannels.dshGetStatus) as Promise<{
				started: boolean;
				homeDir: string;
			}>,
		/** DSH settings.describe（脱敏 namespace 视图 + schema）。 */
		describeDshSettings: () =>
			ipcRenderer.invoke(ipcChannels.dshConfigDescribe) as Promise<{
				writable: boolean;
				hasDocument: boolean;
				namespaces: Array<{
					ns: string;
					applies: string;
					revision: number;
					value: unknown;
					user?: unknown;
					secrets: Array<{ path: string[]; set: boolean }>;
					schema: unknown;
				}>;
			}>,
		/** DSH settings.update。 */
		updateDshSettings: (ns: string, patch: Record<string, unknown>, expectedRevision?: number) =>
			ipcRenderer.invoke(ipcChannels.dshConfigUpdate, ns, patch, expectedRevision) as Promise<unknown>,
		/** DSH credentials.describe。 */
		describeDshCredentials: (refs: string[]) =>
			ipcRenderer.invoke(ipcChannels.dshCredentialDescribe, refs) as Promise<Record<string, {
				configured: boolean;
				source?: string;
				writable: boolean;
			}>>,
		/** DSH credentials.set。 */
		setDshCredential: (ref: string, value: string) =>
			ipcRenderer.invoke(ipcChannels.dshCredentialSet, ref, value) as Promise<void>,
		/** DSH credentials.unset。 */
		unsetDshCredential: (ref: string) =>
			ipcRenderer.invoke(ipcChannels.dshCredentialUnset, ref) as Promise<void>,
		/** DSH 凭证明文读取（渲染层点「眼睛」时按 ref 取一次；无值返回 undefined）。 */
		readDshCredential: (ref: string) =>
			ipcRenderer.invoke(ipcChannels.dshCredentialRead, ref) as Promise<string | undefined>,
		/** DSH settings.openDocument（平台打开配置文档）。 */
		openDshDocument: () =>
			ipcRenderer.invoke(ipcChannels.dshOpenDocument) as Promise<void>,
		/** DSH host 重启（DSH_HOME 切换后立即生效；有活跃 DSH 会话时返回 false）。 */
		restartDshHost: () =>
			ipcRenderer.invoke(ipcChannels.dshRestartHost) as Promise<boolean>,
		deleteRecord: (sessionId: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsCatalogDelete, sessionId) as Promise<boolean>,
		/** 归档会话（移入 .pideck-archive/ 并从目录移除）；运行中的会话会抛错 */
		archiveRecord: (sessionId: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsCatalogArchive, sessionId) as Promise<boolean>,
		/** 恢复归档会话（移回原路径并重新入目录） */
		unarchiveRecord: (archivedPath: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsCatalogUnarchive, archivedPath) as Promise<boolean>,
		/** 列出已归档会话摘要（恢复 UI 用） */
		listArchived: () =>
			ipcRenderer.invoke(ipcChannels.sessionsCatalogListArchived) as Promise<SessionSummary[]>,
		readRecordMessages: (sessionId: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsCatalogReadMessages, sessionId) as Promise<
				import("../shared/types").ChatMessage[]
			>,
		readRecordMessagePage: (sessionId: string, before?: number, pageSize?: number, options?: { unit?: "message" | "turn"; beforeEntryId?: string }) =>
			ipcRenderer.invoke(
				ipcChannels.sessionsCatalogReadMessagePage,
				sessionId,
				before,
				pageSize,
				options,
			) as Promise<import("../shared/types").SessionMessagePage>,
		/** 会话 JSONL 过程事件（session/model/thinking/custom），轨迹复盘用。 */
		readProcessEvents: (sessionId: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsCatalogReadProcessEvents, sessionId) as Promise<
				SessionProcessEvent[]
			>,
		/** DSH 会话轨迹系统提示（request/header 的 EpochHeader.system；非 DSH/无数据返回 undefined）。 */
		readDshSystemPrompt: (sessionId: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsCatalogReadDshSystemPrompt, sessionId) as Promise<
				string | undefined
			>,
		/** 按需读取单条消息完整文本（工具结果截断后的「查看完整输出」）。
		 *  sessionId 用于运行期绑定不可用时的历史会话文件回退（_viewer 投影）。 */
		readMessageFullText: (
			sessionId: string | undefined,
			agentId: string,
			messageId: string,
			entryId?: string,
		) =>
			ipcRenderer.invoke(
				ipcChannels.sessionsCatalogReadMessageFullText,
				sessionId,
				agentId,
				messageId,
				entryId,
			) as Promise<{ text: string }>,
		readReferenceMessages: (sessionId: string) =>
			ipcRenderer.invoke(
				ipcChannels.sessionsCatalogReadReferenceMessages,
				sessionId,
			) as Promise<Array<{ role: string; content: string; timestamp: number }>>,
		copyRecord: (sessionId: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsCatalogCopy, sessionId) as Promise<{
				cancelled?: boolean;
				targetSessionId?: string;
			}>,
		exportRecordHtml: (sessionId: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsCatalogExportHtml, sessionId) as Promise<{
				path: string;
			}>,
		/** DSH 会话文件路径推导（右键「复制会话文件路径」；非 DSH/不可推导返回 undefined）。 */
		getDshSessionPath: (sessionId: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsGetDshSessionPath, sessionId) as Promise<
				string | undefined
			>,
		/** DSH 会话内容搜索（侧栏搜索框全文搜索；结果含 dshSessionId + snippet）。 */
		searchDshSessions: (query: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsSearchDsh, query) as Promise<
				Array<{ sessionId: string; snippet: string }>
			>,
		/** DSH 创建目标（goal.create）。 */
		createDshGoal: (agentId: string, objective: string, maxGoalRounds?: number) =>
			ipcRenderer.invoke(ipcChannels.dshCreateGoal, agentId, objective, maxGoalRounds) as Promise<void>,
		/** DSH 目标操作（pause/resume/complete/clear）。 */
		runDshGoalAction: (agentId: string, action: "pause" | "resume" | "complete" | "clear") =>
			ipcRenderer.invoke(ipcChannels.dshGoalAction, agentId, action) as Promise<void>,
		/** DSH 子代理列表（subagent.list）。 */
		listDshSubagents: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.dshListSubagents, agentId) as Promise<
				Array<{
					id: string;
					label?: string;
					activity: "running" | "inactive";
					hasChildren: boolean;
					mode: "one-shot" | "continuable";
					kind: "child" | "diagnostic";
				}>
			>,
		/** DSH 子代理历史（subagent.history 只读 transcript）。 */
		readDshSubagentHistory: (
			agentId: string,
			childSessionId: string,
			beforeSeq?: number,
			maxMessages?: number,
		) =>
			ipcRenderer.invoke(ipcChannels.dshSubagentHistory, agentId, childSessionId, beforeSeq, maxMessages) as Promise<{
				messages: import("../shared/types").ChatMessage[];
				hasMore: boolean;
			}>,
		/** DSH 技能目录（skill.list 只读；/name 斜杠调用，G7）。 */
		listDshSkills: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.dshListSkills, agentId) as Promise<import("../shared/types").DshSkillView[]>,
		/** DSH 孤儿会话 id 列表（host 有但 catalog 无映射；G3/D11 清理提示用）。 */
		listDshOrphans: () =>
			ipcRenderer.invoke(ipcChannels.dshListOrphans) as Promise<string[]>,
		/** DSH 外部会话清单（dsh-web 等其他工具创建的 host 根会话，跨工具导入用）。 */
		listDshForeignSessions: () =>
			ipcRenderer.invoke(ipcChannels.dshListForeignSessions) as Promise<Array<{
				dshSessionId: string;
				title?: string;
				cwd?: string;
				updatedAt?: number;
			}>>,
		/** DSH 外部会话导入（把 host 会话映射进 catalog，侧栏可见可加载）。 */
		importDshForeignSession: (dshSessionId: string) =>
			ipcRenderer.invoke(ipcChannels.dshImportForeignSession, dshSessionId) as Promise<import("../shared/types").SessionRecord>,
		/** DSH 外部会话全量同步（自动发现：catalog 未映射的 host 根会话全部导入）。 */
		syncDshForeignSessions: () =>
			ipcRenderer.invoke(ipcChannels.dshSyncForeignSessions) as Promise<{ imported: number; skipped: number }>,
		listUngroupedAdoptable: () =>
			ipcRenderer.invoke(ipcChannels.dshListUngroupedAdoptable) as Promise<Array<{
				dshSessionId: string;
				cwd: string;
				workspaceId: string;
				workspaceTitle?: string;
			}>>,
		adoptUngroupedSessions: () =>
			ipcRenderer.invoke(ipcChannels.dshAdoptUngroupedSessions) as Promise<{ adopted: number; failed: number }>,
		previewMissingProjectionTitles: () =>
			ipcRenderer.invoke(ipcChannels.dshPreviewMissingProjectionTitles) as Promise<{
				missing: number;
				titled: number;
				samples: Array<{ dshSessionId: string; loggedTitle?: string; cwd?: string }>;
			}>,
		backfillProjectionTitles: () =>
			ipcRenderer.invoke(ipcChannels.dshBackfillProjectionTitles) as Promise<{ attempted: number; failed: number }>,
		/** DSH 归档区会话清单（G14：恢复入口用；目录已移入 .pideck-archive 的 host 会话）。 */
		listArchivedDshSessions: () =>
			ipcRenderer.invoke(ipcChannels.dshListArchived) as Promise<Array<{
				dshSessionId: string;
				cwd: string;
				archivedAt: number;
			}>>,
		/** DSH 会话恢复（G14：目录按 manifest 移回 sessions 树并重建 catalog 记录）。 */
		unarchiveDshSession: (dshSessionId: string) =>
			ipcRenderer.invoke(ipcChannels.dshUnarchive, dshSessionId) as Promise<boolean>,
		/** DSH 动态插件清单（G13 深化：进程内临时扩展，重启即失；按会话归属）。 */
		listDshDynamicPlugins: () =>
			ipcRenderer.invoke(ipcChannels.dshPluginList) as Promise<import("../shared/types").DshPluginView[]>,
		/** DSH 静态 Loader 条目清单（只读：moduleName/enabled/fiberPhase）。 */
		listDshStaticPlugins: () =>
			ipcRenderer.invoke(ipcChannels.dshPluginStaticList) as Promise<import("../shared/types").DshStaticPluginView[]>,
		/** DSH 动态插件安装（define：定义源码包，不运行）。 */
		installDshPlugin: (input: import("../shared/types").DshPluginInstallInput) =>
			ipcRenderer.invoke(ipcChannels.dshPluginInstall, input) as Promise<unknown>,
		/** DSH 动态插件运行（面板手势，无需审批）。 */
		runDshPlugin: (input: import("../shared/types").DshPluginLifecycleInput) =>
			ipcRenderer.invoke(ipcChannels.dshPluginRun, input) as Promise<unknown>,
		/** DSH 动态插件停止（保留全部包版本）。 */
		stopDshPlugin: (input: import("../shared/types").DshPluginLifecycleInput) =>
			ipcRenderer.invoke(ipcChannels.dshPluginStop, input) as Promise<unknown>,
		/** DSH 动态插件卸载（undefine：删除插件与全部包版本）。 */
		uninstallDshPlugin: (input: import("../shared/types").DshPluginLifecycleInput) =>
			ipcRenderer.invoke(ipcChannels.dshPluginUninstall, input) as Promise<unknown>,
		sendPrompt: (input: SendSessionPromptInput) =>
			ipcRenderer.invoke(ipcChannels.sessionsSendPrompt, input) as Promise<SendSessionPromptResult>,
		sendUiResponse: (input: SessionUiResponseInput) =>
			ipcRenderer.invoke(ipcChannels.sessionsUiResponse, input) as Promise<void>,
		onRuntimeEvent: (callback: (event: SessionRuntimeEvent) => void) =>
			subscribe(ipcChannels.sessionsRuntimeEvent, callback),
		listRuntimes: () =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimeList) as Promise<SessionRuntimeInfo[]>,
		activateRuntime: (sessionId: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimeActivate, sessionId) as Promise<
				SessionCommandResult<SessionRuntimeInfo>
			>,		/** 汇报当前聚焦的会话（主进程据此决定非聚焦会话的 Ask 桌面通知） */
		setFocusedSession: (sessionId?: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsSetFocusedSession, sessionId) as Promise<void>,
		stopRuntime: (target: SessionRuntimeTarget) =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimeStop, target) as Promise<
				SessionCommandResult<SessionRuntimeTarget>
			>,
		abortRuntime: (target: SessionRuntimeTarget) =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimeAbort, target) as Promise<
				SessionCommandResult<SessionTargetedValue<void>>
			>,
		restartRuntime: (target: SessionRuntimeTarget) =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimeRestart, target) as Promise<
				SessionCommandResult<SessionRuntimeReplacement>
			>,
		compactRuntime: (target: SessionRuntimeTarget, prompt?: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimeCompact, target, prompt) as Promise<
				SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>
			>,
		getRuntimeState: (target: SessionRuntimeTarget) =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimeState, target) as Promise<
				SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>
			>,
		listRuntimeCommands: (target: SessionRuntimeTarget) =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimeCommands, target) as Promise<
				SessionCommandResult<SessionTargetedValue<PiCommand[]>>
			>,
		/** 运行中 Agent 快照里的模型；不在此列表 = 新加配置，切过去要重启。 */
		listRuntimeModels: (target: SessionRuntimeTarget) =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimeListModels, target) as Promise<
				SessionCommandResult<SessionTargetedValue<AvailableModel[]>>
			>,
		exportRuntimeHtml: (target: SessionRuntimeTarget) =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimeExportHtml, target) as Promise<
				SessionCommandResult<SessionTargetedValue<unknown>>
			>,
		editRuntimeMessage: (target: SessionRuntimeTarget, messageId: string, newText: string) =>
			ipcRenderer.invoke(
				ipcChannels.sessionsRuntimeEditMessage,
				target,
				messageId,
				newText,
			) as Promise<SessionCommandResult<SessionTargetedValue<void>>>,
		deleteRuntimeMessage: (target: SessionRuntimeTarget, messageId: string) =>
			ipcRenderer.invoke(
				ipcChannels.sessionsRuntimeDeleteMessage,
				target,
				messageId,
			) as Promise<SessionCommandResult<SessionTargetedValue<void>>>,
		prepareRuntimeResend: (target: SessionRuntimeTarget, messageId: string) =>
			ipcRenderer.invoke(
				ipcChannels.sessionsRuntimePrepareResend,
				target,
				messageId,
			) as Promise<SessionCommandResult<SessionTargetedValue<{
				text: string;
				images?: ImageContent[];
			}>>>,
		setRuntimeModel: (target: SessionRuntimeTarget, provider: string, modelId: string) =>
			ipcRenderer.invoke(
				ipcChannels.sessionsRuntimeSetModel,
				target,
				provider,
				modelId,
			) as Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>>,
		setRuntimeThinking: (target: SessionRuntimeTarget, level: string) =>
			ipcRenderer.invoke(
				ipcChannels.sessionsRuntimeSetThinking,
				target,
				level,
			) as Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>>,
		cloneRuntime: (target: SessionRuntimeTarget) =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimeClone, target) as Promise<
				SessionCommandResult<{
					cancelled?: boolean;
					targetSessionId?: string;
					[key: string]: unknown;
				}>
			>,
		/** 列出可 fork 的用户消息 entryId，用于 meta.entryId 缺失时的正文回退匹配。 */
		getRuntimeForkMessages: (target: SessionRuntimeTarget) =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimeGetForkMessages, target) as Promise<
				SessionCommandResult<
					SessionTargetedValue<Array<{ entryId: string; text: string }>>
				>
			>,
		/** 从指定 entryId fork 新会话（pi /fork），成功后会替换当前 runtime 绑定。 */
		forkRuntimeSession: (target: SessionRuntimeTarget, entryId: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimeFork, target, entryId) as Promise<
				SessionCommandResult<{
					cancelled?: boolean;
					text?: string;
					targetSessionId?: string;
					[key: string]: unknown;
				}>
			>,
	},
	usageStats: {
		detect: () =>
			ipcRenderer.invoke(ipcChannels.usageStatsDetect) as Promise<
				import("../shared/types").UsageStatsDetectResult
			>,
		refresh: () =>
			ipcRenderer.invoke(ipcChannels.usageStatsRefresh) as Promise<
				import("../shared/types").UsageStatsRefreshResult
			>,
		get: () =>
			ipcRenderer.invoke(ipcChannels.usageStatsGet) as Promise<
				import("../shared/types").UsageAggregated
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
		cherryPick: (projectId: string, hash: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitCherryPick,
				projectId,
				hash,
			) as Promise<void>,
		revert: (projectId: string, hash: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitRevert,
				projectId,
				hash,
			) as Promise<void>,
		reset: (projectId: string, hash: string, mode: "soft" | "mixed" | "hard") =>
			ipcRenderer.invoke(
				ipcChannels.gitReset,
				projectId,
				hash,
				mode,
			) as Promise<void>,
		dropCommit: (projectId: string, hash: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitDropCommit,
				projectId,
				hash,
			) as Promise<void>,
		/** AI 生成提交摘要 */
		generateCommitMessage: (projectId: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitGenerateCommitMessage,
				projectId,
			) as Promise<import("../shared/types").GitGenerateCommitMessageResult>,
		/** 初始化 Git 仓库 */
		init: (projectId: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitInit,
				projectId,
			) as Promise<void>,
		/** Push：将当前分支推送到远程 */
		push: (projectId: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitPush,
				projectId,
			) as Promise<void>,
		/** Pull：从远程拉取并合并到当前分支 */
		pull: (projectId: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitPull,
				projectId,
			) as Promise<void>,
		/** Fetch：从远程获取最新数据但不合并 */
		fetch: (projectId: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitFetch,
				projectId,
			) as Promise<void>,
		/** 当前分支相对上游的提交差距（ahead/behind），驱动 push/pull 角标 */
		aheadBehind: (projectId: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitAheadBehind,
				projectId,
			) as Promise<import("../shared/types").GitAheadBehind | null>,
		/** 从磁盘删除变更文件（移入回收站，可恢复） */
		deleteFiles: (projectId: string, paths: string[]) =>
			ipcRenderer.invoke(
				ipcChannels.gitDeleteFiles,
				projectId,
				paths,
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
	system: {
		/** 进程监控：拉取 Electron 各进程 + pi agent 子进程内存/CPU 快照 */
		getProcessMetrics: () =>
			ipcRenderer.invoke(ipcChannels.processMetrics) as Promise<ProcessMetricsSnapshot>,
		/** 停止指定 pi agent（按 agentId），成功后刷新进程快照即可看到消失 */
		stopAgent: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.stopAgent, agentId) as Promise<void>,
	},
	logs: {
		list: (query?: AppLogQuery) =>
			ipcRenderer.invoke(ipcChannels.logsList, query ?? {}) as Promise<AppLogEntry[]>,
		listPage: (query?: AppLogQuery) =>
			ipcRenderer.invoke(ipcChannels.logsListPage, query ?? {}) as Promise<AppLogPage>,
		clear: () => ipcRenderer.invoke(ipcChannels.logsClear) as Promise<void>,
		openFolder: () => ipcRenderer.invoke(ipcChannels.logsOpenFolder) as Promise<void>,
		getSize: () =>
			ipcRenderer.invoke(ipcChannels.logsSize) as Promise<number>,
	},
	rpcLogs: {
		getSize: (target?: SessionRuntimeTarget) =>
			ipcRenderer.invoke(ipcChannels.rpcLogsGetSize, target) as Promise<number>,
		get: (options?: { target?: SessionRuntimeTarget; days?: number; limit?: number }) =>
			ipcRenderer.invoke(ipcChannels.rpcLogsGet, options) as Promise<RpcLogEntry[]>,
		/** 实时查看弹窗初始历史：主进程环形缓冲（按 agentId 过滤） */
		getLive: (agentId?: string) =>
			ipcRenderer.invoke(ipcChannels.rpcLogsGetLive, agentId) as Promise<RpcLogEntry[]>,
		/** 把弹窗中的日志条目合并写入该 agent 的自动日志文件（按 id 去重），返回写入的文件路径列表 */
		save: (options: { entries: RpcLogEntry[] }) =>
			ipcRenderer.invoke(ipcChannels.rpcLogsSave, options) as Promise<string[]>,
		/** 订阅主进程批量推送的实时日志（按 agent 聚合，~80ms 一次），返回退订函数 */
		onLog: (callback: (batch: RpcLogBatch) => void) =>
			subscribe<{ agentId: string; entries: RpcLogEntry[] }>(ipcChannels.agentsRpcLog, callback),
		clear: (target?: SessionRuntimeTarget) =>
			ipcRenderer.invoke(ipcChannels.rpcLogsClear, target) as Promise<void>,
		setLogging: (target: SessionRuntimeTarget, enabled: boolean) =>
			ipcRenderer.invoke(ipcChannels.rpcLoggingSet, target, enabled) as Promise<boolean>,
		getLogging: (target: SessionRuntimeTarget) =>
			ipcRenderer.invoke(ipcChannels.rpcLoggingGet, target) as Promise<boolean>,
	},
	app: {
		info: () => ipcRenderer.invoke(ipcChannels.appInfo) as Promise<AppInfo>,
		networkAddresses: () =>
			ipcRenderer.invoke(ipcChannels.appNetworkAddresses) as Promise<WebNetworkAddress[]>,
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
		openExternal: (url: string, forceSystem?: boolean) =>
			ipcRenderer.invoke(ipcChannels.appOpenExternal, url, forceSystem) as Promise<void>,
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
			ipcRenderer.invoke(ipcChannels.appWindowToggleMaximize) as Promise<boolean>,
		isWindowMaximized: () =>
			ipcRenderer.invoke(ipcChannels.appWindowIsMaximized) as Promise<boolean>,
		onWindowMaximizedChange: (callback: (maximized: boolean) => void) =>
			subscribe(ipcChannels.appWindowMaximizedChanged, callback),
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
		search: (query: string, page?: number, pageSize?: number, sortBy?: string, order?: string) =>
			ipcRenderer.invoke(ipcChannels.skillHubSearch, { query, page, pageSize, sortBy, order }) as Promise<import("../shared/types").SkillHubSearchResult>,
		detail: (slug: string) =>
			ipcRenderer.invoke(ipcChannels.skillHubDetail, slug) as Promise<import("../shared/types").SkillHubDetail | null>,
		install: (slug: string, installDir: string) =>
			ipcRenderer.invoke(ipcChannels.skillHubInstall, slug, installDir) as Promise<import("../shared/types").SkillHubInstallResult>,
	},
	yaoPrompts: {
		list: (opts?: { category?: string; search?: string; page?: number; pageSize?: number }) =>
			ipcRenderer.invoke(ipcChannels.yaoPromptsList, opts) as Promise<YaoPromptListResult>,
		detail: (slug: string, category: string) =>
			ipcRenderer.invoke(ipcChannels.yaoPromptsDetail, slug, category) as Promise<YaoPromptDetailResult>,
		import: (slug: string, category: string) =>
			ipcRenderer.invoke(ipcChannels.yaoPromptsImport, slug, category) as Promise<PiPromptTemplateSummary>,
	},
	extensions: {
		list: (forceRefresh?: boolean) =>
			ipcRenderer.invoke(ipcChannels.extensionsList, forceRefresh) as Promise<PiExtensionListResult>,
		uninstall: (source: string, scope?: "user" | "project" | "unknown") =>
			ipcRenderer.invoke(ipcChannels.extensionsUninstall, source, scope) as Promise<void>,
		install: (source: string) =>
			ipcRenderer.invoke(ipcChannels.extensionsInstall, source) as Promise<string>,
		toggle: (source: string, enabled: boolean) =>
			ipcRenderer.invoke(ipcChannels.extensionsToggle, source, enabled) as Promise<void>,
		removeBuiltIn: (source: string) =>
			ipcRenderer.invoke(ipcChannels.extensionsRemoveBuiltIn, source) as Promise<void>,
		restoreBuiltIn: (source: string) =>
			ipcRenderer.invoke(ipcChannels.extensionsRestoreBuiltIn, source) as Promise<void>,
		update: () =>
			ipcRenderer.invoke(ipcChannels.extensionsUpdate) as Promise<PiCliUpdateResult>,
		updateOne: (source: string) =>
			ipcRenderer.invoke(ipcChannels.extensionsUpdateOne, source) as Promise<PiCliUpdateResult>,
	},
	settings: {
		get: () =>
			ipcRenderer.invoke(ipcChannels.settingsGet) as Promise<AppSettings>,
		update: (patch: Partial<AppSettings>) =>
			ipcRenderer.invoke(
				ipcChannels.settingsUpdate,
				patch,
			) as Promise<AppSettings>,
		restartWebService: () =>
			ipcRenderer.invoke(ipcChannels.settingsRestartWebService) as Promise<void>,
		testPiProxy: () =>
			ipcRenderer.invoke(
				ipcChannels.settingsTestPiProxy,
			) as Promise<PiProxyTestResult>,
		onApplyWindow: (callback: (settings: AppSettings) => void) =>
			subscribe(ipcChannels.settingsApplyWindow, callback),
	},
	security: {
		getConfig: () =>
			ipcRenderer.invoke(ipcChannels.securityGetConfig) as Promise<SecurityConfig>,
		updateConfig: (patch: Partial<SecurityConfig>) =>
			ipcRenderer.invoke(
				ipcChannels.securityUpdateConfig,
				patch,
			) as Promise<{ ok: true; config: SecurityConfig } | { ok: false; error: string }>,
		setSessionLevel: (sessionId: string, levelId: string | null) =>
			ipcRenderer.invoke(
				ipcChannels.securitySetSessionLevel,
				sessionId,
				levelId,
			) as Promise<{ ok: true; config: SecurityConfig } | { ok: false; error: string }>,
	},
	config: {
		previewProviderMigration: (direction: import("../shared/types/providerMigration").ProviderMigrationDirection) =>
			ipcRenderer.invoke(ipcChannels.configPreviewProviderMigration, direction) as Promise<
				import("../shared/types/providerMigration").ProviderMigrationPreview
			>,
		applyProviderMigration: (
			direction: import("../shared/types/providerMigration").ProviderMigrationDirection,
			provider: string,
		) =>
			ipcRenderer.invoke(ipcChannels.configApplyProviderMigration, direction, provider) as Promise<
				import("../shared/types/providerMigration").ProviderMigrationResult
			>,
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
				suggestedBaseUrl?: string;
			}>,
		/** 视觉桥：读取当前配置（模型列表由渲染层经 listModels 拉全量） */
		visionGetConfig: () =>
			ipcRenderer.invoke(ipcChannels.visionGetConfig) as Promise<{
				config: VisionBridgeConfig | null;
				configDir: string;
			}>,
		/** 视觉桥：保存配置（主进程白名单校验后写 ~/.pi/agent/pi-deck-vision.json） */
		visionSaveConfig: (config: VisionBridgeConfig) =>
			ipcRenderer.invoke(ipcChannels.visionSaveConfig, config) as Promise<{
				ok: boolean;
				error?: string;
			}>,
		/** 视觉桥：读取运行日志（诊断“走没走”，不含敏感字段） */
		visionGetLog: () =>
			ipcRenderer.invoke(ipcChannels.visionGetLog) as Promise<{
				exists: boolean;
				size: number;
				content: string;
				truncated: boolean;
			}>,
		/** 视觉桥：清空运行日志 */
		visionClearLog: () =>
			ipcRenderer.invoke(ipcChannels.visionClearLog) as Promise<{ ok: boolean }>,
		/** 视觉桥：读取结构化转换事件（会话渲染层展示「请求详情」，不含敏感字段） */
		visionGetEvents: () =>
			ipcRenderer.invoke(ipcChannels.visionGetEvents) as Promise<{
				exists: boolean;
				size: number;
				events: Array<{
					ts: number;
					kind: "input" | "tool_result" | "request";
					model: string;
					prompt: string;
					totalDurationMs: number;
					items: Array<{
						index: number;
						imageHash?: string;
						mimeType: string;
						ok: boolean;
						error?: string;
						durationMs: number;
						cached: boolean;
						description?: string;
						outputTokens?: number;
					}>;
				}>;
				truncated: boolean;
			}>,
		/** 视觉桥：清空事件文件 */
		visionClearEvents: () =>
			ipcRenderer.invoke(ipcChannels.visionClearEvents) as Promise<{ ok: boolean }>,
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
				suggestedBaseUrl?: string;
			}>,
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
		onFocusTarget: (callback: (target: { sessionId: string }) => void) =>
			subscribe(ipcChannels.petFocusAgentTarget, callback),
		/** 冷启动/页面加载期间点击通知的跳转目标：挂载后主动拉取（一次性） */
		getPendingFocusTarget: () =>
			ipcRenderer.invoke(ipcChannels.petGetFocusTargetPending) as Promise<{ sessionId: string } | null>,
		/** 主进程推送当前选中宠物的 manifest，据此加载 spritesheet */
		onSprite: (callback: (manifest: PetManifest) => void) =>
			subscribe(ipcChannels.petCurrentSprite, callback),
		/** 挂载时主动拉取当前选中宠物 manifest（避免推送竞态） */
		getCurrent: () =>
			ipcRenderer.invoke(ipcChannels.petGetCurrent) as Promise<PetManifest | null>,
		/** 主进程推送通知气泡（出错/完成/等待操作；null 表示清空当前提醒） */
		onNotify: (callback: (n: PetNotification | null) => void) =>
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
		list: (target: TerminalTarget) =>
			ipcRenderer.invoke(ipcChannels.terminalList, target) as Promise<
				TerminalTab[]
			>,
		ensure: (target: TerminalTarget) =>
			ipcRenderer.invoke(ipcChannels.terminalEnsure, target) as Promise<
				TerminalTab[]
			>,
		create: (target: TerminalTarget, shell?: TerminalShell) =>
			ipcRenderer.invoke(ipcChannels.terminalCreate, target, shell) as Promise<
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
		shells: () =>
			ipcRenderer.invoke(ipcChannels.terminalShells) as Promise<
				{ shell: string; label: string; available: boolean }[]
			>,
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
				detail?: string;
			}>,
		connectTemp: (input: FeishuConnectInput) =>
			ipcRenderer.invoke(ipcChannels.feishuConnectTemp, input) as Promise<{
				success: boolean;
				message: string;
				detail?: string;
				botInfo?: { id: string; name: string };
			}>,
		disconnect: () =>
			ipcRenderer.invoke(ipcChannels.feishuDisconnect) as Promise<{ success: boolean }>,
		connectByBot: (botId: string) =>
			ipcRenderer.invoke(ipcChannels.feishuConnectByBot, botId) as Promise<{
				success: boolean;
				message: string;
				detail?: string;
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
		sessionBotGet: (sessionId: string) =>
			ipcRenderer.invoke(ipcChannels.feishuSessionBotGet, sessionId) as Promise<string | null>,
		sessionBotSet: (sessionId: string, botId: string | null) =>
			ipcRenderer.invoke(ipcChannels.feishuSessionBotSet, sessionId, botId) as Promise<FeishuSessionBotResult>,
	},

	// ===== 内置浏览器 =====
	browser: {
		/** 在系统默认浏览器中打开外部链接。
		 *  用于 webview 不支持或需要另开浏览器查看的场景。 */
		openExternal: (url: string, forceSystem?: boolean) =>
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

	// ── 生图：OpenAI 兼容 /images/generations，返回 base64 图片（复用模型页已配的供应商）──
	imagegen: {
		generate: (request: ImageGenRequest) =>
			ipcRenderer.invoke(ipcChannels.imagegenGenerate, request) as Promise<ImageGenResult>,
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
