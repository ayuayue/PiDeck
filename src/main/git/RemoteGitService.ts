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
	REMOTE_GIT_LOG_MAX_SKIP,
	REMOTE_GIT_MAX_RESOURCES,
	REMOTE_GIT_READ_TIMEOUT_MS,
	REMOTE_GIT_RECOVERY_MAX_ENTRIES,
	REMOTE_GIT_REPOS_MAX_REPOS,
	REMOTE_GIT_REPO_PATH_MAX_BYTES,
	REMOTE_GIT_REF_MAX_COUNT,
	REMOTE_GIT_REF_MAX_NAME_BYTES,
	REMOTE_GIT_STATUS_MAX_BYTES,
	REMOTE_GIT_SUBJECT_MAX_BYTES,
	REMOTE_GIT_SYNC_MAX_REMOTES,
	REMOTE_GIT_SYNC_TIMEOUT_MS,
	REMOTE_GIT_TEXT_MAX_BYTES,
	REMOTE_HELPER_PROTOCOL_VERSION,
} from "../remote/RemoteHelperContract";

export type RemoteGitLocator = { hostId: string; remotePath: string };
export type RemoteGitSession = {
	readonly hostRevision?: number;
	request(method: string, params?: unknown, options?: { timeoutMs?: number; onRequestId?: (id: string) => void; repo?: string }): Promise<unknown>;
	cancel(id: string, options?: { timeoutMs?: number }): Promise<unknown>;
};
/**
 * A main-owned capability: it says which confirmed revision, on which host identity, and which action kind it
 * authorizes. `head` is the HEAD the read confirmed, so a branch action can only ever be applied to the state
 * the user was looking at - the renderer names a branch, never the commit the branch may move to.
 */
export type RemoteGitWriteExpectation = { kind: "index" | "commit" | "branch" | "switch" | "discard" | "restore" | "drop" | "fetch" | "push" | "pull"; revision: string; hostRevision: number; target: RemoteGitLocator; repoPath: string; head?: string | null };
export type RemoteGitReadSnapshot = GitReadSnapshot & {
	writeExpectation?: RemoteGitWriteExpectation;
	commitExpectation?: RemoteGitWriteExpectation;
	branchExpectation?: RemoteGitWriteExpectation;
	switchExpectation?: RemoteGitWriteExpectation;
	discardExpectation?: RemoteGitWriteExpectation;
	restoreExpectation?: RemoteGitWriteExpectation;
	dropExpectation?: RemoteGitWriteExpectation;
	fetchExpectation?: RemoteGitWriteExpectation;
	pushExpectation?: RemoteGitWriteExpectation;
	pullExpectation?: RemoteGitWriteExpectation;
};

