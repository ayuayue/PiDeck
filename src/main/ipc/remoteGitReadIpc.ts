import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type {
	GitRef,
	GitCommitResult,
	GitRepoInfo,
	GitIndexMutationResult,
	GitReadSnapshotResult,
	GitResourceGroups,
	GitWorkspaceFileDiff,
	GitCompareRefsResult,
	GitHistoryPageResult,
	GitRepositoryListResult,
	RemoteGitBranchMutationResult,
	RemoteGitCommitDetailResult,
	RemoteGitCompareResult,
	RemoteGitDiscardResult,
	RemoteGitLogResult,
	RemoteGitRecoveryDropResult,
	RemoteGitRecoveryListResult,
	RemoteGitRecoveryRestoreResult,
	RemoteGitRefFileDiffResult,
	RemoteGitRefsResult,
	RemoteGitReposResult,
	RemoteGitFetchOutcomeResult,
	RemoteGitInitResult,
	RemoteGitPullOutcomeResult,
	RemoteGitPushOutcomeResult,
	RemoteGitSyncFactsResult,
} from "../../shared/types/git";
import type { ProjectFileTarget } from "../../shared/types/project";
import type { RemoteProjectFactsScope } from "../../shared/types/remoteHost";
import { opFailFromCode, opOk } from "../../shared/op";
import { createRemoteGitService, remoteGitFailureCode, remoteGitRepoScope, validateRemoteGitPath, validateRemoteGitRepoPath, type RemoteGitLocator, type RemoteGitReadSnapshot } from "../git/RemoteGitService";
import { createRemoteGitMutationTokens } from "../git/RemoteGitMutationTokens";
import { createSnapshotFactsCache, type SnapshotFactsCache } from "../git/RemoteGitSnapshotFacts";
import type { RemoteFactsHub } from "../remote/RemoteFactsNotifications";
import { DIRECTORY_IGNORE_BATCH_SIZE, DIRECTORY_IGNORE_MAX_PATHS, DIRECTORY_IGNORE_REPOS_TTL_MS, repoRelativePathOf, repoScopeOfPath } from "../files/DirectoryIgnore";

/**
 * 工作区事实 owner 的 Git 侧接口（T4）：由 `remoteProjectIpc` 的 handle 提供。
 *
 * 这里只声明 Git IPC 真正需要的三件事：读哪份缓存、写后怎么标脏。目录族（dir/repos/订阅）不在这里暴露。
 */
export type RemoteWorkspaceFactsPort = {
	facts: SnapshotFactsCache<RemoteGitReadSnapshot>;
	/** Git 写成功/结果未知：该仓库 status + 整树标脏，只发一条通知。 */
	afterGitWrite(projectId: string, repoPath: string): void;
	/** 文件写：该项目全部已缓存仓库的 status 标脏（由 owner 发通知）。 */
	invalidateStatuses(projectId: string): void;
};
import { REMOTE_GIT_COMMIT_MESSAGE_MAX_BYTES } from "../remote/RemoteHelperContract";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Reject path authority and additional fields rather than adapting SSH into local path parsing. */
function fileTarget(projectId: string, value: unknown): ProjectFileTarget {
	if (!record(value) || Object.keys(value).some((key) => key !== "projectId" && key !== "relativePath") || value.projectId !== projectId) throw new Error("GIT_RESULT_INVALID");
	return { projectId, relativePath: validateRemoteGitPath(value.relativePath) };
}
/** Local Git IPC still sends a ProjectFileTarget-shaped repo; the remote channels send the relative POSIX path. */
function compatRepo(projectId: string, value: unknown): string {
	// 同一个归一化函数服务两种调用方：字符串（旧远端控制器）与 ProjectFileTarget（共享 Git 通道/文件树）。
	return remoteGitRepoScope(projectId, value);
}

