import type { createStore } from "jotai";
import { acpToolsAtom } from "../../atoms";
import { t } from "../../i18n";
import { isLocalProject } from "../../../../shared/projectLocation";
import type { AppSettings, Project, SessionRecord } from "../../../../shared/types";
import type { PiDesktopApi } from "../../../../preload";
import type { SidebarActions } from "../../components/sidebar/SidebarContent";
import type { useWorkspacePanels } from "../useWorkspacePanels";
import type { useSessionWorkspaceChrome } from "../useSessionWorkspaceChrome";
import type { useImportFlow } from "../useImportFlow";
import type { useRename } from "../useRename";
import type { useSideTasks } from "../useSideTasks";
import type { useSidebarArchiveActions } from "../sidebar/useSidebarArchiveActions";
import type { useSessionActions } from "../useSessionActions";
import type { useSessionRunControl } from "../session/useSessionRunControl";
import type { useWorktreeActions } from "../useWorktreeActions";
import type { useProjectSync } from "../useProjectSync";
import type { useAppProjectActions } from "./useAppProjectActions";

/** 会话导入向导的 11 个入口（每个来源一个向导），由 useImportFlow 一次性提供。 */
type SessionImportOpeners = Pick<ReturnType<typeof useImportFlow>, "openCodexImport" | "openClaudeImport" | "openQoderImport" | "openOpenCodeImport" | "openZCodeImport" | "openWorkBuddyImport" | "openCodeBuddyImport" | "openCursorImport" | "openKimiImport" | "openKimiWorkImport" | "openMinimaxImport">;

export interface AppSidebarActionsDeps {
	api: Pick<PiDesktopApi, "files" | "sessions" | "rpcLogs">;
	store: ReturnType<typeof createStore>;
	showToast: (message: string, duration?: number) => void;
	settings: Pick<AppSettings, "navigationMode" | "sessionTabOpenMode">;
	/** 项目清单（`select`/`refresh` 按 id 反查）与选中态。 */
	projects: Project[];
	selectProject: (projectId: string) => void;
	selectSession: (projectId: string, sessionId: string, scrollToEnd?: boolean) => void;
	/** 会话打开链路（选中 + Tab 登记）；侧栏 `open` 按导航模式决定 preview|permanent。 */
	openSessionInTab: (projectId: string, sessionId: string, tabMode?: "preview" | "permanent") => Promise<string | undefined>;
	refreshProjectSessions: (projectId: string, silent?: boolean) => Promise<unknown>;
	createSessionDraftWithTab: (projectId?: string) => Promise<unknown>;
	createAnonymousSessionWithTab: (projectId?: string) => Promise<unknown>;
	upsertSession: (session: SessionRecord) => void;
	setProxyDialogSessionId: (sessionId: string | null) => void;
	patchRpcLoggingAgentIds: (agentId: string, enabled: boolean) => void;
	openDirectoryImport: (project: Project) => void;
	openProjectResources: (project: Project) => void;
	openAutomations: (projectId: string) => void;
	projectActions: Pick<ReturnType<typeof useAppProjectActions>, "addProject" | "ensureProjectCatalogLoaded" | "reorderProjects" | "setProjectPinned" | "removeSidebarProject" | "removeSidebarProjects" | "deleteDraftSession" | "changeChatPath">;
	sync: Pick<ReturnType<typeof useProjectSync>, "refreshProjectTree" | "refreshAllProjects">;
	sessionActions: Pick<ReturnType<typeof useSessionActions>, "copySidebarSession" | "exportSidebarSession">;
	archiveActions: ReturnType<typeof useSidebarArchiveActions>;
	runControl: Pick<ReturnType<typeof useSessionRunControl>, "runSessionControl" | "getRuntimeTargetForAgent" | "exportAgentHtml" | "cloneAgentSession" | "requestCloseAgent">;
	worktreeActions: Pick<ReturnType<typeof useWorktreeActions>, "toggleProjectWorktree" | "createWorktree" | "requestRemoveWorktree">;
	workspace: Pick<ReturnType<typeof useWorkspacePanels>, "openExternalEditorChooser" | "openRpcLogPanel">;
	chrome: Pick<ReturnType<typeof useSessionWorkspaceChrome>, "beginDrag" | "endDrag" | "registerOpenSession">;
	importFlow: SessionImportOpeners;
	rename: ReturnType<typeof useRename>;
	sideTasks: Pick<ReturnType<typeof useSideTasks>, "create">;
}

