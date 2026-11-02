import type { RemoteProjectFactsChange } from "../../../shared/types/remoteHost";

/**
 * Git 面板对「事实失效通知」的取舍（纯判据，可单测）。
 *
 * 主进程只标脏、不装载：写成功/未知写/文件写之后发的是 `status` 范围（带项目相对 repoPath，"" = 项目根）。
 * 面板只认**自己这个仓库**的 status 失效；`dir`/`tree`/`repos` 不属于 Git 面板的事实面（目录由文件抽屉处理，
 * 仓库发现由选择器自己刷新）。
 *
 * 注意：空 generation 不是「换代码」信号——runtime 已经负责换代；同代事实事件 runtime 不重建 services，
 * 因此面板必须自己订阅才能收到 status 标脏（否则只剩轮询兜底）。
 */
export function shouldRefreshRemoteGitOnFactsChange(change: RemoteProjectFactsChange, projectId: string, repoPath: string): boolean {
	if (change.projectId !== projectId) return false;
	return change.scopes.some((scope) => scope.kind === "status" && scope.repoPath === repoPath);
}