const ERRORS = new Set([
	"PATH_OUTSIDE_ROOT",
	"PATH_NOT_FOUND",
	"NOT_A_FILE",
	"PERMISSION_DENIED",
	"IO_ERROR",
	"RESULT_TOO_LARGE",
	"REQUEST_TIMEOUT",
	"REQUEST_CANCELLED",
	"REMOTE_CONNECTION_LOST",
	"GIT_NOT_FOUND",
	"GIT_VERSION_UNSUPPORTED",
	"GIT_NOT_REPOSITORY",
	"GIT_REPO_EXISTS",
	"GIT_UNSUPPORTED_REPOSITORY",
	"GIT_PLATFORM_UNSUPPORTED",
	"GIT_CONFIG_UNSUPPORTED",
	"GIT_COMMAND_FAILED",
	"GIT_RESULT_INVALID",
	"GIT_RESOURCE_CHANGED",
	"GIT_NOT_TEXT",
	"GIT_INDEX_LOCKED",
	"GIT_WRITE_UNSUPPORTED",
	"GIT_WRITE_RESULT_UNCONFIRMED",
	"GIT_WRITE_SNAPSHOT_EXPIRED",
	"GIT_COMMIT_NOTHING_STAGED",
	"GIT_COMMIT_MESSAGE_EMPTY",
	"GIT_COMMIT_IDENTITY_REQUIRED",
	"GIT_COMMIT_HEAD_CHANGED",
	"GIT_OBJECT_NOT_FOUND",
	"GIT_REF_EXISTS",
	"GIT_REF_NOT_FOUND",
	"GIT_SWITCH_CONFLICT",
	"GIT_RESTORE_CONFLICT",
	"GIT_RECOVERY_ENTRY_NOT_FOUND",
	"GIT_SYNC_REMOTE_UNKNOWN",
	"GIT_SYNC_DIRTY",
	"GIT_PULL_STRATEGY_REQUIRED",
	"GIT_PULL_CONFLICTS",
	"GIT_PUSH_REJECTED",
	"GIT_PUSH_REMOTE_REFUSED",
	"GIT_SYNC_FAILED",
	"REMOTE_FEATURE_DISABLED",
	"TOO_MANY_REQUESTS",
	"GIT_TRUST_REQUIRED",
	"GIT_TARGET_CHANGED",
	"UNSUPPORTED_CAPABILITY",
	"SSH_HOST_NOT_READY",
	"SSH_HOST_DISCONNECTED",
	"REMOTE_CONNECTION_SERVICE_DISPOSED",
]);
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * A branch is named, never addressed as a ref or a revision: the remote `check-ref-format --branch` decides what
 * Git accepts, and this list refuses the shapes a caller must not be able to smuggle in (full refs, object ids,
 * `@`, `@{...}`, a leading dash, backslashes and control characters).
 */
export function validateRemoteGitBranchName(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		Buffer.byteLength(value, "utf8") > REMOTE_GIT_BRANCH_NAME_MAX_BYTES ||
		/[\x00-\x1f\x7f\\]/.test(value) ||
		value === "@" ||
		value.startsWith("-") ||
		// Git refuses these in a ref name; refusing them here keeps the panel's local verdict equal to the remote's.
		value.includes("..") ||
		/[\s~^:?*[]/.test(value) ||
		value.includes("@{") ||
		value.startsWith("refs/") ||
		/^(?:HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_HEAD)$/.test(value) ||
		/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
	)
		throw new Error("GIT_RESULT_INVALID");
	return value;
}

/**
 * A comparison names the same full local refs the refs read returns: `refs/heads/*` or `refs/tags/*`.
 * A full name cannot be mistaken for an option, and both sides are resolved by the helper before any diff.
 * These rules are the main-process copy of the frozen helper's `readRef`; they run before an SSH session is
 * opened, and the helper re-checks them. Git's own check-ref-format accepts `refs/heads/-x`, `refs/heads/@` and
 * `refs/tags/v1.0{}` (measured), so those shapes are refused here on purpose: an option-like component, a lone
 * `@` component and braces (which would collide with the `^{commit}` argument the helper appends) are not names
 * this protocol uses.
 */
const REMOTE_GIT_REF_FORBIDDEN = /[\u0000-\u0020\u007f~^:?*[\\{}]/;
export function validateRemoteGitRefFullName(value: unknown): string {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > REMOTE_GIT_REF_MAX_NAME_BYTES || REMOTE_GIT_REF_FORBIDDEN.test(value) || value.includes("..") || value.includes("@{") || value.includes("//")) throw new Error("GIT_RESULT_INVALID");
	const prefix = value.startsWith("refs/heads/") ? "refs/heads/" : value.startsWith("refs/tags/") ? "refs/tags/" : null;
	if (prefix === null) throw new Error("GIT_RESULT_INVALID");
	const name = value.slice(prefix.length);
	if (!name || name.split("/").some((part) => !part || part === "." || part === ".." || part === "@" || part.startsWith(".") || part.startsWith("-") || part.endsWith(".") || part.endsWith(".lock"))) throw new Error("GIT_RESULT_INVALID");
	return value;
}

