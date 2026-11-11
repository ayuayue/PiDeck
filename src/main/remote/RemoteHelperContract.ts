/**
 * Shared vocabulary for the remote helper protocol (plan §7) and the bootstrap contract (§168).
 * Types and limits only — parsing, framing and validation live in the modules that own them, so this
 * file stays the single place both sides agree on.
 *
 * The read-only workspace batch (`fs.stat`, `fs.list`, `fs.read`, `fs.searchNames`) is declared here in the same spirit:
 * the method name, the exact result fields and every bound are literals in this file, and the frozen
 * helper body — which cannot import anything — repeats those literals under test (§7.1). A result shape
 * that is not stated here is not part of the protocol, and a bound that is not stated here is not
 * enforced on both sides.
 */

/** Wire protocol version. A helper with a different version must not be used (structured refusal). */
export const REMOTE_HELPER_PROTOCOL_VERSION = 1;

/** One NDJSON frame, UTF-8 encoded. Anything larger is a protocol error, never a truncation. */
export const REMOTE_HELPER_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Field bounds both sides enforce. A mismatch turns a rejection into a silent timeout. */
export const REMOTE_HELPER_MAX_HOST_ID_LENGTH = 64;
export const REMOTE_HELPER_MAX_ID_LENGTH = 128;
export const REMOTE_HELPER_MAX_METHOD_LENGTH = 64;
export const REMOTE_HELPER_MAX_ECHO_TEXT_LENGTH = 4096;
/** Ceiling for the assembled remote command: the producer must not emit what the argv boundary refuses. */
export const REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH = 8192;
/**
 * File bodies travel in chunks; the base64 form still has to fit the frame limit. One chunk is 1 MiB of
 * bytes, which base64-encodes to at most `4 * ceil(1048576 / 3) = 1398104` characters: with the frame
 * fields and a 128 character request id the worst-case `fs.read` line is under 1.4 MB, so the chunk
 * ceiling sits an order of magnitude below REMOTE_HELPER_MAX_FRAME_BYTES and the frame cap stays what it
 * is — a fatal ingest bound, not the limit a normal answer is sized against.
 */
export const REMOTE_HELPER_MAX_CHUNK_BYTES = 1024 * 1024;
/** Bounded concurrency: long transfers must not head-of-line block short requests. */
export const REMOTE_HELPER_MAX_CONCURRENT_REQUESTS = 4;
export const REMOTE_HELPER_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * Ceiling on what one frame may ask for. It must stay at or above REMOTE_GIT_SYNC_TIMEOUT_MS: network verbs
 * are the only methods that legitimately run longer than a read, and a lower ceiling here silently truncates
 * the sync budget before the helper's own per-method clamp even sees it (the G5a follow-up in §5.16.2).
 * Per-method handler caps still apply: only fetch/push/pull are admitted for the long budget.
 */
export const REMOTE_HELPER_MAX_REQUEST_TIMEOUT_MS = 600_000;

/**
 * Stable helper error codes. Free text never travels as a code (diagnostics stay redacted).
 *
 * The filesystem half of the list is a closed set on purpose: one code per condition the caller can act
 * on, and `IO_ERROR` for every errno nobody predicted, so a raw platform code or message is never
 * relayed. `PATH_OUTSIDE_ROOT` is a refusal before the operation (nothing outside the root is opened) and
 * is also the answer of every filesystem method in a host-only session, which is a helper started without
 * a `--root` at all: that is a legal state, not a misconfiguration, because probing and the handshake need
 * no file access. `RESULT_TOO_LARGE` is a bounded result that is refused instead of truncated, `ROOT_INVALID`
 * is the fatal startup answer of a helper whose `--root` argument is present but unusable (empty, relative,
 * `/`, not a directory or unreadable), and `NOT_A_FILE` covers both a directory and a non-regular entry
 * handed to `fs.read`. `QUERY_INVALID` is `fs.searchNames`' own refusal for a search term that is absent,
 * empty, longer than REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH or carrying a control byte: the term is checked
 * before any filesystem access, the way a path is, so an unusable query never becomes a partial walk.
 */
export const REMOTE_HELPER_ERROR_CODES = [
	"METHOD_NOT_FOUND",
	"REQUEST_CANCELLED",
	"REQUEST_TIMEOUT",
	"RESULT_TOO_LARGE",
	"PATH_OUTSIDE_ROOT",
	"PATH_NOT_FOUND",
	"NOT_A_DIRECTORY",
	"NOT_A_FILE",
	"QUERY_INVALID",
	"PERMISSION_DENIED",
	"IO_ERROR",
	"ROOT_INVALID",
	"PROTOCOL_INVALID",
	"HELPER_INTERNAL",
	"REMOTE_CONNECTION_LOST",
	"TOO_MANY_REQUESTS",
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
	/* F3 terminal launch ticket: the helper could not mint one (input) or could not publish it (deploy root). */
	"TERMINAL_TICKET_INVALID",
	"TERMINAL_TICKET_UNAVAILABLE",
	/* Phase 5 config scope: target file invalid/oversized, stale expectedVersion, unusable path/dir, or a write whose
	 * readback could not be confirmed. A helper without the config methods answers METHOD_NOT_FOUND instead. */
	"CONFIG_FILE_INVALID",
	"CONFIG_FILE_TOO_LARGE",
	"CONFIG_VERSION_CONFLICT",
	"CONFIG_PATH_UNSUPPORTED",
	"CONFIG_RESULT_UNCONFIRMED",
	"CONFIG_UNAVAILABLE",
	/* SFTP-1 upload transaction: validation and token failures are deterministic; once the hard-link publish
	 * may have happened every later failure is UNCONFIRMED and must never be replayed automatically. */
	"FILE_UPLOAD_INPUT_INVALID",
	"FILE_UPLOAD_TOKEN_INVALID",
	"FILE_UPLOAD_TARGET_EXISTS",
	"FILE_UPLOAD_STAGE_INVALID",
	"FILE_UPLOAD_PATH_INVALID",
	"FILE_UPLOAD_ROOT_CHANGED",
	"FILE_UPLOAD_UNSUPPORTED",
	"FILE_UPLOAD_COMMIT_UNCONFIRMED",
] as const;
export type RemoteHelperErrorCode = (typeof REMOTE_HELPER_ERROR_CODES)[number];

/** `hello` and `cancel` are mandatory; only optional behaviour is negotiated through capabilities. */
export const REMOTE_HELPER_METHOD_HELLO = "hello";
export const REMOTE_HELPER_METHOD_ECHO = "echo";
export const REMOTE_HELPER_METHOD_CANCEL = "cancel";
/** Read-only workspace methods: the first batch of helpers that actually touches the remote filesystem. */
export const REMOTE_HELPER_METHOD_FS_STAT = "fs.stat";
/**
 * Batched form of `fs.stat` (helper 1.22.0): one bounded frame describes up to
 * REMOTE_HELPER_MAX_STAT_MANY_PATHS entries with exactly the per-path rules of the single call. It exists
 * because a session list costs one round trip per file without it; nothing about *which* paths are scanned
 * moves into the helper.
 */
