import { useCallback, useEffect, useRef, useState } from "react";
import type { BranchDiffResult, CommitDetail, CommitEntry, GitAheadBehind, GitBranchInfo, GitChangedFile, GitDiscardResource, GitGenerateCommitMessageResult, GitRepoInfo, GitResourceGroups, GitResourceGroupType, ProjectFileTarget } from "../../../../shared/types";
import { GitPanel } from "../app/GitPanel";
import { useGitRepoScope } from "../../hooks/useGitRepoScope";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";

export type GitDrawerApi = {
	listRepos: (projectId: string) => Promise<GitRepoInfo[]>;
	commitLog: (projectId: string, options?: { maxEntries?: number; ref?: string; path?: ProjectFileTarget; allBranches?: boolean }, repoPath?: ProjectFileTarget) => Promise<CommitEntry[]>;
	/** 与当前图谱过滤一致的提交总数（不分页），供源代码管理图标题徽章使用。 */
	commitCount: (projectId: string, options?: { ref?: string; path?: ProjectFileTarget; allBranches?: boolean }, repoPath?: ProjectFileTarget) => Promise<number>;
	commitDetail: (projectId: string, ref: string, repoPath?: ProjectFileTarget) => Promise<CommitDetail | null>;
	branchCompare: (projectId: string, base: string, target: string, repoPath?: ProjectFileTarget) => Promise<BranchDiffResult>;
	status: (projectId: string, repoPath?: ProjectFileTarget) => Promise<GitResourceGroups>;
	stage: (projectId: string, paths: ProjectFileTarget[], repoPath?: ProjectFileTarget) => Promise<void>;
	unstage: (projectId: string, paths: ProjectFileTarget[], repoPath?: ProjectFileTarget) => Promise<void>;
	discard: (projectId: string, group: "workingTree" | "untracked", fileTarget: ProjectFileTarget, repoPath?: ProjectFileTarget) => Promise<void>;
	discardFiles: (projectId: string, resources: GitDiscardResource[], repoPath?: ProjectFileTarget) => Promise<void>;
	commit: (projectId: string, message: string, repoPath?: ProjectFileTarget) => Promise<void>;
	cherryPick: (projectId: string, hash: string, repoPath?: ProjectFileTarget) => Promise<void>;
	revert: (projectId: string, hash: string, repoPath?: ProjectFileTarget) => Promise<void>;
	reset: (projectId: string, hash: string, mode: "soft" | "mixed" | "hard", repoPath?: ProjectFileTarget) => Promise<void>;
	dropCommit: (projectId: string, hash: string, repoPath?: ProjectFileTarget) => Promise<void>;
	generateCommitMessage: (projectId: string, repoPath?: ProjectFileTarget) => Promise<GitGenerateCommitMessageResult>;
	init: (projectId: string) => Promise<void>;
	push: (projectId: string, repoPath?: ProjectFileTarget) => Promise<void>;
	pull: (projectId: string, repoPath?: ProjectFileTarget) => Promise<void>;
	fetch: (projectId: string, repoPath?: ProjectFileTarget) => Promise<void>;
	aheadBehind: (projectId: string, repoPath?: ProjectFileTarget) => Promise<GitAheadBehind | null>;
	/** 订阅仓库 refs 变化，返回 watchId；由 GitPanel 在挂载期间持有并与 unwatchRefs 配对 */
	watchRefs: (projectId: string, repoPath?: ProjectFileTarget) => Promise<string>;
	unwatchRefs: (watchId: string) => Promise<void>;
	/** refs 变化推送订阅（返回值退订）；payload 为 watchId */
	onRefsChanged: (listener: (watchId: string) => void) => () => void;
	deleteFiles: (projectId: string, paths: ProjectFileTarget[], repoPath?: ProjectFileTarget) => Promise<void>;
	branches: (projectId: string, repoPath?: ProjectFileTarget) => Promise<GitBranchInfo>;
	checkout: (projectId: string, branch: string, repoPath?: ProjectFileTarget) => Promise<GitBranchInfo>;
	createBranch: (projectId: string, branchName: string, repoPath?: ProjectFileTarget) => Promise<GitBranchInfo>;
};