/** Restrict protocol diagnostics to the closed vocabulary; arbitrary remote stderr never crosses IPC. */
export function remoteGitFailureCode(error: unknown): string {
	const message = record(error) && typeof error.message === "string" ? error.message : "";
	return ERRORS.has(message) ? message : "GIT_COMMAND_FAILED";
}
/** A filename stays a literal project-relative POSIX value, including spaces and pathspec punctuation. */
export function validateRemoteGitPath(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		Buffer.byteLength(value, "utf8") > 4096 ||
		/[\x00-\x1f\x7f]/.test(value) ||
		value.startsWith("-") ||
		value.startsWith("/") ||
		value.includes("\\") ||
		/^[A-Za-z]:/.test(value) ||
		/%2e|%2f|%5c/i.test(value) ||
		value.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error("PATH_OUTSIDE_ROOT");
	return value;
}
/**
 * The per-request repository scope: a project-relative POSIX path naming a directory under the verified project root,
 * with "" (or absent) meaning the root itself. The main-process copy of the frozen helper's own rule; it runs before
 * an SSH session is opened, and the entry and worker re-check the same shape. A component that is itself .git or ends
 * in .lock is not a directory this protocol addresses, and Git would read it as metadata.
 */
export function validateRemoteGitRepoPath(value: unknown): string {
	if (value === undefined || value === null || value === "") return "";
	if (
		typeof value !== "string" ||
		Buffer.byteLength(value, "utf8") > REMOTE_GIT_REPO_PATH_MAX_BYTES ||
		/[\x00-\x1f\x7f]/.test(value) ||
		value.startsWith("-") ||
		value.startsWith("/") ||
		value.includes("\\") ||
		/^[A-Za-z]:/.test(value) ||
		/%2e|%2f|%5c/i.test(value) ||
		value.split("/").some((part) => !part || part === "." || part === ".." || /^\.git$/i.test(part) || part.endsWith(".lock"))
	)
		throw new Error("GIT_RESULT_INVALID");
	return value;
}
/**
 * 仓库 scope 的唯一归一化：接受字符串（旧远端控制器/helper 风格）或 `ProjectFileTarget`（共享 Git 通道/
 * 文件树风格）。对象必须是本项目的 target 且只带 `projectId`/`relativePath`，否则拒绝而不是猜。
 */
export function remoteGitRepoScope(projectId: string, value: unknown): string {
	if (value === undefined || value === null || value === "") return "";
	if (record(value)) {
		if (Object.keys(value).some((key) => key !== "projectId" && key !== "relativePath") || value.projectId !== projectId) throw new Error("GIT_RESULT_INVALID");
		return validateRemoteGitRepoPath(value.relativePath);
	}
	return validateRemoteGitRepoPath(value);
}

/**
 * 仓库内路径 → 项目相对路径（公共输出用）。`repoPath` 为空时两者相同；`repoPath` 自身先按仓库规则验证。
 */
export function projectFilePath(repoPath: string, repoRelativePath: string): string {
	const repo = validateRemoteGitRepoPath(repoPath);
	const path = validateRemoteGitPath(repoRelativePath);
	return repo === "" ? path : validateRemoteGitPath(`${repo}/${path}`);
}

/**
 * 项目相对 target → 仓库内路径（公共输入交给 helper 前用）。
 *
 * 严格按目录前缀匹配：`packages/a-other/x` **不是** `packages/a` 里的文件，`packages/a/x` 才是。
 * 不提供“有前缀就剥、没前缀也当合法”的猜测式兼容——同一个参数只能有一种语义。
 */
export function repoRelativeFilePath(projectId: string, repoPath: string, target: ProjectFileTarget): string {
	if (!record(target) || target.projectId !== projectId || typeof target.relativePath !== "string") throw new Error("GIT_RESULT_INVALID");
	const repo = validateRemoteGitRepoPath(repoPath);
	const path = validateRemoteGitPath(target.relativePath);
	if (repo === "") return path;
	const prefix = repo + "/";
	if (!path.startsWith(prefix)) throw new Error("GIT_RESULT_INVALID");
	return validateRemoteGitPath(path.slice(prefix.length));
}

