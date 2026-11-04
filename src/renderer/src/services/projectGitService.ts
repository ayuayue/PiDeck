import { PROJECT_SERVICE_CODES, ProjectServiceError, unwrapOp, type ProjectFileTarget, type ProjectGitBranchMode, type ProjectGitDiscardReceipt, type ProjectGitRecoveryEntry, type ProjectGitRecoveryListing, type ProjectGitService, type ProjectGitSyncFacts, type ProjectServicesApi } from "./projectServiceContracts";
import type { ProjectServiceFence } from "./projectServiceContracts";
import { assertProjectTarget, assertProjectTargets, assertRepoScope, fenceProjectGitService } from "./projectServiceFence";
import type { GitAheadBehind, GitBranchInfo, GitCompareRefsValue, GitDiscardResource, GitHistoryPage, GitRef, GitRepositoryListing, GitResourceGroups, GitWorkspaceFileDiff, WorktreeEntry } from "../../../shared/types/git";

const GIT_UNSUPPORTED = {
	remoteWrite: "remote git writes still need the main-owned token broker",
	remoteForceRefresh: "remote git has no pure-fact force refresh yet; the authorization snapshot must not be used as one",
	remoteSyncFacts: "remote git sync facts are not wired through the service yet",
	localSyncFacts: "local git sync facts are not wired through the service yet",
	localCreateBranch: "local git:createBranch only supports create-and-checkout",
	localRecovery: "local git has no recovery store",
	remoteRecovery: "remote git recovery is not wired through the service yet",
	remoteBranches: "remote branch listing is not wired through the service yet",
	remoteAheadBehind: "remote ahead/behind is read through sync facts",
	remoteDeleteFiles: "remote file deletion belongs to the file service trash path",
	remoteWorktree: "remote git worktree is local-only",
} as const;

function unsupported(detail: string): ProjectServiceError {
	return new ProjectServiceError(PROJECT_SERVICE_CODES.unsupported, "rejected", detail);
}

/** 本地 read face 与远端 read face 共用公共通道；差异只在 provider 是否实现该方法。 */
function createReadFace(projectId: string, api: ProjectServicesApi): Pick<ProjectGitService, "status" | "history" | "repos" | "refs" | "compare" | "workspaceDiff"> {
	return {
		status(repoPath) {
			assertRepoScope(projectId, repoPath);
			return api.git.status(projectId, repoPath);
		},
		async history(options, repoPath): Promise<GitHistoryPage> {
			assertRepoScope(projectId, repoPath);
			return unwrapOp(await api.git.historyPage(projectId, options, repoPath), PROJECT_SERVICE_CODES.failed);
		},
		async repos(): Promise<GitRepositoryListing> {
			return unwrapOp(await api.git.repositoryList(projectId), PROJECT_SERVICE_CODES.failed);
		},
		refs(repoPath) {
			assertRepoScope(projectId, repoPath);
			return api.git.refs(projectId, repoPath);
		},
		async compare(base, head, repoPath): Promise<GitCompareRefsValue> {
			assertRepoScope(projectId, repoPath);
			return unwrapOp(await api.git.compareRefs(projectId, base, head, repoPath), PROJECT_SERVICE_CODES.failed);
		},
		async workspaceDiff(group, file, repoPath): Promise<GitWorkspaceFileDiff> {
			assertProjectTarget(projectId, file);
			assertRepoScope(projectId, repoPath);
			const diff = await api.git.workspaceFileDiff(projectId, group, file, repoPath);
			if (diff === null) throw new ProjectServiceError(PROJECT_SERVICE_CODES.failed, "rejected", "workspace diff returned no result");
			return diff;
		},
	};
}

