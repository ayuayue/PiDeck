import type { ProjectFileTarget } from "./project";
import type { Op } from "../op";

// ── Git 基础类型 ──────────────────────────────────────────────────────

export type GitBranchInfo = {
	current: string | null;
	branches: string[];
};

/**
 * 项目目录内发现的独立 Git 仓库（含根仓库与嵌套仓库）。
 * 侧栏按此项切换 cwd，避免把整棵工作区当成单一仓库。
 */
export type GitRepoInfo = {
	target: ProjectFileTarget;
	/** Stable project-relative repository path; empty for the project root. */
	relativePath: string;
	/** Presentation label; must never be used as filesystem authority. */
	displayPath: string;
	name: string;
	/** @deprecated Local-only compatibility for callers not yet migrated. */
	path?: string;
};

/** AI 生成提交摘要的结果：结构化错误码供渲染层区分“未配置/忙碌/超时”，避免透传 pi 英文错误。 */
/**
 * AI 生成提交摘要的结果。
 * 失败原因必须能区分：
 * - 没配置模型 / 上一份还在生成 / 超时 / 模型调用失败（GIT_COMMIT_*）
 * - 仓库目录没解析出来（GIT_COMMIT_NO_REPO）
 * - 没有暂存内容（GIT_COMMIT_EMPTY_DIFF）——最容易被误报成「模型没返回」，用户会白查模型配置
 * - 读暂存 diff 失败（GIT_COMMIT_DIFF_FAILED，message 为 git 原始报错）
 * 只有 `{ ok: true, message: "" }` 才表示「模型返回了空串」。
 */
export type GitGenerateCommitMessageResult =
	| { ok: true; message: string }
	| {
			ok: false;
			/** 渲染层据此决定提示形态（如未配置时带“去设置”按钮、空暂存区提示先暂存并刷新状态） */
			code: "GIT_COMMIT_MODEL_REQUIRED" | "GIT_COMMIT_BUSY" | "GIT_COMMIT_TIMEOUT" | "GIT_COMMIT_GENERATE_FAILED" | "GIT_COMMIT_NO_REPO" | "GIT_COMMIT_EMPTY_DIFF" | "GIT_COMMIT_DIFF_FAILED";
			message: string;
	  };

export type GitFileStatus = "modified" | "added" | "deleted" | "renamed";

export type GitChangedFile = {
	/** Canonical project-relative path using slash separators. */
	path: string;
	target: ProjectFileTarget;
	/** Repository-relative label for presentation. */
	displayPath: string;
	status: GitFileStatus;
	originalPath?: string;
	originalTarget?: ProjectFileTarget;
};

/** git worktree entry registered as a local child project. */
export type WorktreeEntry = {
	target: ProjectFileTarget;
	branch: string;
	displayPath: string;
	/** @deprecated Local-only compatibility. */
	path?: string;
};

// ── VS Code 风格 Git Status 系统 ─────────────────────────────────────

/** Git 文件状态枚举，对应 VS Code Status enum（非 const，用于运行时映射） */
export enum GitStatus {
	INDEX_MODIFIED,
	INDEX_ADDED,
	INDEX_DELETED,
	INDEX_RENAMED,
	INDEX_COPIED,
	MODIFIED,
	DELETED,
	UNTRACKED,
	IGNORED,
	INTENT_TO_ADD,
	INTENT_TO_RENAME,
	TYPE_CHANGED,
	ADDED_BY_US,
	ADDED_BY_THEM,
	DELETED_BY_US,
	DELETED_BY_THEM,
	BOTH_ADDED,
	BOTH_DELETED,
	BOTH_MODIFIED,
	/** 追加在末尾以保持既有 GitStatus 数值稳定。 */
	INDEX_TYPE_CHANGED,
}

/** Git 资源组类型，对应 VS Code ResourceGroupType */
export type GitResourceGroupType = "merge" | "index" | "workingTree" | "untracked";

/** 单个 Git 变更资源，对应 VS Code Resource 类 */
export type GitResource = {
	/** Stable slash-separated project-relative path, mirrored by target for compatibility. */
	path: string;
	target: ProjectFileTarget;
	displayPath: string;
	status: GitStatus;
	letter: string;
	oldPath?: string;
	oldTarget?: ProjectFileTarget;
};

