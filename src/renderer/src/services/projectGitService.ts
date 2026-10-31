import { opOutcomeOf } from "../../../shared/op";
import { PROJECT_SERVICE_CODES, ProjectServiceError, unwrapOp, type ProjectFileTarget, type ProjectGitBranchMode, type ProjectGitDiscardReceipt, type ProjectGitRecoveryEntry, type ProjectGitRecoveryListing, type ProjectGitService, type ProjectGitSyncFacts, type ProjectServicesApi } from "./projectServiceContracts";
import type { ProjectServiceFence } from "./projectServiceContracts";
import { assertProjectTarget, assertProjectTargets, assertRepoScope, fenceProjectGitService } from "./projectServiceFence";
import type { GitAheadBehind, GitBranchInfo, GitCompareRefsValue, GitDiscardResource, GitHistoryPage, GitReadSnapshot, GitRef, GitRepositoryListing, GitResourceGroups, GitWorkspaceFileDiff, WorktreeEntry } from "../../../shared/types/git";

const GIT_UNSUPPORTED = {
	localSyncFacts: "local git sync facts are not wired through the service yet",
	localCreateBranch: "local git:createBranch only supports create-and-checkout",
	localRecovery: "local git has no recovery store",
	remoteDeleteFiles: "remote file deletion belongs to the file service trash path",
	remoteWorktree: "remote git worktree is local-only",
	remoteBranchMode: "remote git only supports the create and create-and-checkout branch modes",
	remoteSyncAmbiguous: "remote git sync needs one explicit remote; the frozen service contract has no remote parameter",
	remoteSyncBranch: "remote git pull/push needs the current branch; a detached or unknown HEAD cannot be named across the frozen service contract",
} as const;

function unsupported(detail: string): ProjectServiceError {
	return new ProjectServiceError(PROJECT_SERVICE_CODES.unsupported, "rejected", detail);
}

/** 远端通道的失败信封只有稳定码：outcome 由闭集推出，GIT_WRITE_RESULT_UNCONFIRMED 是 unknown（禁止重放）。 */
function remoteFailure(code: string, detail: string): ProjectServiceError {
	return new ProjectServiceError(code, opOutcomeOf(code), detail);
}

