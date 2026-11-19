import {
	GitStatus,
	type GitReadSnapshot,
	type GitResource,
	type GitResourceGroups,
	type GitResourceGroupType,
	type GitWorkspaceFileDiff,
	type RemoteGitCommitDetail,
	type RemoteGitLogPage,
	type RemoteGitRefFileDiff,
	type RemoteGitRecoveryEntryView,
	type RemoteGitRepo,
	type RemoteGitRefs,
	type RemoteGitFetchOutcome,
	type RemoteGitPullOutcome,
	type RemoteGitPushOutcome,
	type RemoteGitSyncFactsView,
	type RemoteGitCompare,
} from "../../shared/types/git";
import type { ProjectFileTarget } from "../../shared/types/project";
import type { RemoteGitCompareMode } from "../remote/RemoteHelperContract";
import { createRemoteGitHistoryMethods } from "./RemoteGitHistoryService";
import { parsePorcelainStatus } from "./gitStatusParser";
import {
	REMOTE_GIT_BRANCH_NAME_MAX_BYTES,
	REMOTE_GIT_COMMIT_MAX_FILES,
	REMOTE_GIT_COMMIT_MESSAGE_MAX_BYTES,
	REMOTE_GIT_COMPARE_MAX_FILES,
	REMOTE_GIT_DETAIL_MESSAGE_MAX_BYTES,
	REMOTE_GIT_IDENTITY_MAX_BYTES,
	REMOTE_GIT_LOG_DEFAULT_COUNT,
	REMOTE_GIT_LOG_MAX_COUNT,
	REMOTE_GIT_LOG_MAX_PARENTS,
	REMOTE_GIT_REPO_WRITE_METHODS,
	REMOTE_GIT_LOG_MAX_SKIP,
	REMOTE_GIT_MAX_RESOURCES,
	REMOTE_GIT_READ_TIMEOUT_MS,
	REMOTE_GIT_RECOVERY_MAX_ENTRIES,
	REMOTE_GIT_REPOS_MAX_REPOS,
	REMOTE_GIT_REPO_PATH_MAX_BYTES,
	REMOTE_GIT_REF_MAX_COUNT,
	REMOTE_GIT_REF_MAX_NAME_BYTES,
	REMOTE_GIT_STATUS_MAX_BYTES,
	REMOTE_GIT_STAGED_DIFF_MAX_CHARS,
	REMOTE_GIT_STAGED_DIFF_TRUNCATION_MARKER,
	REMOTE_GIT_SUBJECT_MAX_BYTES,
	REMOTE_GIT_SYNC_MAX_REMOTES,
	REMOTE_GIT_SYNC_TIMEOUT_MS,
	REMOTE_GIT_TEXT_MAX_BYTES,
	REMOTE_HELPER_PROTOCOL_VERSION,
} from "../remote/RemoteHelperContract";

import {
	projectFilePath,
	remoteGitCount,
	remoteGitMessage,
	remoteGitName,
	remoteGitOid,
	remoteGitParents,
	remoteGitRecoveryRef,
	remoteGitSubject,
	remoteGitSyncRef,
	remoteGitSyncRemote,
	remoteGitSyncUpstream,
	remoteGitTime,
	REMOTE_GIT_BODY_CONTROL,
	REMOTE_GIT_FILE_STATUS_PATTERN,
	REMOTE_GIT_NAME_CONTROL,
	REMOTE_GIT_OID_PATTERN,
	readRemoteGitCommitDetail,
	readRemoteGitCompare,
	readRemoteGitLog,
	readRemoteGitRepos,
	readRemoteGitRefs,
	readRemoteGitStatus,
	record,
	remoteGitFailureCode,
	remoteGitFailureDetail,
	remoteGitRefspecOk,
	remoteGitSnapshotExpectations,
	remoteGitSyncNames,
	repoRelativeFilePath,
	validateRemoteGitBranchName,
	validateRemoteGitPath,
	validateRemoteGitRefFullName,
	validateRemoteGitRepoPath,
	type RemoteGitLocator,
	type RemoteGitReadSnapshot,
	type RemoteGitSession,
	type RemoteGitWriteExpectation,
} from "./RemoteGitReadShapes";

export * from "./RemoteGitReadShapes";

/** 每一个会改动仓库的动词都在这里记账：回执丢失时只能报「未确认」，绝不重放。 */
const WRITE_METHODS = new Set<string>([...REMOTE_GIT_REPO_WRITE_METHODS, "git.init"]);