/** 按组分类的 Git 资源 */
export type GitResourceGroups = {
	merge: GitResource[];
	index: GitResource[];
	workingTree: GitResource[];
	untracked: GitResource[];
};

/** Complete read-only repository snapshot; unsupported or failed reads never masquerade as empty status. */
export type GitReadSnapshot = {
	groups: GitResourceGroups;
	head: string | null;
	branch: string | null;
	mutationToken?: string;
	commitToken?: string;
	branchToken?: string;
	switchToken?: string;
	discardToken?: string;
	restoreToken?: string;
	dropToken?: string;
	fetchToken?: string;
	pushToken?: string;
	pullToken?: string;
	/** 提交图谱写动词各自一枚：一个令牌只授权一个动作。 */
	cherryPickToken?: string;
	revertToken?: string;
	resetToken?: string;
	dropCommitToken?: string;
};

// ── G3a：远端历史／引用／提交详情／两个版本之间的单文件差异（只读、有界、超限即拒）──

/**
 * 一页历史：`commits` 有界，`hasMore` 表示还有下一页（由 main 多取一条判断）。
 *
 * `total` 只在调用方显式要总数（`withCount`）时出现：helper 用同一条 log 过滤做 `rev-list --count`，
 * 于是徽章与列表共享一份过滤条件。没要总数时**缺席**，不填 0 冒充「空仓库」。
 */
export type RemoteGitCommit = { oid: string; parents: string[]; authorName: string; authorEmail: string; authorTimeSec: number; subject: string };
export type RemoteGitLogPage = { commits: RemoteGitCommit[]; hasMore: boolean; total?: number };
export type RemoteGitLogResult = { ok: true; page: RemoteGitLogPage } | { ok: false; code: string; message?: string };
/**
 * 提交详情：完整消息（有界 UTF-8）＋相对第一父提交的变更文件列表；根提交无 base。
 *
 * `additions`/`deletions` 来自同一次 `diff-tree --numstat`（二进制文件计数缺席）；
 * `shortStat` 是整条提交的合计，供悬停卡显示 `+N/-M`，缺席时展示层不编造 0。
 */
export type RemoteGitCommitFile = { status: string; path: string; oldPath?: string; additions?: number; deletions?: number };
export type RemoteGitCommitDetail = {
	oid: string;
	parents: string[];
	authorName: string;
	authorEmail: string;
	authorTimeSec: number;
	committerName: string;
	committerEmail: string;
	committerTimeSec: number;
	subject: string;
	message: string;
	files: RemoteGitCommitFile[];
	shortStat?: { files: number; insertions: number; deletions: number };
};
export type RemoteGitCommitDetailResult = { ok: true; detail: RemoteGitCommitDetail } | { ok: false; code: string; message?: string };
/** 暂存区 unified diff 全文（helper `git.stagedDiff`）：空串表示没有暂存内容，超限截断带标记。 */
export type RemoteGitStagedDiff = { diff: string };
export type RemoteGitStagedDiffResult = { ok: true; value: RemoteGitStagedDiff } | { ok: false; code: string; message?: string };
/** 本地分支与 tag；不含 remote-tracking ref，避免暗示尚未交付的同步状态。 */
export type RemoteGitRef = { fullName: string; name: string; oid: string; kind: "branch" | "tag" };
export type RemoteGitRefs = { head: string | null; branch: string | null; refs: RemoteGitRef[] };
export type RemoteGitRefsResult = { ok: true; refs: RemoteGitRefs } | { ok: false; code: string; message?: string };
/** `base: null` 表示该侧不存在（根提交，或该侧新增文件）；两侧都不存在时拒绝。 */
export type RemoteGitRefFileDiff = { path: string; target: ProjectFileTarget; displayPath: string; base: string | null; head: string; originalContent: string; modifiedContent: string };
export type RemoteGitRefFileDiffResult = { ok: true; diff: RemoteGitRefFileDiff } | { ok: false; code: string; message?: string };
/**
 * G5b refs compare：两个**全名本地引用**（refs/heads/* 或 refs/tags/*）之间的有界变更文件列表。
 * 结果携带解析后的 OID，逐文件两侧内容仍走既有 `remoteRefFileDiff`（同一 diff 视图），不新增内容通道。
 */
