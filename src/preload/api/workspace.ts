/**
 * preload workspace 域：工作区：项目、资源目录、文件树与搜索、粘贴落盘、通知历史、系统对话框、主题。
 *
 * 组装口 `src/preload/index.ts` 只做 spread；方法体 / 参数名 / 通道引用与拆分前逐字一致。
 */
import { ipcRenderer, webUtils } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { subscribe, clipboardSync } from "./ipcHelpers";
import type { CustomThemeListItem } from "../../shared/customThemes";
import type { AvailableModel, CreateProjectSkillInput, FileContentSearchResult, FileManagerInfo, FileTreeNode, ModelListReport, ModelSpec, PasteFileWriteInput, PasteFileWriteResult, PiSkillSummary, Project, ProjectFileAccessScope, ProjectFileTarget, ProjectInheritedResourceToggleInput, ProjectResourceDirectoryKind, ProjectResourceDiscoveryResult, ProjectResourceListResult, ProjectResourceOverrides } from "../../shared/types";
import type { NoticeHistoryFileEntry, NoticeHistoryRecordInput } from "../../shared/types/noticeHistory";
import type { UserDataNameMigrationNotice } from "../../shared/types/userDataMigration";
import type { WallpaperEngineItem, WallpaperEngineListResult } from "../../shared/wallpaperEngine";