export const REMOTE_HELPER_METHOD_FS_STAT_MANY = "fs.statMany";
/**
 * Git 权威的忽略判定（helper 1.23.0）：`{ paths }` → `{ ignored: boolean[] }`，与请求**逐位对应**。
 * 为什么放在 helper 而不在 main 自己写匹配器：`.gitignore` 的语义（取反、嵌套、`core.excludesFile`、
 * `info/exclude`、linked worktree 的 common dir）只有 git 自己是权威；重写一遍必然与 `git status` 打架。
 */
export const REMOTE_HELPER_METHOD_GIT_CHECK_IGNORE = "git.checkIgnore";
/**
 * 目录订阅（helper 1.24.0）：`fs.watch { paths } → { watchId }` / `fs.unwatch { watchId } → { closed }`。
 * 变更以**事件帧**（无 `id`、带 `watchId`）单向推送，主进程只做失效，不触发装载。
 */
export const REMOTE_HELPER_METHOD_FS_WATCH = "fs.watch";
export const REMOTE_HELPER_METHOD_FS_UNWATCH = "fs.unwatch";
/**
 * SFTP-1 binary upload transaction. `prepare` binds a one-use token to the canonical root, host generation,
 * target, size and digest; the SFTP executor may write only the opaque spool named by `stageRef`. `commit`
 * consumes the token before any side effect and publishes create-only. Callers must treat a lost/malformed
 * reply after sending commit as unknown and must not retry it.
 */
export const REMOTE_HELPER_METHOD_FS_UPLOAD_PREPARE = "fs.uploadPrepare";
export const REMOTE_HELPER_METHOD_FS_UPLOAD_COMMIT = "fs.uploadCommit";
/** Token-authorized cleanup for a staged upload that failed before commit; it can never name an arbitrary path. */
export const REMOTE_HELPER_METHOD_FS_UPLOAD_ABORT = "fs.uploadAbort";
/** 一个 helper 会话同时允许的 watcher 数；超出直接拒绝而不是排队。 */
export const REMOTE_HELPER_MAX_WATCHES = 4;
/** 一次订阅里最多几个目录。 */
export const REMOTE_HELPER_MAX_WATCH_PATHS = 32;
/** 连续写合并窗口（毫秒）。 */
export const REMOTE_HELPER_WATCH_DEBOUNCE_MS = 150;
/** 一次判定的路径数上限（与 `fs.statMany` 同量级，够填满一屏目录）。 */
export const REMOTE_HELPER_MAX_CHECK_IGNORE_PATHS = 64;
export const REMOTE_HELPER_METHOD_FS_LIST = "fs.list";
export const REMOTE_HELPER_METHOD_FS_READ = "fs.read";
/**
 * `fs.list`'s recursive cousin: one bounded walk below a request path, answering the entries whose
 * basename contains a query. It is the one read-only method that is not a single filesystem call, so it
 * holds a concurrency slot and can be cancelled while it runs (the other three run inline in dispatch).
 */
export const REMOTE_HELPER_METHOD_FS_SEARCH_NAMES = "fs.searchNames";
/** Optional read-only Git methods; they share the helper concurrency/cancellation lifecycle. */
export const REMOTE_HELPER_METHOD_GIT_STATUS = "git.status";
export const REMOTE_HELPER_METHOD_GIT_WORKSPACE_DIFF = "git.workspaceDiff";
/**
 * The one write that runs before a repository exists. It has no parameters on purpose: the verified root is the
 * whole input, and a root that already contains (in any form) or is governed by a repository is refused with
 * GIT_REPO_EXISTS instead of being initialized into a nested one.
 */
export const REMOTE_HELPER_METHOD_GIT_INIT = "git.init";
export type RemoteGitInitParams = Record<string, never>;
/** `branch` is the default branch the freshly created repository reports; null is reported as read. */
export type RemoteGitInitResult = { branch: string | null };
/**
 * G5d nested repository discovery: one bounded scan under the project root, side-effect free and never following a
 * symlink. `path` is project-relative POSIX ("" is the root repository); `name` is a display label only.`truncated`
 * says a repo-count or visited-directory cap really cut the walk - it is never silently complete (same precedent as
 * fs.searchNames).
 */
export const REMOTE_HELPER_METHOD_GIT_REPOS = "git.repos";
export const REMOTE_GIT_REPOS_MAX_REPOS = 50;
export const REMOTE_GIT_REPOS_MAX_DEPTH = 4;
export const REMOTE_GIT_REPOS_MAX_VISITED_DIRS = 512;
export type RemoteGitRepoEntry = { path: string; name: string };
export type RemoteGitReposResult = { repos: readonly RemoteGitRepoEntry[]; truncated: boolean };
/**
 * The per-request repository scope: an optional project-relative POSIX path (""/absent means the project root).
 * The read batch and every managed write verb accept a non-empty scope (G5e); git.init and git.repos stay root-only and
 * refuse one. The method lists are repeated by the frozen entry's REPO_METHODS and by the frozen worker's READ_REPO /
 * WRITE_REPO sets, and the shape rules by all three plus main's validateRemoteGitRepoPath - all before a session or a Git
 * child is started. A test pins the three method lists against each other.
 */
export const REMOTE_GIT_REPO_PATH_MAX_BYTES = 4096;
export const REMOTE_GIT_REPO_READ_METHODS = ["git.status", "git.workspaceDiff", "git.log", "git.commitDetail", "git.refs", "git.refFileDiff", "git.compare", "git.recoveryList", "git.syncFacts", "git.checkIgnore"] as const;
export const REMOTE_GIT_REPO_WRITE_METHODS = ["git.stage", "git.unstage", "git.commit", "git.createBranch", "git.switchBranch", "git.discard", "git.recoveryRestore", "git.recoveryDrop", "git.fetch", "git.push", "git.pull"] as const;
export const REMOTE_GIT_STATUS_MAX_BYTES = 1024 * 1024;
export const REMOTE_GIT_MAX_RESOURCES = 4096;
export const REMOTE_GIT_TEXT_MAX_BYTES = 256 * 1024;
export const REMOTE_GIT_STDERR_MAX_BYTES = 64 * 1024;
export const REMOTE_GIT_INDEX_MAX_BYTES = 16 * 1024 * 1024;
export const REMOTE_GIT_METADATA_MAX_ENTRIES = 20_000;
export const REMOTE_GIT_METADATA_MAX_DEPTH = 32;
export const REMOTE_GIT_READ_TIMEOUT_MS = 30_000;

