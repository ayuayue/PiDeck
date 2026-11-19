/**
 * Git 面板相关的 IPC 通道（远端 Git 全部 + 本机可还原丢弃）。
 *
 * 从 `src/shared/ipc.ts` 拆出（文件体量门禁：存量巨文件只准降不准升）。这里只声明名字与线上值，
 * 不做任何路由；`ipcChannels` 用一次展开接入，所以 `ipcChannels.gitRemoteSnapshot` 这类既有访问
 * 完全不变。`scripts/check-ipc-wiring.mjs` 会把本模块一起解析，主进程/preload 的覆盖检查不缩水。
 */
export const gitPanelChannels = {
	/** SSH root repository facts plus SCM groups; writes/history/sync remain capability-blocked. */
	gitRemoteSnapshot: "git:remote-snapshot",
	gitRemoteMutateIndex: "git:remote-mutate-index",
	gitRemoteCommit: "git:remote-commit",
	gitRemoteCommitDetail: "git:remote-commit-detail",
	gitRemoteRefs: "git:remote-refs",
	gitRemoteRefFileDiff: "git:remote-ref-file-diff",
	/** Explicit init at the project root; no token because there is no confirmed repository state to bind. */
	gitRemoteInit: "git:remote-init",
	gitRemoteCreateBranch: "git:remote-create-branch",
	gitRemoteSwitchBranch: "git:remote-switch-branch",
	gitRemoteDiscard: "git:remote-discard",
	/** 提交图谱写动词：每个都要自己那枚令牌（helper 未声明能力时不签发，入口自然缺席）。 */
	gitRemoteCherryPick: "git:remote-cherry-pick",
	gitRemoteRevert: "git:remote-revert",
	gitRemoteReset: "git:remote-reset",
	gitRemoteDropCommit: "git:remote-drop-commit",
	gitRemoteRecoveryList: "git:remote-recovery-list",
	gitRemoteRecoveryRestore: "git:remote-recovery-restore",
	gitRemoteRecoveryDrop: "git:remote-recovery-drop",
	gitRemoteSyncFacts: "git:remote-sync-facts",
	gitRemoteFetch: "git:remote-fetch",
	gitRemotePush: "git:remote-push",
	gitRemotePull: "git:remote-pull",
	gitRemoteCancelReads: "git:remote-cancel-reads",
	/** 暂存区 unified diff 全文（只读）：远端的 AI 摘要用它代替本机 `git diff --staged`。 */
	gitRemoteStagedDiff: "git:remote-staged-diff",
	/**
	 * 远端 refs 变化订阅（只读、只标脏）：主进程为这个仓库订阅 `.git` 目录族的 helper `fs.watch`，
	 * 事件到达时经 `remote:project-facts-changed` 推送 `{ kind: "status", repoPath }`。
	 * 与 `gitRemoteUnwatchRefs` 成对；退订幂等。
	 */
	gitRemoteWatchRefs: "git:remote-watch-refs",
	gitRemoteUnwatchRefs: "git:remote-unwatch-refs",
	/** 本机可还原丢弃：list / restore / drop 三个动作读写仓库内 `refs/pideck/recovery/*`。 */
	gitRecoveryList: "git:recovery-list",
	gitRecoveryRestore: "git:recovery-restore",
	gitRecoveryDrop: "git:recovery-drop",
} as const;