export type RemoteGitCompareSide = { ref: string; oid: string };
export type RemoteGitCompareFile = { status: string; path: string; oldPath?: string };
export type RemoteGitCompare = {
	base: RemoteGitCompareSide;
	head: RemoteGitCompareSide;
	files: RemoteGitCompareFile[];
	/**
	 * 公共 compareRefs（T7）答案的语义与三点计数：trees 才需要「无 merge-base / ahead-behind」说明，
	 * merge-base 相反。旧的 remoteCompare 兼容壳不填（远端它本来就是两树比较）。
	 */
	mode?: GitCompareMode;
	ahead?: number;
	behind?: number;
	/** 三点语义解析出的 merge-base（`trees` 没有，缺席）。 */
	mergeBase?: string;
};
export type RemoteGitCompareResult = { ok: true; compare: RemoteGitCompare } | { ok: false; code: string; message?: string };
/**
 * G5c explicit init: creates .git at the project root and reports the default branch of the new repository.
 * The renderer only sends projectId; main and the helper decide whether the root may be initialized at all.
 */
export type RemoteGitInitResult = { ok: true; branch: string | null } | { ok: false; code: string; message?: string };
/**
 * G5d repository discovery: repositories under the project root as the remote helper found them. `path` is a
 * project-relative POSIX path ("" is the root repository) and is the only value that may become a read scope;
 * `name` is a display label. `truncated` says the helper's bounded walk was cut by a cap.
 */
export type RemoteGitRepo = { path: string; name: string };
export type RemoteGitReposResult = { ok: true; repos: RemoteGitRepo[]; truncated: boolean } | { ok: false; code: string; message?: string };
/**
 * 忽略判定（helper 1.23.0）：`ignored` 与请求**逐位对应**——同序、同长、不省略。
 * 由 git 自己回答（`check-ignore --no-index`），所以取反规则、嵌套 .gitignore、core.excludesFile
 * 与 git status 的口径天然一致；PiDeck 不重写匹配器。
 */
export type RemoteGitIgnoreResult = Op<{ ignored: boolean[] }>;
/** G3b branch write face: creating and switching both move a ref the user explicitly asked for. */
export type RemoteGitBranchMutationResult = { ok: true } | { ok: false; code: string; message?: string };
/** G4a recoverable discard: the snapshot ref (null when the discarded change was a deletion) goes back to the panel. */
export type RemoteGitDiscardResult = { ok: true; recoveryRef: string | null } | { ok: false; code: string; message?: string };
/** G4b recovery store: the list is read-only, restore and drop each need their own main-owned grant. */
export type RemoteGitRecoveryEntryView = { ref: string; oid: string; path: string; bytes: number; at: number };
export type RemoteGitRecoveryListResult = { ok: true; entries: RemoteGitRecoveryEntryView[]; truncated: boolean } | { ok: false; code: string; message?: string };
export type RemoteGitRecoveryRestoreResult = { ok: true; path: string; bytes: number } | { ok: false; code: string; message?: string };
export type RemoteGitRecoveryDropResult = { ok: true } | { ok: false; code: string; message?: string };
/** G5a sync: facts are read-only, the three verbs each need their own grant and never force anything. */
export type RemoteGitSyncFactsView = { branch: string | null; upstream: string | null; ahead: number; behind: number; remotes: string[] };
export type RemoteGitSyncFactsResult = { ok: true; facts: RemoteGitSyncFactsView } | { ok: false; code: string; message?: string };
export type RemoteGitFetchOutcome = { upToDate: boolean; updated: { ref: string; before: string | null; after: string }[] };
export type RemoteGitFetchOutcomeResult = { ok: true; outcome: RemoteGitFetchOutcome } | { ok: false; code: string; message?: string };
export type RemoteGitPushOutcome = { outcome: "up-to-date" | "pushed" | "new"; refspec: string };
export type RemoteGitPushOutcomeResult = { ok: true; outcome: RemoteGitPushOutcome } | { ok: false; code: string; message?: string };
export type RemoteGitPullOutcome = { mode: "up-to-date" | "fast-forward" | "merge"; head: string };
export type RemoteGitPullOutcomeResult = { ok: true; outcome: RemoteGitPullOutcome } | { ok: false; code: string; message?: string };
/** An uncertain mutation must be checked by a fresh read, never automatically replayed. */
export type GitIndexMutationResult = { ok: true } | { ok: false; code: string; message?: string };
/** A commit has no renderer-visible result beyond success: the new HEAD is read back through a fresh snapshot. */
export type GitCommitResult = { ok: true } | { ok: false; code: string; message?: string };
export type GitReadSnapshotResult = { ok: true; snapshot: GitReadSnapshot } | { ok: false; code: string; message?: string };