export type RemoteGitStatusResult = { status: string; head: string | null; branch: string | null; revision?: string };

/**
 * Read-only history batch (G3a): log, one commit's detail, local refs and one file's two sides between
 * two revisions. Every list is bounded and refused rather than truncated, and no method touches the network,
 * the index or the working tree. Refs are returned as opaque OIDs: nothing here interprets a branch name.
 */
export const REMOTE_GIT_LOG_MAX_COUNT = 100;
/** One page's default when the caller omits `maxCount`; still a literal on both sides. */
export const REMOTE_GIT_LOG_DEFAULT_COUNT = 50;
export const REMOTE_GIT_LOG_MAX_SKIP = 100_000;
export const REMOTE_GIT_REF_MAX_COUNT = 512;
export const REMOTE_GIT_REF_MAX_NAME_BYTES = 1024;
export const REMOTE_GIT_COMMIT_MAX_FILES = 512;
/** The detail message read back from history; distinct from the 4 KiB commit input bound on purpose. */
export const REMOTE_GIT_DETAIL_MESSAGE_MAX_BYTES = 64 * 1024;
export const REMOTE_GIT_IDENTITY_MAX_BYTES = 320;
export const REMOTE_GIT_SUBJECT_MAX_BYTES = 1024;
export const REMOTE_GIT_LOG_MAX_PARENTS = 8;
/**
 * G3b branch write face: a name that `git check-ref-format --branch` accepts, minus `@` (which that command
 * happens to allow) and any control character. Branch names travel as names, never as full refs or object ids.
 */
export const REMOTE_GIT_BRANCH_NAME_MAX_BYTES = 1024;
/**
 * G4a recoverable discard: before a working-tree change is thrown away or an untracked file is removed, its raw
 * bytes go into the repository's own object store behind a `refs/pideck/recovery/<stamp>` ref. A snapshot larger
 * than this bound is refused instead of being copied, and nothing prunes these refs automatically: the user deletes
 * one with `git update-ref -d <ref>` when they no longer need it.
 */
export const REMOTE_GIT_DISCARD_MAX_BYTES = 8 * 1024 * 1024;
/** Listing bound for the recovery namespace: past it the list is labelled truncated instead of refused. */
export const REMOTE_GIT_RECOVERY_MAX_ENTRIES = 64;
export const REMOTE_HELPER_METHOD_GIT_RECOVERY_LIST = "git.recoveryList";
export const REMOTE_HELPER_METHOD_GIT_RECOVERY_RESTORE = "git.recoveryRestore";
export const REMOTE_HELPER_METHOD_GIT_RECOVERY_DROP = "git.recoveryDrop";
/** One snapshot as the panel sees it: where it came from, how big it is and when it was taken. */
export type RemoteGitRecoveryEntry = { ref: string; oid: string; path: string; bytes: number; at: number };
export type RemoteGitRecoveryListResult = { entries: readonly RemoteGitRecoveryEntry[]; truncated: boolean };
export type RemoteGitRecoveryRestoreParams = { ref: string; oid: string; path: string };
export type RemoteGitRecoveryRestoreResult = { applied: true; path: string; bytes: number };
export type RemoteGitRecoveryDropParams = { ref: string; oid: string };
export type RemoteGitRecoveryDropResult = { applied: true };
export const REMOTE_GIT_RECOVERY_REF_PREFIX = "refs/pideck/recovery/";
/** Fixed author identity of a recovery commit: PiDeck's own journal entry, never the user's Git configuration. */
export const REMOTE_GIT_RECOVERY_IDENTITY = { name: "PiDeck recovery", email: "pideck-recovery@localhost" } as const;
export const REMOTE_HELPER_METHOD_GIT_DISCARD = "git.discard";
/** Network verbs get their own budget: a fetch or push over a slow link is not a 30-second read. */
export const REMOTE_GIT_SYNC_TIMEOUT_MS = 600_000;
export const REMOTE_GIT_SYNC_MAX_REMOTES = 64;
export const REMOTE_HELPER_METHOD_GIT_SYNC_FACTS = "git.syncFacts";
export const REMOTE_HELPER_METHOD_GIT_FETCH = "git.fetch";
export const REMOTE_HELPER_METHOD_GIT_PUSH = "git.push";
export const REMOTE_HELPER_METHOD_GIT_PULL = "git.pull";
/** Read-only facts the sync bar needs; `remotes` are names only, never URLs (a URL can carry a token). */
export type RemoteGitSyncFacts = { branch: string | null; upstream: string | null; ahead: number; behind: number; remotes: readonly string[] };
export type RemoteGitFetchParams = { remote: string; expectedRevision: string };
export type RemoteGitFetchResult = { applied: true; upToDate: boolean; updated: readonly { ref: string; before: string | null; after: string }[] };
export type RemoteGitPushParams = { remote: string; branch: string; expectedRevision: string };
export type RemoteGitPushResult = { applied: true; outcome: "up-to-date" | "pushed" | "new"; refspec: string };
export type RemoteGitPullParams = { remote: string; branch: string; expectedRevision: string };
export type RemoteGitPullResult = { applied: true; mode: "up-to-date" | "fast-forward" | "merge"; head: string };
export type RemoteGitDiscardParams = { path: string; group: "workingTree" | "untracked"; expectedRevision: string };
/**
 * `mode` says what happened to the file: restored to the staged version, or removed from the working tree.
 * `recoveryRef` is null only when the discarded change itself was the deletion of the file (a " D" resource):
 * there are no bytes to preserve, and restoring reads the already durable staged version.
 */
export type RemoteGitDiscardResult = { applied: true; recoveryRef: string | null; path: string; mode: "restored" | "removed" };
export const REMOTE_HELPER_METHOD_GIT_CREATE_BRANCH = "git.createBranch";
export const REMOTE_HELPER_METHOD_GIT_SWITCH_BRANCH = "git.switchBranch";
/** `expectedHead: null` means the repository is unborn; the branch is created at the confirmed HEAD otherwise. */
export type RemoteGitCreateBranchParams = { name: string; expectedHead: string | null };
export type RemoteGitCreateBranchResult = { applied: true; branch: string };
/** Switching only ever names an existing local branch; a conflicting worktree is refused, never forced. */
export type RemoteGitSwitchBranchParams = { name: string; expectedHead: string | null };
export type RemoteGitSwitchBranchResult = { applied: true; branch: string; head: string | null };