export function createRemoteGitService(ports: { locator(projectId: string): RemoteGitLocator | undefined; trusted(target: RemoteGitLocator): Promise<boolean>; withProject<T>(target: RemoteGitLocator, work: (session: RemoteGitSession) => Promise<T>, signal?: AbortSignal): Promise<T> }) {
	function target(projectId: string): RemoteGitLocator {
		if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) throw new Error("GIT_RESULT_INVALID");
		const locator = ports.locator(projectId);
		if (!locator) throw new Error("GIT_TARGET_CHANGED");
		return { hostId: locator.hostId, remotePath: locator.remotePath };
	}
	function assertCurrent(projectId: string, expected: RemoteGitLocator) {
		const current = ports.locator(projectId);
		if (!current || current.hostId !== expected.hostId || current.remotePath !== expected.remotePath) throw new Error("GIT_TARGET_CHANGED");
	}
	async function run<T>(
		projectId: string,
		method:
			| "git.status"
			| "git.workspaceDiff"
			| "git.stage"
			| "git.unstage"
			| "git.commit"
			| "git.log"
			| "git.commitDetail"
			| "git.refs"
			| "git.refFileDiff"
			| "git.compare"
			| "git.stagedDiff"
			| "git.init"
			| "git.repos"
			| "git.checkIgnore"
			| "git.createBranch"
			| "git.switchBranch"
			| "git.discard"
			| "git.recoveryList"
			| "git.recoveryRestore"
			| "git.recoveryDrop"
			| "git.syncFacts"
			| "git.fetch"
			| "git.push"
			| "git.pull"
			| "git.cherryPick"
			| "git.revert"
			| "git.reset"
			| "git.drop",
		params: unknown,
		signal: AbortSignal | undefined,
		parse: (value: unknown, session: RemoteGitSession, capabilities: unknown[]) => T,
		expected?: RemoteGitWriteExpectation,
		repo?: string,
	): Promise<T> {
		// The scope is part of the request identity: a grant minted for one repository can never be used against another.
		// This runs before the locator/trust/withProject boundary, so a cross-scope write is refused without any host work.
		const repoPath = validateRemoteGitRepoPath(repo);
		if (expected !== undefined && expected.repoPath !== repoPath) throw new Error("GIT_TARGET_CHANGED");
		const locator = target(projectId);
		let dispatchedWrite = false;
		try {
			if (expected && (expected.target.hostId !== locator.hostId || expected.target.remotePath !== locator.remotePath)) throw new Error("GIT_TARGET_CHANGED");
			if (signal?.aborted) throw new Error("REQUEST_CANCELLED");
			if (!(await ports.trusted(locator))) throw new Error("GIT_TRUST_REQUIRED");
			assertCurrent(projectId, locator);
			return await ports.withProject(
				locator,
				async (session) => {
					assertCurrent(projectId, locator);
					let activeId: string | undefined;
					const cancel = () => {
						if (activeId) void session.cancel(activeId, { timeoutMs: 3000 }).catch(() => undefined);
					};
					signal?.addEventListener("abort", cancel);
					async function request(name: string, input?: unknown, frameRepo?: string) {
						if (signal?.aborted) throw new Error("REQUEST_CANCELLED");
						assertCurrent(projectId, locator);
						try {
							if (WRITE_METHODS.has(name)) dispatchedWrite = true;
							// Network verbs own the long budget (G5a follow-up, plan section 5.16.2); every other Git
							// method keeps the read deadline. The client's request cap and the helper's per-method clamp
							// repeat the same split, so this value survives both boundaries instead of being truncated.
							const timeoutMs = name === "git.fetch" || name === "git.push" || name === "git.pull" ? REMOTE_GIT_SYNC_TIMEOUT_MS : REMOTE_GIT_READ_TIMEOUT_MS;
							const result = await session.request(name, input, {
								timeoutMs,
								...(frameRepo === undefined || frameRepo === "" ? {} : { repo: frameRepo }),
								onRequestId: (id) => {
									activeId = id;
									if (signal?.aborted) cancel();
								},
							});
							if (signal?.aborted) throw new Error("REQUEST_CANCELLED");
							assertCurrent(projectId, locator);
							return result;
						} finally {
							activeId = undefined;
						}
					}
					try {
						const hello = await request("hello");
						if (!record(hello) || hello.protocolVersion !== REMOTE_HELPER_PROTOCOL_VERSION || hello.root !== locator.remotePath || !Array.isArray(hello.capabilities) || !hello.capabilities.includes(method)) throw new Error("UNSUPPORTED_CAPABILITY");
						// Trust is mutable while the host lock is queued; check it at the actual operation boundary.
						if (!(await ports.trusted(locator))) throw new Error("GIT_TRUST_REQUIRED");
						if (expected && session.hostRevision !== expected.hostRevision) throw new Error("GIT_TARGET_CHANGED");
						return parse(await request(method, params, repoPath), session, hello.capabilities);
					} finally {
						signal?.removeEventListener("abort", cancel);
					}
				},
				signal,
			);
		} catch (error) {
			// helper 自带的 stderr 摘要（闭集码 + 一句原文）随失败一起上来：界面要与本机一样能看到原因。
			const code = remoteGitFailureCode(error),
				detail = remoteGitFailureDetail(error);
			if (dispatchedWrite && ["GIT_RESULT_INVALID", "REQUEST_TIMEOUT", "REQUEST_CANCELLED", "REMOTE_CONNECTION_LOST", "GIT_TARGET_CHANGED", "GIT_COMMAND_FAILED"].includes(code))
				throw Object.assign(new Error("GIT_WRITE_RESULT_UNCONFIRMED"), { code: "GIT_WRITE_RESULT_UNCONFIRMED", ...(detail === undefined ? {} : { detail }) });
			throw Object.assign(new Error(code), { code, ...(detail === undefined ? {} : { detail }) });
		}
	}
	return {
		status(projectId: string, repo: string | undefined, signal?: AbortSignal): Promise<RemoteGitReadSnapshot> {
			const repoPath = validateRemoteGitRepoPath(repo);
			return run(
				projectId,
				"git.status",
				{},
				signal,
				(value, session, capabilities) => {
					const snapshot = readRemoteGitStatus(value, projectId, repoPath);
					// Every confirmed scope hands out grants bound to itself (G5e): a nested snapshot authorizes nested writes
					// only, and the token layer refuses a grant used against another repository.
					if (record(value) && value.revision !== undefined) {
						if (typeof value.revision !== "string" || !/^[0-9a-f]{64}$/.test(value.revision)) throw new Error("GIT_RESULT_INVALID");
						const hostRevision = session.hostRevision;
						if (typeof hostRevision === "number" && Number.isSafeInteger(hostRevision) && hostRevision >= 0) {
							remoteGitSnapshotExpectations(snapshot, value.revision, hostRevision, target(projectId), repoPath, capabilities);
						}
					}
					return snapshot;
				},
				undefined,
				repoPath,
			);
		},
		/** The expectation is issued by main; renderer data never becomes a host/revision authority. */
		mutate(projectId: string, operation: "stage" | "unstage", group: GitResourceGroupType, file: ProjectFileTarget, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal): Promise<void> {
			if (file.projectId !== projectId || (operation === "unstage" ? group !== "index" : !["workingTree", "untracked"].includes(group))) throw new Error("GIT_RESULT_INVALID");
			// 公共 target 是项目相对；helper 只认仓库内路径（唯一的转换点）。
			const path = repoRelativeFilePath(projectId, repoPath, file);
			return run(
				projectId,
				operation === "stage" ? "git.stage" : "git.unstage",
				{ path, group, expectedRevision: expected.revision },
				signal,
				(value) => {
					if (!record(value) || value.applied !== true || Object.keys(value).length !== 1) throw new Error("GIT_RESULT_INVALID");
				},
				expected,
				repoPath,
			);
		},
		/** One commit of the exact index the user confirmed; the message is passed verbatim, bounded and NUL-free. */
		commit(projectId: string, message: string, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal): Promise<{ head: string; tree: string }> {
			if (expected.kind !== "commit") throw new Error("GIT_RESULT_INVALID");
			if (typeof message !== "string" || message.length === 0 || message.trim().length === 0 || message.includes("\0") || Buffer.byteLength(message, "utf8") > REMOTE_GIT_COMMIT_MESSAGE_MAX_BYTES) throw new Error("GIT_COMMIT_MESSAGE_EMPTY");
			return run(
				projectId,
				"git.commit",
				{ message, expectedRevision: expected.revision },
				signal,
				(value) => {
					const hash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
					if (!record(value) || value.applied !== true || Object.keys(value).length !== 3 || typeof value.head !== "string" || !hash.test(value.head) || typeof value.tree !== "string" || !hash.test(value.tree)) throw new Error("GIT_RESULT_INVALID");
					return { head: value.head, tree: value.tree };
				},
				expected,
				repoPath,
			);
		},
		workspaceDiff(projectId: string, group: GitResourceGroupType, file: ProjectFileTarget, repo: string | undefined, signal?: AbortSignal): Promise<GitWorkspaceFileDiff> {
			if (file.projectId !== projectId || !["merge", "index", "workingTree", "untracked"].includes(group)) throw new Error("GIT_RESULT_INVALID");
			const repoPath = validateRemoteGitRepoPath(repo);
			// 公共输入是项目相对 target；helper 只认仓库内路径（唯一的转换点）。
			const path = repoRelativeFilePath(projectId, repoPath, file);
			const projectPath = projectFilePath(repoPath, path);
			return run(
				projectId,
				"git.workspaceDiff",
				{ group, path },
				signal,
				(value) => {
					if (!record(value) || typeof value.originalContent !== "string" || typeof value.modifiedContent !== "string") throw new Error("GIT_RESULT_INVALID");
					for (const text of [value.originalContent, value.modifiedContent]) if (text.includes("\0") || Buffer.byteLength(text, "utf8") > REMOTE_GIT_TEXT_MAX_BYTES || Buffer.from(text, "utf8").toString("utf8") !== text) throw new Error("GIT_RESULT_INVALID");
					return { path: projectPath, target: { projectId, relativePath: projectPath }, displayPath: projectPath, originalContent: value.originalContent, modifiedContent: value.modifiedContent };
				},
				undefined,
				repoPath,
			);
		},
		/* Read-only history (G3a): no token, no write expectation, nothing staged or moved. */
		log(projectId: string, options: unknown, repo: string | undefined, signal?: AbortSignal): Promise<RemoteGitLogPage> {
			let maxCount = REMOTE_GIT_LOG_DEFAULT_COUNT;
			let skip = 0;
			let ref: string | undefined;
			let all = false;
			let withCount = false;
			if (options !== undefined) {
				if (!record(options) || Object.keys(options).some((key) => !["maxCount", "skip", "ref", "all", "withCount"].includes(key))) throw new Error("GIT_RESULT_INVALID");
				if (options.maxCount !== undefined) {
					if (typeof options.maxCount !== "number" || !Number.isSafeInteger(options.maxCount) || options.maxCount < 1 || options.maxCount > REMOTE_GIT_LOG_MAX_COUNT) throw new Error("GIT_RESULT_INVALID");
					maxCount = options.maxCount;
				}
				if (options.skip !== undefined) {
					if (typeof options.skip !== "number" || !Number.isSafeInteger(options.skip) || options.skip < 0 || options.skip > REMOTE_GIT_LOG_MAX_SKIP) throw new Error("GIT_RESULT_INVALID");
					skip = options.skip;
				}
				// A ref is the same full local name a compare takes; the helper refuses one that is not, before any Git work.
				if (options.ref !== undefined) ref = validateRemoteGitRefFullName(options.ref);
				if (options.all !== undefined) {
					if (typeof options.all !== "boolean") throw new Error("GIT_RESULT_INVALID");
					all = options.all;
				}
				if (options.withCount !== undefined) {
					if (typeof options.withCount !== "boolean") throw new Error("GIT_RESULT_INVALID");
					withCount = options.withCount;
				}
				// One history per page: a ref narrows it, --all replaces HEAD, and both at once is ambiguous.
				if (ref !== undefined && all) throw new Error("GIT_RESULT_INVALID");
			}
			// Only the fields that were asked for travel: an older helper sees exactly the payload it already knows.
			const params = { maxCount, skip, ...(ref === undefined ? {} : { ref }), ...(all ? { all } : {}), ...(withCount ? { withCount } : {}) };
			return run(projectId, "git.log", params, signal, (value) => readRemoteGitLog(value, withCount), undefined, validateRemoteGitRepoPath(repo));
		},
		commitDetail(projectId: string, oid: unknown, repo: string | undefined, signal?: AbortSignal): Promise<RemoteGitCommitDetail> {
			const value = remoteGitOid(oid);
			const repoPath = validateRemoteGitRepoPath(repo);
			return run(
				projectId,
				"git.commitDetail",
				{ oid: value },
				signal,
				(raw) => {
					const detail = readRemoteGitCommitDetail(raw, repoPath);
					if (detail.oid !== value) throw new Error("GIT_RESULT_INVALID");
					return detail;
				},
				undefined,
				repoPath,
			);
		},
		/**
		 * 忽略判定：一次调用问 git 一组路径，返回与请求逐位对应的布尔数组。
		 * 结果形状在客户端重新校验（数组、等长、布尔），所以 helper 的多余字段或多一位都不会被信任。
		 */
		checkIgnore(projectId: string, repo: string | undefined, paths: readonly string[], signal?: AbortSignal): Promise<boolean[]> {
			const validated = paths.map((path) => validateRemoteGitPath(path));
			return run(
				projectId,
				"git.checkIgnore",
				{ paths: validated },
				signal,
				(value) => {
					if (!record(value) || !Array.isArray(value.ignored) || value.ignored.length !== validated.length) throw new Error("GIT_RESULT_INVALID");
					if (value.ignored.some((flag) => typeof flag !== "boolean")) throw new Error("GIT_RESULT_INVALID");
					return value.ignored as boolean[];
				},
				undefined,
				validateRemoteGitRepoPath(repo),
			);
		},
		refs(projectId: string, repo: string | undefined, signal?: AbortSignal): Promise<RemoteGitRefs> {
			return run(projectId, "git.refs", {}, signal, (value) => readRemoteGitRefs(value), undefined, validateRemoteGitRepoPath(repo));
		},
		/** Bounded, side-effect-free discovery of the repositories under the project root; no token, no write. */
		listRepositories(projectId: string, signal?: AbortSignal): Promise<{ repos: RemoteGitRepo[]; truncated: boolean }> {
			return run(projectId, "git.repos", {}, signal, (value) => readRemoteGitRepos(value));
		},
		/**
		 * Read-only refs comparison: no token, no write expectation, nothing staged or moved.
		 * `mode` names the semantics instead of inferring them: "trees" (default) is the direct two-tree diff,
		 * "threeDot" also answers the merge base with ahead/behind and lists merge-base..head.
		 */
		compare(projectId: string, base: unknown, head: unknown, repo: string | undefined, signal?: AbortSignal, mode: RemoteGitCompareMode = "trees"): Promise<RemoteGitCompare> {
			const baseRef = validateRemoteGitRefFullName(base);
			const headRef = validateRemoteGitRefFullName(head);
			if (mode !== "trees" && mode !== "threeDot") throw new Error("GIT_RESULT_INVALID");
			const repoPath = validateRemoteGitRepoPath(repo);
			return run(projectId, "git.compare", { base: baseRef, head: headRef, ...(mode === "threeDot" ? { mode } : {}) }, signal, (value) => readRemoteGitCompare(value, baseRef, headRef, repoPath, mode), undefined, repoPath);
		},
		/**
		 * 暂存区 unified diff：AI 提交摘要的唯一输入。空暂存区是空串；超过 100 KiB 字符由 helper 截断并
		 * 追加固定标记，所以客户端永远能区分「没有暂存」与「答案被截断」。
		 */
		stagedDiff(projectId: string, repo: string | undefined, signal?: AbortSignal): Promise<string> {
			const repoPath = validateRemoteGitRepoPath(repo);
			return run(
				projectId,
				"git.stagedDiff",
				{},
				signal,
				(value) => {
					if (!record(value) || Object.keys(value).length !== 1 || typeof value.diff !== "string") throw new Error("GIT_RESULT_INVALID");
					if (value.diff.includes("\0") || value.diff.length > REMOTE_GIT_STAGED_DIFF_MAX_CHARS + REMOTE_GIT_STAGED_DIFF_TRUNCATION_MARKER.length) throw new Error("GIT_RESULT_INVALID");
					return value.diff;
				},
				undefined,
				repoPath,
			);
		},
		/**
		 * The explicit write that creates the repository at the project root. There is no main-owned token because there
		 * is no prior confirmed repository state to bind - the absence of .git is the whole precondition - but it still
		 * runs through the same trust/locator/host-ready boundary and is accounted as a write, so a reply lost after
		 * dispatch is reported as unconfirmed instead of retried.
		 */
		init(projectId: string, signal?: AbortSignal): Promise<{ branch: string | null }> {
			return run(projectId, "git.init", {}, signal, (value) => {
				if (!record(value) || Object.keys(value).length !== 1) throw new Error("GIT_RESULT_INVALID");
				const branch = value.branch === null ? null : remoteGitName(value.branch, 4096);
				return { branch };
			});
		},
		/** Creating a branch is a create-only native CAS at the HEAD the read confirmed; HEAD itself never moves. */
		createBranch(projectId: string, name: unknown, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal): Promise<{ branch: string }> {
			if (expected.kind !== "branch") throw new Error("GIT_RESULT_INVALID");
			const branch = validateRemoteGitBranchName(name);
			return run(
				projectId,
				"git.createBranch",
				{ name: branch, expectedHead: expected.head ?? null },
				signal,
				(value) => {
					if (!record(value) || value.applied !== true || Object.keys(value).length !== 2 || value.branch !== branch) throw new Error("GIT_RESULT_INVALID");
					return { branch };
				},
				expected,
				repoPath,
			);
		},
		/** Switching runs native `git switch` for an existing local branch; a conflicting worktree is refused. */
		switchBranch(projectId: string, name: unknown, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal): Promise<{ branch: string; head: string | null }> {
			if (expected.kind !== "switch") throw new Error("GIT_RESULT_INVALID");
			const branch = validateRemoteGitBranchName(name);
			return run(
				projectId,
				"git.switchBranch",
				{ name: branch, expectedHead: expected.head ?? null },
				signal,
				(value) => {
					if (!record(value) || value.applied !== true || Object.keys(value).length !== 3 || value.branch !== branch) throw new Error("GIT_RESULT_INVALID");
					if (value.head !== null && (typeof value.head !== "string" || !REMOTE_GIT_OID_PATTERN.test(value.head))) throw new Error("GIT_RESULT_INVALID");
					return { branch, head: value.head };
				},
				expected,
				repoPath,
			);
		},
		/**
		 * The recoverable one: main only ever names a project-relative path and a group, and the helper refuses the
		 * whole action unless the bytes are safely in the object store behind the returned recovery ref first.
		 */
		discard(projectId: string, group: unknown, file: ProjectFileTarget, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal): Promise<{ recoveryRef: string | null }> {
			if (expected.kind !== "discard") throw new Error("GIT_RESULT_INVALID");
			if (file.projectId !== projectId || (group !== "workingTree" && group !== "untracked")) throw new Error("GIT_RESULT_INVALID");
			// 公共输入是项目相对 target；helper 只认仓库内路径（唯一的转换点）。
			const path = repoRelativeFilePath(projectId, repoPath, file);
			return run(
				projectId,
				"git.discard",
				{ path, group, expectedRevision: expected.revision },
				signal,
				(value) => {
					if (!record(value) || value.applied !== true || Object.keys(value).length !== 4 || value.path !== path) throw new Error("GIT_RESULT_INVALID");
					if (value.mode !== "restored" && value.mode !== "removed") throw new Error("GIT_RESULT_INVALID");
					if (value.recoveryRef === null) return { recoveryRef: null };
					// The ref name is remote output: it may only name one of our own recovery refs, never another ref.
					if (typeof value.recoveryRef !== "string" || !new RegExp("^refs/pideck/recovery/[A-Za-z0-9._-]+$").test(value.recoveryRef)) throw new Error("GIT_RESULT_INVALID");
					return { recoveryRef: value.recoveryRef };
				},
				expected,
				repoPath,
			);
		},
		/** Read-only listing of the recovery namespace; nothing here needs a grant or touches the repository. */
		recoveryList(projectId: string, repo: string | undefined, signal?: AbortSignal): Promise<{ entries: RemoteGitRecoveryEntryView[]; truncated: boolean }> {
			const repoPath = validateRemoteGitRepoPath(repo);
			return run(
				projectId,
				"git.recoveryList",
				{},
				signal,
				(value) => {
					if (!record(value) || Object.keys(value).length !== 2 || typeof value.truncated !== "boolean" || !Array.isArray(value.entries) || value.entries.length > REMOTE_GIT_RECOVERY_MAX_ENTRIES) throw new Error("GIT_RESULT_INVALID");
					const entries = value.entries.map((entry) => {
						if (!record(entry) || Object.keys(entry).length !== 5) throw new Error("GIT_RESULT_INVALID");
						// The ref may only name our own namespace: remote output never becomes an arbitrary ref authority.
						if (typeof entry.ref !== "string" || !/^refs\/pideck\/recovery\/[A-Za-z0-9._-]+$/.test(entry.ref)) throw new Error("GIT_RESULT_INVALID");
						const bytes = remoteGitCount(entry.bytes);
						const at = remoteGitCount(entry.at);
						// 公共输出是项目相对路径（与 status/历史一致，可直接回传给 restore）。
						return { ref: entry.ref, oid: remoteGitOid(entry.oid), path: projectFilePath(repoPath, validateRemoteGitPath(entry.path)), bytes, at };
					});
					return { entries, truncated: value.truncated };
				},
				undefined,
				repoPath,
			);
		},
		/** One snapshot's raw bytes go back to its path, and only where the worktree still matches the index. */
		recoveryRestore(projectId: string, ref: unknown, oid: unknown, path: unknown, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal): Promise<{ path: string; bytes: number }> {
			if (expected.kind !== "restore") throw new Error("GIT_RESULT_INVALID");
			const target = remoteGitRecoveryRef(ref);
			const commit = remoteGitOid(oid);
			// 公共输入是项目相对路径；helper 只认仓库内路径。
			const relative = repoRelativeFilePath(projectId, repoPath, { projectId, relativePath: validateRemoteGitPath(path) });
			const projectPath = projectFilePath(repoPath, relative);
			return run(
				projectId,
				"git.recoveryRestore",
				{ ref: target, oid: commit, path: relative, expectedRevision: expected.revision },
				signal,
				(value) => {
					if (!record(value) || value.applied !== true || Object.keys(value).length !== 3 || value.path !== relative) throw new Error("GIT_RESULT_INVALID");
					return { path: projectPath, bytes: remoteGitCount(value.bytes) };
				},
				expected,
				repoPath,
			);
		},
		/** The one operation that discards a snapshot for good: a compare-and-swap on the exact commit listed. */
		recoveryDrop(projectId: string, ref: unknown, oid: unknown, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal): Promise<void> {
			if (expected.kind !== "drop") throw new Error("GIT_RESULT_INVALID");
			const target = remoteGitRecoveryRef(ref);
			const commit = remoteGitOid(oid);
			return run(
				projectId,
				"git.recoveryDrop",
				{ ref: target, oid: commit, expectedRevision: expected.revision },
				signal,
				(value) => {
					if (!record(value) || value.applied !== true || Object.keys(value).length !== 1) throw new Error("GIT_RESULT_INVALID");
				},
				expected,
				repoPath,
			);
		},
		/** Read-only sync facts: names and counts, never a URL (a remote URL can carry credentials). */
		syncFacts(projectId: string, repo: string | undefined, signal?: AbortSignal): Promise<RemoteGitSyncFactsView> {
			return run(
				projectId,
				"git.syncFacts",
				{},
				signal,
				(value) => {
					if (!record(value) || Object.keys(value).length !== 5 || !Array.isArray(value.remotes) || value.remotes.length > REMOTE_GIT_SYNC_MAX_REMOTES) throw new Error("GIT_RESULT_INVALID");
					const branch = value.branch === null ? null : remoteGitSyncRef(value.branch);
					const upstream = value.upstream === null ? null : remoteGitSyncUpstream(value.upstream);
					return { branch, upstream, ahead: remoteGitCount(value.ahead), behind: remoteGitCount(value.behind), remotes: value.remotes.map((name) => remoteGitSyncRemote(name)) };
				},
				undefined,
				validateRemoteGitRepoPath(repo),
			);
		},
		/** Fetch updates remote-tracking refs only; the helper verifies that nothing else moved. */
		fetch(projectId: string, remote: unknown, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal): Promise<RemoteGitFetchOutcome> {
			if (expected.kind !== "fetch") throw new Error("GIT_RESULT_INVALID");
			const name = remoteGitSyncRemote(remote);
			return run(
				projectId,
				"git.fetch",
				{ remote: name, expectedRevision: expected.revision },
				signal,
				(value) => {
					if (!record(value) || value.applied !== true || typeof value.upToDate !== "boolean" || !Array.isArray(value.updated)) throw new Error("GIT_RESULT_INVALID");
					const updated = value.updated.map((entry) => {
						if (!record(entry) || typeof entry.ref !== "string" || !entry.ref.startsWith("refs/remotes/" + name + "/") || typeof entry.after !== "string") throw new Error("GIT_RESULT_INVALID");
						return { ref: entry.ref, before: entry.before === null ? null : remoteGitOid(entry.before), after: remoteGitOid(entry.after) };
					});
					return { upToDate: value.upToDate, updated };
				},
				expected,
				repoPath,
			);
		},
		/** Push is never forced and never sets an upstream; the helper reports what the remote did. */
		push(projectId: string, remote: unknown, branch: unknown, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal): Promise<RemoteGitPushOutcome> {
			if (expected.kind !== "push") throw new Error("GIT_RESULT_INVALID");
			const { remote: name, branch: local, upstream } = remoteGitSyncNames(remote, branch);
			return run(
				projectId,
				"git.push",
				{ remote: name, branch: local, expectedRevision: expected.revision },
				signal,
				(value) => {
					if (!record(value) || value.applied !== true) throw new Error("GIT_RESULT_INVALID");
					if (value.outcome !== "up-to-date" && value.outcome !== "pushed" && value.outcome !== "new") throw new Error("GIT_RESULT_INVALID");
					// 显式模式只接受同名 refspec；upstream 模式允许远端侧名字不同（upstream 重命名配置）。
					if (typeof value.refspec !== "string" || value.refspec.length > 4096 || !remoteGitRefspecOk(value.refspec, upstream, local)) throw new Error("GIT_RESULT_INVALID");
					return { outcome: value.outcome, refspec: value.refspec };
				},
				expected,
				repoPath,
			);
		},
		/** Pull may rewrite HEAD and the worktree; the helper refuses a dirty tree and any strategy choice of its own. */
		pull(projectId: string, remote: unknown, branch: unknown, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal): Promise<RemoteGitPullOutcome> {
			if (expected.kind !== "pull") throw new Error("GIT_RESULT_INVALID");
			const { remote: name, branch: local, upstream } = remoteGitSyncNames(remote, branch);
			return run(
				projectId,
				"git.pull",
				{ remote: name, branch: local, expectedRevision: expected.revision },
				signal,
				(value) => {
					if (!record(value) || value.applied !== true) throw new Error("GIT_RESULT_INVALID");
					if (value.mode !== "up-to-date" && value.mode !== "fast-forward" && value.mode !== "merge") throw new Error("GIT_RESULT_INVALID");
					return { mode: value.mode, head: remoteGitOid(value.head) };
				},
				expected,
				repoPath,
			);
		},
		/** `base: null` names the side that does not exist; both sides missing is a refusal, not an empty diff. */
		refFileDiff(projectId: string, base: unknown, head: unknown, file: ProjectFileTarget, repo: string | undefined, signal?: AbortSignal): Promise<RemoteGitRefFileDiff> {
			if (file.projectId !== projectId) throw new Error("GIT_RESULT_INVALID");
			const repoPath = validateRemoteGitRepoPath(repo);
			// 公共输入是项目相对 target；helper 只认仓库内路径（唯一的转换点）。
			const path = repoRelativeFilePath(projectId, repoPath, file);
			const projectPath = projectFilePath(repoPath, path);
			const headOid = remoteGitOid(head);
			const baseOid = base === null ? null : remoteGitOid(base);
			return run(
				projectId,
				"git.refFileDiff",
				{ base: baseOid, head: headOid, path },
				signal,
				(raw) => {
					if (!record(raw) || Object.keys(raw).length !== 2 || typeof raw.originalContent !== "string" || typeof raw.modifiedContent !== "string") throw new Error("GIT_RESULT_INVALID");
					for (const text of [raw.originalContent, raw.modifiedContent]) if (text.includes("\0") || Buffer.byteLength(text, "utf8") > REMOTE_GIT_TEXT_MAX_BYTES) throw new Error("GIT_RESULT_INVALID");
					return { path: projectPath, target: { projectId, relativePath: projectPath }, displayPath: projectPath, base: baseOid, head: headOid, originalContent: raw.originalContent, modifiedContent: raw.modifiedContent };
				},
				undefined,
				repoPath,
			);
		},
		...createRemoteGitHistoryMethods({ run }),
	};
}
export type RemoteGitService = ReturnType<typeof createRemoteGitService>;
