import { useCallback } from "react";
import type { createStore } from "jotai";
import { sessionCatalogLoadStateAtom } from "../../atoms";
import { removeProjectsSequentially, type BatchProjectRemovalOutcome } from "../../utils/batchProjectRemoval";
import { reorderProjectList } from "../../utils/projectOrder";
import { isChatProject } from "../../rendererUtils";
import type { PiDesktopApi } from "../../../../preload";
import { isRemoteProject } from "../../../../shared/projectLocation";
import type { AppSettings, Project, SessionRecord } from "../../../../shared/types";
import { t } from "../../i18n";
import type { WorkspaceDrawerPanel } from "../useWorkspacePanels";

/**
 * 项目记录域：项目入库/移除/排序/置顶、Chat 记录目录切换、草稿会话删除、会话 catalog 按需预热。
 * 全部动作都是「主进程落库 → 用返回清单覆盖本地」的同一形状，App 只负责把 IO 接口与选中态接进来。
 * 侧栏 actions 与引导页/资源弹窗共用这些入口，所以放在 App 级 hook 里保持唯一实现。
 */
export interface AppProjectActionsDeps {
	store: ReturnType<typeof createStore>;
	api: PiDesktopApi;
	showToast: (message: string, duration?: number) => void;
	showConfirm: (options: { title: string; message: string; confirmLabel: string; onConfirm: () => void }) => void;
	clearConfirm: () => void;
	projects: Project[];
	setProjects: (next: Project[]) => void;
	activeProjectId: string | undefined;
	setActiveProjectId: (projectId: string | undefined) => void;
	sessionsProjectId: string | undefined;
	setSessionsProjectId: (projectId: string | undefined) => void;
	drawer: WorkspaceDrawerPanel | null;
	closeSessionsDrawer: () => void;
	setVisibleProjectChildCountByProject: (updater: (current: Record<string, number>) => Record<string, number>) => void;
	revealProjectInSidebar: (projectId: string) => void;
	setWslProjectPicker: (value: { hostId?: string }) => void;
	settings: Pick<AppSettings, "wslEnabled">;
	syncDshForeignSessionsIfEnabled: () => Promise<void>;
	refreshProjects: () => Promise<unknown>;
	refreshProjectSessions: (projectId: string, silent?: boolean) => Promise<unknown>;
	removeSessionState: (sessionId: string) => void;
	removeSessionComposerState: (sessionId: string) => void;
}

export interface AppProjectActions {
	announceProjectAdded: (project: Project) => void;
	addProject: () => Promise<void>;
	updateAfterProjectRemoved: (removedProjectId: string, next: Project[]) => void;
	deleteDraftSession: (session: SessionRecord) => Promise<void>;
	reorderProjects: (sourceProjectId: string, targetProjectId: string, position?: "before" | "after") => Promise<void>;
	setProjectPinned: (project: Project, pinned: boolean) => Promise<void>;
	removeSidebarProject: (project: Project) => Promise<void>;
	removeSidebarProjects: (projectIds: readonly string[], onProgress?: (done: number, total: number) => void) => Promise<BatchProjectRemovalOutcome>;
	changeChatPath: (project: Project) => Promise<void>;
	ensureProjectCatalogLoaded: (projectId: string, silent?: boolean) => void;
}