/** 批量回滚时保留资源组，避免同一目录中的 tracked/untracked 文件混淆。 */
export type GitDiscardResource = {
	group: "workingTree" | "untracked";
	target: ProjectFileTarget;
};

/** Git Changes 各资源组打开 Diff 时的比较上下文。 */
export type GitWorkspaceDiffGroup = GitResourceGroupType;

/**
 * Git 工作区单文件 Diff 的两侧快照。内容只在用户点击资源行时读取，
 * 不随 status 轮询返回，避免在常驻 Git 抽屉中缓存所有变更文件内容。
 */
export type GitWorkspaceFileDiff = {
	path: string;
	target: ProjectFileTarget;
	displayPath: string;
	originalContent: string;
	modifiedContent: string;
};

// ── Git 增强：提交历史 / 分支对比 / Graph ──────────────────────────────

/** 单个 Git 提交记录，对应 git log 一行输出 */
export type CommitEntry = {
	hash: string; // 完整 SHA
	shortHash: string; // 短 SHA（前 7 位）
	message: string; // 提交信息首行（subject）
	authorName: string;
	authorEmail: string;
	authorDate: number; // unix timestamp (ms)：GitService 已把 git 的秒级时间戳乘 1000，消费方直接用 new Date(ms)
	parents: string[]; // 父提交 hash 列表
	refNames: string[]; // 关联的 ref 名称（如 HEAD -> main, origin/main）
	/** git log --graph 输出的 ASCII 图谱行（等宽字体渲染即得分支图） */
	graph: string[];
	/** 完整提交信息；历史列表仍使用 message 作为单行 subject。 */
	fullMessage?: string;
	/** 改动的文件统计（仅 getCommitDetail 填充，getCommitLog 不包含） */
	shortStat?: { files: number; insertions: number; deletions: number };
};

/** 单个提交的按需详情，对应 VS Code SCM History 的 resolve + changes。 */
export type CommitDetail = {
	commit: CommitEntry;
	files: GitChangedFile[];
};

/** 提交历史中单个文件相对第一父提交的两侧内容，供 Monaco Diff Viewer 展示。 */
export type GitCommitFileDiff = {
	path: string;
	target: ProjectFileTarget;
	displayPath: string;
	originalPath?: string;
	originalTarget?: ProjectFileTarget;
	originalContent: string;
	modifiedContent: string;
};

/** Git 引用（分支 / 远程分支 / Tag） */
export type GitRef = {
	name: string; // 短名称（如 main, v1.0）
	fullName: string; // 完整 ref（如 refs/heads/main）
	hash: string; // 对象 SHA
	type: "head" | "remote" | "tag";
};

/**
 * 本机可还原丢弃（与远端同一套语义）：丢弃前把文件字节写进仓库对象库，
 * 并把一条快照 commit 挂在 `refs/pideck/recovery/<stamp>` 下；只有用户显式删除才会消失。
 */
export type GitRecoveryEntry = {
	/** 快照 ref 全名（`refs/pideck/recovery/...`），删除时原样回传。 */
	ref: string;
	/** 快照 commit 的 OID。 */
	oid: string;
	/** 项目相对路径（POSIX），还原即写回这个位置。 */
	path: string;
	bytes: number;
	/** 快照时间（Unix 毫秒）。 */
	at: number;
};
/** 列表超出上限时 `truncated` 为真而不是把结果裁成“完整”。 */
export type GitRecoveryListing = { entries: GitRecoveryEntry[]; truncated: boolean };

