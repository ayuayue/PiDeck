import type { PiDesktopApi } from "../../../preload";

/**
 * Git 面板桩：只回放夹具文件树，远端事实与流操作保持禁用。
 */
export function createGitPreview(): Pick<PiDesktopApi, "git"> {
	return {
		git: {
			cancelRemoteReads: async () => {},
			remoteSnapshot: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			refreshRemoteSnapshot: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			repositoryList: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			historyPage: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			compareRefs: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const }),
			createRemoteBranch: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			switchRemoteBranch: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			discardRemote: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			recoveryList: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			recoveryRestore: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			recoveryDrop: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			syncFacts: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			fetchRemote: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			pushRemote: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			pullRemote: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			remoteCommitDetail: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			remoteRefs: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			remoteRefFileDiff: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			initRemote: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			mutateRemoteIndex: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			commitRemote: async () => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }),
			listRepos: async () => [],
			branches: async () => ({ current: "main", branches: ["main", "dev"] }),
			checkout: async (_projectId, branch) => ({
				current: branch,
				branches: ["main", "dev"],
			}),
			createBranch: async (_projectId, branchName) => ({
				current: branchName,
				branches: ["main", "dev", branchName],
			}),
			// 预览环境无真实 Git，返回空原始内容，差异左侧显示为空。
			originalContent: async () => "",
			worktreeList: async () => [],
			worktreeCreate: async (_projectId, branchName) => ({
				target: { projectId: `preview-worktree-${branchName}`, relativePath: "" },
				displayPath: `/tmp/worktree/${branchName}`,
				branch: branchName,
			}),
			worktreeRemove: async () => true,
			commitLog: async () => [],
			commitCount: async () => 0,
			refs: async () => [],
			branchCompare: async () => ({ files: [], ahead: 0, behind: 0 }),
			commitDetail: async () => null,
			commitFileDiff: async () => null,
			diffFileBetween: async () => "",
			status: async () => ({ merge: [], index: [], workingTree: [], untracked: [] }),
			workspaceFileDiff: async () => null,
			stage: async () => {},
			unstage: async () => {},
			discard: async () => {},
			discardFiles: async () => {},
			commit: async () => {},
			cherryPick: async () => {},
			revert: async () => {},
			reset: async () => {},
			dropCommit: async () => {},
			generateCommitMessage: async () => ({ ok: true, message: "" }),
			init: async () => {},
			pull: async () => {},
			push: async () => {},
			fetch: async () => undefined,
			// 预览环境无真实远程：恒返回 null（不显示 push/pull 角标）
			aheadBehind: async () => null,
			// 预览环境无主进程监听：恒返回空 watchId，onRefsChanged 是空订阅（不推送）
			watchRefs: async () => "",
			unwatchRefs: async () => {},
			onRefsChanged: () => () => {},
			deleteFiles: async () => {},
			// 预览环境无真实子进程：恒报告「PATH 中的 git 可用」
			detectExecutable: async () => ({
				source: "path",
				executable: "git",
				resolvedPath: "/usr/bin/git",
				version: "2.53.0",
				error: null,
				system: { resolvedPath: "/usr/bin/git", version: "2.53.0", source: "path" },
			}),
			// 预览环境无文件对话框：恒取消
			chooseExecutable: async () => null,
		},
	};
}
