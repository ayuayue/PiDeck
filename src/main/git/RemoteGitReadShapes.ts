/**
 * 远端 Git 读面的**纯形状层**：把 helper 的答复校验成渲染层能信任的类型。
 *
 * 从 `RemoteGitService.ts` 拆出（文件体量门禁：存量巨文件只准降不准升）。这里没有会话、没有 IPC、
 * 没有 electron：只有「什么形状算合法」与「哪些值算可展示」。服务工厂（`createRemoteGitService`）
 * 仍然从原模块导出，并 `export *` 本模块，所以既有 import 路径不变。
 */

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
	REMOTE_GIT_STAGED_DIFF_MAX_CHARS,
	REMOTE_GIT_STAGED_DIFF_TRUNCATION_MARKER,
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
export type RemoteGitWriteExpectation = {
	kind: "index" | "commit" | "branch" | "switch" | "discard" | "restore" | "drop" | "fetch" | "push" | "pull" | "cherryPick" | "revert" | "reset" | "dropCommit";
	revision: string;
	hostRevision: number;
	target: RemoteGitLocator;
	repoPath: string;
	head?: string | null;
};

export type RemoteGitReadSnapshot = GitReadSnapshot & {
	writeExpectation?: RemoteGitWriteExpectation;
	commitExpectation?: RemoteGitWriteExpectation;
	branchExpectation?: RemoteGitWriteExpectation;
	switchExpectation?: RemoteGitWriteExpectation;
	discardExpectation?: RemoteGitWriteExpectation;
	restoreExpectation?: RemoteGitWriteExpectation;
	dropExpectation?: RemoteGitWriteExpectation;
	cherryPickExpectation?: RemoteGitWriteExpectation;
	revertExpectation?: RemoteGitWriteExpectation;
	resetExpectation?: RemoteGitWriteExpectation;
	dropCommitExpectation?: RemoteGitWriteExpectation;
	fetchExpectation?: RemoteGitWriteExpectation;
	pushExpectation?: RemoteGitWriteExpectation;
	pullExpectation?: RemoteGitWriteExpectation;
};

/**
 * One grant per action, all bound to the same confirmed revision/host/scope: a token can therefore only authorize
 * the exact state the user was looking at, and a nested repository gets grants that are unusable elsewhere (G5e).
 * The table is the single place a new write verb has to be registered; the capability list is what decides whether
 * the helper can actually run it, so a missing capability simply mints no grant.
 */
const EXPECTATIONS: readonly { method: string; field: keyof RemoteGitReadSnapshot; kind: RemoteGitWriteExpectation["kind"]; head?: boolean; also?: string }[] = [
	{ method: "git.stage", field: "writeExpectation", kind: "index", also: "git.unstage" },
	{ method: "git.commit", field: "commitExpectation", kind: "commit" },
	{ method: "git.createBranch", field: "branchExpectation", kind: "branch", head: true },
	{ method: "git.switchBranch", field: "switchExpectation", kind: "switch", head: true },
	{ method: "git.discard", field: "discardExpectation", kind: "discard" },
	{ method: "git.recoveryRestore", field: "restoreExpectation", kind: "restore" },
	{ method: "git.recoveryDrop", field: "dropExpectation", kind: "drop" },
	{ method: "git.cherryPick", field: "cherryPickExpectation", kind: "cherryPick", head: true },
	{ method: "git.revert", field: "revertExpectation", kind: "revert", head: true },
	{ method: "git.reset", field: "resetExpectation", kind: "reset", head: true },
	{ method: "git.drop", field: "dropCommitExpectation", kind: "dropCommit", head: true },
	{ method: "git.fetch", field: "fetchExpectation", kind: "fetch" },
	{ method: "git.push", field: "pushExpectation", kind: "push" },
	{ method: "git.pull", field: "pullExpectation", kind: "pull" },
];