/** 两个分支之间的差异概要 */
/** 当前分支相对其上游（@{upstream}）的提交差距；无上游/非仓库时为 null。 */
export type GitAheadBehind = {
	/** 本地领先上游的提交数（push 可送出） */
	ahead: number;
	/** 本地落后上游的提交数（pull 可拉入） */
	behind: number;
};

export type BranchDiffResult = {
	/** 变更的文件列表（base...target 三点语法 symmetric difference） */
	files: GitChangedFile[];
	ahead: number; // target 比 base 多几个 commit
	behind: number; // target 比 base 少几个 commit（等于 0 时 base 是 target 的子集）
};

// ── Git 可执行文件探测（设置页「Git 可执行文件」行契约）────────────────

/** 探测结果的来源，决定设置页展示文案与是否提示用户干预。 */
export type GitExecutableSource = "configured" | "path" | "known-location" | "not-found";

/** 一次成功探测的结论：绝对路径 + 版本号。 */
export type GitExecutableProbe = {
	resolvedPath: string;
	version: string;
};

/** 系统自动探测结论（忽略用户配置），带来源以便区分「PATH 命中」与「按安装位置找到」。 */
export type GitSystemProbe = GitExecutableProbe & {
	source: Exclude<GitExecutableSource, "configured" | "not-found">;
};

/** git:detect-executable 的返回值。 */
export type GitExecutableInfo = {
	/** 当前实际会生效的来源 */
	source: GitExecutableSource;
	/** 实际会 spawn 的命令：用户配置路径，或字面量 "git"（走 PATH） */
	executable: string;
	/** 解析出的绝对路径；PATH 模式下由 where/which 得出，失败为空 */
	resolvedPath: string;
	/** 形如 "2.53.0"；探测失败为空 */
	version: string;
	/** 失败原因，成功时为 null */
	error: string | null;
	/** 系统自动探测结果：配置为空时展示占位，配置无效时提供一键填入的备选 */
	system: GitSystemProbe | null;
};

// ── 公共 Git 面（v5 T7）：本地与 SSH 同一形状的读入口 ───────────────────
/**
 * 公共历史条目：两种 backend 都映射到这一份。本地额外的图谱/引用是可选字段，
 * 远端 HEAD-only 时自然缺席；不允许用空数组/0 冒充“本地也支持”。
 */
export type GitHistoryCommit = {
	oid: string;
	parents: string[];
	subject: string;
	authorName: string;
	authorEmail: string;
	authorTimeMs: number;
	shortHash?: string;
	refNames?: string[];
	graph?: string[];
	fullMessage?: string;
};

/** 公共历史页：`totalCount` 只有本地能给；远端显式缺席（不填 0）。 */
export type GitHistoryPage = { commits: GitHistoryCommit[]; hasMore: boolean; totalCount?: number };
export type GitHistoryPageResult = Op<GitHistoryPage>;

/** 比较语义必须显式：三点（merge-base）与直接两树（trees）不是同一件事。 */
export type GitCompareMode = "merge-base" | "trees";
export type GitCompareRefsSide = { ref: string; oid: string };
export type GitCompareRefsFile = { status: string; path: string; oldPath?: string };
export type GitCompareRefsValue = {
	mode: GitCompareMode;
	base: GitCompareRefsSide;
	head: GitCompareRefsSide;
	files: GitCompareRefsFile[];
	/** 三点模式才有；远端两树比较不支持时缺席，不填 0。 */
	ahead?: number;
	behind?: number;
};
export type GitCompareRefsResult = Op<GitCompareRefsValue>;

/** 仓库列表的公共结果：`truncated` 是发现阶段的真实元数据，不得在归一化时丢失。 */
export type GitRepositoryListing = { repos: GitRepoInfo[]; truncated: boolean; revision: number; generation: string };
export type GitRepositoryListResult = Op<GitRepositoryListing>;