/** 远端写缺授权：helper 没有声明该动作，快照里就没有对应令牌——在触达写通道之前拒绝。 */
function missingGrant(action: string): ProjectServiceError {
	return unsupported(`remote git ${action} grant is missing from the confirmed snapshot`);
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

/** 快照里的令牌字段；每个动作只能消费自己那一张。 */
type RemoteGrantKey = "mutationToken" | "commitToken" | "branchToken" | "switchToken" | "discardToken" | "restoreToken" | "dropToken" | "fetchToken" | "pushToken" | "pullToken";

type StageGroup = "merge" | "workingTree" | "untracked";

/** 服务契约的 stage 只收 targets（没有 group）：用同一份 grant 快照判定资源当前所属组，不猜“已暂存”状态。 */
function stageGroupOf(snapshot: GitReadSnapshot, target: ProjectFileTarget): StageGroup {
	const holds = (group: keyof GitResourceGroups) => snapshot.groups[group].some((resource) => resource.target.projectId === target.projectId && resource.target.relativePath === target.relativePath);
	if (holds("untracked")) return "untracked";
	if (holds("workingTree")) return "workingTree";
	if (holds("merge")) return "merge";
	// 快照没有该路径（调用方拿的是另一份事实）：仍按工作区改动提交；main 会用 expectedRevision 与
	// 真实分组再校验，失败就拒绝——provider 不凭猜测发写。
	return "workingTree";
}

/**
 * 远端 Git provider。
 *
 * 读面与本地同一份公共通道（main 按位置路由）；写面走 main 的令牌经纪：
 * - main 每次 `git:remote-snapshot` 都先撤销该 sender+project 的全部旧令牌，再按同一份事实现签新令牌。
 *   因此 provider 只保留“最后一次”快照（按 repoPath 分桶 + 递增序号），整份收下（含各动作令牌），
 *   令牌只在本模块内使用，绝不进入返回值或契约字段；
 * - 写前先取 grant：桶里的快照仍是最后一次就直接复用，否则 `remoteSnapshot` 现取；再从快照取对应令牌；
 * - 快照没有该动作的令牌 = helper 未授权：抛 unsupported 且不触达写通道；
 * - 写一旦发出（无论成功、拒绝还是 unknown），桶即作废（事实已变），下一次写重新确认；
 * - GIT_WRITE_RESULT_UNCONFIRMED 报 unknown，绝不重放/自动重试；其余失败是 rejected；
 * - 同一 projectId+repoPath 的强刷与写共用一条 promise 队列：强刷不会在写途中撤销它的 grant；
 * - 只有 fetch/pull/push 会联网；provider 任何路径都不会自动 fetch。
 */
export function createRemoteProjectGitService(projectId: string, api: ProjectServicesApi, fence: ProjectServiceFence): ProjectGitService {
	/** 已确认快照的私有桶：repoPath → { snapshot, sequence }。令牌只留在这里。 */
	const buckets = new Map<string, { snapshot: GitReadSnapshot; sequence: number }>();
	/** 本 provider 内最后一次快照的序号；序号相等是桶可复用的唯一条件。 */
	let issued = 0;
	/** projectId+repoPath 级 promise 队列：强刷与写互相等待。 */
	const queues = new Map<string, Promise<void>>();

	function enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
		const previous = queues.get(key) ?? Promise.resolve();
		// 前一个任务失败只属于它自己：队尾继续执行，调用者只承受自己的失败。
		const next = previous.then(run, run);
		const tail = next.then(
			() => undefined,
			() => undefined,
		);
		queues.set(key, tail);
		void tail.then(() => {
			if (queues.get(key) === tail) queues.delete(key);
		});
		return next;
	}

	const keyOf = (repoPath: ProjectFileTarget | undefined): string => repoPath?.relativePath ?? "";
	/** 远端通道只接受项目相对 POSIX 路径；调用前都已过 assertRepoScope。 */
	const scopeOf = (repoPath: ProjectFileTarget | undefined): string | undefined => repoPath?.relativePath;

	/**
	 * 现取一份快照并登记为“最后一次”。main 在读到事实之前就撤销了旧令牌，所以即使这次读失败，
	 * 序号也必须推进：所有旧桶随之失效，而不是带着死令牌去写。
	 */
	async function fetchSnapshot(repoPath: ProjectFileTarget | undefined, key: string): Promise<GitReadSnapshot> {
		// 先推进序号：main 在读到事实之前就撤销了旧令牌，即使这次读抛错（IPC 异常），旧桶也必须失效。
		const sequence = ++issued;
		const result = await api.git.remoteSnapshot(projectId, scopeOf(repoPath));
		if (!result.ok) throw remoteFailure(result.code, "remote git snapshot refused");
		buckets.set(key, { snapshot: result.snapshot, sequence });
		return result.snapshot;
	}

	/** 写前的 grant：桶里的快照仍是最后一次就复用（不丢弃令牌），否则现取。 */
	async function grantFor(repoPath: ProjectFileTarget | undefined): Promise<GitReadSnapshot> {
		const key = keyOf(repoPath);
		const bucket = buckets.get(key);
		return bucket !== undefined && bucket.sequence === issued ? bucket.snapshot : fetchSnapshot(repoPath, key);
	}

	/** 令牌经纪：只在本模块内使用；缺令牌 = 该动作没有被授权。 */
	function grantToken(snapshot: GitReadSnapshot, key: RemoteGrantKey, action: string): string {
		const token = snapshot[key];
		if (typeof token !== "string" || token.length === 0) throw missingGrant(action);
		return token;
	}

	/** 写一旦发出，这份事实就旧了：桶作废，下一次写重新确认。 */
	function dropBucket(key: string): void {
		buckets.delete(key);
	}

	async function readBranches(repoPath: ProjectFileTarget | undefined): Promise<GitBranchInfo> {
		const result = await api.git.remoteRefs(projectId, scopeOf(repoPath));
		if (!result.ok) throw remoteFailure(result.code, "remote git refs refused");
		return { current: result.refs.branch, branches: result.refs.refs.filter((ref) => ref.kind === "branch").map((ref) => ref.name) };
	}

	async function createRemoteBranch(name: string, repoPath: ProjectFileTarget | undefined): Promise<void> {
		const key = keyOf(repoPath);
		try {
			const snapshot = await grantFor(repoPath);
			const token = grantToken(snapshot, "branchToken", "create branch");
			const result = await api.git.createRemoteBranch(projectId, name, token, scopeOf(repoPath));
			if (!result.ok) throw remoteFailure(result.code, "remote git create branch failed");
		} finally {
			dropBucket(key);
		}
	}

	async function switchRemoteBranch(name: string, repoPath: ProjectFileTarget | undefined): Promise<void> {
		const key = keyOf(repoPath);
		try {
			const snapshot = await grantFor(repoPath);
			const token = grantToken(snapshot, "switchToken", "switch branch");
			const result = await api.git.switchRemoteBranch(projectId, name, token, scopeOf(repoPath));
			if (!result.ok) throw remoteFailure(result.code, "remote git switch branch failed");
		} finally {
			dropBucket(key);
		}
	}

	async function readSyncFacts(repoPath: ProjectFileTarget | undefined): Promise<ProjectGitSyncFacts> {
		const result = await api.git.syncFacts(projectId, scopeOf(repoPath));
		if (!result.ok) throw remoteFailure(result.code, "remote git sync facts refused");
		const facts = result.facts;
		return { branch: facts.branch, upstream: facts.upstream, ahead: facts.ahead, behind: facts.behind, remotes: [...facts.remotes] };
	}

	/** 契约缺口：同步方法没有 remote 参数。0 个 remote 是确定失败；>1 个无法替用户选，显式 unsupported。 */
	function resolveRemote(facts: ProjectGitSyncFacts): string {
		if (facts.remotes.length === 0) throw new ProjectServiceError("GIT_SYNC_REMOTE_UNKNOWN", "rejected", "remote git has no configured remote");
		if (facts.remotes.length > 1) throw unsupported(GIT_UNSUPPORTED.remoteSyncAmbiguous);
		return facts.remotes[0];
	}

	function resolveBranch(facts: ProjectGitSyncFacts): string {
		if (facts.branch === null || facts.branch.length === 0) throw unsupported(GIT_UNSUPPORTED.remoteSyncBranch);
		return facts.branch;
	}

	const service: ProjectGitService = {
		...createReadFace(projectId, api),
		/**
		 * 真正的纯事实强刷：越过 main 的事实缓存重读。
		 *
		 * 两层路径：
		 * - 主进程支持 facts-only 入口（`refreshRemoteGitFacts`）时，强刷**零授权副作用**：既不撤旧令牌也不签发
		 *   新令牌，已确认快照桶原样可复用（一次刷新不会打断在途写）；
		 * - 旧装配只有带授权副作用的强刷：整份快照（含新签的十类令牌）收进桶里，绝不丢弃。
		 */
		async refresh(repoPath): Promise<GitResourceGroups> {
			assertRepoScope(projectId, repoPath);
			const key = keyOf(repoPath);
			return enqueue(key, async () => {
				const factsOnly = api.git.refreshRemoteGitFacts;
				if (typeof factsOnly === "function") {
					const result = await factsOnly.call(api.git, projectId, scopeOf(repoPath));
					if (!result.ok) throw remoteFailure(result.code, "remote git force refresh refused");
					return result.snapshot.groups;
				}
				const result = await api.git.refreshRemoteSnapshot(projectId, scopeOf(repoPath));
				const sequence = ++issued;
				// 失败绝不返回空 groups 冒充“干净仓库”；main 已撤销旧令牌，旧桶也随序号失效。
				if (!result.ok) throw remoteFailure(result.code, "remote git force refresh refused");
				buckets.set(key, { snapshot: result.snapshot, sequence });
				return result.snapshot.groups;
			});
		},
		branches(repoPath): Promise<GitBranchInfo> {
			assertRepoScope(projectId, repoPath);
			return readBranches(repoPath);
		},
		async createBranch(name, mode, repoPath) {
			assertRepoScope(projectId, repoPath);
			if (mode !== "create" && mode !== "create-and-checkout") throw unsupported(GIT_UNSUPPORTED.remoteBranchMode);
			const key = keyOf(repoPath);
			await enqueue(key, async () => {
				await createRemoteBranch(name, repoPath);
				// 第二步失败只报第二步的码：分支已经创建，不回滚（回滚会把用户刚得到的引用悄悄删掉）。
				if (mode === "create-and-checkout") await switchRemoteBranch(name, repoPath);
			});
		},
		async checkout(branch, repoPath): Promise<GitBranchInfo> {
			assertRepoScope(projectId, repoPath);
			const key = keyOf(repoPath);
			await enqueue(key, () => switchRemoteBranch(branch, repoPath));
			// 切换已经确认：读回只是展示信息，读失败不能把“切换成功”改写成失败（调用方会清掉事实）。
			// 返回 null 表示“现在不知道”，下一次显式读修复；绝不重放已确认的切换。
			try {
				return await readBranches(repoPath);
			} catch {
				return { current: null, branches: [] };
			}
		},
		async stage(targets, repoPath) {
			assertProjectTargets(projectId, targets);
			assertRepoScope(projectId, repoPath);
			if (targets.length === 0) return;
			const key = keyOf(repoPath);
			await enqueue(key, async () => {
				for (const target of targets) {
					try {
						const snapshot = await grantFor(repoPath);
						const token = grantToken(snapshot, "mutationToken", "stage/unstage");
						const result = await api.git.mutateRemoteIndex(projectId, "stage", stageGroupOf(snapshot, target), target, token, scopeOf(repoPath));
						if (!result.ok) throw remoteFailure(result.code, "remote git stage failed");
					} finally {
						dropBucket(key);
					}
				}
			});
		},
		async unstage(targets, repoPath) {
			assertProjectTargets(projectId, targets);
			assertRepoScope(projectId, repoPath);
			if (targets.length === 0) return;
			const key = keyOf(repoPath);
			await enqueue(key, async () => {
				for (const target of targets) {
					try {
						const snapshot = await grantFor(repoPath);
						const token = grantToken(snapshot, "mutationToken", "stage/unstage");
						const result = await api.git.mutateRemoteIndex(projectId, "unstage", "index", target, token, scopeOf(repoPath));
						if (!result.ok) throw remoteFailure(result.code, "remote git unstage failed");
					} finally {
						dropBucket(key);
					}
				}
			});
		},
		async commit(message, repoPath) {
			assertRepoScope(projectId, repoPath);
			const key = keyOf(repoPath);
			await enqueue(key, async () => {
				try {
					const snapshot = await grantFor(repoPath);
					const token = grantToken(snapshot, "commitToken", "commit");
					const result = await api.git.commitRemote(projectId, message, token, scopeOf(repoPath));
					if (!result.ok) throw remoteFailure(result.code, "remote git commit failed");
				} finally {
					dropBucket(key);
				}
			});
		},
		async discard(resources, repoPath): Promise<ProjectGitDiscardReceipt> {
			assertProjectTargets(
				projectId,
				resources.map((resource) => resource.target),
			);
			assertRepoScope(projectId, repoPath);
			const key = keyOf(repoPath);
			return enqueue(key, async () => {
				let recoveryRef: string | null = null;
				for (const resource of resources) {
					try {
						const snapshot = await grantFor(repoPath);
						const token = grantToken(snapshot, "discardToken", "discard");
						const result = await api.git.discardRemote(projectId, resource.group, resource.target, token, scopeOf(repoPath));
						if (!result.ok) throw remoteFailure(result.code, "remote git discard failed");
						// 批量回滚只有一张收据：保留最后一个非空恢复快照；null 原样表示该次无需快照。
						if (result.recoveryRef !== null) recoveryRef = result.recoveryRef;
					} finally {
						dropBucket(key);
					}
				}
				return { recoveryRef };
			});
		},
		async fetch(repoPath) {
			assertRepoScope(projectId, repoPath);
			const key = keyOf(repoPath);
			await enqueue(key, async () => {
				// 只有显式 fetch 才会联网；remote 从只读 syncFacts 解析（0 → 确定失败，>1 → 契约缺口）。
				const remote = resolveRemote(await readSyncFacts(repoPath));
				try {
					const snapshot = await grantFor(repoPath);
					const token = grantToken(snapshot, "fetchToken", "fetch");
					const result = await api.git.fetchRemote(projectId, remote, token, scopeOf(repoPath));
					if (!result.ok) throw remoteFailure(result.code, "remote git fetch failed");
				} finally {
					dropBucket(key);
				}
			});
		},
		async pull(repoPath) {
			assertRepoScope(projectId, repoPath);
			const key = keyOf(repoPath);
			await enqueue(key, async () => {
				const facts = await readSyncFacts(repoPath);
				const remote = resolveRemote(facts);
				const branch = resolveBranch(facts);
				try {
					const snapshot = await grantFor(repoPath);
					const token = grantToken(snapshot, "pullToken", "pull");
					const result = await api.git.pullRemote(projectId, remote, branch, token, scopeOf(repoPath));
					if (!result.ok) throw remoteFailure(result.code, "remote git pull failed");
				} finally {
					dropBucket(key);
				}
			});
		},
		async push(repoPath) {
			assertRepoScope(projectId, repoPath);
			const key = keyOf(repoPath);
			await enqueue(key, async () => {
				const facts = await readSyncFacts(repoPath);
				const remote = resolveRemote(facts);
				const branch = resolveBranch(facts);
				try {
					const snapshot = await grantFor(repoPath);
					const token = grantToken(snapshot, "pushToken", "push");
					const result = await api.git.pushRemote(projectId, remote, branch, token, scopeOf(repoPath));
					if (!result.ok) throw remoteFailure(result.code, "remote git push failed");
				} finally {
					dropBucket(key);
				}
			});
		},
		async syncFacts(repoPath): Promise<ProjectGitSyncFacts> {
			assertRepoScope(projectId, repoPath);
			return readSyncFacts(repoPath);
		},
		async recoveryList(repoPath): Promise<ProjectGitRecoveryListing> {
			assertRepoScope(projectId, repoPath);
			const result = await api.git.recoveryList(projectId, scopeOf(repoPath));
			if (!result.ok) throw remoteFailure(result.code, "remote git recovery list refused");
			return { entries: result.entries.map((entry) => ({ ref: entry.ref, oid: entry.oid, path: entry.path, bytes: entry.bytes, at: entry.at })), truncated: result.truncated };
		},
		async recoveryRestore(entry, repoPath) {
			assertRepoScope(projectId, repoPath);
			const key = keyOf(repoPath);
			await enqueue(key, async () => {
				try {
					const snapshot = await grantFor(repoPath);
					const token = grantToken(snapshot, "restoreToken", "recovery restore");
					const result = await api.git.recoveryRestore(projectId, entry.ref, entry.oid, entry.path, token, scopeOf(repoPath));
					if (!result.ok) throw remoteFailure(result.code, "remote git recovery restore failed");
				} finally {
					dropBucket(key);
				}
			});
		},
		async recoveryDrop(entry, repoPath) {
			assertRepoScope(projectId, repoPath);
			const key = keyOf(repoPath);
			await enqueue(key, async () => {
				try {
					const snapshot = await grantFor(repoPath);
					const token = grantToken(snapshot, "dropToken", "recovery drop");
					const result = await api.git.recoveryDrop(projectId, entry.ref, entry.oid, token, scopeOf(repoPath));
					if (!result.ok) throw remoteFailure(result.code, "remote git recovery drop failed");
				} finally {
					dropBucket(key);
				}
			});
		},
		async init(): Promise<{ branch: string | null }> {
			// init 没有令牌：不存在可绑定的“已确认仓库状态”，.git 的缺席就是前提；main 仍把它记为写，
			// 答复丢失时按 unknown 处理（不重放）。
			const branch = await enqueue("", async () => {
				const result = await api.git.initRemote(projectId);
				if (!result.ok) {
					// 结果未知时仓库可能已经建好：旧快照的令牌随之失效，必须重新确认（未知绝不重放）。
					if (opOutcomeOf(result.code) === "unknown") buckets.clear();
					throw remoteFailure(result.code, "remote git init failed");
				}
				// 新仓库让此前的事实与令牌全部失效；桶一律作废（最坏只多一次确认）。
				buckets.clear();
				return result.branch;
			});
			return { branch };
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
		async aheadBehind(repoPath): Promise<GitAheadBehind | null> {
			assertRepoScope(projectId, repoPath);
			const facts = await readSyncFacts(repoPath);
			// 没有上游就没有“领先/落后”这件事实；null 比 0/0 更诚实。
			return facts.upstream === null ? null : { ahead: facts.ahead, behind: facts.behind };
		},
	};
	return fenceProjectGitService(fence, service);
}

export type { ProjectGitService as ProjectGitServiceImpl, ProjectFileTarget as ProjectGitTarget, ProjectGitRecoveryEntry };