/** One history row; `parents` is bounded and `subject` is the first line only. */
export type RemoteGitLogEntry = { oid: string; parents: readonly string[]; authorName: string; authorEmail: string; authorTimeSec: number; subject: string };
export type RemoteGitLogParams = { maxCount?: number; skip?: number };
export type RemoteGitLogResult = { commits: readonly RemoteGitLogEntry[]; hasMore: boolean };
/** The commit's full message and its changed files against its first parent (a root commit lists all files). */
export type RemoteGitCommitDetailParams = { oid: string };
export type RemoteGitCommitFile = { status: string; path: string; oldPath?: string };
export type RemoteGitCommitDetailResult = {
	oid: string;
	parents: readonly string[];
	authorName: string;
	authorEmail: string;
	authorTimeSec: number;
	committerName: string;
	committerEmail: string;
	committerTimeSec: number;
	subject: string;
	message: string;
	files: readonly RemoteGitCommitFile[];
};
export type RemoteGitRefsParams = Record<string, never>;
/** Local branches and tags only: remote-tracking refs would imply sync state this batch does not deliver. */
export type RemoteGitRefEntry = { fullName: string; name: string; oid: string; kind: "branch" | "tag" };
export type RemoteGitRefsResult = { head: string | null; branch: string | null; refs: readonly RemoteGitRefEntry[] };
/** `base: null` means the file has no other side (root commit, or a file added by this commit). */
export type RemoteGitRefFileDiffParams = { base: string | null; head: string; path: string };
export type RemoteGitRefFileDiffResult = { originalContent: string; modifiedContent: string };
/**
 * G5b refs compare: both inputs are full local ref names (refs/heads/* or refs/tags/*) — the same
 * `fullName` values the refs read returns — and both sides are resolved to commits before the diff.
 * The comparison is the direct tree diff of the two commits (two-dot), not a merge-base or three-dot
 * view: there is no common-ancestor discovery to fail or to disagree with the per-file read.
 */
export const REMOTE_GIT_COMPARE_MAX_FILES = 4096;
export const REMOTE_HELPER_METHOD_GIT_COMPARE = "git.compare";
export type RemoteGitCompareParams = { base: string; head: string };
/** The OID a ref resolved to at read time; a later ref move cannot rewrite this answer. */
export type RemoteGitCompareSide = { ref: string; oid: string };
export type RemoteGitCompareFile = { status: string; path: string; oldPath?: string };
export type RemoteGitCompareResult = { base: RemoteGitCompareSide; head: RemoteGitCompareSide; files: readonly RemoteGitCompareFile[] };
/** Managed single-resource index mutations. The expectation is main-owned, never renderer authority. */
export type RemoteGitMutationParams = { path: string; group: "index" | "workingTree" | "untracked"; expectedRevision: string };
export type RemoteGitMutationResult = { applied: true };
/**
 * Managed commit: the tree comes from the verified index, the ref move is a native compare-and-swap.
 * `message` is sent verbatim (no Git comment stripping) and bounded by REMOTE_GIT_COMMIT_MESSAGE_MAX_BYTES.
 * `expectedRevision` is the same main-owned fingerprint the index mutations use, so the commit can only
 * ever contain what the user confirmed.
 */
export type RemoteGitCommitParams = { message: string; expectedRevision: string };
/** `head`/`tree` are the committed objects; both are read back from the repository after the CAS. */
export type RemoteGitCommitResult = { applied: true; head: string; tree: string };
export const REMOTE_GIT_COMMIT_MESSAGE_MAX_BYTES = 4096;
export type RemoteGitWorkspaceDiffParams = { group: "merge" | "index" | "workingTree" | "untracked"; path: string };
export type RemoteGitWorkspaceDiffResult = { originalContent: string; modifiedContent: string };

export const REMOTE_HELPER_CAPABILITIES = [
	"echo",
	"fs.stat",
	"fs.statMany",
	"fs.list",
	"fs.read",
	"fs.searchNames",
	"fs.searchContent",
	"fs.watch",
	"fs.unwatch",
	"fs.uploadPrepare",
	"fs.uploadCommit",
	"fs.uploadAbort",
	"git.status",
	"git.workspaceDiff",
	"git.stage",
	"git.unstage",
	"git.commit",
	"git.log",
	"git.commitDetail",
	"git.refs",
	"git.refFileDiff",
	"git.compare",
	"git.createBranch",
	"git.switchBranch",
	"git.discard",
	"git.recoveryList",
	"git.recoveryRestore",
	"git.recoveryDrop",
	"git.syncFacts",
	"git.fetch",
	"git.push",
	"git.pull",
	"git.init",
	"git.repos",
	"git.checkIgnore",
	"terminal.prepare",
	"config.read",
	"config.patch",
] as const;
export type RemoteHelperCapability = (typeof REMOTE_HELPER_CAPABILITIES)[number];
/**
 * Ceiling for one requested relative path. It is applied to the raw string before any filesystem access,
 * so an over-long path is a PROTOCOL_INVALID refusal rather than an ENAMETOOLONG round trip.
 */
export const REMOTE_HELPER_MAX_PATH_LENGTH = 4096;
/** Short single-use upload tickets; expiry is checked after the token is consumed, so a late commit cannot revive it. */
export const REMOTE_FILE_UPLOAD_TOKEN_TTL_MS = 120_000;
/** SFTP streams the body, so this bound is not a frame bound; it keeps one commit finite on the helper side. */
export const REMOTE_FILE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024 * 1024;
export const REMOTE_FILE_UPLOAD_ID_PATTERN = /^[0-9a-f]{32}$/;
export const REMOTE_FILE_UPLOAD_SHA256_PATTERN = /^[0-9a-f]{64}$/;
export type RemoteFileUploadPolicy = "create";
export type RemoteFileUploadPrepareParams = {
	uploadId: string;
	path: string;
	policy: RemoteFileUploadPolicy;
	size: number;
	sha256: string;
};
/** stageRef is the 32hex id the caller appends as `.part` inside the helper-owned upload-spool. */
export type RemoteFileUploadPrepareResult = { token: string; stageRef: string; expiresAt: number };
export type RemoteFileUploadCommitParams = { uploadId: string; token: string };
export type RemoteFileUploadAbortParams = RemoteFileUploadCommitParams;
export type RemoteFileUploadAbortResult = { cleaned: true };
export type RemoteFileUploadRevision = {
	mode: number;
	size: number;
	dev: string;
	ino: string;
	uid: string;
	gid: string;
	mtimeNs: string;
	ctimeNs: string;
};
export type RemoteFileUploadCommitResult = {
	committed: true;
	path: string;
	size: number;
	sha256: string;
	revision: RemoteFileUploadRevision;
	fsync: true;
	stageCleaned: boolean;
};
/**
 * Paths per `fs.statMany` request. It bounds both directions: the caller sends few enough paths for one
 * frame, and the helper answers without splitting a batch, so a full 2000-file listing is <= 32 round trips
 * instead of 2000 while each entry still counts as its own logical unit.
 */
export const REMOTE_HELPER_MAX_STAT_MANY_PATHS = 64;
/**
 * `fs.list` answers in one frame, so the entry count is capped instead of paged: past the cap the whole
 * call is refused with RESULT_TOO_LARGE, never truncated into a listing that silently looks complete.
 * 4096 entries of at most 255 byte names stay below the 8 MiB frame cap with room to spare.
 */