export type GitDrawerHostProps = {
	projectId: string;
	gitApi: GitDrawerApi;
	/** App 级项目根分支信息，单根仓库时继续复用，避免多打一轮 IPC。 */
	fallbackGitInfo: GitBranchInfo;
	fallbackSwitchBranch: (branch: string) => void;
	fallbackCreateBranch: (branchName: string) => void;
	onOpenCommitFileDiff: (commit: CommitEntry, file: GitChangedFile, repoTarget?: ProjectFileTarget) => void | Promise<void>;
	onOpenWorkspaceFileDiff: (group: GitResourceGroupType, target: ProjectFileTarget, repoTarget?: ProjectFileTarget) => void | Promise<void>;
	onOpenFile?: (target: ProjectFileTarget) => void;
};

const EMPTY_GIT_INFO: GitBranchInfo = { current: null, branches: [] };

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 为一个仓库固定全部 Git 调用的 cwd。
 * 同时挂载多个面板时不能从全局“当前仓库”读取路径，否则异步回调会误操作另一仓库。
 */
function createScopedGitApi(gitApi: GitDrawerApi, repoPath: ProjectFileTarget | undefined, refreshRepos: () => Promise<void>) {
	return {
		commitLog: (id: string, options?: { maxEntries?: number; ref?: string; path?: ProjectFileTarget; allBranches?: boolean }) => gitApi.commitLog(id, options, repoPath),
		// 与 commitLog 一样固定 cwd：多仓并排时不能从全局当前仓库读路径。
		commitCount: (id: string, options?: { ref?: string; path?: ProjectFileTarget; allBranches?: boolean }) => gitApi.commitCount(id, options, repoPath),
		commitDetail: (id: string, ref: string) => gitApi.commitDetail(id, ref, repoPath),
		branchCompare: (id: string, base: string, target: string) => gitApi.branchCompare(id, base, target, repoPath),
		getStatus: (id: string) => gitApi.status(id, repoPath),
		stageFiles: (id: string, paths: ProjectFileTarget[]) => gitApi.stage(id, paths, repoPath),
		unstageFiles: (id: string, paths: ProjectFileTarget[]) => gitApi.unstage(id, paths, repoPath),
		discardFile: (id: string, group: "workingTree" | "untracked", target: ProjectFileTarget) => gitApi.discard(id, group, target, repoPath),
		discardFiles: (id: string, resources: GitDiscardResource[]) => gitApi.discardFiles(id, resources, repoPath),
		commit: (id: string, message: string) => gitApi.commit(id, message, repoPath),
		cherryPick: (id: string, hash: string) => gitApi.cherryPick(id, hash, repoPath),
		revert: (id: string, hash: string) => gitApi.revert(id, hash, repoPath),
		reset: (id: string, hash: string, mode: "soft" | "mixed" | "hard") => gitApi.reset(id, hash, mode, repoPath),
		dropCommit: (id: string, hash: string) => gitApi.dropCommit(id, hash, repoPath),
		generateCommitMessage: (id: string) => gitApi.generateCommitMessage(id, repoPath),
		gitInit: async (id: string) => {
			await gitApi.init(id);
			await refreshRepos();
		},
		push: (id: string) => gitApi.push(id, repoPath),
		pull: (id: string) => gitApi.pull(id, repoPath),
		fetch: (id: string) => gitApi.fetch(id, repoPath),
		aheadBehind: (id: string) => gitApi.aheadBehind(id, repoPath),
		// refs 监听的 scope 同样固定在仓库路径上（多仓并排时各自监听自己的仓库）
		watchRefs: (id: string) => gitApi.watchRefs(id, repoPath),
		unwatchRefs: (watchId: string) => gitApi.unwatchRefs(watchId),
		onRefsChanged: gitApi.onRefsChanged,
		deleteFiles: (id: string, paths: ProjectFileTarget[]) => gitApi.deleteFiles(id, paths, repoPath),
	};
}

function repoLabel(repo: GitRepoInfo): string {
	// 根仓与嵌套仓统一用目录名，避免“根仓库”说明文案与子仓相对路径看起来像两种控件。
	return repo.name;
}