/** Discovery output is re-validated field by field: unique project-relative paths, display names only, honest flag. */
export function readRemoteGitRepos(value: unknown): { repos: RemoteGitRepo[]; truncated: boolean } {
	if (!record(value) || Object.keys(value).length !== 2 || typeof value.truncated !== "boolean" || !Array.isArray(value.repos) || value.repos.length > REMOTE_GIT_REPOS_MAX_REPOS) throw new Error("GIT_RESULT_INVALID");
	const seen = new Set<string>();
	const repos = value.repos.map((entry) => {
		if (!record(entry) || Object.keys(entry).length !== 2) throw new Error("GIT_RESULT_INVALID");
		const path = validateRemoteGitRepoPath(entry.path);
		// A duplicate would make the panel offer two indistinguishable scopes; refuse instead of silently filtering.
		if (seen.has(path)) throw new Error("GIT_RESULT_INVALID");
		seen.add(path);
		if (typeof entry.name !== "string" || !entry.name || Buffer.byteLength(entry.name, "utf8") > 4096 || /[\x00-\x1f\x7f]/.test(entry.name)) throw new Error("GIT_RESULT_INVALID");
		return { path, name: entry.name };
	});
	return { repos, truncated: value.truncated };
}
/** Validate the complete machine format before feeding the existing SCM parser, which tolerates local legacy data. */
export function readRemoteGitStatus(value: unknown, projectId: string, repoPath = ""): RemoteGitReadSnapshot {
	if (!record(value) || typeof value.status !== "string" || value.status.length > 4 * Math.ceil(REMOTE_GIT_STATUS_MAX_BYTES / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.status)) throw new Error("GIT_RESULT_INVALID");
	const bytes = Buffer.from(value.status, "base64");
	if (bytes.length > REMOTE_GIT_STATUS_MAX_BYTES || bytes.toString("base64") !== value.status) throw new Error("GIT_RESULT_INVALID");
	if (value.head !== null && (typeof value.head !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.head))) throw new Error("GIT_RESULT_INVALID");
	if (value.branch !== null && (typeof value.branch !== "string" || !value.branch || Buffer.byteLength(value.branch) > 4096 || /[\x00-\x1f\x7f]/.test(value.branch))) throw new Error("GIT_RESULT_INVALID");
	let raw: string;
	try {
		raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new Error("GIT_RESULT_INVALID");
	}
	if (raw && !raw.endsWith("\0")) throw new Error("GIT_RESULT_INVALID");
	const records = raw ? raw.slice(0, -1).split("\0") : [];
	let count = 0;
	const intentPaths: string[] = [];
	for (let i = 0; i < records.length; i += 1) {
		let line = records[i];
		if (!line || line.length < 4 || line[2] !== " " || !/^[ MADRCUT?!]{2}$/.test(line.slice(0, 2))) throw new Error("GIT_RESULT_INVALID");
		// Git names an untracked directory - an embedded repository above all - with a trailing slash. The resource is
		// that directory's project-relative path, so the slash is removed before it becomes SCM data.
		if (line.length > 4 && line.endsWith("/")) line = line.slice(0, -1);
		records[i] = line;
		const filePath = line.slice(3);
		validateRemoteGitPath(filePath);
		if (line.startsWith(" A ")) intentPaths.push(filePath);
		if (/[RC]/.test(line.slice(0, 2))) validateRemoteGitPath(records[++i]);
		if (++count > REMOTE_GIT_MAX_RESOURCES) throw new Error("RESULT_TOO_LARGE");
	}
	// The existing SCM parser reads the same normalized records; the raw bytes are never shown to the renderer.
	const normalizedRaw = records.length > 0 ? records.join("\0") + "\0" : "";
	const groups: GitResourceGroups = { merge: [], index: [], workingTree: [], untracked: [] };
	// 公共 target 是**项目相对**的（与文件树/公共 Git 通道一致）：helper 的仓库内路径只在这一层出现一次。
	const repo = validateRemoteGitRepoPath(repoPath);
	const projectPath = (path: string): string => projectFilePath(repo, path);
	for (const parsed of parsePorcelainStatus(normalizedRaw)) {
		const relativePath = projectPath(parsed.path);
		const target: ProjectFileTarget = { projectId, relativePath };
		const resource: GitResource = { ...parsed, path: relativePath, target, displayPath: relativePath, ...(parsed.oldPath ? { oldPath: projectPath(parsed.oldPath), oldTarget: { projectId, relativePath: projectPath(parsed.oldPath) } } : {}) };
		if (resource.status === GitStatus.UNTRACKED) groups.untracked.push(resource);
		else if ([GitStatus.INDEX_MODIFIED, GitStatus.INDEX_ADDED, GitStatus.INDEX_DELETED, GitStatus.INDEX_RENAMED, GitStatus.INDEX_COPIED, GitStatus.INDEX_TYPE_CHANGED].includes(resource.status)) groups.index.push(resource);
		else if ([GitStatus.ADDED_BY_US, GitStatus.ADDED_BY_THEM, GitStatus.DELETED_BY_US, GitStatus.DELETED_BY_THEM, GitStatus.BOTH_ADDED, GitStatus.BOTH_DELETED, GitStatus.BOTH_MODIFIED].includes(resource.status)) groups.merge.push(resource);
		else groups.workingTree.push(resource);
	}
	// The local legacy parser omits Y=A (intent-to-add); remote reads must not lose that resource.
	for (const path of intentPaths) {
		const relativePath = projectPath(path);
		groups.workingTree.push({ path: relativePath, displayPath: relativePath, target: { projectId, relativePath }, status: GitStatus.INTENT_TO_ADD, letter: "A" });
	}
	return { groups, head: value.head, branch: value.branch };
}

