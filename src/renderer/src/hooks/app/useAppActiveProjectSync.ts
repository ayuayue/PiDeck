import { useEffect } from "react";
import type { createStore } from "jotai";
import { sessionCatalogLoadStateAtom } from "../../atoms";
import { desktopApi as api } from "../../desktopApi";
import type { GitBranchInfo, Project } from "../../../../shared/types";

/**
 * 活动项目的 catalog 补加载与 git 分支同步。
 *
 * 三条 effect 共用「活动项目 + 是否远端」这两个入口条件：
 * - catalog：按 load state（而不是会话数量）判定，空项目返回 [] 后也算 ready，避免每次选中都重扫；
 * - 分支：切项目只回读一次分支（文件树加载/恢复由 useProjectFileTreeController 负责）；
 * - refs 订阅：与栏内 usePaneGitInfo 同一事件源（主进程 GitRefsWatcher 复用一份 1.5s 签名轮询），
 *   替代 App 级 4s 盲轮询，订阅失败静默降级为初始一次回读。
 *
 * 远端项目没有本机仓库，一切本地 git 调用都跳过（各 IPC 也已按 locator 拒绝）。
 */
export interface AppActiveProjectSyncDeps {
	store: ReturnType<typeof createStore>;
	activeProjectId: string | undefined;
	activeProjectIsRemote: boolean;
	projects: Project[];
	expandedProjects: ReadonlySet<string>;
	expandedProjectsReady: boolean;
	/** refreshProjectSessions 每次渲染换引用，自动加载类 effect 必须经 ref 取最新实现 */
	refreshProjectSessionsRef: { current: (projectId: string, silent?: boolean) => Promise<unknown> };
	setGitInfo: (next: GitBranchInfo | ((current: GitBranchInfo) => GitBranchInfo)) => void;
	setBranchByProject: (updater: (current: Record<string, string | null>) => Record<string, string | null>) => void;
}

export function useAppActiveProjectSync(deps: AppActiveProjectSyncDeps): void {
	const { store, activeProjectId, activeProjectIsRemote, projects, expandedProjects, expandedProjectsReady, refreshProjectSessionsRef, setGitInfo, setBranchByProject } = deps;

	useEffect(() => {
		if (!activeProjectId || activeProjectIsRemote) return;
		// 切换项目时按 catalog load state 判断。空项目成功返回 [] 后也会是 ready，
		// 不能再用列表长度，否则每次选中都会重扫。
		const activeProject = projects.find((p) => p.id === activeProjectId);
		const loadState = store.get(sessionCatalogLoadStateAtom)[activeProjectId];
		if (expandedProjectsReady && activeProject && expandedProjects.has(activeProjectId) && loadState?.status !== "loading" && loadState?.status !== "ready") {
			void refreshProjectSessionsRef.current(activeProjectId).catch(() => undefined);
		}
	}, [activeProjectId, activeProjectIsRemote, expandedProjects, expandedProjectsReady, projects, store]);

	// 项目切换只刷 git 分支（文件树加载/恢复已收口到 useProjectFileTreeController）
	useEffect(() => {
		if (!activeProjectId || activeProjectIsRemote) {
			setGitInfo({ current: null, branches: [] });
			return;
		}
		let cancelled = false;

		void api.git
			.branches(activeProjectId)
			.then((info) => {
				if (!cancelled) setGitInfo(info);
			})
			.catch(() => {
				if (!cancelled) setGitInfo({ current: null, branches: [] });
			});
		return () => {
			cancelled = true;
		};
	}, [activeProjectId, activeProjectIsRemote]);

	useEffect(() => {
		if (!activeProjectId || activeProjectIsRemote) return;
		let stopped = false;
		const refreshGitInfo = async () => {
			try {
				const next = await api.git.branches(activeProjectId);
				if (stopped) return;
				// 外部终端/IDE 切分支时同步侧栏徽标与抽屉，只在状态真的变化时更新，避免不必要重渲染。
				setGitInfo((current) => (current.current === next.current && current.branches.join("\n") === next.branches.join("\n") ? current : next));
				// 侧栏分支徽标与 Git 抽屉同源：外部终端 checkout 后也要一起跟上。
				// 只更新聚焦项目——非聚焦项目不在监听范围内，由栏内 usePaneGitInfo 回写。
				setBranchByProject((prev) => (prev[activeProjectId] === next.current ? prev : { ...prev, [activeProjectId]: next.current }));
			} catch {
				if (!stopped) {
					setGitInfo({ current: null, branches: [] });
				}
			}
		};
		void refreshGitInfo();
		// 与栏内 usePaneGitInfo 同一事件源：主进程 GitRefsWatcher 复用一份 1.5s refs
		// 签名轮询，替代 App 级 4s 盲轮询；订阅失败时静默降级为初始一次回读。
		const offRefsChanged = api.git.onRefsChanged((changedWatchId) => {
			if (changedWatchId !== watchId || stopped) return;
			void refreshGitInfo();
		});
		const watchPromise = api.git.watchRefs(activeProjectId).catch(() => null);
		let watchId: string | null = null;
		void watchPromise.then((id) => {
			watchId = id;
		});
		return () => {
			stopped = true;
			offRefsChanged();
			// 竞态安全：卸载时 watch 可能尚未 resolve，退订等它落地后执行。
			void watchPromise.then((id) => {
				if (id) void api.git.unwatchRefs(id);
			});
		};
	}, [activeProjectId, activeProjectIsRemote]);
}