export function useAppProjectActions(deps: AppProjectActionsDeps): AppProjectActions {
	const {
		store,
		api,
		showToast,
		showConfirm,
		clearConfirm,
		projects,
		setProjects,
		activeProjectId,
		setActiveProjectId,
		sessionsProjectId,
		setSessionsProjectId,
		drawer,
		closeSessionsDrawer,
		setVisibleProjectChildCountByProject,
		revealProjectInSidebar,
		setWslProjectPicker,
		settings,
		syncDshForeignSessionsIfEnabled,
		refreshProjects,
		refreshProjectSessions,
		removeSessionState,
		removeSessionComposerState,
	} = deps;
	/**
	 * clone / fork 会把同一个 Agent 换绑到新的 SessionRecord。
	 * 必须先刷新 catalog 再登记 Tab：否则 chrome 的 prune 看到 records 里还没有新 id，会立刻清掉刚打开的 Tab。
	 * 选中与登记都在这里组合——selectSession 本身不碰 Tab。
	 */
	async function deleteDraftSession(session: SessionRecord) {
		try {
			await api.sessions.deleteRecord(session.id);
			// A false result means another path already removed the catalog record;
			// clear the stale sidebar row the same way as a successful deletion.
			removeSessionState(session.id);
			removeSessionComposerState(session.id);
		} catch (error) {
			showToast(error instanceof Error ? error.message : String(error), 4000);
		}
	}

	async function reorderProjects(sourceProjectId: string, targetProjectId: string, position: "before" | "after" = "after") {
		if (sourceProjectId === targetProjectId) return;
		const sourceProject = projects.find((project) => project.id === sourceProjectId);
		const targetProject = projects.find((project) => project.id === targetProjectId);
		if (isChatProject(sourceProject) || isChatProject(targetProject)) return;
		// 插入点由拖放边缘显式决定（utils/projectOrder 纯函数，便于单测）。
		const previousProjects = projects;
		const nextProjects = reorderProjectList(projects, (project) => project.id, sourceProjectId, targetProjectId, position);
		if (nextProjects === previousProjects) return;
		setProjects([...nextProjects]);

		try {
			const savedProjects = await api.projects.reorder(nextProjects.map((project) => project.id));
			setProjects(savedProjects);
		} catch (error) {
			setProjects(previousProjects);
			showToast(
				t("app.projectSortFailed", {
					error: error instanceof Error ? error.message : String(error),
				}),
				4000,
			);
		}
	}

	/** 置顶/取消置顶普通项目：主进程落库后用返回列表刷新，聊天项目由 ProjectStore 拒绝。 */
	async function setProjectPinned(project: Project, pinned: boolean) {
		if (isChatProject(project)) return;
		try {
			const savedProjects = await api.projects.setPinned(project.id, pinned);
			setProjects(savedProjects);
		} catch (error) {
			showToast(
				t("app.projectSortFailed", {
					error: error instanceof Error ? error.message : String(error),
				}),
				4000,
			);
		}
	}

	/**
	 * 新项目入库后的统一收尾：提示「已添加」+ 请侧栏揭示新行（切到项目分段、展开、滚进可视区）。
	 * 少了揭示这一步，停在「聊天/活动」分段的用户看到的只是原列表不变——新行根本没挂载。
	 */
	function announceProjectAdded(project: Project) {
		showToast(t("app.openFolderAdded", { name: project.name }));
		revealProjectInSidebar(project.id);
	}

	async function addProject() {
		// WSL 模式：系统「打开文件夹」只按 Windows 身份访问 \\wsl.localhost，发行版内的目录（尤其 root
		// 档案的 /root）递进去就是「无法访问网络资源」；改由内置选择器在发行版内列目录。
		if (settings.wslEnabled === true) {
			setWslProjectPicker({});
			return;
		}
		const project = await api.projects.add();
		if (!project) return;
		// 先同步 DSH：新目录注册后，原先按 cwd 找不到项目的外部会话才能挂进来。
		await syncDshForeignSessionsIfEnabled();
		await refreshProjects();
		setActiveProjectId(project.id);
		announceProjectAdded(project);
		await refreshProjectSessions(project.id);
	}

	function updateAfterProjectRemoved(removedProjectId: string, next: Project[]) {
		setVisibleProjectChildCountByProject((current) => {
			const updated = { ...current };
			delete updated[removedProjectId];
			return updated;
		});
		if (activeProjectId === removedProjectId) {
			setActiveProjectId(next[0]?.id);
		}
		if (sessionsProjectId === removedProjectId) {
			setSessionsProjectId(undefined);
			if (drawer === "sessions") closeSessionsDrawer();
		}
	}

	async function removeSidebarProject(project: Project) {
		try {
			const next = await api.projects.remove(project.id);
			setProjects(next);
			updateAfterProjectRemoved(project.id, next);
		} catch (error) {
			if (String(error instanceof Error ? error.message : error).includes("PROJECT_HAS_RUNNING_AGENT")) {
				showConfirm({
					title: t("app.projectRemoveBlockedTitle"),
					message: t("app.projectRemoveBlockedByAgent"),
					confirmLabel: t("app.projectRemoveBlockedAck"),
					onConfirm: () => clearConfirm(),
				});
			} else {
				showToast(error instanceof Error ? error.message : String(error), 5000);
			}
		}
	}

	/**
	 * 批量移除项目记录：逐个调用既有 projects.remove IPC（主进程已按项目做 standby 释放、
	 * 运行中 Agent 拦截与会话索引清理）。失败容错、进度回调与计数在 removeProjectsSequentially，
	 * 这里只负责接线：每个成功项同步本地侧栏与选中态（见 updateAfterProjectRemoved），
	 * 全部结束后用最后一次清单刷新；只删记录、不动磁盘目录，已成功的项目不回滚。
	 */
	async function removeSidebarProjects(projectIds: readonly string[], onProgress?: (done: number, total: number) => void): Promise<BatchProjectRemovalOutcome> {
		// 逐项返回的清单按顺序收集：最后一次成功的结果就是当前完整清单（主进程每次重算可见项目）。
		const remainingLists: Project[][] = [];
		const outcome = await removeProjectsSequentially(
			projectIds,
			async (projectId) => {
				const next = await api.projects.remove(projectId);
				remainingLists.push(next);
				updateAfterProjectRemoved(projectId, next);
			},
			onProgress,
		);
		const latest = remainingLists[remainingLists.length - 1];
		if (latest) setProjects(latest);
		if (outcome.removed + outcome.failed > 0) {
			showToast(outcome.failed > 0 ? t("app.projectsRemovePartial", { removed: outcome.removed, failed: outcome.failed }) : t("app.projectsRemoved", { count: outcome.removed }), outcome.failed > 0 ? 6000 : 2200);
		}
		return outcome;
	}

	/**
	 * 修改内置对话区（Chat）的聊天记录保存目录：弹目录选择器 → 主进程写入
	 * chat-path.json 并广播 projects:changed → 重新扫描该项目会话列表 → toast 提示。
	 * 侧边栏菜单与聊天区头部按钮共用此实现，避免两处 IPC 调用逻辑漂移。
	 */
	async function changeChatPath(project: Project) {
		const picked = await api.projects.chooseChatPath();
		if (!picked || picked === project.path) return;
		try {
			await api.projects.setChatPath(picked);
			await refreshProjectSessions(project.id);
			showToast(t("app.chatProjectPathUpdated"), 1800);
		} catch (error) {
			// 主进程拒绝把聊天目录指向已注册的项目目录（CHAT_PATH_OVERLAPS_PROJECT，issue #149）：
			// 同路径会吞掉项目区的新项目，这里给出明确提示而不是静默失败。
			const message = String(error instanceof Error ? error.message : error);
			showToast(message.includes("CHAT_PATH_OVERLAPS_PROJECT") ? t("app.chatPathOverlapsProject") : message, 5000);
		}
	}

	/**
	 * 按需加载单个项目的会话 catalog：已 loading/ready 的项目直接跳过。
	 * 空项目也可能已经成功加载，所以用 catalog 状态区分「空结果」和「尚未扫描」。
	 *
	 * silent 区分两种触发意图：
	 * - false（默认，用户点选/展开项目）：走常规加载态，侧栏会显示该项在加载；
	 * - true（活动页「最近会话」跨项目预热）：后台静默拉取，不挂 loading 态、不装 catalog
	 *   看门狗——用户只是看了眼活动页，不该让侧栏一堆项目同时转圈。
	 * 两者共用同一处「什么时候该扫、什么时候该跳过」判断，避免规则漂移。
	 */
	const ensureProjectCatalogLoaded = useCallback(
		(projectId: string, silent = false) => {
			// 远端项目的会话扫描属于后续阶段：本地 scanner 不读远端路径，主进程也会拒绝。
			if (projects.some((project) => project.id === projectId && isRemoteProject(project))) return;
			const loadState = store.get(sessionCatalogLoadStateAtom)[projectId];
			if (loadState?.status === "loading" || loadState?.status === "ready") return;
			void refreshProjectSessions(projectId, silent).catch(() => undefined);
		},
		[store, refreshProjectSessions, projects],
	);

	return {
		announceProjectAdded,
		addProject,
		updateAfterProjectRemoved,
		deleteDraftSession,
		reorderProjects,
		setProjectPinned,
		removeSidebarProject,
		removeSidebarProjects,
		changeChatPath,
		ensureProjectCatalogLoaded,
	};
}