/** 本机 Git provider：读写都直接委派现有 git:* 通道。 */
export function createLocalProjectGitService(projectId: string, api: ProjectServicesApi, fence: ProjectServiceFence): ProjectGitService {
	const service: ProjectGitService = {
		...createReadFace(projectId, api),
		async refresh(repoPath): Promise<GitResourceGroups> {
			assertRepoScope(projectId, repoPath);
			// 本机 status 是直接读子进程，没有跨请求的事实缓存，因此 refresh 与 status 同源。
			return api.git.status(projectId, repoPath);
		},
		branches(repoPath): Promise<GitBranchInfo> {
			assertRepoScope(projectId, repoPath);
			return api.git.branches(projectId, repoPath);
		},
		async createBranch(name: string, mode: ProjectGitBranchMode, repoPath) {
			assertRepoScope(projectId, repoPath);
			if (mode !== "create-and-checkout") throw unsupported(GIT_UNSUPPORTED.localCreateBranch);
			await api.git.createBranch(projectId, name, repoPath);
		},
		async checkout(branch, repoPath): Promise<GitBranchInfo> {
			assertRepoScope(projectId, repoPath);
			return api.git.checkout(projectId, branch, repoPath);
		},
		async stage(targets, repoPath) {
			assertProjectTargets(projectId, targets);
			assertRepoScope(projectId, repoPath);
			await api.git.stage(projectId, targets, repoPath);
		},
		async unstage(targets, repoPath) {
			assertProjectTargets(projectId, targets);
			assertRepoScope(projectId, repoPath);
			await api.git.unstage(projectId, targets, repoPath);
		},
		async commit(message, repoPath) {
			assertRepoScope(projectId, repoPath);
			await api.git.commit(projectId, message, repoPath);
		},
		async discard(resources: GitDiscardResource[], repoPath): Promise<ProjectGitDiscardReceipt> {
			assertProjectTargets(
				projectId,
				resources.map((resource) => resource.target),
			);
			assertRepoScope(projectId, repoPath);
			await api.git.discardFiles(projectId, resources, repoPath);
			return {};
		},
		async fetch(repoPath) {
			assertRepoScope(projectId, repoPath);
			await api.git.fetch(projectId, repoPath);
		},
		async pull(repoPath) {
			assertRepoScope(projectId, repoPath);
			await api.git.pull(projectId, repoPath);
		},
		async push(repoPath) {
			assertRepoScope(projectId, repoPath);
			await api.git.push(projectId, repoPath);
		},
		async syncFacts(): Promise<ProjectGitSyncFacts> {
			throw unsupported(GIT_UNSUPPORTED.localSyncFacts);
		},
		async recoveryList(): Promise<ProjectGitRecoveryListing> {
			throw unsupported(GIT_UNSUPPORTED.localRecovery);
		},
		async recoveryRestore(): Promise<void> {
			throw unsupported(GIT_UNSUPPORTED.localRecovery);
		},
		async recoveryDrop(): Promise<void> {
			throw unsupported(GIT_UNSUPPORTED.localRecovery);
		},
		async init(): Promise<{ branch: string | null }> {
			await api.git.init(projectId);
			// main 的 git:init 不返回默认分支；null 表示未知，不伪造分支名。
			return { branch: null };
		},
		async deleteFiles(targets, repoPath) {
			assertProjectTargets(projectId, targets);
			assertRepoScope(projectId, repoPath);
			await api.git.deleteFiles(projectId, targets, repoPath);
		},
		async worktreeList(): Promise<WorktreeEntry[]> {
			return api.git.worktreeList(projectId);
		},
		async worktreeCreate(branchName): Promise<WorktreeEntry> {
			return api.git.worktreeCreate(projectId, branchName);
		},
		async worktreeRemove(target): Promise<boolean> {
			assertProjectTarget(projectId, target);
			return api.git.worktreeRemove(projectId, target);
		},
		aheadBehind(repoPath): Promise<GitAheadBehind | null> {
			assertRepoScope(projectId, repoPath);
			return api.git.aheadBehind(projectId, repoPath);
		},
	};
	return fenceProjectGitService(fence, service);
}

/** 远端 Git provider：读面与本地同一份公共通道；写面/强刷/同步/恢复在 G 接手前显式拒绝，不假装成功。 */
export function createRemoteProjectGitService(projectId: string, api: ProjectServicesApi, fence: ProjectServiceFence): ProjectGitService {
	const service: ProjectGitService = {
		...createReadFace(projectId, api),
		async refresh(): Promise<GitResourceGroups> {
			// 不能退化成 status（缓存命中仍是旧事实），也不能调用 refreshRemoteSnapshot（撤/重签授权）。
			throw unsupported(GIT_UNSUPPORTED.remoteForceRefresh);
		},
		async branches(): Promise<GitBranchInfo> {
			throw unsupported(GIT_UNSUPPORTED.remoteBranches);
		},
		async createBranch(): Promise<void> {
			throw unsupported(GIT_UNSUPPORTED.remoteWrite);
		},
		async checkout(): Promise<GitBranchInfo> {
			throw unsupported(GIT_UNSUPPORTED.remoteWrite);
		},
		async stage(): Promise<void> {
			throw unsupported(GIT_UNSUPPORTED.remoteWrite);
		},
		async unstage(): Promise<void> {
			throw unsupported(GIT_UNSUPPORTED.remoteWrite);
		},
		async commit(): Promise<void> {
			throw unsupported(GIT_UNSUPPORTED.remoteWrite);
		},
		async discard(): Promise<ProjectGitDiscardReceipt> {
			throw unsupported(GIT_UNSUPPORTED.remoteWrite);
		},
		async fetch(): Promise<void> {
			throw unsupported(GIT_UNSUPPORTED.remoteWrite);
		},
		async pull(): Promise<void> {
			throw unsupported(GIT_UNSUPPORTED.remoteWrite);
		},
		async push(): Promise<void> {
			throw unsupported(GIT_UNSUPPORTED.remoteWrite);
		},
		async syncFacts(): Promise<ProjectGitSyncFacts> {
			throw unsupported(GIT_UNSUPPORTED.remoteSyncFacts);
		},
		async recoveryList(): Promise<ProjectGitRecoveryListing> {
			throw unsupported(GIT_UNSUPPORTED.remoteRecovery);
		},
		async recoveryRestore(): Promise<void> {
			throw unsupported(GIT_UNSUPPORTED.remoteRecovery);
		},
		async recoveryDrop(): Promise<void> {
			throw unsupported(GIT_UNSUPPORTED.remoteRecovery);
		},
		async init(): Promise<{ branch: string | null }> {
			throw unsupported(GIT_UNSUPPORTED.remoteWrite);
		},
		async deleteFiles(): Promise<void> {
			throw unsupported(GIT_UNSUPPORTED.remoteDeleteFiles);
		},
		async worktreeList(): Promise<WorktreeEntry[]> {
			throw unsupported(GIT_UNSUPPORTED.remoteWorktree);
		},
		async worktreeCreate(): Promise<WorktreeEntry> {
			throw unsupported(GIT_UNSUPPORTED.remoteWorktree);
		},
		async worktreeRemove(): Promise<boolean> {
			throw unsupported(GIT_UNSUPPORTED.remoteWorktree);
		},
		async aheadBehind(): Promise<GitAheadBehind | null> {
			throw unsupported(GIT_UNSUPPORTED.remoteAheadBehind);
		},
	};
	return fenceProjectGitService(fence, service);
}

export type { ProjectGitService as ProjectGitServiceImpl, ProjectFileTarget as ProjectGitTarget, ProjectGitRecoveryEntry };