/** Owns Git read request lifetimes; existing status/diff IPC can delegate before any local repository lookup. */
export function registerRemoteGitReadIpc(input: {
	enabled: boolean;
	locator(projectId: string): RemoteGitLocator | undefined;
	trusted(target: RemoteGitLocator): Promise<boolean>;
	service(): RemoteHostConnectionService | undefined | Promise<RemoteHostConnectionService | undefined>;
	/** 事实变化通知出口（与目录共用同一个 hub）；缺省时不发通知。 */
	factsEvents?: RemoteFactsHub;
	/**
	 * 工作区事实 owner（T4）：**单一**目录/status 缓存与失效矩阵都由它持有。
	 *
	 * 生产装配注入 `remoteProjectIpc` 的 handle；缺省时本模块自持一份缓存与通知（旧装配/单测），
	 * 那是兼容路径，不是第二份事实源：一个进程只会走其中一条。
	 */
	workspace?: RemoteWorkspaceFactsPort;
	/**
	 * 整树失效的主进程侧入口（旧装配兼容；新装配走 `workspace.afterGitWrite`）。
	 * 写成功/结果未知都可能让工作树的条目整块变化（切分支/discard/恢复快照/init）。
	 */
	onTreeInvalidated?: (projectId: string) => void;
}) {
	const reads = new Map<AbortController, { senderId: number; projectId: string }>();
	const tokens = createRemoteGitMutationTokens();
	const senders = new Map<number, { sender: IpcMainInvokeEvent["sender"]; destroy: () => void }>();
	function watchSender(sender: IpcMainInvokeEvent["sender"]) {
		if (senders.has(sender.id)) return;
		const destroy = () => {
			tokens.revoke(sender.id);
			senders.delete(sender.id);
		};
		senders.set(sender.id, { sender, destroy });
		sender.once("destroyed", destroy);
	}
	let disposed = false;
	const git = createRemoteGitService({
		locator: input.locator,
		trusted: input.trusted,
		withProject: async (target, task, signal) => {
			const service = await input.service();
			if (!service) throw new Error("SSH_HOST_NOT_READY");
			const result = await service.withProjectSession(target.hostId, target.remotePath, task, { requireReady: true, signal });
			if (!result.ok) throw new Error(result.code);
			return result.value;
		},
	});
	/**
	 * 快照**事实**缓存（W4 前置）：读与签授权拆开之后，同一个仓库状态在一次内容变化里只读一次。
	 *
	 * 事实旧了不会让写穿过去：每个写动词都带 `expectedRevision`，revision 不符时远端自己拒绝
	 * （见 `RemoteGitSnapshotFacts` 的模块头）。令牌仍然每次现签，缓存的只是事实。
	 */
	const facts = input.workspace?.facts ?? createSnapshotFactsCache<RemoteGitReadSnapshot>();
	/**
	 * 仓库列表（目录页 ignore 归因用）：只在目录页装载时用，按项目缓 60s。
	 * 写成功/unknown 写会清这份缓存（仓库可能新建/删除），不把它当第二份仓库事实源。
	 */
	const directoryIgnoreRepos = new Map<string, { repos: readonly string[]; at: number }>();
	const clearDirectoryIgnoreRepos = (projectId: string): void => {
		directoryIgnoreRepos.delete(projectId);
	};
	/** 公共仓库列表的单调版本：一次成功列表就是一份新事实（truncated 也属这份事实）。 */
	let repositoryListingRevision = 0;

	/**
	 * 本项目 **root 的会话代**（没有稳定身份时为空串）：只用于随结果/通知一起返给渲染层。
	 *
	 * 主机级 connectionFacts 回答的是「这台机器是否连着」；项目需要的是「服务我这个 root 的会话是否
	 * 连着」。拿主机当前 manager 的代当项目代，等于让兄弟 root 的会话给这个项目的缓存和渲染层背书。
	 */
	async function generationFor(projectId: string): Promise<string> {
		try {
			const locator = input.locator(projectId);
			if (locator === undefined) return "";
			const service = await input.service();
			return service?.projectConnectionFacts?.(locator.hostId, locator.remotePath)?.connectionId ?? "";
		} catch {
			return "";
		}
	}

	/**
	 * 写面标脏后通知渲染层：只发“哪个仓库的 status 该重读”，不装载、不碰授权。
	 *
	 * 通知不是事务的一部分：生成代、取服务失败都不影响已经成功的写。
	 */
	function publishFacts(projectId: string, repoPath: string): void {
		publishScopes(projectId, [{ kind: "status", repoPath }]);
	}

	/** 一次通知的公共出口：生成代在发布时求值，订阅者只看到 (项目, 代, scopes)。 */
	function publishScopes(projectId: string, scopes: RemoteProjectFactsScope[]): void {
		const events = input.factsEvents;
		if (events === undefined) return;
		void (async () => {
			try {
				const locator = input.locator(projectId);
				const service = await input.service();
				const generation = locator === undefined ? "" : (service?.projectConnectionFacts?.(locator.hostId, locator.remotePath)?.connectionId ?? "");
				events.publish({ projectId, generation, scopes });
			} catch {
				// 观察者不是事务的一部分。
			}
		})();
	}

	/**
	 * 目录页 ignore 归因用的仓库列表（TTL 缓存）：能力缺失时不发仓库发现帧。
	 * 它不是第二份仓库事实源：只给修饰用，写成功 / 项目关闭就清。
	 */
	async function directoryIgnoreReposOf(projectId: string): Promise<readonly string[]> {
		const cached = directoryIgnoreRepos.get(projectId);
		const now = Date.now();
		if (cached !== undefined && now - cached.at < DIRECTORY_IGNORE_REPOS_TTL_MS) return cached.repos;
		const locator = input.locator(projectId);
		if (locator === undefined) return [];
		const service = await input.service();
		const capabilities = service?.projectHelperCapabilities?.(locator.hostId, locator.remotePath);
		if (capabilities !== undefined && !capabilities.includes("git.checkIgnore")) return [];
		const listing = await git.listRepositories(projectId);
		const repos = listing.repos.map((repository) => repository.path);
		directoryIgnoreRepos.set(projectId, { repos, at: now });
		return repos;
	}

	/**
	 * 一次 Git 写（成功或结果未知）的跨域失效：
	 * - 单一 owner 装配：`workspace.afterGitWrite` 同时标脏该仓库 status 与整树，并只发一条通知；
	 * - 旧装配/单测：自持缓存标脏 + 旧的三件事（标树、发 status+tree 通知）。
	 */
	function invalidateAfterGitWrite(projectId: string, repoPath: string): void {
		clearDirectoryIgnoreRepos(projectId);
		if (input.workspace !== undefined) {
			input.workspace.afterGitWrite(projectId, repoPath);
			return;
		}
		facts.invalidate(projectId, repoPath);
		publishTreeInvalidation(projectId, repoPath);
	}

	/** 旧装配用的发布路径（没有单一 owner 时）：目录标脏 + 一条 status/tree 通知。 */
	function publishTreeInvalidation(projectId: string, repoPath: string): void {
		try {
			input.onTreeInvalidated?.(projectId);
		} catch {
			// 观察者不是事务的一部分。
		}
		// 写会改变工作树条目：status 让 Git 面板重读，tree 让文件树重读根与全部已加载目录
		// （tree 不是根目录事件：根事件只重读根层，覆盖不了深层目录）。
		publishScopes(projectId, [{ kind: "status", repoPath }, { kind: "tree" }]);
	}

	async function read<T>(event: IpcMainInvokeEvent, projectId: unknown, repo: unknown, task: (projectId: string, signal: AbortSignal) => Promise<T>, mutating = false): Promise<T> {
		const { repoPath, guard } = guardRead(event, projectId, repo);
		try {
			const value = await task(guard.projectId, guard.controller.signal);
			if (guard.controller.signal.aborted || guard.sender.isDestroyed()) throw new Error(mutating ? "GIT_WRITE_RESULT_UNCONFIRMED" : "REQUEST_CANCELLED");
			// 写成功 ⇒ 这一仓的事实过时了：只标脏，下一次读重新装载（不在这里主动再读一次）。
			if (mutating) invalidateAfterGitWrite(guard.projectId, repoPath);
			return value;
		} catch (error) {
			// 写已发出但结果未知（超时/断连/答复畸形）：事实可能已经变了，标脏但不自动读、不重放。
			if (mutating && remoteGitFailureCode(error) === "GIT_WRITE_RESULT_UNCONFIRMED") invalidateAfterGitWrite(guard.projectId, repoPath);
			throw error;
		} finally {
			guard.finish();
		}
	}

	/**
	 * 读边界（每个调用者自己的存活/取消/压力边界），不含任何事实缓存。
	 *
	 * 缓存命中必须重新过这一层：暖缓存不是权限旁路。它也不缓存任何授权快照——令牌仍然每次现签。
	 */
	function guardRead(event: IpcMainInvokeEvent, projectId: unknown, repo: unknown): { repoPath: string; guard: { sender: IpcMainInvokeEvent["sender"]; projectId: string; controller: AbortController; finish(): void } } {
		if (!input.enabled) throw new Error("REMOTE_FEATURE_DISABLED");
		if (disposed) throw new Error("REQUEST_CANCELLED");
		const sender = event.sender;
		if (!Number.isSafeInteger(sender.id) || sender.id < 1 || typeof projectId !== "string" || !projectId.trim() || projectId !== projectId.trim() || projectId.length > 256 || /[\x00-\x1f\x7f]/.test(projectId)) throw new Error("GIT_RESULT_INVALID");
		// 已销毁的窗口是「取消」，不是「输入非法」：先校验身份，再报取消（与读中途销毁的结局一致）。
		if (sender.isDestroyed()) throw new Error("REQUEST_CANCELLED");
		// The scope is validated (and refused) before anything is queued for SSH.
		const repoPath = validateRemoteGitRepoPath(repo);
		if (reads.size >= 32 || [...reads.values()].filter((read) => read.senderId === sender.id).length >= 4) throw new Error("TOO_MANY_REQUESTS");
		const controller = new AbortController();
		const cancel = () => controller.abort();
		reads.set(controller, { senderId: sender.id, projectId });
		sender.once("destroyed", cancel);
		return {
			repoPath,
			guard: {
				sender,
				projectId,
				controller,
				finish: () => {
					sender.removeListener("destroyed", cancel);
					reads.delete(controller);
				},
			},
		};
	}

	/**
	 * 事实读的授权/生命周期边界：每次读都重新确认目标、trust、连接身份与就绪状态。
	 *
	 * 缓存只复用事实，绝不能复用授权结论：trust 被撤销、项目被移除、host 离线都必须当场拒绝，
	 * 而不是把暖缓存当“仍然是那个权限下的同一个事实”。没有稳定 helper 身份时返回空（不猜 identity）。
	 *
	 * 身份必须是**本项目 root 的会话**：同一主机上另一个 root 的 helper 不能给这个项目的缓存换代背书，
	 * 所以这里按 (hostId, remotePath) 查项目连接事实；主机在线本身不构成“这个项目的会话可用”。
	 *
	 * `hasCachedFacts` 区分两种读：没有暖事实时允许正常读去建立/恢复会话（首次打开项目必须可读）；
	 * 有暖事实时，没有就绪的同代会话就不许拿旧值冒充成功。
	 */
	async function verifyFactsBoundary(projectId: string, hasCachedFacts: boolean): Promise<{ generation?: string }> {
		const locator = input.locator(projectId);
		if (locator === undefined) throw new Error("GIT_TARGET_CHANGED");
		if (!(await input.trusted(locator))) throw new Error("GIT_TRUST_REQUIRED");
		const service = await input.service();
		if (service === undefined) throw new Error("SSH_HOST_NOT_READY");
		if (typeof service.projectConnectionFacts !== "function") return {};
		const connection = service.projectConnectionFacts(locator.hostId, locator.remotePath);
		if (connection === undefined || connection.state !== "ready") {
			if (hasCachedFacts) throw new Error("SSH_HOST_NOT_READY");
			// 没有暖事实：让正常读走 withProjectSession，由它决定建立会话还是报告真实状态。
			return {};
		}
		return { generation: connection.connectionId };
	}

	/**
	 * 快照/状态的公共事实读：同一次内容变化里，树与面板只读一次；显式 refresh 越过已完成缓存。
	 *
	 * 共享装载不继承任何一个调用者的取消信号：一个窗口取消不能撤销另一个窗口对同 scope 的读
	 * （各自在 await 后检查自己的 controller，取消者拿不到结果，也不会拿到现签的 token）。
	 */
	async function readFacts(event: IpcMainInvokeEvent, projectId: unknown, repoPath: string, force: boolean): Promise<{ facts: RemoteGitReadSnapshot; revision: number }> {
		const { guard } = guardRead(event, projectId, repoPath);
		try {
			// 只有暖事实才需要“活的同代会话”；首次读必须允许正常建立会话。
			const boundary = await verifyFactsBoundary(guard.projectId, facts.peek(guard.projectId, repoPath) !== undefined);
			if (guard.controller.signal.aborted || guard.sender.isDestroyed()) throw new Error("REQUEST_CANCELLED");
			const shared = new AbortController();
			const options = { ...(boundary.generation === undefined ? {} : { generation: boundary.generation }), force };
			// 有稳定会话身份时，共享装载不继承单个调用者的取消（一个人取消不能撤销另一个窗口的读）；
			// 没有稳定身份的兼容端口保留旧的逐调用者取消语义。
			const signal = boundary.generation === undefined ? guard.controller.signal : shared.signal;
			const load = () => git.status(guard.projectId, repoPath, signal);
			const result = force ? await facts.refresh(guard.projectId, repoPath, load, options) : await facts.read(guard.projectId, repoPath, load, options);
			if (guard.controller.signal.aborted || guard.sender.isDestroyed()) throw new Error("REQUEST_CANCELLED");
			return { facts: result.facts, revision: result.revision };
		} finally {
			guard.finish();
		}
	}
	// Cancellation authority is scoped to this sender and main-owned project reads, never a helper id.
	ipcMain.handle(ipcChannels.gitRemoteCancelReads, (event, projectId: unknown) => {
		if (typeof projectId !== "string" || !projectId || projectId.length > 256) throw new Error("GIT_RESULT_INVALID");
		tokens.revoke(event.sender.id, projectId);
		for (const [controller, read] of reads) if (read.senderId === event.sender.id && read.projectId === projectId) controller.abort();
	});
	ipcMain.handle(ipcChannels.gitRemoteSnapshot, async (event, projectId: unknown, repo: unknown, force?: unknown, mode?: unknown): Promise<GitReadSnapshotResult> => {
		try {
			// 显式 refresh 是第十五个参数位置（同一通道的第四个入参）：只接受 boolean/undefined，不猜。
			if (force !== undefined && typeof force !== "boolean") throw new Error("GIT_RESULT_INVALID");
			// 第五个入参是显式的模式位：缺省/ "snapshot" = 今天的行为（撤旧令牌 + 现签）；
			// "facts" = 纯事实强刷（只读事实，既不撤旧令牌也不签发新令牌）。
			if (mode !== undefined && mode !== "facts" && mode !== "snapshot") throw new Error("GIT_RESULT_INVALID");
			const repoPath = validateRemoteGitRepoPath(repo);
			const factsOnly = mode === "facts";
			if (!factsOnly) tokens.revoke(event.sender.id, typeof projectId === "string" ? projectId : "");
			// 事实可缓存（同键并发合并成一次往返）；令牌每次现签，绑定的是这份事实的 revision。
			const readSnapshot = (await readFacts(event, projectId, repoPath, force === true)).facts;
			const { writeExpectation, commitExpectation, branchExpectation, switchExpectation, discardExpectation, restoreExpectation, dropExpectation, fetchExpectation, pushExpectation, pullExpectation, ...snapshot } = readSnapshot;
			// 纯事实：事实之外什么都不带（尤其没有授权令牌），让渲染层可以“只看事实”地强刷一次。
			if (factsOnly) return { ok: true, snapshot };
			// Every confirmed scope mints grants bound to itself (G5e): a nested snapshot's tokens carry its repoPath, so
			// the token layer refuses them against another repository.
			if (typeof projectId === "string") {
				if (writeExpectation) snapshot.mutationToken = tokens.issue(event.sender.id, projectId, writeExpectation);
				if (commitExpectation) snapshot.commitToken = tokens.issue(event.sender.id, projectId, commitExpectation);
				if (branchExpectation) snapshot.branchToken = tokens.issue(event.sender.id, projectId, branchExpectation);
				if (switchExpectation) snapshot.switchToken = tokens.issue(event.sender.id, projectId, switchExpectation);
				if (discardExpectation) snapshot.discardToken = tokens.issue(event.sender.id, projectId, discardExpectation);
				if (restoreExpectation) snapshot.restoreToken = tokens.issue(event.sender.id, projectId, restoreExpectation);
				if (dropExpectation) snapshot.dropToken = tokens.issue(event.sender.id, projectId, dropExpectation);
				if (fetchExpectation) snapshot.fetchToken = tokens.issue(event.sender.id, projectId, fetchExpectation);
				if (pushExpectation) snapshot.pushToken = tokens.issue(event.sender.id, projectId, pushExpectation);
				if (pullExpectation) snapshot.pullToken = tokens.issue(event.sender.id, projectId, pullExpectation);
				if (
					snapshot.mutationToken !== undefined ||
					snapshot.commitToken !== undefined ||
					snapshot.branchToken !== undefined ||
					snapshot.switchToken !== undefined ||
					snapshot.discardToken !== undefined ||
					snapshot.restoreToken !== undefined ||
					snapshot.dropToken !== undefined ||
					snapshot.fetchToken !== undefined ||
					snapshot.pushToken !== undefined ||
					snapshot.pullToken !== undefined
				)
					watchSender(event.sender);
			}
			return { ok: true, snapshot };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	/** G5d: one read-only, bounded discovery of the repositories under the project root; no token, no write. */
	ipcMain.handle(ipcChannels.gitRemoteRepos, async (event, projectId: unknown): Promise<RemoteGitReposResult> => {
		try {
			const listing = await read(event, projectId, "", (id, signal) => git.listRepositories(id, signal));
			return { ok: true, repos: listing.repos, truncated: listing.truncated };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteMutateIndex, async (event, projectId: unknown, operation: unknown, group: unknown, value: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<GitIndexMutationResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			if (operation !== "stage" && operation !== "unstage") throw new Error("GIT_RESULT_INVALID");
			if (group !== "index" && group !== "workingTree" && group !== "untracked") throw new Error("GIT_RESULT_INVALID");
			if (operation === "unstage" ? group !== "index" : group === "index") throw new Error("GIT_RESULT_INVALID");
			await read(
				event,
				projectId,
				repoPath,
				(id, signal) => {
					const file = fileTarget(id, value);
					const expected = tokens.take(event.sender.id, id, "index", repoPath, token);
					return git.mutate(id, operation, group, file, expected, repoPath, signal);
				},
				true,
			);
			return { ok: true };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteCommit, async (event, projectId: unknown, message: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<GitCommitResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			// The message is user input, so it is bounded here before any SSH session is queued for it.
			if (typeof message !== "string" || message.length === 0 || message.trim().length === 0 || message.includes("\0") || Buffer.byteLength(message, "utf8") > REMOTE_GIT_COMMIT_MESSAGE_MAX_BYTES) throw new Error("GIT_COMMIT_MESSAGE_EMPTY");
			await read(event, projectId, repoPath, (id, signal) => git.commit(id, message, tokens.take(event.sender.id, id, "commit", repoPath, token), repoPath, signal), true);
			return { ok: true };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteCreateBranch, async (event, projectId: unknown, name: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitBranchMutationResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			await read(event, projectId, repoPath, (id, signal) => git.createBranch(id, name, tokens.take(event.sender.id, id, "branch", repoPath, token), repoPath, signal), true);
			return { ok: true };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteSwitchBranch, async (event, projectId: unknown, name: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitBranchMutationResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			await read(event, projectId, repoPath, (id, signal) => git.switchBranch(id, name, tokens.take(event.sender.id, id, "switch", repoPath, token), repoPath, signal), true);
			return { ok: true };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteDiscard, async (event, projectId: unknown, group: unknown, value: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitDiscardResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			const result = await read(event, projectId, repoPath, (id, signal) => git.discard(id, group, fileTarget(id, value), tokens.take(event.sender.id, id, "discard", repoPath, token), repoPath, signal), true);
			return { ok: true, recoveryRef: result.recoveryRef };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteRecoveryList, async (event, projectId: unknown, repo: unknown): Promise<RemoteGitRecoveryListResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			const listing = await read(event, projectId, repoPath, (id, signal) => git.recoveryList(id, repoPath, signal));
			return { ok: true, entries: listing.entries, truncated: listing.truncated };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteRecoveryRestore, async (event, projectId: unknown, ref: unknown, oid: unknown, path: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitRecoveryRestoreResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			const restored = await read(event, projectId, repoPath, (id, signal) => git.recoveryRestore(id, ref, oid, path, tokens.take(event.sender.id, id, "restore", repoPath, token), repoPath, signal), true);
			return { ok: true, path: restored.path, bytes: restored.bytes };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteRecoveryDrop, async (event, projectId: unknown, ref: unknown, oid: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitRecoveryDropResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			await read(event, projectId, repoPath, (id, signal) => git.recoveryDrop(id, ref, oid, tokens.take(event.sender.id, id, "drop", repoPath, token), repoPath, signal), true);
			return { ok: true };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	/* G5a sync: facts are a read, the three verbs are network writes with their own grants. */
	ipcMain.handle(ipcChannels.gitRemoteSyncFacts, async (event, projectId: unknown, repo: unknown): Promise<RemoteGitSyncFactsResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			return { ok: true, facts: await read(event, projectId, repoPath, (id, signal) => git.syncFacts(id, repoPath, signal)) };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteFetch, async (event, projectId: unknown, remote: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitFetchOutcomeResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			return { ok: true, outcome: await read(event, projectId, repoPath, (id, signal) => git.fetch(id, remote, tokens.take(event.sender.id, id, "fetch", repoPath, token), repoPath, signal), true) };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemotePush, async (event, projectId: unknown, remote: unknown, branch: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitPushOutcomeResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			return { ok: true, outcome: await read(event, projectId, repoPath, (id, signal) => git.push(id, remote, branch, tokens.take(event.sender.id, id, "push", repoPath, token), repoPath, signal), true) };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemotePull, async (event, projectId: unknown, remote: unknown, branch: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitPullOutcomeResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			return { ok: true, outcome: await read(event, projectId, repoPath, (id, signal) => git.pull(id, remote, branch, tokens.take(event.sender.id, id, "pull", repoPath, token), repoPath, signal), true) };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	/* Read-only history (G3a): same sender/project/pressure boundaries as status; never a token. */
	ipcMain.handle(ipcChannels.gitRemoteLog, async (event, projectId: unknown, options: unknown, repo: unknown): Promise<RemoteGitLogResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			const page = await read(event, projectId, repoPath, (id, signal) => git.log(id, options, repoPath, signal));
			return { ok: true, page };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteCommitDetail, async (event, projectId: unknown, oid: unknown, repo: unknown): Promise<RemoteGitCommitDetailResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			const detail = await read(event, projectId, repoPath, (id, signal) => git.commitDetail(id, oid, repoPath, signal));
			return { ok: true, detail };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteRefs, async (event, projectId: unknown, repo: unknown): Promise<RemoteGitRefsResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			const refs = await read(event, projectId, repoPath, (id, signal) => git.refs(id, repoPath, signal));
			return { ok: true, refs };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	/* G5b refs compare: same read boundary as history, no token; both refs are full local ref names. */
	ipcMain.handle(ipcChannels.gitRemoteCompare, async (event, projectId: unknown, base: unknown, head: unknown, repo: unknown): Promise<RemoteGitCompareResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			return { ok: true, compare: await read(event, projectId, repoPath, (id, signal) => git.compare(id, base, head, repoPath, signal)) };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	/*
	 * G5c explicit init: the one write channel with no token, because there is no confirmed repository state a
	 * renderer could bind a grant to - the absence of .git is the precondition. It still runs through the same
	 * read() boundary (enabled / sender / project identity / trust / pressure) and is marked as a write, so a
	 * reply lost after dispatch becomes GIT_WRITE_RESULT_UNCONFIRMED instead of being replayed.
	 */
	ipcMain.handle(ipcChannels.gitRemoteInit, async (event, projectId: unknown, ...extra: unknown[]): Promise<RemoteGitInitResult> => {
		try {
			// Init is root-only: a supplied repository scope is refused before any SSH session is opened.
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			const created = await read(event, projectId, undefined, (id, signal) => git.init(id, signal), true);
			return { ok: true, branch: created.branch };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteRefFileDiff, async (event, projectId: unknown, base: unknown, head: unknown, value: unknown, repo: unknown): Promise<RemoteGitRefFileDiffResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			const diff = await read(event, projectId, repoPath, (id, signal) => git.refFileDiff(id, base, head, fileTarget(id, value), repoPath, signal));
			return { ok: true, diff };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	return {
		async status(event: IpcMainInvokeEvent, projectId: unknown, repo?: unknown): Promise<GitResourceGroups> {
			const repoPath = compatRepo(typeof projectId === "string" ? projectId : "", repo);
			// 文件树着色与 Git 面板读的是同一份事实：同一次内容变化里，一个仓库只读一次状态。
			const cached = await readFacts(event, projectId, repoPath, false);
			return cached.facts.groups;
		},
		async workspaceDiff(event: IpcMainInvokeEvent, projectId: unknown, group: unknown, value: unknown, repo?: unknown): Promise<GitWorkspaceFileDiff> {
			const repoPath = compatRepo(typeof projectId === "string" ? projectId : "", repo);
			return read(event, projectId, repoPath, async (id, signal) => {
				if (group !== "merge" && group !== "index" && group !== "workingTree" && group !== "untracked") throw new Error("GIT_RESULT_INVALID");
				return git.workspaceDiff(id, group, fileTarget(id, value), repoPath, signal);
			});
		},
		/**
		 * 仓库列表（W4：同一条 `git:listRepos` 通道服务两种位置）。
		 *
		 * 过去 ssh 项目在这条通道上直接抛 UNSUPPORTED_PROJECT_LOCATION，于是远端文件树的着色与
		 * 仓库下拉只能各自再走一条 `git:remote-repos`（不同形状、不同失败词汇）。这里把远端结果
		 * 映射成与本地同形的 `GitRepoInfo[]`，上层不需要知道自己看的是哪种位置。
		 */
		/**
		 * `git:refs` 的远端实现：**同形**返回本地的 `GitRef[]`。
		 *
		 * 远端刻意只报本地分支与 tag（不报 remote-tracking：那是「尚未交付」的暗示），于是 type 只有两档——
		 * 分支归 `head`（本地 `for-each-ref` 对 refs/heads 的同一档），tag 归 `tag`。OID 字段名不同
		 * （`oid` ↔ `hash`）也在这里换掉，渲染层不再需要知道自己在看哪一侧。
		 */
		async refs(event: IpcMainInvokeEvent, projectId: unknown, repo: unknown): Promise<GitRef[]> {
			// 旧调用方传字符串，共享通道传 ProjectFileTarget：两种都归一到同一个仓库 scope，跨项目/越界一律拒。
			const repoPath = remoteGitRepoScope(typeof projectId === "string" ? projectId : "", repo);
			const refs = await read(event, projectId, repoPath, (id, signal) => git.refs(id, repoPath, signal));
			return refs.refs.map((ref) => ({ name: ref.name, fullName: ref.fullName, hash: ref.oid, type: ref.kind === "tag" ? "tag" : "head" }));
		},
		async listRepositories(event: IpcMainInvokeEvent, projectId: unknown): Promise<GitRepoInfo[]> {
			const listing = await read(event, projectId, "", (id, signal) => git.listRepositories(id, signal));
			const owner = typeof projectId === "string" ? projectId : "";
			return listing.repos.map((repository) => ({
				target: { projectId: owner, relativePath: repository.path },
				relativePath: repository.path,
				displayPath: repository.name,
				name: repository.name,
			}));
		},
		/**
		 * 公共仓库列表（T7）：保留 truncated，带 revision/generation；旧 `listRepositories` 仍返回裸数组给兼容入口。
		 */
		async repositoryListing(event: IpcMainInvokeEvent, projectId: unknown): Promise<GitRepositoryListResult> {
			try {
				const listing = await read(event, projectId, "", (id, signal) => git.listRepositories(id, signal));
				const owner = typeof projectId === "string" ? projectId : "";
				repositoryListingRevision += 1;
				return opOk({
					repos: listing.repos.map((repository) => ({ target: { projectId: owner, relativePath: repository.path }, relativePath: repository.path, displayPath: repository.name, name: repository.name })),
					truncated: listing.truncated,
					revision: repositoryListingRevision,
					generation: typeof projectId === "string" ? await generationFor(projectId) : "",
				});
			} catch (error) {
				return opFailFromCode(remoteGitFailureCode(error));
			}
		},
		/** 公共历史页（T7）：远端 HEAD-only，不编造 totalCount/过滤能力。 */
		async historyPage(event: IpcMainInvokeEvent, projectId: unknown, options: unknown, repo: unknown): Promise<GitHistoryPageResult> {
			try {
				const repoPath = remoteGitRepoScope(typeof projectId === "string" ? projectId : "", repo);
				const page = await read(event, projectId, repoPath, (id, signal) => git.log(id, options, repoPath, signal));
				return opOk({
					commits: page.commits.map((commit) => ({ oid: commit.oid, parents: [...commit.parents], subject: commit.subject, authorName: commit.authorName, authorEmail: commit.authorEmail, authorTimeMs: commit.authorTimeSec * 1000 })),
					hasMore: page.hasMore,
				});
			} catch (error) {
				return opFailFromCode(remoteGitFailureCode(error));
			}
		},
		/** 公共比较（T7）：远端是两树比较（trees），不返还 ahead/behind。 */
		async compareRefs(event: IpcMainInvokeEvent, projectId: unknown, base: unknown, head: unknown, repo: unknown): Promise<GitCompareRefsResult> {
			try {
				const repoPath = remoteGitRepoScope(typeof projectId === "string" ? projectId : "", repo);
				const compare = await read(event, projectId, repoPath, (id, signal) => git.compare(id, base, head, repoPath, signal));
				return opOk({
					mode: "trees",
					base: { ref: compare.base.ref, oid: compare.base.oid },
					head: { ref: compare.head.ref, oid: compare.head.oid },
					files: compare.files.map((file) => ({ status: file.status, path: file.path, ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }) })),
				});
			} catch (error) {
				return opFailFromCode(remoteGitFailureCode(error));
			}
		},
		/**
		 * 忽略判定（只读、零授权）：结果与请求逐位对应。
		 *
		 * 目录页的修饰走同一条能力（见 `probeIgnore`：最长仓库前缀归因、64 路径/批）；
		 * 这条 IPC 方法保留给未来需要显式判定的调用方，形状与 helper 契约一致。
		 */
		async checkIgnore(event: IpcMainInvokeEvent, projectId: unknown, repo: unknown, paths: unknown): Promise<boolean[]> {
			const repoPath = compatRepo(typeof projectId === "string" ? projectId : "", repo);
			if (!Array.isArray(paths) || paths.length === 0 || paths.length > 64 || paths.some((path) => typeof path !== "string")) throw new Error("GIT_RESULT_INVALID");
			return read(event, projectId, repoPath, (id, signal) => git.checkIgnore(id, repoPath, paths as string[], signal));
		},
		/**
		 * 文件写成功后（`remoteProjectIpc.afterWrite` 的对侧，兼容入口）：该项目**全部已缓存仓库**的事实过时了。
		 *
		 * 单一 owner 装配下文件写的 status 失效已由 `afterWrite` 一并完成，这里只在旧装配（自持缓存）里使用；
		 * 保留它是为了让装配层仍能显式表达“一次文件写影响 Git 事实”，而不是把语义藏在目录模块里。
		 */
		invalidateProject(projectId: string): void {
			clearDirectoryIgnoreRepos(projectId);
			if (input.workspace !== undefined) {
				input.workspace.invalidateStatuses(projectId);
				return;
			}
			const repos = facts.reposOf(projectId);
			facts.invalidateProject(projectId);
			for (const repoPath of repos) publishFacts(projectId, repoPath);
		},
		/**
		 * 目录页的 Git ignore 修饰（只读、零授权）：返回与 `paths` 逐位对应的布尔数组，
		 * 无法判定时返回 `undefined`（调用方不填 `ignored`，不冒充“都没被忽略”）。
		 *
		 * 仓库归因只有一条规则：仓库列表的最长目录前缀（严格边界）；helper 只看到仓库内路径。
		 * 超过目录页上限、无能力、无仓库、任一帧失败都整页放弃修饰。
		 */
		async probeIgnore(projectId: string, paths: readonly string[]): Promise<readonly boolean[] | undefined> {
			if (!input.enabled || disposed) return undefined;
			if (!Array.isArray(paths) || paths.length === 0 || paths.length > DIRECTORY_IGNORE_MAX_PATHS) return undefined;
			if (paths.some((path) => typeof path !== "string" || path.length === 0)) return undefined;
			// `.git` 是 git 保留名（从不是用户文件，渲染层也永不显示）：不送进 check-ignore。
			// 某些 git/环境组合会对它直接失败，那会把整页修饰一起吞掉；跳过的条目保持 false
			// （目录页只落 true，所以等价于“没判定”）。
			const candidates = paths.map((path, index) => ({ path, index })).filter((entry) => !entry.path.split("/").some((part: string) => part === ".git"));
			const flags = new Array<boolean>(paths.length).fill(false);
			if (candidates.length === 0) return flags;
			try {
				const repos = await directoryIgnoreReposOf(projectId);
				if (repos.length === 0) return undefined;
				// 先归因：有一条无法归到仓库就整页不修饰（部分置灰比不置灰更容易让人误读）。
				const groups = new Map<string, { indexes: number[]; relative: string[] }>();
				for (const { path, index } of candidates) {
					const repo = repoScopeOfPath(repos, path);
					if (repo === undefined) return undefined;
					const group = groups.get(repo) ?? { indexes: [], relative: [] };
					group.indexes.push(index);
					group.relative.push(repoRelativePathOf(repo, path));
					groups.set(repo, group);
				}
				// 有没有任何一批真正被判定过：全都失败时返回 undefined（“没判定”），
				// 而不是一串 false 让调用方误以为“查过了、都没被忽略”。
				let answered = 0;
				for (const [repo, group] of groups) {
					for (let at = 0; at < group.relative.length; at += DIRECTORY_IGNORE_BATCH_SIZE) {
						const batch = group.relative.slice(at, at + DIRECTORY_IGNORE_BATCH_SIZE);
						// 单批失败只丢这一批：修饰不是读的前置条件，也不该被一个怪异路径连坐。
						let answer: readonly boolean[] | undefined;
						try {
							answer = await git.checkIgnore(projectId, repo, batch);
						} catch {
							answer = undefined;
						}
						if (answer === undefined || answer.length !== batch.length) continue;
						answered += batch.length;
						for (let offset = 0; offset < batch.length; offset += 1) flags[group.indexes[at + offset]] = answer[offset];
					}
				}
				return answered === 0 ? undefined : flags;
			} catch {
				// 判定不是读的前置条件：任何失败都只是“没修饰”，不是目录页失败。
				return undefined;
			}
		},
		/** Pair with quit cleanup; sender destruction separately cancels only that window's pending reads. */
		dispose() {
			disposed = true;
			tokens.clear();
			for (const { sender, destroy } of senders.values()) sender.removeListener("destroyed", destroy);
			senders.clear();
			for (const controller of reads.keys()) controller.abort();
		},
	};
}
export type RemoteGitReadIpc = ReturnType<typeof registerRemoteGitReadIpc>;