export function remoteGitSnapshotExpectations(snapshot: RemoteGitReadSnapshot, revision: string, hostRevision: number, target: RemoteGitLocator, repoPath: string, capabilities: readonly unknown[]): void {
	for (const entry of EXPECTATIONS) {
		if (!capabilities.includes(entry.method)) continue;
		if (entry.also !== undefined && !capabilities.includes(entry.also)) continue;
		const grant: RemoteGitWriteExpectation = { kind: entry.kind, revision, hostRevision, target, repoPath };
		// `head` is optional in the type but fixed per verb: a branch/switch/history action always carries it.
		(snapshot[entry.field] as RemoteGitWriteExpectation | undefined) = entry.head === true ? { ...grant, head: snapshot.head } : grant;
	}
}

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
export function record(value: unknown): value is Record<string, unknown> {
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

export const REMOTE_GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const REMOTE_GIT_NAME_CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/;
export const REMOTE_GIT_BODY_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
export const REMOTE_GIT_FILE_STATUS_PATTERN = /^(?:[AMDTUXB]|[RC]\d{1,3})$/;
/** Helper output is re-validated field by field before it crosses IPC; trust stays with the read, not the producer. */
export function remoteGitOid(value: unknown): string {
	if (typeof value !== "string" || !REMOTE_GIT_OID_PATTERN.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
export function remoteGitName(value: unknown, maxBytes: number): string {
	if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maxBytes || REMOTE_GIT_NAME_CONTROL.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
export function remoteGitSubject(value: unknown): string {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > REMOTE_GIT_SUBJECT_MAX_BYTES || REMOTE_GIT_NAME_CONTROL.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
export function remoteGitMessage(value: unknown): string {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > REMOTE_GIT_DETAIL_MESSAGE_MAX_BYTES || REMOTE_GIT_BODY_CONTROL.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
export function remoteGitTime(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("GIT_RESULT_INVALID");
	return value;
}
/** A recovery ref is only ever one of ours: the namespace is the authority, not the remote's wording. */
export function remoteGitRecoveryRef(value: unknown): string {
	if (typeof value !== "string" || !/^refs\/pideck\/recovery\/[A-Za-z0-9._-]+$/.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
/** A remote name and an upstream ref name are closed shapes; neither may smuggle a URL or a flag. */
export function remoteGitSyncRemote(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
export function remoteGitSyncUpstream(value: unknown): string {
	if (typeof value !== "string" || !/^refs\/remotes\/[A-Za-z0-9._-]+\/.{1,1024}$/.test(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
export function remoteGitSyncRef(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}
/** Explicit mode must name the same branch on both sides; upstream mode may rename the remote side. */
export function remoteGitRefspecOk(refspec: string, upstream: boolean, local: string | null): boolean {
	return upstream ? /^refs\/heads\/[^:]{1,1024}:refs\/heads\/[A-Za-z0-9._/-]{1,1024}$/.test(refspec) : refspec === `refs/heads/${local}:refs/heads/${local}`;
}

/** The helper's own bounded stderr text, control bytes stripped; undefined when it said nothing. */
/** null/null is upstream mode; a mixed null/string pair is a caller bug, refused before any session work. */
export function remoteGitSyncNames(remote: unknown, branch: unknown): { remote: string | null; branch: string | null; upstream: boolean } {
	const upstream = remote === null && branch === null;
	if ((remote === null) !== (branch === null)) throw new Error("GIT_RESULT_INVALID");
	return upstream ? { remote: null, branch: null, upstream: true } : { remote: remoteGitSyncRemote(remote), branch: validateRemoteGitBranchName(branch), upstream: false };
}

export function remoteGitFailureDetail(error: unknown): string | undefined {
	const raw = record(error) && typeof error.remoteMessage === "string" ? error.remoteMessage.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() : "";
	return raw.length === 0 ? undefined : raw.slice(0, 4096);
}

export function remoteGitCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("GIT_RESULT_INVALID");
	return value;
}
export function remoteGitParents(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > REMOTE_GIT_LOG_MAX_PARENTS) throw new Error("GIT_RESULT_INVALID");
	return value.map(remoteGitOid);
}
/** One bounded history page; hasMore comes from the extra record the helper fetched, total only when asked for. */
export function readRemoteGitLog(value: unknown, expectTotal = false): RemoteGitLogPage {
	if (!record(value) || Object.keys(value).length !== (expectTotal ? 3 : 2) || typeof value.hasMore !== "boolean" || !Array.isArray(value.commits) || value.commits.length > REMOTE_GIT_LOG_MAX_COUNT) throw new Error("GIT_RESULT_INVALID");
	const page: RemoteGitLogPage = {
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
	// A total the caller did not ask for is a shape this protocol never sends; an asked-for one must cover the page.
	if (!expectTotal) return page;
	const total = remoteGitCount(value.total);
	if (total < page.commits.length) throw new Error("GIT_RESULT_INVALID");
	page.total = total;
	return page;
}
/** One commit's byte-exact detail plus its changed files against the first parent, with line counts when sent. */
export function readRemoteGitCommitDetail(value: unknown, repoPath = ""): RemoteGitCommitDetail {
	const detailKeys = record(value) ? Object.keys(value) : [];
	const withStat = detailKeys.includes("shortStat");
	if (!record(value) || detailKeys.length !== (withStat ? 12 : 11) || !Array.isArray(value.files) || value.files.length > REMOTE_GIT_COMMIT_MAX_FILES) throw new Error("GIT_RESULT_INVALID");
	const repo = validateRemoteGitRepoPath(repoPath);
	const files = value.files.map((file) => {
		if (!record(file)) throw new Error("GIT_RESULT_INVALID");
		const keys = Object.keys(file);
		const renamed = keys.includes("oldPath"),
			counted = keys.includes("additions") || keys.includes("deletions");
		// A counted file carries both numbers or neither (a binary record has no count), and nothing else.
		if (!keys.includes("path") || !keys.includes("status") || keys.includes("additions") !== keys.includes("deletions") || keys.length !== 2 + (renamed ? 1 : 0) + (counted ? 2 : 0)) throw new Error("GIT_RESULT_INVALID");
		if (typeof file.status !== "string" || !REMOTE_GIT_FILE_STATUS_PATTERN.test(file.status)) throw new Error("GIT_RESULT_INVALID");
		// 公共输出是项目相对路径（helper 的仓库内路径在本层归一）。
		const path = projectFilePath(repo, validateRemoteGitPath(file.path));
		const numbers = counted ? { additions: remoteGitCount(file.additions), deletions: remoteGitCount(file.deletions) } : {};
		return renamed ? { status: file.status, path, oldPath: projectFilePath(repo, validateRemoteGitPath(file.oldPath)), ...numbers } : { status: file.status, path, ...numbers };
	});
	const detail: RemoteGitCommitDetail = {
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
		files,
	};
	if (!withStat) return detail;
	if (!record(value.shortStat) || Object.keys(value.shortStat).length !== 3) throw new Error("GIT_RESULT_INVALID");
	const shortStat = { files: remoteGitCount(value.shortStat.files), insertions: remoteGitCount(value.shortStat.insertions), deletions: remoteGitCount(value.shortStat.deletions) };
	// The helper sums the same list it answers; a mismatch means the two passes disagreed and neither is trustworthy.
	if (shortStat.files !== files.length) throw new Error("GIT_RESULT_INVALID");
	detail.shortStat = shortStat;
	return detail;
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
export function readRemoteGitCompare(value: unknown, base: string, head: string, repoPath = "", mode: "trees" | "threeDot" = "trees"): RemoteGitCompare {
	// The answer states its own semantics, and they must be the semantics this call asked for.
	const merging = record(value) && value.mode === "merge-base";
	if (!record(value) || Object.keys(value).length !== (merging ? 7 : 3) || !record(value.base) || !record(value.head) || !Array.isArray(value.files) || value.files.length > REMOTE_GIT_COMPARE_MAX_FILES) throw new Error("GIT_RESULT_INVALID");
	if (mode === "threeDot" ? !merging : merging) throw new Error("GIT_RESULT_INVALID");
	const repo = validateRemoteGitRepoPath(repoPath);
	const side = (raw: Record<string, unknown>, expected: string): RemoteGitCompare["base"] => {
		if (Object.keys(raw).length !== 2 || raw.ref !== expected) throw new Error("GIT_RESULT_INVALID");
		return { ref: expected, oid: remoteGitOid(raw.oid) };
	};
	const compare: RemoteGitCompare = {
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
			const path = projectFilePath(repo, validateRemoteGitPath(file.path));
			return renamed ? { status: file.status, path, oldPath: projectFilePath(repo, validateRemoteGitPath(file.oldPath)) } : { status: file.status, path };
		}),
	};
	if (!merging) return compare;
	compare.mode = "merge-base";
	compare.mergeBase = remoteGitOid(value.mergeBase);
	compare.ahead = remoteGitCount(value.ahead);
	compare.behind = remoteGitCount(value.behind);
	return compare;
}

/** Main-owned operation boundary: live project values, live trust and bound helper requests; never a local cwd. */
