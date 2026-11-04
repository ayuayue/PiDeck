import { dialog, ipcMain, type BrowserWindow } from "electron";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import { opFail } from "../../shared/op";
import { isLocalProject, isRemoteProject, PROJECT_HOST_ID_PATTERN } from "../../shared/projectLocation";
import type { FeedbackProjectContext, LocalProject, Project } from "../../shared/types";
import { WSL_DIRECTORY_CODES } from "../../shared/types/wslDirectory";
import type { ProjectStore, WslProjectIdentity } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import { readTextBounded } from "../fs/boundedTextRead";
import type { GitService } from "../git/GitService";
import type { WorktreeService } from "../git/WorktreeService";
import type { AgentManager } from "../pi/AgentManager";
import type { AppLogger } from "../logging/AppLogger";
import type { ProjectResourceManager } from "../projects/ProjectResourceManager";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import { attachProjectPresence } from "../projects/projectPresence";
import { removeProjectWithSessions } from "../projects/projectRemoval";
import { consumeUserDataNameMigrationNotice } from "../projects/userDataNameMigration";
import { registerProjectResourceIpc } from "./projectResourceIpc";
import { createProjectGitHandler } from "./gitProjectHandlers";
import { isWslDistroMismatchError, linuxPathToWslUnc, normalizeSelectedWslProjectPath, normalizeWslProjectAddPath, parseWslUncPath, toWindowsHostPath, type WslEnvironment } from "../wsl/WslPaths";
import { listWslDirectory } from "../wsl/WslDirectoryBrowser";
import { createWslHostStore } from "../wsl/WslHostStore";

export type ProjectsIpcDeps = {
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	gitService: GitService;
	worktreeService: WorktreeService;
	agentManager: AgentManager;
	appLogger: AppLogger;
	projectResourceManager: ProjectResourceManager;
	sessionCatalog?: SessionCatalog;
	/**
	 * 项目被删除后的收尾（目录订阅等）。在数据库删除成功之后调用，失败不回滚删除，也不影响返回值。
	 */
	onProjectRemoved?: (projectId: string, removed?: Project) => void | Promise<void>;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	getMainWindow: () => BrowserWindow | null;
	/** 添加 WSL 项目前解析当前发行版/用户；缺失时 chooseAndAdd 会拒绝（#155）。 */
	resolveWslEnvironment?: (distro: string, user: string) => Promise<WslEnvironment>;
	/** WSL 档案文件所在目录（本机 userData）；只读该目录，不启动发行版。 */
	userDataDir: string;
};

