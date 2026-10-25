import { t as i18nT } from "../i18n";
import { useCallback, useState } from "react";
import type { AgentTab, GitBranchInfo, Project } from "../../../shared/types";

export interface UseGitFlowInput {
	activeProjectId: string | undefined;
	gitInfo: GitBranchInfo;
	setGitInfo: React.Dispatch<React.SetStateAction<GitBranchInfo>>;
	displayAgents: AgentTab[];
	setProjects: (projects: Project[]) => void;
	refreshWorktrees: (projectId: string) => Promise<void>;
	setConfirmDialog: (
		dialog: {
			title: string;
			message: string;
			danger?: boolean;
			confirmLabel?: string;
			onConfirm: () => void;
		} | null,
	) => void;
	showToast: (message: string, duration?: number) => void;
	/** Git checkout API */
	checkout: (projectId: string, branch: string) => Promise<GitBranchInfo>;
	/** Git create branch API */
	createBranchApi: (projectId: string, branchName: string) => Promise<GitBranchInfo>;
	/** Git branches API */
	branches: (projectId: string) => Promise<GitBranchInfo>;
	/** Worktree create API */
	worktreeCreate: (projectId: string, branchName: string) => Promise<{ branch: string }>;
	/** Worktree remove API */
	worktreeRemove: (parentProjectId: string, worktreePath: string) => Promise<boolean>;
	/** Projects list API */
	projectsList: () => Promise<Project[]>;
	/** Translation function */
	t: typeof i18nT;
}

export interface UseGitFlowOutput {
	switchingBranch: string | null;
	worktreeCreating: boolean;
	removingWorktreePaths: Set<string>;
	switchBranch: (branch: string) => Promise<void>;
	createBranch: (branchName: string) => Promise<void>;
	createWorktree: (projectId: string, branchName: string) => Promise<{ branch: string }>;
	removeWorktree: (parentProjectId: string, worktreePath: string) => Promise<void>;
	requestRemoveWorktree: (parentProjectId: string, worktreePath: string, childProject: Project | undefined) => void;
}

export function useGitFlow(input: UseGitFlowInput): UseGitFlowOutput {
	const { activeProjectId, gitInfo, setGitInfo, displayAgents, setProjects, refreshWorktrees, setConfirmDialog, showToast, checkout, createBranchApi, branches, worktreeCreate: worktreeCreateApi, worktreeRemove: worktreeRemoveApi, projectsList, t } = input;

	const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
	const [worktreeCreating, setWorktreeCreating] = useState(false);
	const [removingWorktreePaths, setRemovingWorktreePaths] = useState<Set<string>>(() => new Set());

	const switchBranch = useCallback(
		async (branch: string) => {
			if (!activeProjectId || !branch || branch === gitInfo.current) return;
			setSwitchingBranch(branch);
			try {
				const next = await checkout(activeProjectId, branch);
				setGitInfo(next);
			} catch (error) {
				showToast(
					t("app.branchSwitchFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
				const refreshed = await branches(activeProjectId).catch(() => ({
					current: null,
					branches: [],
				}));
				setGitInfo(refreshed);
			} finally {
				setSwitchingBranch(null);
			}
		},
		[activeProjectId, gitInfo.current, checkout, branches, setGitInfo, showToast, t],
	);

	const createBranch = useCallback(
		async (branchName: string) => {
			if (!activeProjectId || !branchName.trim()) return;
			setSwitchingBranch(branchName);
			try {
				const next = await createBranchApi(activeProjectId, branchName);
				setGitInfo(next);
				showToast(t("app.branchCreated", { branch: branchName }), 2500);
			} catch (error) {
				showToast(
					t("app.branchCreateFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			} finally {
				setSwitchingBranch(null);
			}
		},
		[activeProjectId, createBranchApi, setGitInfo, showToast, t],
	);

	const createWorktree = useCallback(
		async (projectId: string, branchName: string) => {
			setWorktreeCreating(true);
			try {
				const result = await worktreeCreateApi(projectId, branchName);
				const next = await projectsList();
				setProjects(next);
				await refreshWorktrees(projectId);
				showToast(t("app.worktreeCreated") + result.branch);
				return result;
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				showToast(t("app.worktreeCreateFailed") + message, 5000);
				throw e;
			} finally {
				setWorktreeCreating(false);
			}
		},
		[worktreeCreateApi, projectsList, setProjects, refreshWorktrees, showToast, t],
	);

	const removeWorktree = useCallback(
		async (parentProjectId: string, worktreePath: string) => {
			try {
				const removed = await worktreeRemoveApi(parentProjectId, worktreePath);
				if (!removed) {
					throw new Error(t("app.worktreeRemoveNotFound"));
				}
				const next = await projectsList();
				setProjects(next);
				await refreshWorktrees(parentProjectId);
				showToast(t("app.worktreeRemoved"));
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				showToast(t("app.worktreeRemoveFailed") + message, 5000);
			} finally {
				setRemovingWorktreePaths((prev) => {
					const next = new Set(prev);
					next.delete(worktreePath);
					return next;
				});
			}
		},
		[worktreeRemoveApi, projectsList, setProjects, refreshWorktrees, showToast, t],
	);

	const requestRemoveWorktree = useCallback(
		(parentProjectId: string, worktreePath: string, childProject: Project | undefined) => {
			const childAgents = childProject ? displayAgents.filter((a) => a.projectId === childProject.id && (a.status === "running" || a.status === "starting")) : [];
			if (childAgents.length > 0) {
				showToast(t("app.worktreeRemoveBlockedByAgents"), 5000);
				return;
			}
			setConfirmDialog({
				title: t("app.worktreeRemoveConfirmTitle"),
				message: t("app.worktreeRemoveConfirmMessage"),
				danger: true,
				confirmLabel: t("common.delete"),
				onConfirm: () => {
					setConfirmDialog(null);
					setRemovingWorktreePaths((prev) => new Set(prev).add(worktreePath));
					setTimeout(() => {
						void removeWorktree(parentProjectId, worktreePath);
					}, 280);
				},
			});
		},
		[displayAgents, setConfirmDialog, removeWorktree, showToast, t],
	);

	return {
		switchingBranch,
		worktreeCreating,
		removingWorktreePaths,
		switchBranch,
		createBranch,
		createWorktree,
		removeWorktree,
		requestRemoveWorktree,
	};
}
