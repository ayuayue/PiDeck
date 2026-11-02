import type {
	GitBranchInfo,
	GitCommitResult,
	GitCompareRefsResult,
	GitHistoryPageResult,
	GitIndexMutationResult,
	GitReadSnapshot,
	GitReadSnapshotResult,
	GitRepositoryListing,
	GitResourceGroupType,
	GitResourceGroups,
	GitWorkspaceFileDiff,
	RemoteGitBranchMutationResult,
	RemoteGitCommitDetail,
	RemoteGitCommitDetailResult,
	RemoteGitCompare,
	RemoteGitCompareResult,
	RemoteGitDiscardResult,
	RemoteGitInitResult,
	RemoteGitLogPage,
	RemoteGitLogResult,
	RemoteGitRecoveryEntryView,
	RemoteGitRefFileDiff,
	RemoteGitRefFileDiffResult,
	RemoteGitRefs,
	RemoteGitRefsResult,
	RemoteGitSyncFactsView,
} from "../../../shared/types/git";
import type { ProjectFileTarget } from "../../../shared/types/project";
import type { ProjectGitCapabilities } from "../services/projectServiceContracts";
import { createRemoteGitStatusRefresher } from "./remoteGitStatusPolling";

/** The panel's own snapshot: the service contract no longer hands the renderer any authorization token. */
export type RemoteGitViewSnapshot = { groups: GitResourceGroups; branch: string | null };

export type RemoteGitViewState = {
	projectKey: string;
	loading: boolean;
	snapshot?: RemoteGitViewSnapshot;
	errorCode?: string;
	/** Stable reason supplied by the service capabilities when this repository cannot be read at all. */
	blockedReason?: string;
	mutating?: boolean;
	/** Which action is in flight; the panel says “writing the index”, “committing”, or which branch action runs. */
	mutatingKind?: "index" | "commit" | "branch" | "switch" | "discard" | "restore" | "drop" | "fetch" | "push" | "pull" | "init";
	/** Explicit repository creation is its own single-flight state: it starts from “not a repository”, not from facts. */
	initializing?: boolean;
	/** The branch the newly created repository reported; the panel shows it on the init outcome line. */
	initNotice?: { branch: string | null };
	/** Where the last discarded content went; null means the discarded change was a deletion (nothing to keep). */
	discardRecovery?: { ref: string | null; path: string };
	/* Recovery store (G4b): a manually loaded listing plus the outcome of the last restore or drop. */
	recovery?: { entries: RemoteGitRecoveryEntryView[]; truncated: boolean };
	recoveryLoading?: boolean;
	recoveryErrorCode?: string;
	recoveryNotice?: { kind: "restored" | "dropped"; path: string };
	/* Sync (G5a): facts of the remote chain, loaded manually-by-effect, plus the outcome of the last verb. */
	sync?: RemoteGitSyncFactsView;
	syncLoading?: boolean;
	syncErrorCode?: string;
	/** The service layer reports completion only (no push mode / fetch ref list), so the verb is the outcome. */
	syncNotice?: { kind: "fetch" | "push" | "pull"; outcome: string };
	/** Counts confirmed commits, so the panel can clear its message box exactly once per success. */
	confirmedCommits?: number;
	diffLoading: boolean;
	/** A workspace diff or one file's two sides between two revisions; one surface, one flight at a time. */
	diff?: GitWorkspaceFileDiff | RemoteGitRefFileDiff;
	diffKind?: "workspace" | "revision";
	diffGroup?: GitResourceGroupType;
	diffErrorCode?: string;
	/* Read-only history (G3a): manual loads only; facts die with the snapshot facts so the panel never mixes generations. */
	history?: RemoteGitLogPage;
	historyLoading?: boolean;
	historyMoreLoading?: boolean;
	historyErrorCode?: string;
	detailOid?: string;
	detail?: RemoteGitCommitDetail;
	detailLoading?: boolean;
	detailErrorCode?: string;
	refs?: RemoteGitRefs;
	refsLoading?: boolean;
	refsErrorCode?: string;
	/* G5b compare: last click wins; the file list carries the resolved OIDs used for the per-file read. */
	compare?: RemoteGitCompare;
	compareLoading?: boolean;
	compareErrorCode?: string;
};
/**
 * The one data entry of the remote Git panel (G4a): every method is bound to the project the service instance was
 * created for, so the renderer never passes a project id and never sees an authorization token.
 *
 * Results keep the existing `{ok:true,...}|{ok:false,code}` envelope so the controller logic stays the same; a failed
 * write is reported as `GIT_WRITE_RESULT_UNCONFIRMED` and is never replayed.
 */