/**
 * Git 抽屉宿主：多仓时只堆叠各仓变更区；Graph / Compare 全局只挂一份，
 * 通过下拉切换仓库。单仓继续完整三栏；嵌套仓分支状态按路径隔离。
 */
export function GitDrawerHost(props: GitDrawerHostProps) {
	const { projectId, gitApi, fallbackGitInfo, fallbackSwitchBranch, fallbackCreateBranch, onOpenCommitFileDiff, onOpenWorkspaceFileDiff, onOpenFile } = props;
	const scope = useGitRepoScope({ projectId, listRepos: gitApi.listRepos });
	const [gitInfoByRepoPath, setGitInfoByRepoPath] = useState<Record<string, GitBranchInfo>>({});
	const singleRepo = scope.repos.length === 1 ? scope.repos[0] : undefined;
	const needsScopedBranchInfo = scope.hasMultipleRepos || singleRepo?.relativePath !== "";

	useEffect(() => {
		if (!needsScopedBranchInfo) {
			setGitInfoByRepoPath({});
			return;
		}
		let cancelled = false;
		void Promise.all(
			scope.repos.map(async (repo): Promise<readonly [string, GitBranchInfo]> => {
				try {
					return [repo.relativePath, await gitApi.branches(projectId, repo.target)];
				} catch {
					return [repo.relativePath, EMPTY_GIT_INFO];
				}
			}),
		).then((entries) => {
			if (!cancelled) setGitInfoByRepoPath(Object.fromEntries(entries));
		});
		return () => {
			cancelled = true;
		};
	}, [gitApi, needsScopedBranchInfo, projectId, scope.repos]);

	const updateGitInfo = useCallback((repoKey: string, next: GitBranchInfo) => {
		setGitInfoByRepoPath((current) => ({ ...current, [repoKey]: next }));
	}, []);

	const switchScopedBranch = useCallback(
		(repo: GitRepoInfo, branch: string) => {
			void gitApi
				.checkout(projectId, branch, repo.target)
				.then((next) => updateGitInfo(repo.relativePath, next))
				.catch((error: unknown) => {
					showNotice(t("app.branchSwitchFailed", { error: errorText(error) }), 4000, "error");
					void gitApi
						.branches(projectId, repo.target)
						.then((next) => updateGitInfo(repo.relativePath, next))
						.catch(() => undefined);
				});
		},
		[gitApi, projectId, updateGitInfo],
	);

	const createScopedBranch = useCallback(
		(repo: GitRepoInfo, branchName: string) => {
			void gitApi
				.createBranch(projectId, branchName, repo.target)
				.then((next) => {
					updateGitInfo(repo.relativePath, next);
					showNotice(t("app.branchCreated", { branch: branchName }), 2500);
				})
				.catch((error: unknown) => {
					showNotice(t("app.branchCreateFailed", { error: errorText(error) }), 4000, "error");
				});
		},
		[gitApi, projectId, updateGitInfo],
	);

	const [historyRepoPath, setHistoryRepoPath] = useState<string | undefined>(undefined);
	const historyRepoPathRef = useRef(historyRepoPath);
	historyRepoPathRef.current = historyRepoPath;

	useEffect(() => {
		if (!scope.hasMultipleRepos) {
			setHistoryRepoPath(undefined);
			return;
		}
		// Graph/Compare 全局只挂一份：记住上次选中的仓，仓库列表变化时落到仍存在的路径。
		let stored: string | null = null;
		try {
			stored = localStorage.getItem(`pideck:git-panel:${projectId}:history-repo`);
		} catch {
			stored = null;
		}
		const match = scope.repos.find((repo) => repo.relativePath === stored) ?? scope.repos.find((repo) => repo.relativePath === historyRepoPathRef.current) ?? scope.repos[0];
		setHistoryRepoPath(match?.relativePath);
	}, [projectId, scope.hasMultipleRepos, scope.repos]);

	const selectHistoryRepo = useCallback(
		(path: string) => {
			setHistoryRepoPath(path);
			try {
				localStorage.setItem(`pideck:git-panel:${projectId}:history-repo`, path);
			} catch {
				// 预览/无存储环境仍允许本次会话内切换。
			}
		},
		[projectId],
	);

	const renderPanel = (repo: GitRepoInfo | undefined, repositoryLabel?: string, layout: "full" | "changesOnly" | "historyOnly" = "full") => {
		const repoTarget = repo?.target;
		const repoKey = repo?.relativePath;
		const scopedApi = createScopedGitApi(gitApi, repoTarget, scope.refreshRepos);
		const useScopedBranches = Boolean(repo) && needsScopedBranchInfo;
		const gitInfo = repo && needsScopedBranchInfo ? (gitInfoByRepoPath[repo.relativePath] ?? EMPTY_GIT_INFO) : fallbackGitInfo;

		return (
			<GitPanel
				projectId={projectId}
				repoScopeKey={repoKey ?? ""}
				repositoryLabel={repositoryLabel}
				layout={layout}
				historyRepoPath={layout === "historyOnly" ? historyRepoPath : undefined}
				historyRepoOptions={layout === "historyOnly" ? scope.repos.map((item) => ({ value: item.relativePath, label: repoLabel(item) })) : undefined}
				onSelectHistoryRepo={layout === "historyOnly" ? selectHistoryRepo : undefined}
				commitLog={scopedApi.commitLog}
				commitCount={scopedApi.commitCount}
				commitDetail={scopedApi.commitDetail}
				onOpenCommitFileDiff={(commit, file) => onOpenCommitFileDiff(commit, file, repoTarget)}
				onOpenWorkspaceFileDiff={(group, target) => onOpenWorkspaceFileDiff(group, target, repoTarget)}
				onOpenFile={onOpenFile}
				branchCompare={scopedApi.branchCompare}
				getStatus={scopedApi.getStatus}
				stageFiles={scopedApi.stageFiles}
				unstageFiles={scopedApi.unstageFiles}
				discardFile={scopedApi.discardFile}
				discardFiles={scopedApi.discardFiles}
				commit={scopedApi.commit}
				branches={gitInfo.branches}
				currentBranch={gitInfo.current}
				onSwitchBranch={
					useScopedBranches
						? (branch) => {
								// repoPath exists whenever scoped branches are enabled; keep the guard for TS and stale renders.
								if (repo) switchScopedBranch(repo, branch);
							}
						: fallbackSwitchBranch
				}
				onCreateBranch={
					useScopedBranches
						? (branchName) => {
								// 同上：异步分支操作必须保留本仓库的路径快照。
								if (repo) createScopedBranch(repo, branchName);
							}
						: fallbackCreateBranch
				}
				cherryPick={scopedApi.cherryPick}
				revert={scopedApi.revert}
				reset={scopedApi.reset}
				dropCommit={scopedApi.dropCommit}
				generateCommitMessage={scopedApi.generateCommitMessage}
				gitInit={scopedApi.gitInit}
				push={scopedApi.push}
				pull={scopedApi.pull}
				fetch={scopedApi.fetch}
				aheadBehind={scopedApi.aheadBehind}
				watchRefs={scopedApi.watchRefs}
				unwatchRefs={scopedApi.unwatchRefs}
				onRefsChanged={scopedApi.onRefsChanged}
				deleteFiles={scopedApi.deleteFiles}
			/>
		);
	};

	if (scope.hasMultipleRepos) {
		const historyRepo = scope.repos.find((repo) => repo.relativePath === historyRepoPath) ?? scope.repos[0];
		return (
			<div className="git-panel flex h-full min-h-0 flex-col overflow-hidden">
				<div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
					{scope.repos.map((repo) => (
						<section key={repo.relativePath} className="shrink-0 border-b border-[var(--git-panel-border)] last:border-b-0">
							{renderPanel(repo, repoLabel(repo), "changesOnly")}
						</section>
					))}
				</div>
				{/* 不预留固定高度：折叠时只占两行标题，避免截图里大块空白。 */}
				<div className="shrink-0 overflow-hidden border-t border-[var(--git-panel-border)]">{historyRepo && renderPanel(historyRepo, undefined, "historyOnly")}</div>
			</div>
		);
	}

	return (
		<div className="git-panel flex h-full min-h-0 flex-col overflow-hidden">
			<div className="min-h-0 flex-1">{renderPanel(singleRepo)}</div>
		</div>
	);
}