export const REMOTE_HELPER_MAX_LIST_ENTRIES = 4096;
/**
 * Hard ceilings for `fs.searchNames`, all of them enforced inside the frozen helper. At most 512 matches
 * are answered, at most 20000 directory entries are visited, and no entry deeper than 12 path segments
 * below the request path is reached (the request path itself is depth 0, a file directly inside it depth
 * 1). Reaching any of them stops the walk *at that entry* and answers `truncated: true`, so a bounded
 * answer is a deterministic prefix instead of a listing that quietly looks complete. The walk is
 * breadth first and visits each directory's entries in name order, so one directory is read (bounded by the
 * entry ceiling) before any of its entries is visited: that ceiling is also the work bound of a call. 512 entries of at
 * most 255 byte names stay far below the 8 MiB frame cap with room to spare.
 */
export const REMOTE_HELPER_MAX_SEARCH_MATCHES = 512;
export const REMOTE_HELPER_MAX_SEARCH_SCANNED = 20000;
export const REMOTE_HELPER_MAX_SEARCH_DEPTH = 12;
/** Query ceiling for `fs.searchNames`, counted in characters and checked before any filesystem access. */
export const REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH = 128;
/**
 * Bounded content search (helper 1.25.0). `fs.searchContent` is the first read that actually opens file
 * bodies, so every bound is a literal of the frozen artifact and repeated here under test:
 * - matches: at most 200 answered; the walk stops at the match that fills the ceiling;
 * - files: at most 2000 files read, bytes: at most 16 MiB read in total, and one file larger than 1 MiB is
 *   skipped (its bytes are never read) — each limit sets `truncated` with the `reason` that stopped it;
 * - time: at most 8 s of scanning, checked at entry/file boundaries, so a slow filesystem cannot hold a
 *   helper slot for the whole request deadline;
 * - depth: 12 segments below the request path, the same ceiling the filename walk uses;
 * - a file whose first 8 KiB contain a NUL byte is binary and is skipped without being decoded; invalid
 *   UTF-8 is skipped too. Skips are not truncation: they say "this file is not text", not "the tree was cut".
 * - a snippet is at most 200 characters of the matched line, and a match names only its relative path,
 *   line (1-based) and column (0-based): no file body ever travels back in a result.
 */
export const REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT = "fs.searchContent";
export const REMOTE_HELPER_MAX_CONTENT_MATCHES = 200;
export const REMOTE_HELPER_MAX_CONTENT_SCANNED_FILES = 2000;
export const REMOTE_HELPER_MAX_CONTENT_SCANNED_BYTES = 16 * 1024 * 1024;
export const REMOTE_HELPER_MAX_CONTENT_FILE_BYTES = 1024 * 1024;
export const REMOTE_HELPER_MAX_CONTENT_BINARY_PROBE_BYTES = 8 * 1024;
export const REMOTE_HELPER_MAX_CONTENT_TIME_MS = 8000;
export const REMOTE_HELPER_MAX_CONTENT_DEPTH = 12;
export const REMOTE_HELPER_MAX_CONTENT_SNIPPET_LENGTH = 200;
/**
 * Directories the content walk never descends into: VCS metadata, package installs and PiDeck's own trash are
 * not project text sources, and `.git`/`node_modules` alone can exhaust the whole file/byte budget before a
 * single source file is reached. They are skipped by name at any depth; a user file inside them is intentionally
 * outside this search, which is the same set the remote file tree hides.
 */
export const REMOTE_HELPER_CONTENT_SKIPPED_DIRECTORIES = [".git", ".hg", ".svn", "node_modules", ".pideck-trash"] as const;
/** Bounded concurrency plus a bounded waiting room: past both, a request is refused, never buffered. */
export const REMOTE_HELPER_MAX_QUEUED_REQUESTS = 64;
/**
 * Upper bound for the optional delay of `echo`. The delay exists so a connection self-test can hold a
 * few requests open and observe the concurrency bound instead of only the steady state.
 */
export const REMOTE_HELPER_MAX_ECHO_DELAY_MS = 5_000;

export type RemoteHelperHelloResult = RemoteHelperHandshake & { helperVersion: string; nodeVersion: string; pid: number };

export type RemoteHelperRequestFrame = {
	v: number;
	hostId: string;
	generation: number;
	id: string;
	method: string;
	timeoutMs?: number;
	params?: unknown;
	/** Optional repository scope (project-relative POSIX path; empty/absent is the project root); read batch only. */
	repo?: string;
};

export type RemoteHelperErrorBody = {
	code: string;
	message?: string;
	retryable?: boolean;
};

export type RemoteHelperResponseFrame = {
	v: number;
	hostId: string;
	generation: number;
	id: string;
	ok: boolean;
	result?: unknown;
	error?: RemoteHelperErrorBody;
};

/** Cancel is a first-class request: it carries its own id and names the target request. */
export type RemoteHelperCancelParams = { requestId: string };
export type RemoteHelperCancelResult = { cancelled: boolean; reason?: "already-settled" | "commit-started" };

/**
 * How an entry is classified by `fs.stat` and by every `fs.list` entry. `other` is everything that is not
 * a regular file or a directory — a symlink above all: both methods answer with lstat semantics, so a link
 * is never followed for the classification and its target's size is never reported as its own.
 */
export type RemoteHelperPathKind = "file" | "directory" | "other";

/**
 * `path` is a relative POSIX path inside the helper's root; an absolute path, a backslash, a drive
 * prefix, a percent-encoded separator or dot, and any `..` segment are refused as PATH_OUTSIDE_ROOT
 * before the filesystem is touched, and so is a path whose resolved form leaves the root (a symlink that
 * points outside included). `.` names the root itself.
 */
export type RemoteHelperStatParams = { path: string };
/** `bytes` is the entry's own size (the link's size for a symlink) and `mtimeMs` its modification time. */
export type RemoteHelperStatResult = { kind: RemoteHelperPathKind; bytes: number; mtimeMs: number };
/**
 * `paths` is 1..REMOTE_HELPER_MAX_STAT_MANY_PATHS relative POSIX paths, each checked exactly like
 * RemoteHelperStatParams. Any unusable path refuses the whole request with that path's own code: a batch is
 * all-or-nothing, which is what keeps its result comparable to calling `fs.stat` once per entry.
 */
export type RemoteHelperStatManyParams = { paths: readonly string[] };
/** Entries are in request order and echo the requested path; an index is never implied by omission. */
export type RemoteHelperStatManyEntry = { path: string; kind: RemoteHelperPathKind; bytes: number; mtimeMs: number };
export type RemoteHelperStatManyResult = { entries: readonly RemoteHelperStatManyEntry[] };