export function registerProjectsIpc({ projectStore, settingsStore, gitService, worktreeService, agentManager, appLogger, projectResourceManager, sessionCatalog, mainCopy, getMainWindow, resolveWslEnvironment, userDataDir, onProjectRemoved }: ProjectsIpcDeps): void {
	const handleProjectGit = createProjectGitHandler(ipcMain, projectStore, settingsStore);
	// Windows Node 只能 stat/打开主机路径；WSL 项目在 store 里可能是 Linux 路径。远端项目不能到这里。
	const resolveProjectHostPath = (project: LocalProject) => {
		const settings = settingsStore.get();
		// 第 11 步起，项目自带 distro 时优先使用它；缺省才回退全局设置（第 14 步删除）。
		const distro = project.wslDistro ?? settings.wslDistro;
		if (process.platform !== "win32" || project.environment !== "wsl" || !distro) {
			return project.path;
		}
		try {
			return toWindowsHostPath(project.path, { distro });
		} catch {
			// Presence / git 探测不应把临时 WSL 不可用升级成 IPC 硬失败。
			return project.path;
		}
	};

	const resolveProjectStoredPath = (path: string, project: LocalProject) => {
		const distro = project.wslDistro ?? settingsStore.get().wslDistro;
		if (process.platform !== "win32" || project.environment !== "wsl" || !distro) return path;
		try {
			return normalizeSelectedWslProjectPath(path, { distro });
		} catch {
			return path;
		}
	};

	// 可见项目 = 按环境过滤 + 目录存在性标记（missing 保留记录，见 projectPresence.ts）。
	// 远端项目不受 WSL 模式过滤影响（它不属于本机环境），一律保留。
	const getVisibleProjects = async () => {
		const settings = settingsStore.get();
		const all = projectStore.list();
		// 全局 WSL 模式（设置 → 开发 → Pi 来源）仍决定本机项目清单：关掉时只列 Windows 项目，
		// 打开时只列 WSL 项目。连接档案（一等 WSL 目标）尚未放开，这里保持 0.9.8 的开关语义；
		// 远端项目与聊天项目不属于本机环境，不受这条过滤影响。
		const visible = settings.wslEnabled ? all.filter((project) => isRemoteProject(project) || project.kind === "chat" || project.environment === "wsl") : all.filter((project) => isRemoteProject(project) || project.kind === "chat" || !project.environment || project.environment === "windows");
		return attachProjectPresence(visible, undefined, (project) => {
			// 远端项目已在 attachProjectPresence 内跳过；走到这里说明窄化失败。
			if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
			return resolveProjectHostPath(project);
		});
	};

	ipcMain.handle(ipcChannels.projectsList, async () => getVisibleProjects());
	ipcMain.handle(ipcChannels.projectsAdd, async () => {
		// 只服务 Windows 目录选择框：WSL 添加项目走内置选择器（projects:list-wsl-directory +
		// projects:add-wsl-path），因为系统对话框递给我们的 `\\wsl.localhost\<distro>\<home>` 是按
		// 发行版**默认用户**鉴权的，root 档案的 /root 在 Windows 侧根本打不开（issue 见计划文档）。
		const project = await projectStore.chooseAndAdd();
		void appLogger.info("project", "Project added", { projectId: project?.id, path: project?.path, environment: "windows" });
		return project;
	});

	/**
	 * Wave 0：目录浏览/按路径添加所需的 WSL 身份。**只来自主进程**：渲染层最多给一个档案 id，
	 * distro/user 由档案或全局 WSL 模式解析，缺省档案身份时保持旧行为（运行时回退全局 distro/user）。
	 */
	const resolveWslBrowseTarget = async (hostIdValue: unknown): Promise<{ distro: string; user: string; identity?: WslProjectIdentity } | null> => {
		if (process.platform !== "win32") return null;
		if (hostIdValue === undefined || hostIdValue === null || hostIdValue === "") {
			const settings = settingsStore.get();
			if (settings.wslEnabled !== true) return null;
			const distro = String(settings.wslDistro ?? "").trim();
			const user = String(settings.wslUser ?? "").trim();
			if (!distro || !user) return null;
			return { distro, user };
		}
		if (typeof hostIdValue !== "string" || !PROJECT_HOST_ID_PATTERN.test(hostIdValue)) return null;
		const store = await createWslHostStore(userDataDir);
		const profile = (await store.list()).find((host) => host.id === hostIdValue);
		if (profile === undefined) return null;
		return { distro: profile.distro, user: profile.user, identity: { hostId: profile.id, distro: profile.distro, user: profile.user } };
	};

	/**
	 * 该档案用户的 HOME：只在选择器首次定位（未给路径）时用一次。
	 * 解析不到就从 `/` 开始浏览——列根目录对任何用户都可读，把它当成硬失败会让用户连自己的目录都找不到。
	 */
	const resolveWslBrowseStart = async (distro: string, user: string): Promise<string> => {
		if (resolveWslEnvironment === undefined) return "/";
		const environment = await resolveWslEnvironment(distro, user).catch(() => null);
		return environment?.linuxHome ?? "/";
	};

	ipcMain.handle(ipcChannels.projectsListWslDirectory, async (_event, pathValue: unknown, hostIdValue: unknown) => {
		const target = await resolveWslBrowseTarget(hostIdValue);
		if (target === null) return opFail(WSL_DIRECTORY_CODES.unavailable);
		// 空串是「从我该在的地方开始」，具体起点由主进程解析；渲染层永远拿不到别人的 HOME 猜测。
		const path = typeof pathValue === "string" && pathValue.length > 0 ? pathValue : await resolveWslBrowseStart(target.distro, target.user);
		return listWslDirectory({ distro: target.distro, user: target.user, path });
	});

	/**
	 * 选定发行版内目录后添加项目：入库前必须在发行版内校验（Windows 侧对 `\\wsl.localhost` 的
	 * `stat` 按默认用户鉴权，root 档案的目录可能报错也可能假报存在），路径取列举已归一后的绝对路径，
	 * 转规范 UNC 只在入库这一刻发生。
	 */
	ipcMain.handle(ipcChannels.projectsAddWslPath, async (_event, pathValue: unknown, hostIdValue: unknown) => {
		const target = await resolveWslBrowseTarget(hostIdValue);
		if (target === null) throw new Error(mainCopy("project.wslEnvironmentUnavailable"));
		const path = typeof pathValue === "string" ? pathValue : "";
		const listed = await listWslDirectory({ distro: target.distro, user: target.user, path });
		if (!listed.ok) {
			if (listed.code === WSL_DIRECTORY_CODES.unavailable) throw new Error(mainCopy("project.wslEnvironmentUnavailable"));
			throw new Error(mainCopy("project.wslPathNotFound", { path, distro: target.distro }));
		}
		const projectPath = linuxPathToWslUnc(listed.value.path, target.distro);
		const project = await projectStore.add(projectPath, undefined, "wsl", target.identity);
		void appLogger.info("project", "WSL project added via in-distro picker", { projectId: project.id, path: project.path, environment: "wsl" });
		const visible = await getVisibleProjects();
		getMainWindow()?.webContents.send(ipcChannels.projectsChanged, visible);
		return project;
	});

	// 文件夹右键菜单（--open-project）直达：给定路径必须是已存在的目录，
	// 校验通过后直接入库（与选择框添加同一 add 链路：同路径去重/聊天目录特判）。
	ipcMain.handle(ipcChannels.projectsAddByPath, async (_event, path: unknown) => {
		if (typeof path !== "string" || path.trim().length === 0) {
			throw new Error(mainCopy("project.invalidPath"));
		}
		// 全局 WSL 模式：右键菜单 / 快捷任务递过来的通常是 `\\wsl.localhost\<distro>\...` 这类 UNC，或
		// WSL 内的绝对 Linux 路径。早先这里不带 environment 入库，项目被记成 windows 环境，随后
		// getVisibleProjects 在 WSL 模式下按环境过滤把它整条藏掉 —— 表现为「添加了却找不到、打不开」。
		const settings = settingsStore.get();
		const wslDistro = process.platform === "win32" && settings.wslEnabled === true ? String(settings.wslDistro ?? "").trim() : "";
		let projectPath = path.trim();
		if (wslDistro) {
			let normalized: string | null;
			try {
				normalized = normalizeWslProjectAddPath(projectPath, wslDistro);
			} catch (error) {
				// 别的发行版的目录：项目运行时要按 Linux 侧路径转发给 wsl.exe，发行版对不上一律拒绝。
				if (isWslDistroMismatchError(error)) throw new Error(mainCopy("project.wslDistroMismatch", { distro: parseWslUncPath(projectPath)?.distro ?? "", active: wslDistro }));
				throw error;
			}
			if (normalized === null) {
				// 宿主盘符目录在 WSL 模式下不属于可见清单：说清楚，不要静默入库后消失。
				throw new Error(mainCopy("project.windowsPathInWslMode"));
			}
			projectPath = normalized;
		}
		const stats = await stat(projectPath).catch(() => null);
		if (!stats || !stats.isDirectory()) {
			throw new Error(wslDistro ? mainCopy("project.wslPathNotFound", { path: projectPath, distro: wslDistro }) : mainCopy("project.pathNotFound", { path: projectPath }));
		}
		const project = await projectStore.add(projectPath, undefined, wslDistro ? "wsl" : undefined);
		void appLogger.info("project", "Project added via explorer context menu", { projectId: project.id, path: project.path, environment: wslDistro ? "wsl" : "windows" });
		// 与重命名/删除一致：入库后广播可见项目清单，侧栏（含 LAN Web 端）立即刷新，否则新增项目不显示。
		const visible = await getVisibleProjects();
		getMainWindow()?.webContents.send(ipcChannels.projectsChanged, visible);
		return project;
	});
	ipcMain.handle(ipcChannels.projectsRemove, async (_event, id: string) => {
		const removed = projectStore.get(id);
		const childIds = removed ? projectStore.listWorktreeChildren(removed.id).map((child) => child.id) : [];
		// 预热进程属于本项目但 UI 不可见：不先回收，它会以「仍有运行中的 Agent」挡住删除，
		// 而用户在界面上找不到可停止的会话（issue #360）。
		for (const projectId of [id, ...childIds]) agentManager.releaseStandbyAgent(projectId);
		// 删除前拦截：项目仍有运行中的 Agent（pi 子进程）时禁止删除，避免进程悬挂后台继续占用资源。
		if (agentManager.hasAgentForProject(id)) {
			throw new Error("PROJECT_HAS_RUNNING_AGENT");
		}
		// 进程已退出、runtime 还留在内存里的会话随项目一起丢弃，避免删后残留幽灵会话。
		for (const projectId of [id, ...childIds]) agentManager.discardStoppedAgentsForProject(projectId);
		// 先清 catalog 引用、再删项目（顺序与理由见 removeProjectWithSessions）：两个 store 没有共同
		// 提交点，只有这个顺序保证任一段失败时都不会留下指向已删项目的倒挂引用；失败不再被吞成“0 条”。
		await removeProjectWithSessions({ projects: projectStore, sessions: sessionCatalog }, id, { childProjectIds: childIds });
		// 目录订阅跟着项目一起收尾：退订失败不影响删除结果，但下次同项目读会重新订阅。
		if (onProjectRemoved !== undefined) await Promise.resolve(onProjectRemoved(id, removed)).catch(() => undefined);
		void appLogger.info("project", "Project removed", { projectId: id, path: removed?.path });
		return getVisibleProjects();
	});
	ipcMain.handle(ipcChannels.projectsReorder, async (_event, projectIds: string[]) => {
		const result = await projectStore.reorder(projectIds);
		void appLogger.info("project", "Projects reordered", { count: projectIds.length });
		return getVisibleProjects();
	});

	// 项目置顶/取消置顶：入参边界校验后落库，广播 projectsChanged 让其他渲染实例同步排序。
	ipcMain.handle(ipcChannels.projectsSetPinned, async (_event, id: unknown, pinned: unknown) => {
		if (typeof id !== "string" || !id) throw new Error("invalid projectId");
		if (typeof pinned !== "boolean") throw new Error("invalid pinned");
		await projectStore.setPinned(id, pinned);
		const visible = await getVisibleProjects();
		getMainWindow()?.webContents.send(ipcChannels.projectsChanged, visible);
		void appLogger.info("project", "Project pin toggled", { projectId: id, pinned });
		return visible;
	});

	// 重命名项目显示名：仅改 label 不动磁盘目录。聊天项目 / worktree 子项目由
	// ProjectStore.rename 拒绝（PROJECT_RENAME_NOT_ALLOWED）。广播 + 返回全量列表，
	// 让其他渲染实例（LAN Web）与当前窗口都拿到最新 name。
	ipcMain.handle(ipcChannels.projectsRename, async (_event, id: unknown, name: unknown) => {
		if (typeof id !== "string" || !id) throw new Error("invalid projectId");
		if (typeof name !== "string") throw new Error("invalid name");
		const project = await projectStore.rename(id, name);
		if (!project) throw new Error(`Project not found: ${id}`);
		const visible = await getVisibleProjects();
		getMainWindow()?.webContents.send(ipcChannels.projectsChanged, visible);
		void appLogger.info("project", "Project renamed", { projectId: id, name: project.name });
		return visible;
	});

	// ── Worktree 项目管理 ──

	ipcMain.handle(ipcChannels.projectsListRoot, () => {
		return projectStore.listRoot();
	});

	ipcMain.handle(ipcChannels.projectsListWorktreeChildren, async (_event, parentId: string) => {
		return projectStore.listWorktreeChildren(parentId);
	});

	handleProjectGit(ipcChannels.projectsToggleWorktreeEnabled, async (_event, projectId: string) => {
		const existing = projectStore.get(projectId);
		if (!existing) throw new Error(`Project not found: ${projectId}`);
		// worktree 工作区模式依赖本机 Git：远端项目明确拒绝（Phase 5 再按 capability 矩阵评估）。
		if (!isLocalProject(existing)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
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
					// findByPath 必须用 store 里的 Linux/规范化路径，不能拿 git 返回的 UNC。
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
	});

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

	ipcMain.handle(ipcChannels.projectsSetChatPath, async (_event, path: string) => {
		if (typeof path !== "string" || path.length === 0) throw new Error("Invalid chat path");
		const project = await projectStore.setChatProjectPath(path);
		// 路径变更后广播项目列表变化，渲染端据此刷新聊天项目的会话。
		const mainWindow = getMainWindow();
		mainWindow?.webContents.send(ipcChannels.projectsChanged, await getVisibleProjects());
		void appLogger.info("project", "Chat project path updated", { path });
		return project;
	});

	// userData 更名（pi-desktop → PiDeck）的一次性迁移提示：启动早期已同步完成迁移，
	// 渲染层首挂载领取一次即清空（消费式），保证「只提示一次、之后不再打扰」。
	ipcMain.handle(ipcChannels.userDataMigrationConsumeNotice, async () => consumeUserDataNameMigrationNotice());

	registerProjectResourceIpc({
		appLogger,
		projectResourceManager,
	});

	// ── 问题反馈「新建会话分析」的项目上下文 ──
	// 读取项目根 AGENTS.md（大小截断）与项目级技能目录名，供 AI 提示词携带工程规范。
	// 只读文件内容，不写任何数据；路径来自 projectStore（用户已信任的项目），无需再次弹信任。

	const FEEDBACK_AGENTS_MD_MAX_CHARS = 14_000;
	// 头部有界读：UTF-8 最坏 4B/字符，64KB 覆盖字符预算；超大 AGENTS.md 不再整读进内存
	const FEEDBACK_AGENTS_MD_MAX_BYTES = 64 * 1024;
	ipcMain.handle(ipcChannels.appFeedbackProjectContext, async (_event, projectId: unknown): Promise<FeedbackProjectContext> => {
		if (typeof projectId !== "string" || !projectId) {
			throw new Error("invalid projectId");
		}
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		// AGENTS.md/skills 在本机项目目录读取：远端项目必须在远端发现（Phase 4），不能当本机路径。
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const hostPath = resolveProjectHostPath(project);
		// AGENTS.md 缺失时返回空串而非报错：不是所有项目都写了规范文件
		let agentsMd = "";
		try {
			// head 模式自带行对齐：不会把半截代码行带给提示词
			agentsMd = await readTextBounded(join(hostPath, "AGENTS.md"), FEEDBACK_AGENTS_MD_MAX_BYTES, "head");
		} catch {
			agentsMd = "";
		}
		const agentsMdTruncated = agentsMd.length > FEEDBACK_AGENTS_MD_MAX_CHARS;
		if (agentsMdTruncated) {
			// 在字符上限处往前截到行尾，避免提示词里出现半截代码行
			const capped = agentsMd.slice(0, FEEDBACK_AGENTS_MD_MAX_CHARS);
			const lastBreak = capped.lastIndexOf("\n");
			agentsMd = lastBreak > 0 ? capped.slice(0, lastBreak) : capped;
		}
		// 项目级技能：.pi/agent/skills 与 .agents/skills 下的子目录名（读取失败视为无技能）
		const skillNames = new Set<string>();
		for (const skillsDir of [".pi/agent/skills", ".agents/skills"]) {
			try {
				const entries = await readdir(join(hostPath, skillsDir), { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory()) skillNames.add(entry.name);
				}
			} catch {
				// 目录不存在/不可读都视为无技能，不把项目上下文拉垮
			}
		}
		return {
			projectId,
			projectName: project.name,
			agentsMd,
			agentsMdTruncated,
			skills: [...skillNames].sort(),
		};
	});
}
