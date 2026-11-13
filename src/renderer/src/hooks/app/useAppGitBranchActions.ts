import { useCallback } from "react";
import { desktopApi as api } from "../../desktopApi";
import { t } from "../../i18n";
import type { NoticeKind } from "../../utils/notice";
import type { GitBranchInfo } from "../../../../shared/types";

/**
 * 活动项目的分支切换/新建：成功后同源回写侧栏徽标字典与 Git 抽屉的聚焦分支，
 * 失败时提示并把抽屉回读到真实状态（切分支失败的工作区可能已半改）。
 *
 * 侧栏与抽屉都消费同一份 branchByProject，所以两个动作都在这里落盘一次，
 * 不在 UI 各处各写一遍。
 */
export interface AppGitBranchActionsDeps {
	activeProjectId: string | undefined;
	gitInfo: GitBranchInfo;
	showToast: (message: string, duration?: number, kind?: NoticeKind) => void;
	setGitInfo: (next: GitBranchInfo | ((current: GitBranchInfo) => GitBranchInfo)) => void;
	setBranchByProject: (updater: (current: Record<string, string | null>) => Record<string, string | null>) => void;
}

export interface AppGitBranchActions {
	switchBranch: (branch: string) => Promise<void>;
	createBranch: (branchName: string) => Promise<void>;
}

export function useAppGitBranchActions({ activeProjectId, gitInfo, showToast, setGitInfo, setBranchByProject }: AppGitBranchActionsDeps): AppGitBranchActions {
	const switchBranch = useCallback(
		async (branch: string) => {
			if (!activeProjectId || !branch || branch === gitInfo.current) return;
			try {
				const next = await api.git.checkout(activeProjectId, branch);
				setGitInfo(next);
				setBranchByProject((prev) => ({ ...prev, [activeProjectId]: next.current }));
			} catch (error) {
				showToast(
					t("app.branchSwitchFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
				const refreshed = await api.git.branches(activeProjectId).catch(() => ({ current: null, branches: [] }));
				setGitInfo(refreshed);
			}
		},
		[activeProjectId, gitInfo.current, showToast],
	);

	const createBranch = useCallback(
		async (branchName: string) => {
			if (!activeProjectId || !branchName.trim()) return;
			try {
				const next = await api.git.createBranch(activeProjectId, branchName);
				setGitInfo(next);
				setBranchByProject((prev) => ({ ...prev, [activeProjectId]: next.current }));
				showToast(t("app.branchCreated", { branch: branchName }), 2500);
			} catch (error) {
				showToast(
					t("app.branchCreateFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		},
		[activeProjectId, showToast],
	);

	return { switchBranch, createBranch };
}