export type RemoteHelperListParams = { path: string };
/** `bytes` is present for regular files only; a symlink is `other` and is never followed. */
export type RemoteHelperListEntry = { name: string; kind: RemoteHelperPathKind; bytes?: number };
/** Entries are sorted by name in code-unit order and capped by REMOTE_HELPER_MAX_LIST_ENTRIES. */
export type RemoteHelperListResult = { entries: readonly RemoteHelperListEntry[] };

/**
 * `path` names the directory to walk and is checked exactly as `fs.list` checks one. `query` is matched
 * against each entry's basename, case-insensitively, and directory names take part in the match.
 * `maxMatches` is optional and is *clamped* by the helper to 1..REMOTE_HELPER_MAX_SEARCH_MATCHES (absent
 * means that ceiling); a value that is not a safe integer is refused as PROTOCOL_INVALID.
 */
export type RemoteHelperSearchParams = { path: string; query: string; maxMatches?: number };
/**
 * `path` is the entry's relative POSIX path inside the root (never absolute, never the root itself),
 * `name` its basename and `kind` its own classification — a symlink is `other` and is never followed.
 * `bytes` is present for regular files only. Entries are sorted by `path` in code-unit order.
 */
export type RemoteHelperSearchEntry = { path: string; name: string; kind: RemoteHelperPathKind; bytes?: number };
/**
 * `scanned` counts every entry the walk visited, matching or not, so it is always at least
 * `entries.length` and never above REMOTE_HELPER_MAX_SEARCH_SCANNED; `truncated` says that one of the
 * three ceilings stopped the walk, which is the only case in which the answer is not the whole tree.
 */
export type RemoteHelperSearchResult = { entries: readonly RemoteHelperSearchEntry[]; scanned: number; truncated: boolean };
/**
 * `fs.searchContent` (helper 1.25.0): the bounded content read. `path` names the directory to walk and is
 * checked exactly as `fs.list` checks one; `query` is a 1..128 character literal matched case-insensitively
 * inside each line; `maxMatches` is optional and clamped to 1..REMOTE_HELPER_MAX_CONTENT_MATCHES.
 */
export type RemoteHelperSearchContentParams = { path: string; query: string; maxMatches?: number };
/**
 * One line match: `path` is the relative POSIX path inside the root, `line` is 1-based, `column` is the
 * 0-based character offset of the match in that line, and `snippet` is at most
 * REMOTE_HELPER_MAX_CONTENT_SNIPPET_LENGTH characters of the same line. The file body never travels back.
 */
export type RemoteHelperSearchContentMatch = { path: string; name: string; line: number; column: number; snippet: string };
/**
 * The reason a bounded answer is not the whole tree. `file-size` means one file was skipped because it is
 * larger than REMOTE_HELPER_MAX_CONTENT_FILE_BYTES (its bytes were never read); binary and invalid UTF-8
 * skips are deliberately not truncation and carry no reason.
 */
export type RemoteHelperSearchContentReason = "matches" | "files" | "bytes" | "time" | "depth" | "file-size";
/**
 * `matchedFiles` counts distinct files with at least one match, `scannedFiles` every file whose bytes were
 * read (including binary/invalid UTF-8 skips) and `scannedBytes` every byte handed to the decoder, so the
 * three fields describe work actually done. `reason` is present exactly when `truncated` is true.
 */
export type RemoteHelperSearchContentResult = {
	matches: readonly RemoteHelperSearchContentMatch[];
	matchedFiles: number;
	scannedFiles: number;
	scannedBytes: number;
	truncated: boolean;
	reason?: RemoteHelperSearchContentReason;
};

/**
 * `offset` and `bytes` are safe non-negative integers; `bytes` is at most REMOTE_HELPER_MAX_CHUNK_BYTES,
 * so exactly one frame is needed per chunk and a longer request is refused (PROTOCOL_INVALID) rather than
 * silently shortened.
 */
export type RemoteHelperReadParams = { path: string; offset: number; bytes: number };
/**
 * `chunk` is base64 of the bytes that were actually read, `bytes` their count (0 at or past EOF) and `eof`
 * the fact that this chunk reached the size observed while reading — a client reads until `eof` instead of
 * trusting a total from an earlier `fs.stat`, because the file may change between the two calls.
 */
export type RemoteHelperReadResult = { chunk: string; bytes: number; eof: boolean };

// ── Phase 5: remote Pi config scope (models / settings / trust / mcp only) ─────────────────────

/**
 * The config scope is deliberately tiny: four allowlisted files under the remote Pi agent directory, no path
 * parameter, no auth.json. Read answers are sanitized (secret values become configured/missing); writes are
 * RFC 7396 merge patches guarded by expectedVersion and an atomic temp+rename+fsync. The frozen config.mjs
 * repeats these literals under test, exactly like the Git worker. Adding a file means editing the frozen
 * artifact, bumping the helper build identity and re-pinning both digests — never a path parameter.
 */
export const REMOTE_HELPER_METHOD_CONFIG_READ = "config.read";
export const REMOTE_HELPER_METHOD_CONFIG_PATCH = "config.patch";
export type RemoteConfigFileKey = "models" | "settings" | "trust" | "mcp";
/** Upper bound for either agent file (raw bytes) and for the serialized patched result. */
export const REMOTE_CONFIG_MAX_FILE_BYTES = 1024 * 1024;
/** Bounded patch/merge walk: an answer that would need more than this is refused, never truncated. */
export const REMOTE_CONFIG_MAX_NODES = 20_000;
export const REMOTE_CONFIG_MAX_DEPTH = 32;
/**
 * Secret key NAMES the sanitizer redacts recursively (case-insensitive), matched as a whole name (optionally
 * prefixed by separator-delimited segments, e.g. ANTHROPIC_API_KEY) so real fields like maxTokens/tokenizer are
 * not misclassified. This is the ONE pattern main and the frozen config.mjs share; the frozen body repeats the
 * literal and a test asserts the repetition. Reserved keys (__proto__/constructor/prototype) are refused by the
 * helper and main before any merge; patch values for a secret must be strings.
 */
export const REMOTE_CONFIG_SECRET_KEY_PATTERN = /^(?:[a-z0-9]+[-_])*(?:[a-z0-9]+)?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|secret|password|passwd|authorization|cookie|credential|private[-_]?key)$/i;
/** configured and missing are the only values a secret position may carry in a remote DTO. */
export type RemoteConfigSecretStatus = "configured" | "missing";
export type RemoteConfigSecretEntry = { path: string; status: RemoteConfigSecretStatus };
export type RemoteConfigReadParams = { file: RemoteConfigFileKey };
/** Sanitized snapshot: data keeps the file shape; secret positions hold only the status string. */
export type RemoteConfigSnapshot = {
	version: string;
	sha256: string;
	data: Record<string, unknown>;
	secrets: readonly RemoteConfigSecretEntry[];
};
export type RemoteConfigPatchParams = { file: RemoteConfigFileKey; expectedVersion: string; patch: Record<string, unknown> };