export type RemoteGitViewApi = {
	cancelRemoteReads(): Promise<void>;
	/** Ordinary fact read (main routes by location; a completed read cache may answer). */
	status(repo?: string, options?: { branch?: boolean }): Promise<GitReadSnapshotResult>;
	/** Pure-fact force refresh: bypasses the completed read cache without touching authorization tokens. */
	refresh(repo?: string, options?: { branch?: boolean }): Promise<GitReadSnapshotResult>;
	branches(repo?: string): Promise<{ ok: true; info: GitBranchInfo } | { ok: false; code: string }>;
	historyPage(options?: { maxCount?: number; skip?: number }, repo?: string): Promise<GitHistoryPageResult>;
	commitDetail(oid: string, repo?: string): Promise<RemoteGitCommitDetailResult>;
	refs(repo?: string): Promise<RemoteGitRefsResult>;
	refFileDiff(base: string | null, head: string, target: ProjectFileTarget, repo?: string): Promise<RemoteGitRefFileDiffResult>;
	compareRefs(base: string, head: string, repo?: string): Promise<GitCompareRefsResult>;
	workspaceFileDiff(group: GitResourceGroupType, target: ProjectFileTarget, repo?: string): Promise<GitWorkspaceFileDiff | null>;
	syncFacts(repo?: string): Promise<{ ok: true; facts: RemoteGitSyncFactsView } | { ok: false; code: string }>;
	repos(): Promise<GitRepositoryListing>;
	mutateIndex(operation: "stage" | "unstage", group: GitResourceGroupType, target: ProjectFileTarget, repo?: string): Promise<GitIndexMutationResult>;
	commit(message: string, repo?: string): Promise<GitCommitResult>;
	discard(group: "workingTree" | "untracked", target: ProjectFileTarget, repo?: string): Promise<RemoteGitDiscardResult>;
	createBranch(name: string, repo?: string): Promise<RemoteGitBranchMutationResult>;
	switchBranch(name: string, repo?: string): Promise<RemoteGitBranchMutationResult>;
	recoveryList(repo?: string): Promise<{ ok: true; entries: RemoteGitRecoveryEntryView[]; truncated: boolean } | { ok: false; code: string }>;
	recoveryRestore(ref: string, oid: string, path: string, repo?: string): Promise<{ ok: true } | { ok: false; code: string }>;
	recoveryDrop(ref: string, oid: string, repo?: string): Promise<{ ok: true } | { ok: false; code: string }>;
	fetch(remote: string, repo?: string): Promise<{ ok: true } | { ok: false; code: string }>;
	push(remote: string, branch: string, repo?: string): Promise<{ ok: true } | { ok: false; code: string }>;
	pull(remote: string, branch: string, repo?: string): Promise<{ ok: true } | { ok: false; code: string }>;
	init(): Promise<RemoteGitInitResult>;
};
import { validRemoteGitBranchName, validRemoteGitRefFullName } from "./remoteGitRefValidation";
export { validRemoteGitBranchName, validRemoteGitRefFullName } from "./remoteGitRefValidation";

/**
 * Raw IPC/domain errors carry their stable code in the message (main's existing convention); only that bounded code
 * becomes visible text. Shared with the panel bridge, which normalizes service failures through the same rule.
 */
export function errorCode(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	// Electron invoke prefixes errors with the channel; only the bounded code becomes visible text.
	return /\b(?:GIT_[A-Z_]+|SSH_[A-Z_]+|REMOTE_FEATURE_DISABLED|UNSUPPORTED_CAPABILITY|RESULT_TOO_LARGE|REQUEST_TIMEOUT|REQUEST_CANCELLED|REMOTE_CONNECTION_LOST|PERMISSION_DENIED|PATH_[A-Z_]+|NOT_A_FILE|TOO_MANY_REQUESTS)\b/.exec(raw)?.[0] ?? "GIT_COMMAND_FAILED";
}

/**
 * Every capability the panel can ask for. Callers that do not pass a capability set (older tests, isolated callers)
 * get the complete surface; production always passes `services.capabilities.git`.
 */
const ALL_GIT_CAPABILITIES: ProjectGitCapabilities = {
	read: true,
	diff: true,
	branchRead: true,
	history: true,
	repos: true,
	refs: true,
	write: true,
	branchWrite: true,
	branchCreateMode: "both",
	sync: true,
	syncFacts: true,
	aheadBehind: true,
	compare: true,
	recovery: true,
	worktree: true,
	init: true,
	forceRefresh: true,
	autoFetch: false,
	statusPoll: true,
	refsWatch: true,
	deleteFiles: true,
};

/** The silent status poll thinks in the raw read shape; the panel state keeps only groups + branch. */
type RemoteGitStatusPollState = {
	loading: boolean;
	diffLoading: boolean;
	mutating?: boolean;
	snapshot?: GitReadSnapshot;
	errorCode?: string;
};

/**
 * Single-owner controller: explicit, one-shot index actions and one commit per confirmed snapshot; no polling or replay.
 * `repoPath` is the repository scope of this controller instance ("" is the project root): every read AND every write
 * carries it, so a nested scope writes only that repository; init remains the one root-only action.
 *
 * `capabilities` is the one capability source (`services.capabilities.git`). Every action checks its capability
 * before touching the API: a closed capability means zero calls, never a “try and see” request. Capabilities gate the
 * UI entry only; main still re-validates each operation, and an unknown write is never replayed.
 */
