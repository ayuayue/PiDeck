/**
 * useWorktreeActions — Git worktree 创建/删除/切换 hook。
 * Phase 5: 从 App.tsx 中提取，管理 worktree 相关状态和操作。
 */

import { useState } from "react";
import type { Project } from "../../../shared/types";
import type { AgentTab } from "../../../shared/types";
import { desktopApi as api } from "../desktopApi";
import { showNotice } from "../utils/notice";
import { t } from "../i18n";

export interface WorktreeActionsDeps {
	projects: Project[];
	displayAgents: AgentTab[];
	setProjects: (projects: Project[]) => void;
	refreshWorktrees: (projectId: string) => Promise<void>;
	overlays: {
		showConfirm: (opts: { title: string; message: string; danger?: boolean; confirmLabel: string; onConfirm: () => void }) => void;
		clearConfirm: () => void;
	};
}

export function useWorktreeActions(deps: WorktreeActionsDeps) {
	const { displayAgents, setProjects, refreshWorktrees, overlays } = deps;

	const [worktreeCreating, setWorktreeCreating] = useState(false);
	const [removingWorktreePaths, setRemovingWorktreePaths] = useState<Set<string>>(new Set());

	/** 创建新的 git worktree 工作区 */
	async function createWorktree(projectId: string, branchName: string) {
		setWorktreeCreating(true);
		try {
			const result = await api.git.worktreeCreate(projectId, branchName);
			// 刷新项目列表（新 worktree 已注册为项目）
			const next = await api.projects.list();
			setProjects(next);
			// 刷新 worktree 列表
			await refreshWorktrees(projectId);
			showNotice(t("app.worktreeCreated") + result.branch);
			return result;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			showNotice(t("app.worktreeCreateFailed") + message, 5000);
			throw e;
		} finally {
			setWorktreeCreating(false);
		}
	}

	/** 删除 worktree 工作区 */
	async function removeWorktree(parentProjectId: string, worktreePath: string) {
		try {
			const removed = await api.git.worktreeRemove(parentProjectId, worktreePath);
			if (!removed) {
				throw new Error(t("app.worktreeRemoveNotFound"));
			}
			const next = await api.projects.list();
			setProjects(next);
			await refreshWorktrees(parentProjectId);
			showNotice(t("app.worktreeRemoved"));
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			showNotice(t("app.worktreeRemoveFailed") + message, 5000);
		} finally {
			// 无论成功还是失败，都移除动画状态，避免 worktree 行永久隐藏
			setRemovingWorktreePaths((prev) => {
				const next = new Set(prev);
				next.delete(worktreePath);
				return next;
			});
		}
	}

	/**
	 * 请求删除 worktree：先校验是否有运行中的 Agent，再弹确认框，确认后执行删除。
	 * 避免误删正在使用的 worktree，也保证删除结果通过 toast 反馈给用户。
	 */
	function requestRemoveWorktree(parentProjectId: string, worktreePath: string, childProject: Project | undefined) {
		const childAgents = childProject ? displayAgents.filter((a) => a.projectId === childProject.id && (a.status === "running" || a.status === "starting")) : [];
		if (childAgents.length > 0) {
			showNotice(t("app.worktreeRemoveBlockedByAgents"), 5000);
			return;
		}
		overlays.showConfirm({
			title: t("app.worktreeRemoveConfirmTitle"),
			message: t("app.worktreeRemoveConfirmMessage"),
			danger: true,
			confirmLabel: t("common.delete"),
			onConfirm: () => {
				overlays.clearConfirm();
				// 先触发淡出动画（添加 removing 类），等动画结束后再执行真实删除。
				setRemovingWorktreePaths((prev) => new Set(prev).add(worktreePath));
				setTimeout(() => {
					void removeWorktree(parentProjectId, worktreePath);
				}, 280);
			},
		});
	}

	/** 切换项目的 worktree 功能开关 */
	async function toggleProjectWorktree(project: Project) {
		try {
			const updated = await api.projects.toggleWorktreeEnabled(project.id);
			if (!updated) return;
			setProjects(await api.projects.list());
			if (updated.worktreeEnabled) void refreshWorktrees(updated.id);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("NOT_A_GIT_REPO")) {
				showNotice(t("app.worktreeNotGitRepo"), 5000);
			} else {
				showNotice(message, 5000);
			}
		}
	}

	return {
		worktreeCreating,
		removingWorktreePaths,
		createWorktree,
		removeWorktree,
		requestRemoveWorktree,
		toggleProjectWorktree,
	};
}