// ── F3: one-shot terminal launch ticket and the fixed terminal runner ─────────────────────────────

/**
 * Terminal launch ticket (security review F3, plan §6.5.2): main asks the helper for one opaque, single-use
 * reference, launches the fixed `terminal-runner.mjs` with `ssh -tt`, and hands the reference to the runner over
 * one bounded init frame. The renderer never supplies cwd/shell/argv/ticket; the helper mints the ticket for its
 * own verified root and the binding facts main already proved (live locator host id, route digest, project id).
 */
export const REMOTE_HELPER_METHOD_TERMINAL_PREPARE = "terminal.prepare";
/** A launch ticket lives long enough for one immediate launch and no longer. */
export const REMOTE_TERMINAL_TICKET_TTL_MS = 60_000;
/** Claim temp names the frozen runner creates during atomic consumption; the helper sweep must match this shape. */
export const REMOTE_TERMINAL_TICKET_CLAIM_PREFIX = ".claim-";
export const REMOTE_TERMINAL_TICKET_CLAIM_PATTERN = /^\.claim-[0-9a-f]{32}-[1-9][0-9]{0,9}$/;
export const REMOTE_TERMINAL_TICKET_REF_LENGTH = 32;
export const REMOTE_TERMINAL_TICKET_MAX_BYTES = 4096;
/** Directory under the deploy root; 0700 owner-only, deliberately outside the immutable bundle. */
export const REMOTE_TERMINAL_TICKETS_DIRECTORY = "terminal-tickets";
/** Bounded sweep: at most this many directory entries are inspected per mint, and only our own entries are pruned. */
export const REMOTE_TERMINAL_TICKET_SWEEP_LIMIT = 256;
export const REMOTE_TERMINAL_TICKET_VERSION = 1;
/** The only launch kind this batch mints: only project roots may be initialized this way. */
export type RemoteTerminalPrepareParams = { kind: "project"; projectId: string; hostId: string; routeDigest: string };
/** The only thing the helper answers: an opaque ref; the cwd lives in the ticket file, not in a frame. */
export type RemoteTerminalPrepareResult = { ticketRef: string };
/** Ticket content; every field is re-checked by the runner, never trusted as a launch plan. */
export type RemoteTerminalTicket = { v: 1; kind: "project"; projectId: string; hostId: string; routeDigest: string; cwd: string; bundleSha256: string; ticketRef: string; expiresAt: number };
export const REMOTE_TERMINAL_PROJECT_ID_MAX_LENGTH = 256;
export const REMOTE_TERMINAL_HOST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const REMOTE_TERMINAL_ROUTE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const REMOTE_TERMINAL_TICKET_REF_PATTERN = /^[0-9a-f]{32}$/;
export const REMOTE_TERMINAL_BUNDLE_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Runner handshake frames. The frozen runner writes an RS/US-wrapped ASCII marker terminated by CRLF; Windows
 * node-pty ConPTY strips the C0 wrapper bytes (RS 0x1e / US 0x1f) but keeps CRLF, so main matches the plain
 * marker and consumes through the CRLF. RS and a trailing US are tolerated when present (Linux PTY), never
 * required: a frame that depends on a stripped byte would deadlock the handshake exactly like the real e2e did.
 */
export const REMOTE_TERMINAL_FRAME_RS = "\u001e";
export const REMOTE_TERMINAL_FRAME_US = "\u001f";
export const REMOTE_TERMINAL_FRAME_TERMINATOR = "\r\n";
export const REMOTE_TERMINAL_READY_MARKER = "PIDECK_TERMINAL/1 READY";
/** START carries the selected login shell (base64url of its absolute path) and is stripped before terminal bytes. */
export const REMOTE_TERMINAL_START_MARKER = "PIDECK_TERMINAL/1 START ";
export const REMOTE_TERMINAL_ERROR_MARKER = "PIDECK_TERMINAL/1 ERROR ";
/** Exact wire frames the frozen runner writes; the parser accepts these with RS/US missing (ConPTY). */
export const REMOTE_TERMINAL_READY_FRAME = REMOTE_TERMINAL_FRAME_RS + REMOTE_TERMINAL_READY_MARKER + REMOTE_TERMINAL_FRAME_US + REMOTE_TERMINAL_FRAME_TERMINATOR;
export const REMOTE_TERMINAL_START_FRAME_PREFIX = REMOTE_TERMINAL_FRAME_RS + REMOTE_TERMINAL_START_MARKER;
export const REMOTE_TERMINAL_ERROR_FRAME_PREFIX = REMOTE_TERMINAL_FRAME_RS + REMOTE_TERMINAL_ERROR_MARKER;
export const REMOTE_TERMINAL_FRAME_SUFFIX = REMOTE_TERMINAL_FRAME_US;
export const REMOTE_TERMINAL_INIT_FRAME_MAX_BYTES = 1024;
export const REMOTE_TERMINAL_PRE_START_MAX_BYTES = 32 * 1024;
export const REMOTE_TERMINAL_HANDSHAKE_TIMEOUT_MS = 30_000;
export const REMOTE_TERMINAL_SHELL_PATH_MAX_BYTES = 4096;
/** Closed vocabulary the frozen runner may answer in one ERROR frame; anything else is TERMINAL_INTERNAL. */
export const REMOTE_TERMINAL_RUNNER_ERROR_CODES = [
	"TERMINAL_TICKET_ALREADY_CONSUMED",
	"TERMINAL_TICKET_EXPIRED",
	"TERMINAL_TICKET_INVALID",
	"TERMINAL_CWD_CHANGED",
	"TERMINAL_BUNDLE_MISMATCH",
	"TERMINAL_TERMIOS_FAILED",
	"TERMINAL_INPUT_INVALID",
	"TERMINAL_INPUT_TIMEOUT",
	"TERMINAL_SHELL_UNAVAILABLE",
	"TERMINAL_INTERNAL",
] as const;
export type RemoteTerminalRunnerErrorCode = (typeof REMOTE_TERMINAL_RUNNER_ERROR_CODES)[number];

/**
 * Encode the one line main writes after READY: base64url JSON, newline-terminated, bounded and control-free.
 * The runner repeats this frame shape, its bounds and the ref pattern as literals under test.
 */
export function buildRemoteTerminalInitFrame(ticketRef: unknown): string {
	if (typeof ticketRef !== "string" || REMOTE_TERMINAL_TICKET_REF_PATTERN.test(ticketRef) === false) throw new Error("REMOTE_TERMINAL_OPTIONS_INVALID");
	const line = Buffer.from(JSON.stringify({ v: REMOTE_TERMINAL_TICKET_VERSION, ticketRef }), "utf8").toString("base64url");
	if (line.length > REMOTE_TERMINAL_INIT_FRAME_MAX_BYTES) throw new Error("REMOTE_TERMINAL_OPTIONS_INVALID");
	return line + "\n";
}

