import { ipcChannels } from "../../shared/ipc";
import type { GitService } from "../git/GitService";
import { withRefLockRetry, withRepoRefLock } from "../git/gitRefQueue";
import type { AppLogger } from "../logging/AppLogger";
import type { createProjectGitHandler } from "./gitProjectHandlers";

/**
 * push / pull / fetch 的 IPC 注册（从 gitIpc 拆出：本组三个操作都要按仓库串行，见下）。
 *
 * 现场（#603）：Git 面板的自动 fetch（非静默刷新成功后、每 5 分钟一次）与用户点的「拉取」
 * 可以同时跑，两个 git 进程都要更新 `refs/remotes/origin/<branch>`，后加锁的那个直接失败：
 * `error: cannot lock ref …`，`git pull` 在合并之前就退出，HEAD 不动——表现为「时好时坏，
 * 隔几秒再点一次就好」。按 cwd 串行化即可消掉面板自己制造的那一半竞态；外部 git 抢先时
 * 由 `withRefLockRetry` 重跑一次兜底（规则见 gitRefQueue）。
 */
export function registerGitSyncIpc({
	handleProjectGit,
	requireGitCwd,
	gitService,
	appLogger,
}: {
	handleProjectGit: ReturnType<typeof createProjectGitHandler>;
	requireGitCwd: (projectId: string, repoPath?: unknown) => Promise<string>;
	gitService: Pick<GitService, "push" | "pull" | "fetch" | "isGitRepo">;
	appLogger: Pick<AppLogger, "warn" | "info">;
}): void {
	handleProjectGit(ipcChannels.gitPush, async (_event, projectId: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		await withRepoRefLock(cwd, () => gitService.push(cwd));
		void appLogger.info("git", "Pushed", { projectId, repoPath: cwd });
	});

	handleProjectGit(ipcChannels.gitPull, async (_event, projectId: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		try {
			await withRepoRefLock(cwd, () => withRefLockRetry(() => gitService.pull(cwd)));
			void appLogger.info("git", "Pulled", { projectId, repoPath: cwd });
		} catch (error) {
			// 失败也留痕：面板只弹 8 秒通知，事后无法回查（git 的 stderr 才是根因所在）。
			void appLogger.warn("git", "Pull failed", { projectId, repoPath: cwd, error: error instanceof Error ? error.message : String(error) });
			throw error;
		}
	});

	// Fetch：刷新远程跟踪引用（定时轮询 ahead/behind 的前置步骤）。
	// 非仓库直接跳过：面板首次挂载时 status 与 fetch 会并行，不能等 UI 标记。
	handleProjectGit(ipcChannels.gitFetch, async (_event, projectId: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		if (!(await gitService.isGitRepo(cwd))) return;
		await withRepoRefLock(cwd, () => gitService.fetch(cwd));
	});
}
