/**
 * 提交图谱写动词的 provider 实现（cherry-pick / revert / reset / drop）。
 *
 * 单独成模块的原因与远端写面对齐：`projectGitService.ts` 已在体量门禁基线上，而这四个动作在两个
 * provider 上都是「断言作用域 → 调通道 → 折稳定码」的同一种形状，放在一起才不会两头各写一遍。
 *
 * 本机走既有的 `git:cherry-pick` / `git:revert` / `git:reset` / `git:drop-commit` 通道（与面板一直用的
 * 完全同一批）；远端走新的令牌通道，每个动作一枚令牌，且令牌按 (窗口, 项目, 动作, 仓库) 绑定。
 */
import type { ProjectFileTarget } from "../../../shared/types";
import type { ProjectGitService, ProjectServiceFence, ProjectServicesApi } from "./projectServiceContracts";
import { ProjectServiceError, assertProjectServiceCurrent } from "./projectServiceContracts";
import { assertRepoScope } from "./projectServiceFence";

type HistoryFace = Pick<ProjectGitService, "cherryPick" | "revert" | "reset" | "dropCommit">;

/** 本机：四个动词就是四个既有 IPC，语义由本机 Git 进程决定。 */
export function createLocalGitHistoryMethods({ api, projectId, fence }: { api: ProjectServicesApi; projectId: string; fence: ProjectServiceFence }): HistoryFace {
	const scope = (repoPath: ProjectFileTarget | undefined): void => {
		assertProjectServiceCurrent(fence);
		assertRepoScope(projectId, repoPath);
	};
	return {
		async cherryPick(hash, repoPath) {
			scope(repoPath);
			await api.git.cherryPick(projectId, hash, repoPath);
		},
		async revert(hash, repoPath) {
			scope(repoPath);
			await api.git.revert(projectId, hash, repoPath);
		},
		async reset(hash, mode, repoPath) {
			scope(repoPath);
			await api.git.reset(projectId, hash, mode, repoPath);
		},
		async dropCommit(hash, repoPath) {
			scope(repoPath);
			await api.git.dropCommit(projectId, hash, repoPath);
		},
	};
}

/** 远端：每个动作现取自己那枚令牌；写一旦发出，桶即作废，下一次写重新确认。 */
export function createRemoteGitHistoryMethods({
	api,
	projectId,
	scopeOf,
	remoteFailure,
	withGrant,
}: {
	api: ProjectServicesApi;
	projectId: string;
	scopeOf(repoPath?: ProjectFileTarget): string | undefined;
	remoteFailure(code: string, detail: string, message?: string): ProjectServiceError;
	withGrant<T>(repoPath: ProjectFileTarget | undefined, key: string, action: string, task: (token: string) => Promise<T>): Promise<T>;
}): HistoryFace {
	const run = async (repoPath: ProjectFileTarget | undefined, key: string, action: string, task: (token: string) => Promise<{ ok: true } | { ok: false; code: string; message?: string }>): Promise<void> => {
		assertRepoScope(projectId, repoPath);
		await withGrant(repoPath, key, action, async (token) => {
			const result = await task(token);
			if (!result.ok) throw remoteFailure(result.code, `remote git ${action} failed`, result.message);
		});
	};
	return {
		cherryPick: (hash, repoPath) => run(repoPath, "cherryPickToken", "cherry-pick", (token) => api.git.cherryPickRemote(projectId, hash, token, scopeOf(repoPath))),
		revert: (hash, repoPath) => run(repoPath, "revertToken", "revert", (token) => api.git.revertRemote(projectId, hash, token, scopeOf(repoPath))),
		reset: (hash, mode, repoPath) => run(repoPath, "resetToken", "reset", (token) => api.git.resetRemote(projectId, hash, mode, token, scopeOf(repoPath))),
		dropCommit: (hash, repoPath) => run(repoPath, "dropCommitToken", "drop commit", (token) => api.git.dropCommitRemote(projectId, hash, token, scopeOf(repoPath))),
	};
}
