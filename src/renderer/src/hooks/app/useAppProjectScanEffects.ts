import { useEffect } from "react";
import type { createStore } from "jotai";
import { sessionCatalogLoadStateAtom } from "../../atoms";
import { isPendingAgentId } from "../../rendererUtils";
import type { AgentTab, Project } from "../../../../shared/types";

/**
 * 项目/会话集合的周期性收敛 effect：都是「按各自存活集合裁剪或补加载」的同一形状，
 * 由 App 级集中挂载一份（分屏各栏与抽屉共享状态，重复挂会打重复 IPC）。
 *
 * - 项目裁剪：项目被移除后，侧栏子项计数与会话 loading 标记要跟着消失；
 * - catalog 补加载：设置落地后按最终展开集合补加载（先于首拉的 localStorage 只算首屏预演）；用 catalog
 *   load state 而不是会话数量判定，空项目也只加载一次；
 * - 运行态回读：切到某 agent 时拉一次能力快照（pending agent 没有 runtime，跳过）；
 * - 终端裁剪：只按各自存活集合裁剪，流式事件仅更新 agent 集合，不能误删项目终端状态；
 * - 周期扫描：折叠中的项目不跑，省掉后台无意义的会话列表刷新；运行期间低频兜底，
 *   保证子会话（由扩展直接写盘）不因最后一次写入时序而遗漏。
 */
export interface AppProjectScanEffectsDeps {
	store: ReturnType<typeof createStore>;
	projects: Project[];
	projectIdsKey: string;
	setVisibleProjectChildCountByProject: (updater: (current: Record<string, number>) => Record<string, number>) => void;
	setSessionLoadingByProject: (updater: (current: Record<string, boolean>) => Record<string, boolean>) => void;
	expandedProjects: ReadonlySet<string>;
	expandedProjectsReady: boolean;
	// refreshProjectSessions 每次渲染换引用，自动加载类 effect 必须经 ref 取最新实现
	refreshProjectSessionsRef: { current: (projectId: string, silent?: boolean) => Promise<unknown> };
	activeAgentId: string | undefined;
	refreshRuntimeState: (agentId?: string) => Promise<void>;
	displayAgents: AgentTab[];
	pruneTerminalDockState: (liveAgentIds: Set<string>, liveProjectIds: Set<string>) => void;
	activeProjectId: string | undefined;
	activeProjectHasBusyAgent: boolean;
	activeProjectSessionSyncKey: string;
	refreshProjectSessions: (projectId: string, silent?: boolean) => Promise<unknown>;
}

export function useAppProjectScanEffects(deps: AppProjectScanEffectsDeps): void {
	const {
		store,
		projects,
		projectIdsKey,
		setVisibleProjectChildCountByProject,
		setSessionLoadingByProject,
		expandedProjects,
		expandedProjectsReady,
		refreshProjectSessionsRef,
		activeAgentId,
		refreshRuntimeState,
		displayAgents,
		pruneTerminalDockState,
		activeProjectId,
		activeProjectHasBusyAgent,
		activeProjectSessionSyncKey,
		refreshProjectSessions,
	} = deps;

	useEffect(() => {
		const projectIds = new Set(projects.map((project) => project.id));
		setVisibleProjectChildCountByProject((current) => Object.fromEntries(Object.entries(current).filter(([projectId]) => projectIds.has(projectId))));
		setSessionLoadingByProject((current) => Object.fromEntries(Object.entries(current).filter(([projectId]) => projectIds.has(projectId))));
	}, [projectIdsKey]);

	useEffect(() => {
		// settings.json 覆盖首屏 localStorage 后，按最终展开集合补加载；使用 catalog load state
		// 而不是会话数量判定，空项目也只加载一次。
		if (!expandedProjectsReady) return;
		for (const project of projects) {
			if (!expandedProjects.has(project.id)) continue;
			const loadState = store.get(sessionCatalogLoadStateAtom)[project.id];
			if (loadState?.status === "loading" || loadState?.status === "ready") continue;
			void refreshProjectSessionsRef.current(project.id).catch(() => undefined);
		}
	}, [expandedProjects, expandedProjectsReady, projectIdsKey, store]);

	useEffect(() => {
		if (activeAgentId && !isPendingAgentId(activeAgentId)) void refreshRuntimeState(activeAgentId);
	}, [activeAgentId]);

	useEffect(() => {
		// 只按各自存活集合裁剪：流式事件仅更新 agent 集合，不能误删项目终端状态
		const liveAgentIds = new Set(displayAgents.map((agent) => agent.id));
		const liveProjectIds = new Set(projects.map((project) => project.id));
		pruneTerminalDockState(liveAgentIds, liveProjectIds);
	}, [displayAgents, projects]);

	useEffect(() => {
		// 折叠中的项目不跑周期扫描，避免后台无意义刷会话列表
		if (!expandedProjectsReady || !activeProjectId || !expandedProjects.has(activeProjectId)) return;
		// 进入/退出运行态时都立即扫描一次，保证最终 child session 不因最后一次写入时序而遗漏。
		let disposed = false;
		const scheduleRefresh = () => {
			if (disposed) return;
			void refreshProjectSessions(activeProjectId, true).catch(() => undefined);
		};
		scheduleRefresh();
		if (!activeProjectHasBusyAgent) {
			return () => {
				disposed = true;
			};
		}

		// 子会话由扩展直接写盘，运行期间保留低频兜底；工具 start/end 不应重置计时器并触发额外扫描。
		const timer = window.setInterval(scheduleRefresh, 15_000);
		return () => {
			disposed = true;
			window.clearInterval(timer);
		};
	}, [activeProjectId, activeProjectHasBusyAgent, activeProjectSessionSyncKey, expandedProjects, expandedProjectsReady]);
}