export const workspaceApi = {
	projects: {
		list: () => ipcRenderer.invoke(ipcChannels.projectsList) as Promise<Project[]>,
		add: () => ipcRenderer.invoke(ipcChannels.projectsAdd) as Promise<Project | null>,
		/** 文件夹右键菜单直达：给定路径必须是已存在的目录，主进程校验后入库 */
		addByPath: (path: string) => ipcRenderer.invoke(ipcChannels.projectsAddByPath, path) as Promise<Project>,
		/** WSL 目录浏览：以档案（hostId 缺省则全局 WSL 模式）的 distro+user 在发行版内列一层子目录。 */
		listWslDirectory: (path: string, hostId?: string) => ipcRenderer.invoke(ipcChannels.projectsListWslDirectory, path, hostId) as Promise<import("../../shared/types/wslDirectory").WslDirectoryPageResult>,
		/** 选定发行版内目录后添加项目：主进程在发行版内校验目录，再转规范 UNC 入库。 */
		addWslPath: (path: string, hostId?: string) => ipcRenderer.invoke(ipcChannels.projectsAddWslPath, path, hostId) as Promise<Project>,
		remove: (id: string) => ipcRenderer.invoke(ipcChannels.projectsRemove, id) as Promise<Project[]>,
		reorder: (projectIds: string[]) => ipcRenderer.invoke(ipcChannels.projectsReorder, projectIds) as Promise<Project[]>,
		// 置顶/取消置顶普通项目；返回更新后的项目列表
		setPinned: (projectId: string, pinned: boolean) => ipcRenderer.invoke(ipcChannels.projectsSetPinned, projectId, pinned) as Promise<Project[]>,
		// 重命名项目显示名（仅改 label，不动磁盘目录）；返回更新后的项目列表
		rename: (id: string, name: string) => ipcRenderer.invoke(ipcChannels.projectsRename, id, name) as Promise<Project[]>,
		onChanged: (callback: (projects: Project[]) => void) => subscribe(ipcChannels.projectsChanged, callback),
		// 仅返回顶级项目（不含 worktree 子项目）
		listRoot: () => ipcRenderer.invoke(ipcChannels.projectsListRoot) as Promise<Project[]>,
		// 获取指定父项目的所有 worktree 子项目
		listWorktreeChildren: (parentId: string) => ipcRenderer.invoke(ipcChannels.projectsListWorktreeChildren, parentId) as Promise<Project[]>,
		// 切换 worktree 模式开关
		toggleWorktreeEnabled: (projectId: string) => ipcRenderer.invoke(ipcChannels.projectsToggleWorktreeEnabled, projectId) as Promise<Project | null>,
		// 选择聊天记录目录（系统文件选择器，默认当前目录）
		chooseChatPath: () => ipcRenderer.invoke(ipcChannels.projectsChooseChatPath) as Promise<string | null>,
		// 设置聊天记录目录
		setChatPath: (path: string) => ipcRenderer.invoke(ipcChannels.projectsSetChatPath, path) as Promise<Project | null>,
		// 领取 userData 更名（pi-desktop → PiDeck）的一次性迁移提示（消费式，只返回一次）
		consumeMigrationNotice: () => ipcRenderer.invoke(ipcChannels.userDataMigrationConsumeNotice) as Promise<UserDataNameMigrationNotice | null>,
		// 通过 pi --list-models 获取可用模型列表（无需启动 agent）
		listModels: (projectId?: string) => ipcRenderer.invoke(ipcChannels.projectsListModels, projectId) as Promise<AvailableModel[]>,
		// 模型列表诊断报告：模型 + 失败原因分类（版本过低/配置损坏/pi 未安装），
		// 供选择器在空列表时给出引导；force=true 绕过缓存重新 fork（手动刷新）。
		listModelsReport: (projectId?: string, force?: boolean) => ipcRenderer.invoke(ipcChannels.projectsListModelsReport, projectId, force) as Promise<ModelListReport>,
		// 查询模型规格：优先匹配当前 Pi 目录，第三方中转按 model id/显示名识别模型本体。
		getModelSpec: (providerName: string, modelId: string, modelName?: string) => ipcRenderer.invoke(ipcChannels.projectsGetModelSpec, providerName, modelId, modelName) as Promise<ModelSpec | null>,
		onTrustRequest: (callback: (request: { requestId: string; cwd: string; projectName: string }) => void) => subscribe(ipcChannels.projectsTrustRequest, callback),
		respondTrustRequest: (requestId: string, choice: "trust-remember" | "trust-session" | "deny") => ipcRenderer.invoke(ipcChannels.projectsTrustResponse, requestId, choice) as Promise<void>,
	},
	projectResources: {
		list: (projectId: string) => ipcRenderer.invoke(ipcChannels.projectResourcesList, projectId) as Promise<ProjectResourceListResult>,
		openDirectory: (projectId: string, kind: ProjectResourceDirectoryKind) => ipcRenderer.invoke(ipcChannels.projectResourcesOpenDirectory, projectId, kind) as Promise<void>,
		createSkill: (input: CreateProjectSkillInput) => ipcRenderer.invoke(ipcChannels.projectResourcesCreateSkill, input) as Promise<PiSkillSummary>,
		deleteSkill: (projectId: string, skillPath: string) => ipcRenderer.invoke(ipcChannels.projectResourcesDeleteSkill, projectId, skillPath) as Promise<void>,
		deleteExtension: (projectId: string, extensionPath: string) => ipcRenderer.invoke(ipcChannels.projectResourcesDeleteExtension, projectId, extensionPath) as Promise<void>,
		toggleExtension: (projectId: string, extensionPath: string, enabled: boolean) => ipcRenderer.invoke(ipcChannels.projectResourcesToggleExtension, projectId, extensionPath, enabled) as Promise<void>,
		toggleInherited: (input: ProjectInheritedResourceToggleInput) => ipcRenderer.invoke(ipcChannels.projectResourcesToggleInherited, input) as Promise<ProjectResourceOverrides>,
		toggleSkill: (projectId: string, skillPath: string, enabled: boolean) => ipcRenderer.invoke(ipcChannels.projectResourcesToggleSkill, projectId, skillPath, enabled) as Promise<PiSkillSummary>,
		renameSkill: (projectId: string, skillPath: string, newName: string) => ipcRenderer.invoke(ipcChannels.projectResourcesRenameSkill, projectId, skillPath, newName) as Promise<PiSkillSummary>,
		discovery: (projectId?: string) => ipcRenderer.invoke(ipcChannels.projectResourcesDiscovery, projectId) as Promise<ProjectResourceDiscoveryResult>,
	},
	files: {
		list: (project: string | ProjectFileTarget, options?: { maxDepth?: number; directory?: string; skipGeneratedDirs?: boolean }) => ipcRenderer.invoke(ipcChannels.filesList, project, options) as Promise<FileTreeNode[]>,
		/**
		 * 公共目录页（T6）：位置无关，带 `truncated` 与事实版本。
		 * 本地与远端返回同一形状；`hasChildren` 远端为 "unknown"（不假装空目录）。
		 */
		directoryPage: (target: ProjectFileTarget, options?: { force?: boolean }) => ipcRenderer.invoke(ipcChannels.filesDirectoryPage, target, options) as Promise<import("../../shared/types/projectFiles").ProjectDirectoryPageResult>,
		/** 工作区文件名搜索（issue #215）：主进程全盘扫描，忽略规则与文件抽屉的文件树同档（只跳 .git/node_modules） */
		/** 公共文件名搜索页（位置分派收口）：本机与远端同一形状，带 truncated/scanned 与远端原始 entries。 */
		searchPage: (projectId: string, query: string) => ipcRenderer.invoke(ipcChannels.filesSearchPage, projectId, query) as Promise<import("../../shared/types/projectFiles").ProjectFileSearchPageResult>,
		/** 工作区文件内容检索（Go file-index sidecar）：未就绪/不可用时回 null，渲染层不展示内容分区 */
		searchContent: (projectId: string, query: string) => ipcRenderer.invoke(ipcChannels.filesSearchContent, projectId, query) as Promise<FileContentSearchResult | null>,
		open: (path: string | ProjectFileTarget, scope?: ProjectFileAccessScope) => ipcRenderer.invoke(ipcChannels.filesOpen, path, scope) as Promise<void>,
		showInFolder: (path: string | ProjectFileTarget, scope?: ProjectFileAccessScope) => ipcRenderer.invoke(ipcChannels.filesShowInFolder, path, scope) as Promise<void>,
		/** 检测系统可用的文件管理器（打开方式下拉补充入口） */
		detectFileManager: () => ipcRenderer.invoke(ipcChannels.filesDetectFileManager) as Promise<FileManagerInfo | null>,
		/** 在系统文件管理器中打开目录 */
		openFileManager: (path: string) => ipcRenderer.invoke(ipcChannels.filesOpenFileManager, path) as Promise<void>,
		readContent: (path: string | ProjectFileTarget, maxBytes?: number, scope?: ProjectFileAccessScope) => ipcRenderer.invoke(ipcChannels.filesReadContent, path, maxBytes, scope) as Promise<string>,
		/** 批量校验路径是否存在（返回与入参等长的 boolean[]；单路径失败按 false 计） */
		pathsExist: (paths: Array<string | ProjectFileTarget>, scope?: ProjectFileAccessScope) => ipcRenderer.invoke(ipcChannels.filesPathsExist, paths, scope) as Promise<boolean[]>,
		/** 单路径 stat（存在性 + 是否目录）：会话内文件链接点击路由用（目录 → 资源管理器打开） */
		stat: (path: string | ProjectFileTarget, scope?: ProjectFileAccessScope) => ipcRenderer.invoke(ipcChannels.filesStat, path, scope) as Promise<import("../../shared/types/projectFiles").ProjectFileStatResult>,
		/** 读取二进制文件为 base64；scope 存在时主进程限制到对应 ProjectStore 根目录。 */
		readBase64: (path: string | ProjectFileTarget, maxBytes?: number, scope?: ProjectFileAccessScope) => ipcRenderer.invoke(ipcChannels.filesReadBase64, path, maxBytes, scope) as Promise<string>,
		/** 保存项目来源文件时复用读取 scope，主进程据此校验真实写入路径。 */
		writeContent: (path: string | ProjectFileTarget, content: string, scope?: ProjectFileAccessScope, expectedRevision?: string) => ipcRenderer.invoke(ipcChannels.filesWriteContent, path, content, scope, expectedRevision) as Promise<void>,
		/** 远端目标的删除进回收站，返回 trashId 收据；本机删除没有收据（undefined）。 */
		delete: (path: string | ProjectFileTarget, recursive?: boolean) => ipcRenderer.invoke(ipcChannels.filesDelete, path, recursive) as Promise<import("../../shared/op").Op<void | { trashId: string }>>,
		/** 复制来源路径到目标目录（支持文件和目录递归），返回目标路径列表 */
		copy: (sourcePaths: Array<string | ProjectFileTarget>, targetDir: string | ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.filesCopy, sourcePaths, targetDir) as Promise<Array<string | ProjectFileTarget>>,
		/** 移动来源路径到目标目录（同设备 rename，跨设备 cp+rm） */
		move: (sourcePaths: Array<string | ProjectFileTarget>, targetDir: string | ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.filesMove, sourcePaths, targetDir) as Promise<import("../../shared/op").Op<Array<string | ProjectFileTarget>>>,
		/** 单源移动到目标全路径（一次写）：跨目录改名不再由渲染层拆成 move + rename。 */
		moveTo: (source: ProjectFileTarget, target: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.filesMoveTo, source, target) as Promise<import("../../shared/op").Op<ProjectFileTarget>>,
		create: (parentDir: string | ProjectFileTarget, name: string, type: "file" | "directory") => ipcRenderer.invoke(ipcChannels.filesCreate, parentDir, name, type) as Promise<import("../../shared/op").Op<string | ProjectFileTarget>>,
		rename: (path: string | ProjectFileTarget, newName: string) => ipcRenderer.invoke(ipcChannels.filesRename, path, newName) as Promise<import("../../shared/op").Op<string | ProjectFileTarget>>,
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
		getClipboardPaths: () => clipboardSync<string[]>(ipcChannels.clipboardReadFilePaths, []),
	},
	pasteFiles: {
		/** 粘贴大文本 → 落盘 userData/paste-files，返回路径元数据供 chip 展示与发送内联。 */
		write: (input: PasteFileWriteInput) => ipcRenderer.invoke(ipcChannels.pasteFilesWrite, input) as Promise<PasteFileWriteResult>,
		/** 移除 chip 时同步删除落盘文件（仅限受管目录内路径）。 */
		delete: (path: string) => ipcRenderer.invoke(ipcChannels.pasteFilesDelete, path) as Promise<void>,
		/** 启动清理过期粘贴文件（渲染层一般不调用）。 */
		cleanup: () => ipcRenderer.invoke(ipcChannels.pasteFilesCleanup) as Promise<number>,
		/** 设置页占用统计：userData 新文件 + 各项目遗留 .pideck-paste。 */
		getSize: () => ipcRenderer.invoke(ipcChannels.pasteFilesGetSize) as Promise<number>,
		/** 设置页一键清空两个受管根下的 paste-* 文件。 */
		clearAll: () => ipcRenderer.invoke(ipcChannels.pasteFilesClearAll) as Promise<number>,
	},
	noticeHistory: {
		/** 读取落盘通知历史（启动回灌环形缓冲用）。 */
		get: () => ipcRenderer.invoke(ipcChannels.noticeHistoryGet) as Promise<NoticeHistoryFileEntry[]>,
		/** 追加一条记录（showNotice 单点记录后 fire-and-forget，失败静默——历史永不阻断 toast）。 */
		record: (input: NoticeHistoryRecordInput) => ipcRenderer.invoke(ipcChannels.noticeHistoryRecord, input) as Promise<void>,
		/** 清空并删除落盘文件（历史面板「清空记录」与设置页清理共用）。 */
		clear: () => ipcRenderer.invoke(ipcChannels.noticeHistoryClear) as Promise<void>,
		/** 文件占用统计（设置页「缓存与日志」）。 */
		getSize: () => ipcRenderer.invoke(ipcChannels.noticeHistoryGetSize) as Promise<number>,
	},
	dialog: {
		/**
		 * 打开系统原生文件选择器（默认仅文件；includeDirectories 时文件+目录），支持多选。
		 * 返回选中路径列表，取消时返回空数组。
		 */
		pickFiles: (options?: { title?: string; includeDirectories?: boolean }) => ipcRenderer.invoke(ipcChannels.dialogPickFiles, options) as Promise<string[]>,
		/** 换肤背景图：选图并复制到 userData/backgrounds/，返回文件名（空串=取消） */
		pickBackgroundImage: () => ipcRenderer.invoke(ipcChannels.pickBackgroundImage) as Promise<string>,
		/** 删除背景图文件（清空背景设置时调用） */
		removeBackgroundImage: (name: string) => ipcRenderer.invoke(ipcChannels.removeBackgroundImage, name) as Promise<void>,
		/** Wallpaper Engine 视频壁纸：选工坊目录 / 列出视频条目 / 校验选中条目（视频字节只走 pideck-we:// 协议） */
		pickWallpaperEngineDir: () => ipcRenderer.invoke(ipcChannels.wallpaperEnginePickDir) as Promise<string>,
		listWallpaperEngine: (dir?: string) => ipcRenderer.invoke(ipcChannels.wallpaperEngineList, dir) as Promise<WallpaperEngineListResult>,
		selectWallpaperEngine: (dir: string, id: string) => ipcRenderer.invoke(ipcChannels.wallpaperEngineSelect, dir, id) as Promise<WallpaperEngineItem | null>,
	},
	customThemes: {
		/** 列出自定义主题（内置示例 + 用户目录；dir 为存放目录，供指南/提示展示） */
		list: () => ipcRenderer.invoke(ipcChannels.listCustomThemes) as Promise<{ dir: string; themes: CustomThemeListItem[] }>,
		/** 读取主题原始 JSON 文本（编辑器用；不存在返回 null） */
		read: (id: string) => ipcRenderer.invoke(ipcChannels.readCustomTheme, id) as Promise<string | null>,
		/** 校验并保存主题包；失败返回面向用户的错误清单 */
		save: (raw: string) => ipcRenderer.invoke(ipcChannels.saveCustomTheme, raw) as Promise<{ ok: true; id: string } | { ok: false; errors: string[] }>,
		/** 删除用户主题文件（回收站） */
		remove: (id: string) => ipcRenderer.invoke(ipcChannels.deleteCustomTheme, id) as Promise<void>,
		/** 把 AI 主题开发指南写入主题目录并在资源管理器定位，返回文件路径 */
		writeGuide: (locale: "zh-CN" | "en-US") => ipcRenderer.invoke(ipcChannels.writeCustomThemeGuide, locale) as Promise<string>,
	},
};