const REMOTE_GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REMOTE_GIT_NAME_CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/;
const REMOTE_GIT_BODY_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const REMOTE_GIT_FILE_STATUS_PATTERN = /^(?:[AMDTUXB]|[RC]\d{1,3})$/;
/** Helper output is re-validated field by field before it crosses IPC; trust stays with the read, not the producer. */
function remoteGitOid(value: unknown): string {
	if (typeof value !== "string" || !REMOTE_GIT_OID_PATTERN.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
function remoteGitName(value: unknown, maxBytes: number): string {
	if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maxBytes || REMOTE_GIT_NAME_CONTROL.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
function remoteGitSubject(value: unknown): string {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > REMOTE_GIT_SUBJECT_MAX_BYTES || REMOTE_GIT_NAME_CONTROL.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
function remoteGitMessage(value: unknown): string {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > REMOTE_GIT_DETAIL_MESSAGE_MAX_BYTES || REMOTE_GIT_BODY_CONTROL.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
function remoteGitTime(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("GIT_RESULT_INVALID");
	return value;
}
/** A recovery ref is only ever one of ours: the namespace is the authority, not the remote's wording. */
function remoteGitRecoveryRef(value: unknown): string {
	if (typeof value !== "string" || !/^refs\/pideck\/recovery\/[A-Za-z0-9._-]+$/.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
/** A remote name and an upstream ref name are closed shapes; neither may smuggle a URL or a flag. */
function remoteGitSyncRemote(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
function remoteGitSyncUpstream(value: unknown): string {
	if (typeof value !== "string" || !/^refs\/remotes\/[A-Za-z0-9._-]+\/.{1,1024}$/.test(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
function remoteGitSyncRef(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
function remoteGitCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("GIT_RESULT_INVALID");
	return value;
}
function remoteGitParents(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > REMOTE_GIT_LOG_MAX_PARENTS) throw new Error("GIT_RESULT_INVALID");
	return value.map(remoteGitOid);
}
/** One bounded history page; hasMore comes from the extra record the helper fetched, never a total. */
export function readRemoteGitLog(value: unknown): RemoteGitLogPage {
	if (!record(value) || Object.keys(value).length !== 2 || typeof value.hasMore !== "boolean" || !Array.isArray(value.commits) || value.commits.length > REMOTE_GIT_LOG_MAX_COUNT) throw new Error("GIT_RESULT_INVALID");
	return {
		commits: value.commits.map((entry) => {
			if (!record(entry) || Object.keys(entry).length !== 6) throw new Error("GIT_RESULT_INVALID");
			return {
				oid: remoteGitOid(entry.oid),
				parents: remoteGitParents(entry.parents),
				authorName: remoteGitName(entry.authorName, REMOTE_GIT_IDENTITY_MAX_BYTES),
				authorEmail: remoteGitName(entry.authorEmail, REMOTE_GIT_IDENTITY_MAX_BYTES),
				authorTimeSec: remoteGitTime(entry.authorTimeSec),
				subject: remoteGitSubject(entry.subject),
			};
		}),
		hasMore: value.hasMore,
	};
}
/** One commit's byte-exact detail plus its changed files against the first parent. */
export function readRemoteGitCommitDetail(value: unknown, repoPath = ""): RemoteGitCommitDetail {
	if (!record(value) || Object.keys(value).length !== 11 || !Array.isArray(value.files) || value.files.length > REMOTE_GIT_COMMIT_MAX_FILES) throw new Error("GIT_RESULT_INVALID");
	return {
		oid: remoteGitOid(value.oid),
		parents: remoteGitParents(value.parents),
		authorName: remoteGitName(value.authorName, REMOTE_GIT_IDENTITY_MAX_BYTES),
		authorEmail: remoteGitName(value.authorEmail, REMOTE_GIT_IDENTITY_MAX_BYTES),
		authorTimeSec: remoteGitTime(value.authorTimeSec),
		committerName: remoteGitName(value.committerName, REMOTE_GIT_IDENTITY_MAX_BYTES),
		committerEmail: remoteGitName(value.committerEmail, REMOTE_GIT_IDENTITY_MAX_BYTES),
		committerTimeSec: remoteGitTime(value.committerTimeSec),
		subject: remoteGitSubject(value.subject),
		message: remoteGitMessage(value.message),
		files: value.files.map((file) => {
			if (!record(file)) throw new Error("GIT_RESULT_INVALID");
			const keys = Object.keys(file);
			const renamed = keys.includes("oldPath");
			if (!keys.includes("path") || !keys.includes("status") || (renamed ? keys.length !== 3 : keys.length !== 2)) throw new Error("GIT_RESULT_INVALID");
			if (typeof file.status !== "string" || !REMOTE_GIT_FILE_STATUS_PATTERN.test(file.status)) throw new Error("GIT_RESULT_INVALID");
			// 公共输出是项目相对路径（helper 的仓库内路径在本层归一）。
			const path = projectFilePath(validateRemoteGitRepoPath(repoPath), validateRemoteGitPath(file.path));
			return renamed ? { status: file.status, path, oldPath: projectFilePath(validateRemoteGitRepoPath(repoPath), validateRemoteGitPath(file.oldPath)) } : { status: file.status, path };
		}),
	};
}
/** Local branches and tags only; the current HEAD and branch name are read alongside. */
export function readRemoteGitRefs(value: unknown): RemoteGitRefs {
	if (!record(value) || Object.keys(value).length !== 3 || !Array.isArray(value.refs) || value.refs.length > REMOTE_GIT_REF_MAX_COUNT) throw new Error("GIT_RESULT_INVALID");
	const head = value.head === null ? null : remoteGitOid(value.head);
	const branch = value.branch === null ? null : remoteGitName(value.branch, 4096);
	return {
		head,
		branch,
		refs: value.refs.map((entry) => {
			if (!record(entry) || Object.keys(entry).length !== 4) throw new Error("GIT_RESULT_INVALID");
			const kind = entry.kind;
			if (kind !== "branch" && kind !== "tag") throw new Error("GIT_RESULT_INVALID");
			const prefix = kind === "branch" ? "refs/heads/" : "refs/tags/";
			const fullName = entry.fullName;
			if (typeof fullName !== "string" || !fullName.startsWith(prefix)) throw new Error("GIT_RESULT_INVALID");
			const name = fullName.slice(prefix.length);
			if (entry.name !== name || !name || Buffer.byteLength(name, "utf8") > REMOTE_GIT_REF_MAX_NAME_BYTES || REMOTE_GIT_NAME_CONTROL.test(name)) throw new Error("GIT_RESULT_INVALID");
			return { fullName, name, oid: remoteGitOid(entry.oid), kind };
		}),
	};
}

/**
 * Two full local refs, their trees, and a bounded changed-file list. The helper's echoed refs must be exactly
 * the requested names, so a remote answer can never redirect the panel to a different pair; each file is
 * re-validated with the same rules as a commit detail's file list.
 */
export function readRemoteGitCompare(value: unknown, base: string, head: string, repoPath = ""): RemoteGitCompare {
	if (!record(value) || Object.keys(value).length !== 3 || !record(value.base) || !record(value.head) || !Array.isArray(value.files) || value.files.length > REMOTE_GIT_COMPARE_MAX_FILES) throw new Error("GIT_RESULT_INVALID");
	const side = (raw: Record<string, unknown>, expected: string): RemoteGitCompare["base"] => {
		if (Object.keys(raw).length !== 2 || raw.ref !== expected) throw new Error("GIT_RESULT_INVALID");
		return { ref: expected, oid: remoteGitOid(raw.oid) };
	};
	return {
		base: side(value.base, base),
		head: side(value.head, head),
		files: value.files.map((file) => {
			if (!record(file)) throw new Error("GIT_RESULT_INVALID");
			const keys = Object.keys(file);
			if (typeof file.status !== "string" || !REMOTE_GIT_FILE_STATUS_PATTERN.test(file.status)) throw new Error("GIT_RESULT_INVALID");
			// Rename/copy records carry the old path; every other status must not pretend to have one.
			const renamed = file.status.startsWith("R") || file.status.startsWith("C");
			if (keys.includes("oldPath") !== renamed || !keys.includes("path") || keys.length !== (renamed ? 3 : 2)) throw new Error("GIT_RESULT_INVALID");
			// 公共输出是项目相对路径（与 status/历史一致）。
			const path = projectFilePath(validateRemoteGitRepoPath(repoPath), validateRemoteGitPath(file.path));
			return renamed ? { status: file.status, path, oldPath: projectFilePath(validateRemoteGitRepoPath(repoPath), validateRemoteGitPath(file.oldPath)) } : { status: file.status, path };
		}),
	};
}

/** Main-owned operation boundary: live project values, live trust and bound helper requests; never a local cwd. */
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
			| "git.pull",
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
							if (
								name === "git.init" ||
								name === "git.stage" ||
								name === "git.unstage" ||
								name === "git.commit" ||
								name === "git.createBranch" ||
								name === "git.switchBranch" ||
								name === "git.discard" ||
								name === "git.recoveryRestore" ||
								name === "git.recoveryDrop" ||
								name === "git.fetch" ||
								name === "git.push" ||
								name === "git.pull"
							)
								dispatchedWrite = true;
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
			const code = remoteGitFailureCode(error);
			if (dispatchedWrite && ["GIT_RESULT_INVALID", "REQUEST_TIMEOUT", "REQUEST_CANCELLED", "REMOTE_CONNECTION_LOST", "GIT_TARGET_CHANGED", "GIT_COMMAND_FAILED"].includes(code)) throw new Error("GIT_WRITE_RESULT_UNCONFIRMED");
			throw new Error(code);
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
							if (capabilities.includes("git.stage") && capabilities.includes("git.unstage")) snapshot.writeExpectation = { kind: "index", revision: value.revision, hostRevision, target: target(projectId), repoPath };
							if (capabilities.includes("git.commit")) snapshot.commitExpectation = { kind: "commit", revision: value.revision, hostRevision, target: target(projectId), repoPath };
							if (capabilities.includes("git.createBranch")) snapshot.branchExpectation = { kind: "branch", revision: value.revision, hostRevision, target: target(projectId), repoPath, head: snapshot.head };
							if (capabilities.includes("git.switchBranch")) snapshot.switchExpectation = { kind: "switch", revision: value.revision, hostRevision, target: target(projectId), repoPath, head: snapshot.head };
							if (capabilities.includes("git.discard")) snapshot.discardExpectation = { kind: "discard", revision: value.revision, hostRevision, target: target(projectId), repoPath };
							if (capabilities.includes("git.recoveryRestore")) snapshot.restoreExpectation = { kind: "restore", revision: value.revision, hostRevision, target: target(projectId), repoPath };
							if (capabilities.includes("git.recoveryDrop")) snapshot.dropExpectation = { kind: "drop", revision: value.revision, hostRevision, target: target(projectId), repoPath };
							if (capabilities.includes("git.fetch")) snapshot.fetchExpectation = { kind: "fetch", revision: value.revision, hostRevision, target: target(projectId), repoPath };
							if (capabilities.includes("git.push")) snapshot.pushExpectation = { kind: "push", revision: value.revision, hostRevision, target: target(projectId), repoPath };
							if (capabilities.includes("git.pull")) snapshot.pullExpectation = { kind: "pull", revision: value.revision, hostRevision, target: target(projectId), repoPath };
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
			if (options !== undefined) {
				if (!record(options) || Object.keys(options).some((key) => key !== "maxCount" && key !== "skip")) throw new Error("GIT_RESULT_INVALID");
				if (options.maxCount !== undefined) {
					if (typeof options.maxCount !== "number" || !Number.isSafeInteger(options.maxCount) || options.maxCount < 1 || options.maxCount > REMOTE_GIT_LOG_MAX_COUNT) throw new Error("GIT_RESULT_INVALID");
					maxCount = options.maxCount;
				}
				if (options.skip !== undefined) {
					if (typeof options.skip !== "number" || !Number.isSafeInteger(options.skip) || options.skip < 0 || options.skip > REMOTE_GIT_LOG_MAX_SKIP) throw new Error("GIT_RESULT_INVALID");
					skip = options.skip;
				}
			}
			return run(projectId, "git.log", { maxCount, skip }, signal, (value) => readRemoteGitLog(value), undefined, validateRemoteGitRepoPath(repo));
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
		/** Read-only refs comparison: no token, no write expectation, nothing staged or moved. */
		compare(projectId: string, base: unknown, head: unknown, repo: string | undefined, signal?: AbortSignal): Promise<RemoteGitCompare> {
			const baseRef = validateRemoteGitRefFullName(base);
			const headRef = validateRemoteGitRefFullName(head);
			const repoPath = validateRemoteGitRepoPath(repo);
			return run(projectId, "git.compare", { base: baseRef, head: headRef }, signal, (value) => readRemoteGitCompare(value, baseRef, headRef, repoPath), undefined, repoPath);
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
			const name = remoteGitSyncRemote(remote),
				local = validateRemoteGitBranchName(branch);
			return run(
				projectId,
				"git.push",
				{ remote: name, branch: local, expectedRevision: expected.revision },
				signal,
				(value) => {
					if (!record(value) || value.applied !== true) throw new Error("GIT_RESULT_INVALID");
					if (value.outcome !== "up-to-date" && value.outcome !== "pushed" && value.outcome !== "new") throw new Error("GIT_RESULT_INVALID");
					if (value.refspec !== `refs/heads/${local}:refs/heads/${local}`) throw new Error("GIT_RESULT_INVALID");
					return { outcome: value.outcome, refspec: value.refspec };
				},
				expected,
				repoPath,
			);
		},
		/** Pull may rewrite HEAD and the worktree; the helper refuses a dirty tree and any strategy choice of its own. */
		pull(projectId: string, remote: unknown, branch: unknown, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal): Promise<RemoteGitPullOutcome> {
			if (expected.kind !== "pull") throw new Error("GIT_RESULT_INVALID");
			const name = remoteGitSyncRemote(remote),
				local = validateRemoteGitBranchName(branch);
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
	};
}
export type RemoteGitService = ReturnType<typeof createRemoteGitService>;