/**
 * Decode one START frame's shell token. Accepts the bare base64url token the parser extracts as well as the
 * whole wire frame, and tolerates a trailing US and/or CR/LF (ConPTY keeps CRLF, Linux PTY may add CR).
 */
export function decodeRemoteTerminalStartFrame(value: unknown): { shell: string } | null {
	if (typeof value !== "string" || value.length === 0 || value.length > 2 * REMOTE_TERMINAL_SHELL_PATH_MAX_BYTES) return null;
	let token = value;
	if (token.startsWith(REMOTE_TERMINAL_START_FRAME_PREFIX)) token = token.slice(REMOTE_TERMINAL_START_FRAME_PREFIX.length);
	else if (token.startsWith(REMOTE_TERMINAL_START_MARKER)) token = token.slice(REMOTE_TERMINAL_START_MARKER.length);
	for (;;) {
		const last = token.charAt(token.length - 1);
		if (last === "\r" || last === "\n" || last === REMOTE_TERMINAL_FRAME_US) token = token.slice(0, -1);
		else break;
	}
	if (token.length === 0 || token.length > 8192 || /^[A-Za-z0-9_-]+$/.test(token) === false) return null;
	const shell = Buffer.from(token, "base64url").toString("utf8");
	if (shell.length === 0 || shell.length > REMOTE_TERMINAL_SHELL_PATH_MAX_BYTES || shell.charAt(0) !== "/" || /[\u0000-\u001f\u007f]/.test(shell)) return null;
	return { shell };
}

/** Staged-connection phases a bootstrap run walks through (plan §11.1 test-connection stages). */
export type RemoteHelperHandshake = {
	protocolVersion: number;
	platform: string;
	arch: string;
	home: string;
	/**
	 * The canonical directory the helper confined itself to, or null for a host-only session.
	 *
	 * Reported because main cannot otherwise prove that the `--root` it asked for is the one that took
	 * effect: the helper resolves symlinks once at startup, so a root that is itself a link (or points
	 * through one) would otherwise leave the confined boundary different from the path the user confirmed.
	 * With this the confirmation is checkable instead of assumed.
	 */
	root: string | null;
	capabilities: readonly string[];
};

/** Bootstrap manifest entry: one immutable file of the uploaded bundle (§168). */
export type RemoteBundleFile = { name: string; sha256: string; bytes: number };

export type RemoteBundleManifest = {
	schemaVersion: number;
	bundleSha256: string;
	files: readonly RemoteBundleFile[];
};

export const REMOTE_BUNDLE_MANIFEST_SCHEMA_VERSION = 1;
/** Deployment roots and per-file caps stay explicit so a manifest cannot smuggle an unbounded set. */
export const REMOTE_BUNDLE_MAX_FILES = 256;
export const REMOTE_BUNDLE_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const REMOTE_BUNDLE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * Bootstrap staging-session frames (plan §168). The frozen entry caps an inbound line at 4096 bytes,
 * so the manifest travels as one small frame per file instead of a single document.
 */
export const REMOTE_BOOTSTRAP_PROTOCOL_VERSION = 1;
export const REMOTE_BOOTSTRAP_MAX_FRAME_BYTES = 4096;
/** Immutable, content-addressed activation target: `<deployRoot>/bundles/<bundleSha256>`. */
export const REMOTE_BOOTSTRAP_BUNDLE_DIR_NAME = "bundles";
/** File modes the entry accepts: regular files 0600, executables 0700. */
export const REMOTE_BOOTSTRAP_FILE_MODES = ["0600", "0700"] as const;
export type RemoteBootstrapFileMode = (typeof REMOTE_BOOTSTRAP_FILE_MODES)[number];

export type RemoteBootstrapFinalizeBeginFrame = { v: 1; op: "finalize-begin"; files: number; bundleSha256: string };
export type RemoteBootstrapFinalizeFileFrame = { v: 1; op: "finalize-file"; name: string; sha256: string; bytes: number; mode: RemoteBootstrapFileMode };
export type RemoteBootstrapFinalizeCommitFrame = { v: 1; op: "finalize-commit" };
/**
 * Read-only reuse check (plan F3): the same declaration frames, but instead of a commit the entry is asked
 * to re-prove the already active `<target>/<bundleSha256>` directory. It answers `verified` (main skips the
 * upload), `verify-miss` with `reason: absent` (continue with the upload) or `conflict` (stop: an installed
 * but different directory is never overwritten), or an `error` frame.
 */
export type RemoteBootstrapFinalizeVerifyFrame = { v: 1; op: "finalize-verify" };
export type RemoteBootstrapAbortFrame = { v: 1; op: "abort" };
export type RemoteBootstrapInboundFrame = RemoteBootstrapFinalizeBeginFrame | RemoteBootstrapFinalizeFileFrame | RemoteBootstrapFinalizeCommitFrame | RemoteBootstrapFinalizeVerifyFrame | RemoteBootstrapAbortFrame;

export type RemoteBootstrapReadyFrame = { v: 1; op: "ready"; protocolVersion: number; bundleSha256: string; nonce: string; deployRoot: string; staging: string; stagingMode: "0700" };
export type RemoteBootstrapFinalizedFrame = { v: 1; op: "finalized"; active: string; files: number };
export type RemoteBootstrapVerifiedFrame = { v: 1; op: "verified"; active: string; files: number };
export type RemoteBootstrapVerifyMissFrame = { v: 1; op: "verify-miss"; reason: "absent" | "conflict" };
export type RemoteBootstrapAbortedFrame = { v: 1; op: "aborted"; reason: "requested" | "eof" };
export type RemoteBootstrapErrorFrame = { v: 1; op: "error"; code: string };
export type RemoteBootstrapResultFrame = RemoteBootstrapReadyFrame | RemoteBootstrapFinalizedFrame | RemoteBootstrapVerifiedFrame | RemoteBootstrapVerifyMissFrame | RemoteBootstrapAbortedFrame | RemoteBootstrapErrorFrame;

export const REMOTE_BOOTSTRAP_FINALIZE_ERROR_CODES = ["BOOTSTRAP_INPUT_INVALID", "BOOTSTRAP_ENTRY_OP_UNSUPPORTED", "BOOTSTRAP_FINALIZE_INCOMPLETE", "BOOTSTRAP_FILE_MISMATCH", "BOOTSTRAP_MODE_INVALID", "BOOTSTRAP_ACTIVE_CONFLICT", "BOOTSTRAP_INTERNAL"] as const;
export type RemoteBootstrapFinalizeErrorCode = (typeof REMOTE_BOOTSTRAP_FINALIZE_ERROR_CODES)[number];