export function createRemoteGitViewController(projectId: string, projectKey: string, api: RemoteGitViewApi, publish: (state: RemoteGitViewState) => void, repoPath = "", capabilities?: ProjectGitCapabilities) {
	const cap = capabilities ?? ALL_GIT_CAPABILITIES;
	let active = true;
	let epoch = 0;
	let diffEpoch = 0;
	let historyEpoch = 0;
	let detailEpoch = 0;
	let refsEpoch = 0;
	// The recovery listing has its own epoch: a reload triggered by a finished action must never invalidate the
	// outcome of the action the user performs next.
	let recoveryEpoch = 0;
	// The sync facts belong to one generation of repository state, so they are invalidated like the other reads.
	let syncEpoch = 0;
	// G5b: the compare answer and the refs poll each have a generation. A slow earlier compare must not replace
	// the pair of refs the user clicked last, and a manual refs load invalidates an in-flight poll (only one
	// visible refs answer may publish).
	let compareEpoch = 0;
	let refsPollEpoch = 0;
	let refsPollInFlight = false;
	let state: RemoteGitViewState = { projectKey, loading: false, diffLoading: false };
	function update(next: RemoteGitViewState) {
		// The confirmed-commit counter is sticky: a later read (or a connection loss) must not resurrect the
		// message box the user already cleared.
		const sticky = state.confirmedCommits;
		// Both stickiness rules exist for the same reason: a later read must not erase something the user still needs.
		const carried = sticky === undefined || next.confirmedCommits !== undefined ? next : { ...next, confirmedCommits: sticky };
		const withDiscard = next.discardRecovery === undefined && state.discardRecovery !== undefined ? { ...carried, discardRecovery: state.discardRecovery } : carried;
		const withNotice = next.recoveryNotice === undefined && state.recoveryNotice !== undefined ? { ...withDiscard, recoveryNotice: state.recoveryNotice } : withDiscard;
		const withSyncNotice = next.syncNotice === undefined && state.syncNotice !== undefined ? { ...withNotice, syncNotice: state.syncNotice } : withNotice;
		state = next.initNotice === undefined && state.initNotice !== undefined ? { ...withSyncNotice, initNotice: state.initNotice } : withSyncNotice;
		if (active) publish(state);
	}
	/** The renderer never holds a token; canceling reads is still a bounded, best-effort read-side action. */
	function cancelReads(): void {
		// A closed read capability means this controller never started a read, so there is nothing to cancel.
		if (!cap.read) return;
		void api.cancelRemoteReads().catch(() => undefined);
	}
	/** Retire every silent poll and invalidate the in-flight answers a new "unavailable/uncertain" state must not inherit. */
	function stopPolling(): void {
		statusRefresher.stop();
		epoch += 1;
		diffEpoch += 1;
		historyEpoch += 1;
		detailEpoch += 1;
		refsEpoch += 1;
		compareEpoch += 1;
		recoveryEpoch += 1;
	}
	/**
	 * One repository read: the fact read (force only when the host grants it) plus the branch current. A branch read
	 * failure leaves the branch unknown and never replaces the groups a successful fact read just returned.
	 */
	async function readRepository(repoScope: string, force: boolean, options?: { branch?: boolean }): Promise<{ facts: GitReadSnapshotResult; branch: string | null }> {
		// 分支只是展示信息：静默轮询不读它（省一次远端往返），读者只拿事实。
		const branchRead =
			cap.branchRead && options?.branch !== false
				? Promise.resolve()
						.then(() => api.branches(repoScope))
						.then(
							(answer) => answer,
							() => undefined,
						)
				: Promise.resolve(undefined);
		const factsRead = force && cap.forceRefresh ? api.refresh(repoScope, options) : api.status(repoScope, options);
		const [facts, branches] = await Promise.all([factsRead, branchRead]);
		const branch = branches !== undefined && branches.ok ? branches.info.current : null;
		return { facts, branch };
	}
	// 静默 status 刷新（P0-3）：策略/闸门/单飞在 remoteGitStatusPolling，控制器只提供状态、事实代次与读口。
	// 能力关闭时 isActive() 直接为 false：一次读都不会发起，也不会发布任何静默结果。
	const statusRefresher = createRemoteGitStatusRefresher<RemoteGitStatusPollState>({
		isActive: () => active && cap.read,
		current: () => ({
			loading: state.loading,
			diffLoading: state.diffLoading,
			...(state.mutating === undefined ? {} : { mutating: state.mutating }),
			...(state.snapshot === undefined ? {} : { snapshot: { head: null, branch: state.snapshot.branch, groups: state.snapshot.groups } }),
			...(state.errorCode === undefined ? {} : { errorCode: state.errorCode }),
		}),
		factGeneration: () => epoch,
		publish: (next) => update({ ...state, ...(next.snapshot === undefined ? {} : { snapshot: { groups: next.snapshot.groups, branch: next.snapshot.branch } }), errorCode: next.errorCode }),
		readSnapshot: async () => {
			// 静默读也要越过主进程已完成的事实缓存：外部 commit/checkout 不会让主进程标脏（能力允许时）。
			// 但轮询只要事实：分支沿用已有状态，不为“展示信息”每 5 秒多开一次远端往返。
			const { facts } = await readRepository(repoPath, true, { branch: false });
			return facts.ok ? { ok: true, snapshot: { groups: facts.snapshot.groups, head: null, branch: state.snapshot?.branch ?? null } } : facts;
		},
		codeOf: errorCode,
	});
	async function readHistoryPage(maxCount: number, skip?: number): Promise<RemoteGitLogResult> {
		const result = await api.historyPage({ maxCount, ...(skip === undefined ? {} : { skip }) }, repoPath);
		if (!result.ok) return { ok: false, code: result.code };
		return {
			ok: true,
			page: {
				commits: result.value.commits.map((commit) => ({ oid: commit.oid, parents: [...commit.parents], subject: commit.subject, authorName: commit.authorName, authorEmail: commit.authorEmail, authorTimeSec: Math.floor(commit.authorTimeMs / 1000) })),
				hasMore: result.value.hasMore,
			},
		};
	}
	const controller = {
		async refresh(force = false): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating) return;
			if (!cap.read) return;
			const generation = ++epoch;
			diffEpoch += 1;
			// History, detail and refs facts die with the snapshot facts; in-flight section loads are stale too.
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			// Clear previous facts during refresh; a failed read must not display a stale clean repository.
			const uncertainWrite = state.errorCode === "GIT_WRITE_RESULT_UNCONFIRMED";
			const failureCode = (code: string) => (uncertainWrite ? "GIT_WRITE_RESULT_UNCONFIRMED" : code);
			// A failed refresh cannot resolve an uncertain write; only fresh repository facts can.
			update({ projectKey, loading: true, diffLoading: false, ...(uncertainWrite ? { errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" } : {}) });
			try {
				// 显式刷新必须重新核对：已完成的旧缓存不能满足一次明确的刷新请求（force 通道在能力允许时使用）。
				const { facts, branch } = await readRepository(repoPath, force);
				if (!active || generation !== epoch) return;
				if (facts.ok) {
					// 一次成功的显式刷新才能解除「连接失效后暂停自动轮询」；失败/断开本身绝不重放一次读。
					statusRefresher.resume();
					update({ projectKey, loading: false, diffLoading: false, snapshot: { groups: facts.snapshot.groups, branch } });
				} else update({ projectKey, loading: false, diffLoading: false, errorCode: failureCode(facts.code) });
			} catch (error) {
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: failureCode(errorCode(error)) });
			}
		},
		/**
		 * The read capability is closed for this repository: publish the stable reason instead of reading. Nothing is
		 * retried here, and no effect may turn this into an implicit read.
		 */
		setUnavailable(reason: string): void {
			if (!active) return;
			stopPolling();
			update({ projectKey, loading: false, diffLoading: false, blockedReason: reason });
		},
		/**
		 * A write was in flight when this controller was retired (disconnect, rebind, root change): the reply is gone,
		 * so the new generation starts from "unconfirmed" instead of a clean repository. The existing refresh path
		 * keeps the code while it loads and only a successful fact read clears it; nothing is replayed.
		 */
		setUncertain(): void {
			if (!active) return;
			stopPolling();
			update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
		},
		async mutate(operation: "stage" | "unstage", group: GitResourceGroupType, target: ProjectFileTarget): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating || !cap.write || !state.snapshot) return;
			if (target.projectId !== projectId || (operation === "unstage" ? group !== "index" : group !== "workingTree" && group !== "untracked")) return;
			if (!state.snapshot.groups[group].some((resource) => resource.target.projectId === projectId && resource.target.relativePath === target.relativePath)) return;
			const generation = ++epoch;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, mutating: true, mutatingKind: "index", errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.mutateIndex(operation, group, target, repoPath);
				if (!active || generation !== epoch) return;
				if (!result.ok) {
					update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
					return;
				}
				update({ projectKey, loading: false, diffLoading: false });
				await controller.refresh();
			} catch {
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		async commit(message: string): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating || !cap.write || !state.snapshot) return;
			// The panel keeps the text; main re-validates it, so an empty/oversized message never reaches the helper.
			if (typeof message !== "string" || message.trim().length === 0 || message.includes("\0")) return;
			const generation = ++epoch;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, mutating: true, mutatingKind: "commit", errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.commit(message, repoPath);
				if (!active || generation !== epoch) return;
				if (!result.ok) {
					// A refusal and an unknown result both drop the facts: only a fresh read may show a clean repository.
					update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
					return;
				}
				update({ projectKey, loading: false, diffLoading: false, confirmedCommits: (state.confirmedCommits ?? 0) + 1 });
				await controller.refresh();
			} catch {
				// The commit may have happened; never retry it, and say so until the user refreshes.
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		async openDiff(group: GitResourceGroupType, target: ProjectFileTarget) {
			if (!active || state.loading || state.diffLoading || state.mutating || !cap.diff || !state.snapshot || target.projectId !== projectId) return;
			const generation = epoch;
			const request = ++diffEpoch;
			update({ ...state, diff: undefined, diffKind: "workspace", diffGroup: group, diffErrorCode: undefined, diffLoading: true });
			try {
				const diff = await api.workspaceFileDiff(group, target, repoPath);
				if (!active || generation !== epoch || request !== diffEpoch) return;
				if (!diff || diff.target.projectId !== projectId || diff.target.relativePath !== target.relativePath) update({ ...state, diffLoading: false, diffErrorCode: "GIT_RESOURCE_CHANGED" });
				else update({ ...state, diffLoading: false, diff });
			} catch (error) {
				if (active && generation === epoch && request === diffEpoch) update({ ...state, diffLoading: false, diffErrorCode: errorCode(error) });
			}
		},
		closeDiff() {
			if (!active || state.diffLoading || state.mutating) return;
			diffEpoch += 1;
			update({ ...state, diff: undefined, diffKind: undefined, diffGroup: undefined, diffLoading: false, diffErrorCode: undefined });
		},
		/* Read-only history (G3a): every load is a user action; nothing here polls, connects or writes. */
		async loadHistory(): Promise<void> {
			if (!active || state.loading || state.mutating || state.historyLoading || state.historyMoreLoading || !cap.history) return;
			const generation = ++historyEpoch;
			update({ ...state, history: undefined, historyErrorCode: undefined, historyLoading: true, detail: undefined, detailOid: undefined, detailErrorCode: undefined });
			try {
				const result = await readHistoryPage(50);
				if (!active || generation !== historyEpoch) return;
				if (result.ok) update({ ...state, historyLoading: false, history: result.page });
				else update({ ...state, historyLoading: false, historyErrorCode: result.code });
			} catch (error) {
				if (active && generation === historyEpoch) update({ ...state, historyLoading: false, historyErrorCode: errorCode(error) });
			}
		},
		async loadMoreHistory(): Promise<void> {
			if (!active || state.loading || state.mutating || state.historyLoading || state.historyMoreLoading || !cap.history || !state.history?.hasMore) return;
			const generation = ++historyEpoch;
			const skip = state.history.commits.length;
			update({ ...state, historyMoreLoading: true, historyErrorCode: undefined });
			try {
				const result = await readHistoryPage(50, skip);
				if (!active || generation !== historyEpoch) return;
				if (result.ok) update({ ...state, historyMoreLoading: false, history: { commits: [...state.history.commits, ...result.page.commits], hasMore: result.page.hasMore } });
				// A failed page keeps the rows already on screen; only a fresh full load replaces them.
				else update({ ...state, historyMoreLoading: false, historyErrorCode: result.code });
			} catch (error) {
				if (active && generation === historyEpoch) update({ ...state, historyMoreLoading: false, historyErrorCode: errorCode(error) });
			}
		},
		async openCommitDetail(oid: string): Promise<void> {
			// A new click always supersedes the flight in progress; the detail epoch decides which answer may publish.
			if (!active || state.loading || state.mutating || !cap.history) return;
			if (typeof oid !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) return;
			const generation = ++detailEpoch;
			update({ ...state, detailOid: oid, detail: undefined, detailErrorCode: undefined, detailLoading: true });
			try {
				const result = await api.commitDetail(oid, repoPath);
				if (!active || generation !== detailEpoch) return;
				if (result.ok && result.detail.oid === oid) update({ ...state, detailLoading: false, detail: result.detail });
				else update({ ...state, detailLoading: false, detailErrorCode: result.ok ? "GIT_RESOURCE_CHANGED" : result.code });
			} catch (error) {
				if (active && generation === detailEpoch) update({ ...state, detailLoading: false, detailErrorCode: errorCode(error) });
			}
		},
		async loadRefs(): Promise<void> {
			if (!active || state.loading || state.mutating || state.refsLoading || !cap.refs) return;
			// A manual load owns the next visible answer; an in-flight poll's answer is retired below.
			refsPollEpoch += 1;
			const generation = ++refsEpoch;
			update({ ...state, refs: undefined, refsErrorCode: undefined, refsLoading: true });
			try {
				const result = await api.refs(repoPath);
				if (!active || generation !== refsEpoch) return;
				if (result.ok) update({ ...state, refsLoading: false, refs: result.refs });
				else update({ ...state, refsLoading: false, refsErrorCode: result.code });
			} catch (error) {
				if (active && generation === refsEpoch) update({ ...state, refsLoading: false, refsErrorCode: errorCode(error) });
			}
		},
		/**
		 * Two full local refs, compared by tree. Every click opens a new generation, so the last click wins:
		 * a slower earlier answer is dropped instead of overwriting the pair the user is looking at.
		 */
		async runCompare(base: string, head: string): Promise<void> {
			if (!active || state.loading || state.mutating || !cap.compare) return;
			// The panel only offers refs from the loaded list; main and the helper re-check the same rules.
			if (!validRemoteGitRefFullName(base) || !validRemoteGitRefFullName(head)) return;
			const generation = ++compareEpoch;
			update({ ...state, compare: undefined, compareErrorCode: undefined, compareLoading: true });
			try {
				const answer = await api.compareRefs(base, head, repoPath);
				const result: RemoteGitCompareResult = answer.ok
					? {
							ok: true,
							compare: {
								// 语义必须跟着答案走：trees 才显示「无 merge-base / ahead-behind」的能力说明，
								// merge-base 有 ahead/behind，不能再提示缺失。
								mode: answer.value.mode,
								...(answer.value.ahead === undefined ? {} : { ahead: answer.value.ahead }),
								...(answer.value.behind === undefined ? {} : { behind: answer.value.behind }),
								base: { ref: answer.value.base.ref, oid: answer.value.base.oid },
								head: { ref: answer.value.head.ref, oid: answer.value.head.oid },
								files: answer.value.files.map((file) => ({ status: file.status, path: file.path, ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }) })),
							},
						}
					: { ok: false, code: answer.code };
				if (!active || generation !== compareEpoch) return;
				if (result.ok && result.compare.base.ref === base && result.compare.head.ref === head) update({ ...state, compareLoading: false, compare: result.compare });
				else update({ ...state, compareLoading: false, compareErrorCode: result.ok ? "GIT_RESOURCE_CHANGED" : result.code });
			} catch (error) {
				if (active && generation === compareEpoch) update({ ...state, compareLoading: false, compareErrorCode: errorCode(error) });
			}
		},
		/**
		 * A quiet refs read for the bounded poll: it never clears the rows on screen (a tick must not flash an
		 * empty section) and a failed tick keeps the last good list plus its stable code. It is a read only:
		 * no fetch, no write, no sync facts.
		 */
		async pollRefs(): Promise<void> {
			// Single-flight: one poll at a time, never alongside a manual load, and only once facts exist.
			if (!active || state.loading || state.mutating || state.refsLoading || refsPollInFlight || state.refs === undefined || !cap.refs) return;
			refsPollInFlight = true;
			const generation = ++refsPollEpoch;
			const refsGeneration = refsEpoch;
			try {
				const result = await api.refs(repoPath);
				if (!active || generation !== refsPollEpoch || refsGeneration !== refsEpoch) return;
				if (result.ok) update({ ...state, refs: result.refs, refsErrorCode: undefined });
				else update({ ...state, refsErrorCode: result.code });
			} catch (error) {
				if (active && generation === refsPollEpoch && refsGeneration === refsEpoch) update({ ...state, refsErrorCode: errorCode(error) });
			} finally {
				refsPollInFlight = false;
			}
		},
		/** Collapsing, hiding, switching project or unmounting must retire a poll that is still in flight. */
		stopRefsPolling() {
			refsPollEpoch += 1;
		},
		// 静默 status 刷新（P0-3）：只换 snapshot/errorCode；不置 loading、不清 diff/history/refs。
		refreshStatus: statusRefresher.refreshStatus,
		stopStatusPolling: statusRefresher.stop,
		/** One file's two sides between two revisions, on the same surface as a workspace diff. */
		async openHistoryFileDiff(base: string | null, head: string, target: ProjectFileTarget) {
			if (!active || state.loading || state.diffLoading || state.mutating || !cap.diff || target.projectId !== projectId) return;
			if (typeof head !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) || (base !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base))) return;
			const generation = epoch;
			const request = ++diffEpoch;
			update({ ...state, diff: undefined, diffKind: "revision", diffGroup: undefined, diffErrorCode: undefined, diffLoading: true });
			try {
				const result = await api.refFileDiff(base, head, target, repoPath);
				if (!active || generation !== epoch || request !== diffEpoch) return;
				const diff = result.ok ? result.diff : undefined;
				if (!diff || diff.target.projectId !== projectId || diff.target.relativePath !== target.relativePath || diff.head !== head || diff.base !== base) update({ ...state, diffLoading: false, diffErrorCode: result.ok ? "GIT_RESOURCE_CHANGED" : result.code });
				else update({ ...state, diffLoading: false, diff });
			} catch (error) {
				if (active && generation === epoch && request === diffEpoch) update({ ...state, diffLoading: false, diffErrorCode: errorCode(error) });
			}
		},
		/**
		 * The recoverable destructive action: the provider authorizes it with main's grant, the helper snapshots the
		 * bytes first, and the panel only ever learns where they went. An unknown outcome keeps the warning and is
		 * never replayed, because the file has already been touched by the time the reply could be lost.
		 */
		async discard(group: "workingTree" | "untracked", target: ProjectFileTarget): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating || !cap.write || !state.snapshot) return;
			if (target.projectId !== projectId || (group !== "workingTree" && group !== "untracked")) return;
			if (!state.snapshot.groups[group].some((resource) => resource.target.projectId === projectId && resource.target.relativePath === target.relativePath)) return;
			const generation = ++epoch;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, mutating: true, mutatingKind: "discard", discardRecovery: undefined, errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.discard(group, target, repoPath);
				if (!active || generation !== epoch) return;
				if (!result.ok) {
					update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
					return;
				}
				update({ projectKey, loading: false, diffLoading: false, discardRecovery: { ref: result.recoveryRef, path: target.relativePath } });
				await controller.refresh();
			} catch {
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		/* G5a sync: facts are read on demand; every verb is a network side effect and is never replayed. */
		async loadSync(): Promise<void> {
			// Reading the remote chain does not depend on a repository read being finished, and it has its own
			// single-flight guard; blocking it on `loading` would drop the load that follows the first read.
			if (!active || !cap.syncFacts || state.syncLoading) return;
			const generation = ++syncEpoch;
			update({ ...state, sync: undefined, syncErrorCode: undefined, syncLoading: true });
			try {
				const result = await api.syncFacts(repoPath);
				if (!active || generation !== syncEpoch) return;
				if (result.ok) update({ ...state, syncLoading: false, sync: result.facts });
				else update({ ...state, syncLoading: false, syncErrorCode: result.code });
			} catch (error) {
				if (active && generation === syncEpoch) update({ ...state, syncLoading: false, syncErrorCode: errorCode(error) });
			}
		},
		/** One network verb: it may change the remote or the worktree, so an unknown result is never replayed. */
		async sync(kind: "fetch" | "push" | "pull", remote: string, branch: string): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating || !cap.sync || !state.sync) return;
			if (state.sync.remotes.indexOf(remote) < 0) return;
			if (kind !== "fetch" && state.sync.branch !== branch) return;
			const generation = ++epoch;
			syncEpoch += 1;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, mutating: true, mutatingKind: kind, syncNotice: undefined, errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = kind === "fetch" ? await api.fetch(remote, repoPath) : kind === "push" ? await api.push(remote, branch, repoPath) : await api.pull(remote, branch, repoPath);
				if (!active || generation !== epoch) return;
				if (!result.ok) {
					update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
					return;
				}
				// The service layer reports completion, not a remote-side mode: the verb itself is the closed outcome.
				update({ projectKey, loading: false, diffLoading: false, syncNotice: { kind, outcome: kind === "fetch" ? "fetched" : kind === "push" ? "pushed" : "pulled" } });
				await controller.refresh();
				await controller.loadSync();
			} catch {
				// The remote may have moved: say so instead of pretending nothing happened, and never retry.
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		fetch(remote: string): Promise<void> {
			return controller.sync("fetch", remote, state.sync?.branch ?? "");
		},
		push(remote: string, branch: string): Promise<void> {
			return controller.sync("push", remote, branch);
		},
		pull(remote: string, branch: string): Promise<void> {
			return controller.sync("pull", remote, branch);
		},
		/* G4b recovery store: the listing is a manual read, restore and drop are one-shot writes with their own grants. */
		async loadRecovery(): Promise<void> {
			if (!active || state.loading || state.mutating || state.recoveryLoading || !cap.recovery) return;
			const generation = ++recoveryEpoch;
			update({ ...state, recovery: undefined, recoveryErrorCode: undefined, recoveryLoading: true });
			try {
				const result = await api.recoveryList(repoPath);
				if (!active || generation !== recoveryEpoch) return;
				if (result.ok) update({ ...state, recoveryLoading: false, recovery: { entries: result.entries, truncated: result.truncated } });
				else update({ ...state, recoveryLoading: false, recoveryErrorCode: result.code });
			} catch (error) {
				if (active && generation === recoveryEpoch) update({ ...state, recoveryLoading: false, recoveryErrorCode: errorCode(error) });
			}
		},
		/** Puts the snapshot's bytes back; main and the helper decide whether the target may be written at all. */
		async restoreRecovery(entry: RemoteGitRecoveryEntryView): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating || !cap.recovery || !state.snapshot) return;
			if (!entry || typeof entry.ref !== "string" || !/^refs\/pideck\/recovery\/[A-Za-z0-9._-]+$/.test(entry.ref) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.oid)) return;
			const generation = ++epoch;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, mutating: true, mutatingKind: "restore", recoveryNotice: undefined, errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.recoveryRestore(entry.ref, entry.oid, entry.path, repoPath);
				if (!active || generation !== epoch) return;
				if (!result.ok) {
					update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
					return;
				}
				update({ projectKey, loading: false, diffLoading: false, recoveryNotice: { kind: "restored", path: entry.path } });
				await controller.refresh();
				await controller.loadRecovery();
			} catch {
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		/** The only action that makes a snapshot disappear; the helper deletes it with a compare-and-swap. */
		async dropRecovery(entry: RemoteGitRecoveryEntryView): Promise<void> {
			if (!active || state.loading || state.mutating || !cap.recovery || !state.snapshot) return;
			if (!entry || typeof entry.ref !== "string" || !/^refs\/pideck\/recovery\/[A-Za-z0-9._-]+$/.test(entry.ref) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.oid)) return;
			const generation = ++epoch;
			update({ ...state, mutating: true, mutatingKind: "drop", recoveryNotice: undefined, errorCode: undefined });
			try {
				const result = await api.recoveryDrop(entry.ref, entry.oid, repoPath);
				if (!active || generation !== epoch) return;
				if (!result.ok) {
					update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
					return;
				}
				update({ projectKey, loading: false, diffLoading: false, recoveryNotice: { kind: "dropped", path: entry.path } });
				// A dropped snapshot does not change the worktree, but the panel still re-reads the repository: the
				// success update above carries no facts, and the outcome the user needs lives inside that subtree.
				await controller.refresh();
				await controller.loadRecovery();
			} catch {
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		/* G3b branch write face: one explicit action per click, an unknown outcome is never replayed, and only a
		confirmed answer re-reads the repository. The name is refused here as well as in main, never adapted. */
		async createBranch(name: string): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating || !cap.branchWrite || cap.branchCreateMode === "none" || !state.snapshot) return;
			if (!validRemoteGitBranchName(name)) return;
			const generation = ++epoch;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, mutating: true, mutatingKind: "branch", errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.createBranch(name, repoPath);
				if (!active || generation !== epoch) return;
				if (!result.ok) {
					update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
					return;
				}
				update({ projectKey, loading: false, diffLoading: false });
				await controller.refresh();
			} catch {
				// A ref write with a lost reply may well have happened: say unknown instead of retrying it.
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		async switchBranch(name: string): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating || !cap.branchWrite || !state.snapshot) return;
			if (!validRemoteGitBranchName(name)) return;
			if (state.snapshot.branch === name) return;
			const generation = ++epoch;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, mutating: true, mutatingKind: "switch", errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.switchBranch(name, repoPath);
				if (!active || generation !== epoch) return;
				if (!result.ok) {
					update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
					return;
				}
				update({ projectKey, loading: false, diffLoading: false });
				await controller.refresh();
			} catch {
				// The checkout may have happened; never replay it, and keep saying the result is unknown.
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		/**
		 * Explicit repository creation at the project root. It is a write with no token (there is no confirmed
		 * repository state to bind one to), so it gets everything else a write gets: single-flight, a generation
		 * fence that retires a slow answer after a project switch, connection loss or refresh, and a refreshed
		 * snapshot as its only success report. A refusal drops the stale facts; an unknown result - the reply was
		 * lost after the helper may have created .git - keeps the uncertainty warning and is never replayed or
		 * auto-refreshed: only a successful explicit refresh can clear it.
		 */
		async initRepository(): Promise<boolean> {
			if (!active || state.loading || state.diffLoading || state.mutating || state.initializing || !cap.init) return false;
			// Init creates .git at the project root only: a nested scope never offers it.
			if (repoPath !== "") return false;
			// Only a confirmed non-repository offers this action; anything else is a main/helper decision, not a guess.
			if (state.errorCode !== "GIT_NOT_REPOSITORY") return false;
			const generation = ++epoch;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, initializing: true, mutating: true, mutatingKind: "init", initNotice: undefined, errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.init();
				if (!active || generation !== epoch) return false;
				if (!result.ok) {
					update({ projectKey, loading: false, diffLoading: false, initializing: false, errorCode: result.code });
					return false;
				}
				update({ projectKey, loading: false, diffLoading: false, initializing: false, initNotice: { branch: result.branch } });
				await controller.refresh();
				return true;
			} catch {
				// The helper may have created .git before the reply was lost: say so and never retry or auto-refresh.
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, initializing: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
				return false;
			}
		},
		/** Connection transitions invalidate facts without automatically reconnecting or refreshing. */
		invalidateConnection() {
			if (!active) return;
			// 断开/重连只作废事实，不自己读回来：暂停自动轮询，直到一次成功的显式 refresh()。
			statusRefresher.pause();
			epoch += 1;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			cancelReads();
			// Reconnect may emit several failure states; retain uncertainty until a successful explicit refresh.
			const uncertainWrite = state.mutating || state.errorCode === "GIT_WRITE_RESULT_UNCONFIRMED";
			update({ projectKey, loading: false, diffLoading: false, errorCode: uncertainWrite ? "GIT_WRITE_RESULT_UNCONFIRMED" : "REMOTE_CONNECTION_LOST" });
		},
		/** Component/project identity changes invalidate results; they never connect/replay automatically. */
		dispose() {
			active = false;
			cancelReads();
			epoch += 1;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
		},
	};
	return controller;
}
