/**
 * 远端 provider 的「面板专属」扩展动作（本批新增）：暂存 diff、AI 摘要、refs 订阅、删除。
 *
 * 从 `projectGitService.ts` 拆出（文件体量门禁：存量巨文件只准降不准升）。这里不实现任何 Git 语义：
 * 每个方法只做「作用域断言 → 调 main 的远端通道 → 把稳定码折成 ProjectServiceError」，
 * 与本机 provider 共用同一层错误词汇。
 */
import type { GitAheadBehind, ProjectFileTarget } from "../../../shared/types";
import type { ProjectGitService, ProjectGitSyncFacts, ProjectServiceFence, ProjectServicesApi } from "./projectServiceContracts";
import { PROJECT_SERVICE_CODES, ProjectServiceError, assertProjectServiceCurrent, unwrapOp } from "./projectServiceContracts";
import { assertProjectTarget, assertProjectTargets, assertRepoScope } from "./projectServiceFence";

export type RemoteProjectGitExtrasPorts = {
	api: ProjectServicesApi;
	projectId: string;
	fence: ProjectServiceFence;
	/** 远端通道的仓库 scope（POSIX 相对路径）。 */
	scopeOf(repoPath?: ProjectFileTarget): string | undefined;
	/** 稳定码 → ProjectServiceError（与 provider 其它写面同一份实现）。 */
	remoteFailure(code: string, detail: string, message?: string): ProjectServiceError;
};

export function createRemoteProjectGitExtras({ api, projectId, fence, scopeOf, remoteFailure }: RemoteProjectGitExtrasPorts): Pick<ProjectGitService, "stagedDiff" | "generateCommitMessage" | "watchRefs" | "unwatchRefs" | "deleteFiles" | "commitDetail" | "refFileDiff"> {
	return {
		/**
		 * 远端「删除变更文件」归文件服务回收站（`.pideck-trash`），不是 git discard：
		 * 逐目标删除并让每个目标各自带回 trashId；一个失败即抛出，不回滚已删除的那些。
		 */
		async deleteFiles(targets, repoPath): Promise<void> {
			assertProjectTargets(projectId, targets);
			assertRepoScope(projectId, repoPath);
			for (const target of targets) unwrapOp(await api.files.delete(target), PROJECT_SERVICE_CODES.failed);
		},
		/** 单个提交的完整消息与变更文件；失败抛稳定码，不返回伪造的空详情。 */
		async commitDetail(oid, repoPath) {
			// 旧代的读必须在触达通道前就被拒：fenced 只能在调用后判定迟到结果。
			assertProjectServiceCurrent(fence);
			assertRepoScope(projectId, repoPath);
			const result = await api.git.remoteCommitDetail(projectId, oid, scopeOf(repoPath));
			if (!result.ok) throw remoteFailure(result.code, "remote git commit detail refused", result.message);
			return result.detail;
		},
		/** 两个 revision 的单文件两侧内容；`base: null` 表示该侧不存在。 */
		async refFileDiff(base, head, target, repoPath) {
			assertProjectServiceCurrent(fence);
			assertProjectTarget(projectId, target);
			assertRepoScope(projectId, repoPath);
			const result = await api.git.remoteRefFileDiff(projectId, base, head, target, scopeOf(repoPath));
			if (!result.ok) throw remoteFailure(result.code, "remote git ref file diff refused", result.message);
			return result.diff;
		},
		/** AI 摘要：暂存 diff 由 helper 读，模型仍在本机生成（与本机面板同一个入口）。 */
		async generateCommitMessage(stagedDiff, repoPath) {
			assertRepoScope(projectId, repoPath);
			// repo target 只用于日志/上下文：远端生成不读本地仓库（diff 已在第三个参数里）。
			return api.git.generateCommitMessage(projectId, repoPath, stagedDiff);
		},
		/** 暂存区 diff：helper 读；失败抛稳定码，绝不当成“空暂存区”。 */
		async stagedDiff(repoPath): Promise<string> {
			assertRepoScope(projectId, repoPath);
			const result = await api.git.remoteStagedDiff(projectId, scopeOf(repoPath));
			if (!result.ok) throw remoteFailure(result.code, "remote staged diff refused", result.message);
			return result.value.diff;
		},
		/** 远端 refs 订阅：main 为这个仓库订阅 `.git` 目录族（helper fs.watch），只标脏、不装载。 */
		async watchRefs(repoPath): Promise<string> {
			assertRepoScope(projectId, repoPath);
			const result = await api.git.remoteWatchRefs(projectId, scopeOf(repoPath));
			if (!result.ok) throw remoteFailure(result.code, "remote git refs watch refused", result.message);
			return result.watchId;
		},
		async unwatchRefs(watchId): Promise<void> {
			assertProjectServiceCurrent(fence);
			// 退订是幂等的：面板卸载/切仓库时重复调用不能变成错误。
			await api.git.remoteUnwatchRefs(watchId).catch(() => undefined);
		},
	};
}

/**
 * push/pull 的目标：恰好一个 remote 且有具名分支时显式命名（最可审计）；
 * 多 remote 或 detached HEAD 时传 null/null，交给 git 自己的 upstream / push.default 规则——
 * 与本机 `git push` / `git pull` 完全一致，不再替用户拒绝。
 */
export function remoteSyncTarget(facts: ProjectGitSyncFacts): { remote: string | null; branch: string | null } {
	if (facts.remotes.length === 0) throw new ProjectServiceError("GIT_SYNC_REMOTE_UNKNOWN", "rejected", "remote git has no configured remote");
	const explicit = facts.remotes.length === 1 && facts.branch !== null && facts.branch.length > 0;
	return explicit ? { remote: facts.remotes[0], branch: facts.branch } : { remote: null, branch: null };
}