/**
 * 侧栏动作装配（`SidebarActions` 五个分组：项目 / 会话 / Agent / worktree / RPC 日志）。
 *
 * App 只负责选会话、开 Tab、运行控制这些跨域组合的既有实现，把它们按侧栏契约接线；
 * 分组内的文案、门控与本机/远端判定同源写在这一处，避免侧栏入口各自漂移。
 */
export function useAppSidebarActions(deps: AppSidebarActionsDeps): SidebarActions {
	const {
		api,
		store,
		showToast,
		settings,
		projects,
		selectProject,
		selectSession,
		openSessionInTab,
		refreshProjectSessions,
		createSessionDraftWithTab,
		createAnonymousSessionWithTab,
		upsertSession,
		setProxyDialogSessionId,
		patchRpcLoggingAgentIds,
		openDirectoryImport,
		openProjectResources,
		openAutomations,
		projectActions,
		sync,
		sessionActions,
		archiveActions,
		runControl,
		worktreeActions,
		workspace,
		chrome,
		importFlow,
		rename,
		sideTasks,
	} = deps;
	const { addProject, ensureProjectCatalogLoaded, reorderProjects, setProjectPinned, removeSidebarProject, removeSidebarProjects, deleteDraftSession, changeChatPath } = projectActions;
	const { refreshProjectTree, refreshAllProjects } = sync;
	const { copySidebarSession, exportSidebarSession } = sessionActions;
	const { archiveSidebarSession, unarchiveSidebarSession, unarchiveDshSidebarSession, listArchivedSidebarSessions, deleteArchivedSidebarSession, listArchivedDshSidebarSessions, deleteArchivedDshSidebarSession, requestDeleteSidebarSession } = archiveActions;
	const { runSessionControl, getRuntimeTargetForAgent, exportAgentHtml, cloneAgentSession, requestCloseAgent } = runControl;
	const { toggleProjectWorktree, createWorktree, requestRemoveWorktree } = worktreeActions;

	return {
		projects: {
			add: addProject,
			select: (projectId) => {
				selectProject(projectId);
				// 点开目录只选中项目并显示引导页：不自动创建会话，避免每点一个目录都
				// 悄悄新建一个 agent 会话 tab。创建由用户手动点「启动 Agent / 临时对话」
				// 触发；启动时首项目自动选中除外（见 bootstrapProps.onProjectsChanged）。
				// 项目点击选中即按需加载 catalog（已加载/加载中的跳过）。
				ensureProjectCatalogLoaded(projectId);
			},
			refresh: async (projectId) => {
				const project = projects.find((candidate) => candidate.id === projectId);
				if (project) await refreshProjectTree(project);
			},
			refreshAll: refreshAllProjects,
			reorder: reorderProjects,
			setPinned: setProjectPinned,
			reveal: (project) => {
				// 本机文件处理器不接受远端路径：远端项目不提供「在文件夹中显示」。
				if (!isLocalProject(project)) return Promise.resolve();
				return api.files.showInFolder(project.path);
			},
			openWithEditor: (project) => {
				if (!isLocalProject(project)) return;
				workspace.openExternalEditorChooser(project.path, { x: 80, y: 80 });
			},
			importSessions: (project, source) => {
				if (source === "codex") return importFlow.openCodexImport(project);
				if (source === "claude") return importFlow.openClaudeImport(project);
				if (source === "qoder") return importFlow.openQoderImport(project);
				if (source === "zcode") return importFlow.openZCodeImport(project);
				if (source === "workbuddy") return importFlow.openWorkBuddyImport(project);
				if (source === "codebuddy") return importFlow.openCodeBuddyImport(project);
				if (source === "cursor") return importFlow.openCursorImport(project);
				if (source === "kimi") return importFlow.openKimiImport(project);
				if (source === "kimiwork") return importFlow.openKimiWorkImport(project);
				if (source === "minimax") return importFlow.openMinimaxImport(project);
				return importFlow.openOpenCodeImport(project);
			},
			importDirectorySessions: (project) => openDirectoryImport(project),
			manageResources: (project) => openProjectResources(project),
			manageAutomations: (projectId) => openAutomations(projectId),
			toggleWorktree: toggleProjectWorktree,
			copyPath: async (project) => {
				await navigator.clipboard.writeText(isLocalProject(project) ? project.path : project.locator.remotePath);
				showToast(t("common.copied"));
			},
			remove: removeSidebarProject,
			removeMany: removeSidebarProjects,
			rename: rename.openProjectRename,
			changeChatPath,
		},
		sessions: {
			// 简洁模式没有临时预览；标签模式保留原设置及双击晋升。
			simpleNavigation: settings.navigationMode === "simple",
			open: async (projectId, sessionId, tabMode) => {
				await openSessionInTab(projectId, sessionId, settings.navigationMode === "simple" ? "permanent" : (tabMode ?? settings.sessionTabOpenMode));
			},
			// 活动页「最近会话」跨项目展示：后台静默预热尚未扫描的项目 catalog。
			ensureCatalogsLoaded: (projectIds) => {
				for (const projectId of projectIds) ensureProjectCatalogLoaded(projectId, true);
			},
			// 远端会话登记（侧栏「远端会话」→ 导入）：register 已把记录写进主进程 catalog，
			// 这里只做「显式重拉本地会话清单 + 选中新会话」——不创建会话、也不开 Tab。
			importRemoteSession: async (projectId, sessionId) => {
				await refreshProjectSessions(projectId, true);
				selectSession(projectId, sessionId);
			},
			beginDrag: chrome.beginDrag,
			endDrag: chrome.endDrag,
			createDraft: async (projectId) => {
				await createSessionDraftWithTab(projectId);
			},
			// 侧边任务：建带标记的会话 + 打开抽屉面板。刻意不选会话、不登记主区 Tab——
			// 侧边任务与主工作区互不打扰是这条链路的底线（面板自己按 sessionId 寻址）。
			createSideTask: async (projectId, backend) => {
				await sideTasks.create({ projectId, backend });
			},
			createAnonymous: async (projectId) => {
				await createAnonymousSessionWithTab(projectId);
			},
			// ACP 工具会话：backend 固定 acp、acpToolId 指向 settings.acpTools 条目。
			// 工具表已加载进 acpToolsAtom，此处只按 id 取名称作草稿标题；找不到（刚被删）
			// 提示引导而不是静默失败。创建后与 createDraft 同一条选中/登记链。
			createAcp: async (projectId, toolId) => {
				const tool = store.get(acpToolsAtom).find((candidate) => candidate.id === toolId);
				if (!tool) {
					showToast(t("app.acpNoTools"), 3000);
					return;
				}
				const session = await api.sessions.createDraft({ projectId, title: tool.name, backend: "acp", acpToolId: tool.id });
				upsertSession(session);
				selectSession(projectId, session.id, false);
				chrome.registerOpenSession(session.id, "permanent");
			},
			deleteDraft: deleteDraftSession,
			rename: rename.openSessionRename,
			export: exportSidebarSession,
			copy: copySidebarSession,
			copyPath: async (session) => {
				// DSH 会话没有 pi 会话文件：走主进程按 dshSessionId + cwd 推导 host 持久化路径（F5）。
				// 失败/不可推导时提示而不是把空值写进剪贴板（原实现会把 undefined 写成 "undefined" 字符串）。
				const path = session.backend === "dsh" ? await api.sessions.getDshSessionPath(session.id) : session.filePath;
				if (!path) {
					showToast(t("menu.copySessionFilePathUnavailable"), 3000);
					return;
				}
				await navigator.clipboard.writeText(path);
				showToast(t("common.copied"));
			},
			openFile: (session) =>
				api.files.open(session.filePath).catch((error) => {
					showToast(t("app.openFileFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
				}),
			delete: async (projectId, session) => {
				requestDeleteSidebarSession(projectId, session);
			},
			// 运行控制（全状态统一入口）：启动/停止/重启/重载都走 runSessionControl 分派
			runControl: async (sessionId, action) => {
				await runSessionControl(sessionId, action);
			},
			// 会话代理设置：宿主弹窗在 App 层统一挂载，这里只登记目标会话
			openProxySetting: (sessionId) => setProxyDialogSessionId(sessionId),
			archive: async (projectId, session) => {
				await archiveSidebarSession(projectId, session);
			},
			unarchive: async (archived, projectId) => {
				// 远端归档记录只能按 catalog id 恢复，本机归档走归档路径；派发收在 hook 内，身份不互相回退。
				await unarchiveSidebarSession(archived, projectId);
			},
			listArchived: () => listArchivedSidebarSessions(),
			deleteArchived: async (archivedPath) => {
				await deleteArchivedSidebarSession(archivedPath);
			},
			unarchiveDsh: async (dshSessionId, projectId) => {
				await unarchiveDshSidebarSession(dshSessionId, projectId);
			},
			listArchivedDsh: () => listArchivedDshSidebarSessions(),
			deleteArchivedDsh: async (dshSessionId) => {
				await deleteArchivedDshSidebarSession(dshSessionId);
			},
			// 远端归档行的永久删除：两步 IPC（main 一次性确认），只传本机 catalog 会话 id。
			requestDeleteArchivedRemote: (sessionId) => api.sessions.deleteArchivedRemoteRecord(sessionId),
			answerDeleteArchivedRemote: (requestId, choice) => api.sessions.answerDeleteArchivedRemoteRecord(requestId, choice),
		},
		agents: {
			rename: rename.openAgentRename,
			export: (agent) => exportAgentHtml(agent.id),
			copySession: (agent) => cloneAgentSession(agent.id),
			copyPath: async (agent) => {
				if (!agent.sessionPath) return;
				await navigator.clipboard.writeText(agent.sessionPath);
				showToast(t("common.copied"));
			},
			openSessionFile: (agent) =>
				agent.sessionPath
					? api.files.open(agent.sessionPath).catch((error) => {
							showToast(t("app.openFileFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
						})
					: Promise.resolve(),
			close: requestCloseAgent,
			// 运行控制（全状态统一入口）：agent 菜单同样收敛到 runSessionControl
			runControl: async (sessionId, action) => {
				await runSessionControl(sessionId, action);
			},
		},
		worktrees: {
			create: async (projectId, branchName) => {
				await createWorktree(projectId, branchName);
			},
			remove: (parentProjectId, entry, childProject) => {
				requestRemoveWorktree(parentProjectId, entry.target, childProject);
				return Promise.resolve();
			},
		},
		rpc: {
			getLogging: (agentId) => {
				const target = getRuntimeTargetForAgent(agentId);
				return target ? api.rpcLogs.getLogging(target) : Promise.resolve(false);
			},
			setLogging: (agentId, enabled) => {
				const target = getRuntimeTargetForAgent(agentId);
				if (!target) return Promise.resolve(false);
				// 回执落地后才写渲染层镜像：侧栏菜单文案与抽屉 rpcLog Tab 门控都读它，
				// 写早了会把开关失败误显示为已开启（回执 false 表示主进程未允许）。
				return api.rpcLogs.setLogging(target, enabled).then((receipt) => {
					patchRpcLoggingAgentIds(agentId, receipt);
					return receipt;
				});
			},
			listLogs: (agentId) => {
				const target = getRuntimeTargetForAgent(agentId);
				return target ? api.rpcLogs.get({ target }) : Promise.resolve([]);
			},
			// 日志面板 = 右侧抽屉的临时面板：非模态，可与消息区同时使用（旧弹窗打开时发不了消息）
			openViewer: (agentId) => workspace.openRpcLogPanel(agentId),
		},
	};
}
