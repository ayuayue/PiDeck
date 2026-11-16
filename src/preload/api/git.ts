/**
 * preload git 域：Git：本地读面 + 远端事实/写面（授权令牌绑定在 main）。
 *
 * 组装口 `src/preload/index.ts` 只做 spread；方法体 / 参数名 / 通道引用与拆分前逐字一致。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { BranchDiffResult, CommitDetail, CommitEntry, GitBranchInfo, GitCommitFileDiff, GitDiscardResource, GitRef, GitRepoInfo, GitWorkspaceDiffGroup, GitWorkspaceFileDiff, ProjectFileTarget, WorktreeEntry } from "../../shared/types";
import type { GitExecutableInfo } from "../../shared/types/git";

export const gitApi = {
	git: {
		/** 扫描项目内独立仓库；单仓项目通常只返回根仓库 */
		listRepos: (projectId: string) => ipcRenderer.invoke(ipcChannels.gitListRepos, projectId) as Promise<GitRepoInfo[]>,
		/** 公共仓库列表（T7）：带 truncated 与 revision/generation；旧 listRepos 保留一版兼容。 */
		repositoryList: (projectId: string) => ipcRenderer.invoke(ipcChannels.gitRepositoryList, projectId) as Promise<import("../../shared/types").GitRepositoryListResult>,
		branches: (projectId: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitBranches, projectId, repoPath) as Promise<GitBranchInfo>,
		checkout: (projectId: string, branch: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitCheckout, projectId, branch, repoPath) as Promise<GitBranchInfo>,
		createBranch: (projectId: string, branchName: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitCreateBranch, projectId, branchName, repoPath) as Promise<GitBranchInfo>,
		// 读取文件的 Git HEAD 原始内容，供差异编辑器左侧基准列使用。
		originalContent: (fileTarget: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitOriginalContent, fileTarget) as Promise<string>,
		// 列出项目的 git worktree（排除主工作区）
		worktreeList: (projectId: string) => ipcRenderer.invoke(ipcChannels.gitWorktreeList, projectId) as Promise<WorktreeEntry[]>,
		// 创建新的 worktree
		worktreeCreate: (projectId: string, branchName: string) => ipcRenderer.invoke(ipcChannels.gitWorktreeCreate, projectId, branchName) as Promise<WorktreeEntry>,
		// 删除 worktree
		worktreeRemove: (projectId: string, worktreeTarget: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitWorktreeRemove, projectId, worktreeTarget) as Promise<boolean>,
		// Git 增强：提交历史、分支对比、Graph
		commitLog: (projectId: string, options?: { maxEntries?: number; ref?: string; path?: ProjectFileTarget; allBranches?: boolean }, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitCommitLog, projectId, options, repoPath) as Promise<CommitEntry[]>,
		// 与当前图谱过滤一致的提交总数（不分页），供源代码管理图标题徽章使用。
		commitCount: (projectId: string, options?: { ref?: string; path?: ProjectFileTarget; allBranches?: boolean }, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitCommitCount, projectId, options, repoPath) as Promise<number>,
		// Git 引用（分支 / 远程分支 / Tag）
		refs: (projectId: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitRefs, projectId, repoPath) as Promise<GitRef[]>,
		// 分支对比概要（变更文件 + ahead/behind）
		branchCompare: (projectId: string, base: string, target: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitBranchCompare, projectId, base, target, repoPath) as Promise<BranchDiffResult>,
		/** 公共历史页（T7）：显式分页；远端 HEAD-only 时没有 totalCount。 */
		historyPage: (projectId: string, options?: { maxCount?: number; skip?: number; ref?: string; path?: ProjectFileTarget; allBranches?: boolean }, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitHistoryPage, projectId, options, repoPath) as Promise<import("../../shared/types").GitHistoryPageResult>,
		/** 公共比较（T7）：mode 显式；三点模式才有 ahead/behind。 */
		compareRefs: (projectId: string, base: string, head: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitCompareRefs, projectId, base, head, repoPath) as Promise<import("../../shared/types").GitCompareRefsResult>,
		// 单个 commit 详情
		commitDetail: (projectId: string, ref: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitCommitDetail, projectId, ref, repoPath) as Promise<CommitDetail | null>,
		// 提交历史中单个文件相对第一父提交的两侧内容
		commitFileDiff: (projectId: string, ref: string, fileTarget: ProjectFileTarget, originalTarget?: ProjectFileTarget, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitCommitFileDiff, projectId, ref, fileTarget, originalTarget, repoPath) as Promise<GitCommitFileDiff | null>,
		// 两个 ref 间单个文件的 diff
		diffFileBetween: (projectId: string, ref1: string, ref2: string, fileTarget: ProjectFileTarget, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitDiffFileBetween, projectId, ref1, ref2, fileTarget, repoPath) as Promise<string>,
		// Git 工作区状态（VS Code 风格分组：Staged/Unstaged/Untracked/Merge）
		cancelRemoteReads: (projectId: string) => ipcRenderer.invoke(ipcChannels.gitRemoteCancelReads, projectId) as Promise<void>,
		mutateRemoteIndex: (projectId: string, operation: "stage" | "unstage", group: import("../../shared/types").GitResourceGroupType, target: ProjectFileTarget, token: string, repo?: string) =>
			ipcRenderer.invoke(ipcChannels.gitRemoteMutateIndex, projectId, operation, group, target, token, repo) as Promise<import("../../shared/types").GitIndexMutationResult>,
		// 只提交已确认的暂存区；消息逐字发送，不在渲染层做任何 Git 语义加工
		commitRemote: (projectId: string, message: string, token: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemoteCommit, projectId, message, token, repo) as Promise<import("../../shared/types").GitCommitResult>,
		// G5d/G5e：读通道与写通道尾部都可带项目相对 repo scope（空/缺省 = 项目根）；写通道的 scope 由 main 的令牌绑定。
		remoteSnapshot: (projectId: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemoteSnapshot, projectId, repo) as Promise<import("../../shared/types").GitReadSnapshotResult>,
		// 显式刷新（同一通道的 force 位）：越过已完成事实缓存；普通读仍可共享缓存。
		refreshRemoteSnapshot: (projectId: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemoteSnapshot, projectId, repo, true) as Promise<import("../../shared/types").GitReadSnapshotResult>,
		/**
		 * 纯事实强刷（facts-only force）：越过事实缓存重读，但**不撤销、不签发**任何授权令牌。
		 * provider 用它实现零授权副作用的 refresh；旧装配 / Web / 预览模式没有该方法时回落 refreshRemoteSnapshot。
		 */
		refreshRemoteGitFacts: (projectId: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemoteSnapshot, projectId, repo, true, "facts") as Promise<import("../../shared/types").GitReadSnapshotResult>,
		// G5d：项目根下的有界仓库发现（无 token、纯读）
		// 分支写面（G3b）：新建分支不移动 HEAD，切换走原生 switch 且冲突即拒（绝不 force）
		createRemoteBranch: (projectId: string, name: string, token: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemoteCreateBranch, projectId, name, token, repo) as Promise<import("../../shared/types").RemoteGitBranchMutationResult>,
		switchRemoteBranch: (projectId: string, name: string, token: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemoteSwitchBranch, projectId, name, token, repo) as Promise<import("../../shared/types").RemoteGitBranchMutationResult>,
		// 可恢复丢弃（G4a）：先写恢复快照再动文件；返回可恢复 ref，main 注入指纹
		discardRemote: (projectId: string, group: "workingTree" | "untracked", target: ProjectFileTarget, token: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemoteDiscard, projectId, group, target, token, repo) as Promise<import("../../shared/types").RemoteGitDiscardResult>,
		// 同步（G5a）：facts 只读；fetch/push/pull 各自需要 grant，从不 force、不写配置、不注入凭据
		syncFacts: (projectId: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemoteSyncFacts, projectId, repo) as Promise<import("../../shared/types").RemoteGitSyncFactsResult>,
		fetchRemote: (projectId: string, remote: string, token: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemoteFetch, projectId, remote, token, repo) as Promise<import("../../shared/types").RemoteGitFetchOutcomeResult>,
		pushRemote: (projectId: string, remote: string, branch: string, token: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemotePush, projectId, remote, branch, token, repo) as Promise<import("../../shared/types").RemoteGitPushOutcomeResult>,
		pullRemote: (projectId: string, remote: string, branch: string, token: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemotePull, projectId, remote, branch, token, repo) as Promise<import("../../shared/types").RemoteGitPullOutcomeResult>,
		// 恢复存储（G4b）：列表只读；还原/删除各需自己的 grant，ref 只允许 refs/pideck/recovery/*
		recoveryList: (projectId: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemoteRecoveryList, projectId, repo) as Promise<import("../../shared/types").RemoteGitRecoveryListResult>,
		recoveryRestore: (projectId: string, ref: string, oid: string, path: string, token: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemoteRecoveryRestore, projectId, ref, oid, path, token, repo) as Promise<import("../../shared/types").RemoteGitRecoveryRestoreResult>,
		recoveryDrop: (projectId: string, ref: string, oid: string, token: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemoteRecoveryDrop, projectId, ref, oid, token, repo) as Promise<import("../../shared/types").RemoteGitRecoveryDropResult>,
		// 只读历史（G3a）：分页日志／提交详情／本地引用／两版本间单文件；与 status 同一信任边界，无 token
		remoteCommitDetail: (projectId: string, oid: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemoteCommitDetail, projectId, oid, repo) as Promise<import("../../shared/types").RemoteGitCommitDetailResult>,
		remoteRefs: (projectId: string, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemoteRefs, projectId, repo) as Promise<import("../../shared/types").RemoteGitRefsResult>,
		remoteRefFileDiff: (projectId: string, base: string | null, head: string, target: ProjectFileTarget, repo?: string) => ipcRenderer.invoke(ipcChannels.gitRemoteRefFileDiff, projectId, base, head, target, repo) as Promise<import("../../shared/types").RemoteGitRefFileDiffResult>,
		// G5b：两个全名本地引用之间的只读树对比（无 token）；逐文件两侧内容仍走 remoteRefFileDiff
		// G5c：显式初始化项目根仓库（无 token；属于写操作，结果未知时不重放）
		initRemote: (projectId: string) => ipcRenderer.invoke(ipcChannels.gitRemoteInit, projectId) as Promise<import("../../shared/types").RemoteGitInitResult>,
		status: (projectId: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitStatus, projectId, repoPath) as Promise<import("../../shared/types").GitResourceGroups>,
		// Git Changes 中单个文件的两侧快照（按点击惰性读取）
		workspaceFileDiff: (projectId: string, group: GitWorkspaceDiffGroup, fileTarget: ProjectFileTarget, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitWorkspaceFileDiff, projectId, group, fileTarget, repoPath) as Promise<GitWorkspaceFileDiff | null>,
		// Stage 文件
		stage: (projectId: string, targets: ProjectFileTarget[], repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitStage, projectId, targets, repoPath) as Promise<void>,
		// Unstage 文件
		unstage: (projectId: string, targets: ProjectFileTarget[], repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitUnstage, projectId, targets, repoPath) as Promise<void>,
		// 丢弃单个未暂存文件；主进程会按最新 status 再次验证 group 与路径。
		discard: (projectId: string, group: "workingTree" | "untracked", fileTarget: ProjectFileTarget, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitDiscard, projectId, group, fileTarget, repoPath) as Promise<void>,
		// 按目录批量回滚：资源组随路径传入，主进程会重新校验最新状态。
		discardFiles: (projectId: string, resources: GitDiscardResource[], repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitDiscardFiles, projectId, resources, repoPath) as Promise<void>,
		// Commit
		commit: (projectId: string, message: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitCommit, projectId, message, repoPath) as Promise<void>,
		cherryPick: (projectId: string, hash: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitCherryPick, projectId, hash, repoPath) as Promise<void>,
		revert: (projectId: string, hash: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitRevert, projectId, hash, repoPath) as Promise<void>,
		reset: (projectId: string, hash: string, mode: "soft" | "mixed" | "hard", repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitReset, projectId, hash, mode, repoPath) as Promise<void>,
		dropCommit: (projectId: string, hash: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitDropCommit, projectId, hash, repoPath) as Promise<void>,
		/** AI 生成提交摘要 */
		generateCommitMessage: (projectId: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitGenerateCommitMessage, projectId, repoPath) as Promise<import("../../shared/types").GitGenerateCommitMessageResult>,
		/** 初始化 Git 仓库（始终作用于项目根，不跟随嵌套仓库切换） */
		init: (projectId: string) => ipcRenderer.invoke(ipcChannels.gitInit, projectId) as Promise<void>,
		/** Push：将当前分支推送到远程 */
		push: (projectId: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitPush, projectId, repoPath) as Promise<void>,
		/** Pull：从远程拉取并合并到当前分支 */
		pull: (projectId: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitPull, projectId, repoPath) as Promise<void>,
		/** Fetch：从远程获取最新数据但不合并 */
		fetch: (projectId: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitFetch, projectId, repoPath) as Promise<void>,
		/** 当前分支相对上游的提交差距（ahead/behind），驱动 push/pull 角标 */
		aheadBehind: (projectId: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitAheadBehind, projectId, repoPath) as Promise<import("../../shared/types").GitAheadBehind | null>,
		/**
		 * 订阅仓库 refs 变化（commit/push/fetch/切分支），返回 watchId。
		 * 与 unwatchRefs 成对使用：组件卸载时必须退订，否则监听句柄会留到应用退出。
		 */
		watchRefs: (projectId: string, repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitWatchRefs, projectId, repoPath) as Promise<string>,
		/** 退订 refs 监听；未知 watchId 由主进程静默忽略（重复退订安全） */
		unwatchRefs: (watchId: string) => ipcRenderer.invoke(ipcChannels.gitUnwatchRefs, watchId) as Promise<void>,
		/** refs 变化推送：payload 为 watchId，调用方只处理自己订阅的那一份。返回退订函数。 */
		onRefsChanged: (listener: (watchId: string) => void) => {
			const handler = (_event: unknown, watchId: string) => listener(watchId);
			ipcRenderer.on(ipcChannels.gitRefsChanged, handler);
			return () => {
				ipcRenderer.removeListener(ipcChannels.gitRefsChanged, handler);
			};
		},
		/** 从磁盘删除变更文件（移入回收站，可恢复） */
		deleteFiles: (projectId: string, targets: ProjectFileTarget[], repoPath?: ProjectFileTarget) => ipcRenderer.invoke(ipcChannels.gitDeleteFiles, projectId, targets, repoPath) as Promise<void>,
		/**
		 * 探测 git 可执行文件。传 configuredPath 可在保存前预览「这样配置能不能用」；
		 * 不传则用设置里已持久化的值，返回当前实际生效的路径与版本。
		 */
		detectExecutable: (configuredPath?: string) => ipcRenderer.invoke(ipcChannels.gitDetectExecutable, configuredPath) as Promise<GitExecutableInfo>,
		/** 打开文件选择框挑一个 git 可执行文件；取消返回 null */
		chooseExecutable: () => ipcRenderer.invoke(ipcChannels.gitChooseExecutable) as Promise<string | null>,
	},
};
