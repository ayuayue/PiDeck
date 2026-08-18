import { dialog, ipcMain, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { GitService } from "../git/GitService";
import type { WorktreeService } from "../git/WorktreeService";
import type { AgentManager } from "../pi/AgentManager";
import type { AppLogger } from "../logging/AppLogger";
import type { ProjectResourceManager } from "../projects/ProjectResourceManager";
import { attachProjectPresence } from "../projects/projectPresence";
import { registerProjectResourceIpc } from "./projectResourceIpc";
import {
	normalizeSelectedWslProjectPath,
	toWindowsHostPath,
	type WslEnvironment,
} from "../wsl/WslPaths";

export type ProjectsIpcDeps = {
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	gitService: GitService;
	worktreeService: WorktreeService;
	agentManager: AgentManager;
	appLogger: AppLogger;
	projectResourceManager: ProjectResourceManager;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	getMainWindow: () => BrowserWindow | null;
	resolveWslEnvironment?: (distro: string, user: string) => Promise<WslEnvironment>;
};

export function registerProjectsIpc({
	projectStore,
	settingsStore,
	gitService,
	worktreeService,
	agentManager,
	appLogger,
	projectResourceManager,
	mainCopy,
	getMainWindow,
	resolveWslEnvironment,
}: ProjectsIpcDeps): void {
	const resolveProjectHostPath = (project: { path: string; environment?: string }) => {
		const settings = settingsStore.get();
		if (
			process.platform !== "win32" ||
			project.environment !== "wsl" ||
			!settings.wslEnabled ||
			!settings.wslDistro
		) {
			return project.path;
		}
		try {
			return toWindowsHostPath(project.path, { distro: settings.wslDistro });
		} catch {
			// Presence checks should not turn a temporary WSL/path mismatch into a hard IPC failure.
			return project.path;
		}
	};

	const resolveProjectStoredPath = (path: string, project: { environment?: string }) => {
		const settings = settingsStore.get();
		if (
			process.platform !== "win32" ||
			project.environment !== "wsl" ||
			!settings.wslEnabled ||
			!settings.wslDistro
		) {
			return path;
		}
		try {
			return normalizeSelectedWslProjectPath(path, { distro: settings.wslDistro });
		} catch {
			return path;
		}
	};

	// 可见项目 = 按环境过滤 + 目录存在性标记（missing 保留记录，见 projectPresence.ts）
	const getVisibleProjects = async () => {
		const settings = settingsStore.get();
		const all = projectStore.list();
		const visible = settings.wslEnabled
			? all.filter((p) => p.kind === "chat" || p.environment === "wsl")
			: all.filter((p) => p.kind === "chat" || !p.environment || p.environment === "windows");
		return attachProjectPresence(visible, undefined, resolveProjectHostPath);
	};

	ipcMain.handle(ipcChannels.projectsList, async () => getVisibleProjects());
	ipcMain.handle(ipcChannels.projectsAdd, async () => {
		const settings = settingsStore.get();
		const env = settings.wslEnabled ? "wsl" as const : "windows" as const;
		const wslEnvironment = env === "wsl" && settings.wslDistro && settings.wslUser && resolveWslEnvironment
			? await resolveWslEnvironment(settings.wslDistro, settings.wslUser)
			: null;
		const project = await projectStore.chooseAndAdd(env, wslEnvironment);
		void appLogger.info("project", "Project added", { projectId: project?.id, path: project?.path, environment: env });
		return project;
	});
	ipcMain.handle(ipcChannels.projectsRemove, async (_event, id: string) => {
		// 删除前拦截：项目仍有运行中的 Agent（pi 子进程）时禁止删除，避免进程悬挂后台继续占用资源。
		if (agentManager.hasAgentForProject(id)) {
			throw new Error("PROJECT_HAS_RUNNING_AGENT");
		}
		await projectStore.remove(id);
		void appLogger.info("project", "Project removed", { projectId: id });
		return getVisibleProjects();
	});
	ipcMain.handle(
		ipcChannels.projectsReorder,
		async (_event, projectIds: string[]) => {
			const result = await projectStore.reorder(projectIds);
			void appLogger.info("project", "Projects reordered", { count: projectIds.length });
			return getVisibleProjects();
		},
	);

	// ── Worktree 项目管理 ──

	ipcMain.handle(ipcChannels.projectsListRoot, () => {
		return projectStore.listRoot();
	});

	ipcMain.handle(
		ipcChannels.projectsListWorktreeChildren,
		async (_event, parentId: string) => {
			return projectStore.listWorktreeChildren(parentId);
		},
	);

	ipcMain.handle(
		ipcChannels.projectsToggleWorktreeEnabled,
		async (_event, projectId: string) => {
			const existing = projectStore.get(projectId);
			if (!existing) throw new Error(`Project not found: ${projectId}`);
			// 即将启用时先校验是否 git 仓库；非 git 项目开启工作区模式没有意义，
			// 只会看到空列表并在创建时报错，这里提前给出明确错误让前端提示用户。
			if (!existing.worktreeEnabled) {
				const isRepo = await gitService.isGitRepo(resolveProjectHostPath(existing));
				if (!isRepo) {
					throw new Error("NOT_A_GIT_REPO");
				}
			}
			const project = await projectStore.toggleWorktreeEnabled(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			// 开启 worktree 模式时，自动注册已有的 git worktree
			if (project.worktreeEnabled) {
				try {
					const entries = await worktreeService.list(resolveProjectHostPath(project));
					for (const wt of entries) {
						// findByPath 返回 null 表示未注册
						const storedPath = resolveProjectStoredPath(wt.path, project);
						if (!projectStore.findByPath(storedPath)) {
							await projectStore.add(storedPath, projectId, project.environment);
						}
					}
				} catch {
					// worktree 查询失败不阻塞 toggle
				}
			}
			return project;
		},
	);

	// ── 聊天项目目录设置 ──

	ipcMain.handle(ipcChannels.projectsChooseChatPath, async () => {
		// 系统文件选择器，默认定位到当前聊天目录，便于用户就地切换。
		const result = await dialog.showOpenDialog({
			title: mainCopy("dialog.chooseChatHistoryFolder"),
			defaultPath: projectStore.getChatProjectPath(),
			properties: ["openDirectory"],
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		return result.filePaths[0];
	});

	ipcMain.handle(
		ipcChannels.projectsSetChatPath,
		async (_event, path: string) => {
			if (typeof path !== "string" || path.length === 0) throw new Error("Invalid chat path");
			const project = await projectStore.setChatProjectPath(path);
			// 路径变更后广播项目列表变化，渲染端据此刷新聊天项目的会话。
			const mainWindow = getMainWindow();
			mainWindow?.webContents.send(ipcChannels.projectsChanged, await getVisibleProjects());
			void appLogger.info("project", "Chat project path updated", { path });
			return project;
		},
	);

	registerProjectResourceIpc({
		appLogger,
		projectResourceManager,
	});
}
