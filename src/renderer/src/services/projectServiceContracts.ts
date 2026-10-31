import type { Op } from "../../../shared/op";
import type { HostConnectionStateLike } from "../../../shared/projectCapabilities";
import type { GitAheadBehind, GitBranchInfo, GitCompareRefsValue, GitDiscardResource, GitHistoryPage, GitRef, GitRepositoryListing, GitResourceGroups, GitWorkspaceDiffGroup, GitWorkspaceFileDiff, WorktreeEntry } from "../../../shared/types/git";
import type { Project, ProjectFileTarget } from "../../../shared/types";
import type { ProjectDirectoryPage } from "../../../shared/types/projectFiles";
import type { RemoteProjectSearchEntry } from "../../../shared/types/remoteHost";
import type { FileContentSearchResult, FileSearchResult } from "../../../shared/types/session";
import type { PiDesktopApi } from "../../../preload";

/**
 * 工作区面板的服务缝（S 检查点）。
 *
 * 与 Phase A 草案的区别（见 docs/remote-project-parallel-handoff.md §4）：
 * - 服务实例绑定明确项目身份：构造时带 projectId，方法不再让业务组件传“当前项目”；
 * - 事实快照（host/root/helper/trust/generation）参与能力判定，能力缺失必须带稳定原因；
 * - 异步结果有代数围栏：连接代变化后，旧代成功/失败都不再作为结果发布；
 * - 写面返回既有收据（文本 version、删除 trashId、改名后的 target），unknown 只抛错不重放；
 * - stat 区分 present / missing / unavailable，当前公共 files.stat 只能证明 present。
 *
 * 本文件只放共享契约与错误，不放任何 provider 实现。
 */

/** provider 需要的最小 API 面：本地文件/Git、远端文件管理、远端项目事实。 */
export type ProjectServicesApi = {
	files: PiDesktopApi["files"];
	git: PiDesktopApi["git"];
	remoteHosts: PiDesktopApi["remoteHosts"];
	remoteTrust: PiDesktopApi["remoteTrust"];
};

export const PROJECT_SERVICE_CODES = {
	unsupported: "PROJECT_SERVICE_UNSUPPORTED",
	versionRequired: "PROJECT_SERVICE_VERSION_REQUIRED",
	/** 中性失败码：raw 通道没有稳定码时的回退，不冒充“远端失败”。 */
	failed: "PROJECT_SERVICE_FAILED",
	/** 调用方给的项目身份与服务实例不一致：在触达 IPC 前拒绝。 */
	projectMismatch: "PROJECT_SERVICE_PROJECT_MISMATCH",
	/** 异步结果属于旧连接代：调用方必须丢弃，不能当成功或失败展示。 */
	generationStale: "PROJECT_SERVICE_GENERATION_STALE",
	/** 公共 files.stat 的负结果不能证明“缺失”（读取失败也被折叠成 false）。 */
	statUnavailable: "PROJECT_SERVICE_STAT_UNAVAILABLE",
} as const;

export type ProjectServiceErrorCode = (typeof PROJECT_SERVICE_CODES)[keyof typeof PROJECT_SERVICE_CODES];

/** 服务层的失败：稳定码 + 二阶语义（unknown 只可能来自远端写），并允许带一句内部说明（不直接展示）。 */
export class ProjectServiceError extends Error {
	readonly code: string;
	readonly outcome: "rejected" | "unknown";
	readonly detail?: string;

	constructor(code: string, outcome: "rejected" | "unknown" = "rejected", detail?: string) {
		super(code);
		this.name = "ProjectServiceError";
		this.code = code;
		this.outcome = outcome;
		this.detail = detail;
	}
}

export function unwrapOp<T>(op: Op<T>, fallbackCode: string): T {
	if (op && op.ok === true) return op.value;
	const failure = op as { code?: string; outcome?: "rejected" | "unknown" } | null;
	throw new ProjectServiceError(failure?.code ?? fallbackCode, failure?.outcome ?? "rejected");
}

// ── 项目事实与代数 ──────────────────────────────────────────────────────

/** 远端项目 trust 决策（只作为 Git 能力输入；主进程仍逐操作现读）。 */
export type ProjectServiceTrust = "approved" | "denied" | "stale" | "none" | "unknown";

/** root 复核状态：needs-attention 表示项目根已漂移，读面不能当成“只是旧值”。 */
export type ProjectServiceRootStatus = "ok" | "needs-attention" | "unknown";

export type ProjectServiceFacts = {
	projectId: string;
	locationKind: "local" | "ssh";
	/** 仅 ssh；与 services 绑定一致。 */
	hostId?: string;
	/** 本机项目为 "local"；远端取连接状态机。 */
	hostState: HostConnectionStateLike | "local";
	/** 本机项目环境（内容搜索在 WSL 上不可用）；ssh 项目缺席。 */
	environment?: "windows" | "wsl";
	rootStatus: ProjectServiceRootStatus;
	/** helper hello 声明的实际方法；缺席 = 未知 = 按不支持处理。 */
	helperCapabilities?: readonly string[];
	trust: ProjectServiceTrust;
	/** 连接代围栏：值变化即表示旧代异步结果必须丢弃。 */
	generation: string;
};

/**
 * 代数槽：runtime 在项目/连接代变化时原地更新 current；
 * 服务实例捕获创建时的 generation，await 之后比较槽位，就能识别“旧代结果”。
 */
export type ProjectServiceFenceSlot = { current: string };

export type ProjectServiceFence = {
	readonly generation: string;
	readonly slot: ProjectServiceFenceSlot;
};

export function isProjectServiceCurrent(fence: ProjectServiceFence): boolean {
	return fence.slot.current === fence.generation;
}

/**
 * 代数围栏。读路径用 rejected；写路径必须用 unknown：代变化时写可能已经落地，
 * 调用方不能按“确定没发生”自动重试。
 */
export function assertProjectServiceCurrent(fence: ProjectServiceFence, outcome: "rejected" | "unknown" = "rejected"): void {
	if (!isProjectServiceCurrent(fence)) throw new ProjectServiceError(PROJECT_SERVICE_CODES.generationStale, outcome, outcome === "unknown" ? "write might have been applied on an expired generation" : undefined);
}

// ── 文件结果 ────────────────────────────────────────────────────────────

export type ProjectFileText = { content: string; version?: string };

/**
 * 文件名搜索结果。远端 searchProject 带 truncated/scanned；本机 files.search 没有该元数据时缺席，
 * 不填 false 冒充“结果完整”。
 */
export type ProjectFileSearchResult = {
	results: FileSearchResult[];
	truncated?: boolean;
	scanned?: number;
	/**
	 * 远端 searchProject 的原始条目：保留 `kind: "other"` 与 `bytes`（公共 FileSearchResult 装不下）。
	 * 本机 provider/旧 provider 可缺席；F 有 entries 时优先用它重建视图，绝不把 other 伪装成 file。
	 */
	entries?: RemoteProjectSearchEntry[];
};

/**
 * 文本保存收据：远端 next version 是下一次保存的输入；本机没有 version（textVersion = "none"）。
 * 旧版本由主进程拒绝，provider 绝不用 entry 令牌或重新 open 得到的版本冒充。
 */
export type ProjectTextSaveReceipt = { version?: string };

export type ProjectEntryReceipt = { target: ProjectFileTarget; kind?: "file" | "directory" };

/** 删除收据：远端进回收站时带 trashId；本机没有可恢复收据。 */
export type ProjectEntryDeleteReceipt = { target: ProjectFileTarget; trashId?: string };

/**
 * stat 三态：
 * - present：已证明存在；
 * - missing：已证明不存在（需要公共 files.stat 携带失败码后才会出现）；
 * - unavailable：读不到/不确定——绝不能当成“文件不存在”。
 */
export type ProjectPathAvailability = "present" | "missing" | "unavailable";

export type ProjectServicePathState = {
	target: ProjectFileTarget;
	availability: ProjectPathAvailability;
	/** present 时是事实；unavailable 时缺席（读不到不能猜类型）。 */
	isDirectory?: boolean;
	code?: string;
};

export type ProjectFileService = {
	/** 公共目录页：本地与远端的唯一目录读入口。truncated/revision/generation 原样保留。 */
	listDirectory(target: ProjectFileTarget, options?: { force?: boolean }): Promise<ProjectDirectoryPage>;
	searchFiles(query: string): Promise<ProjectFileSearchResult>;
	/** 内容搜索（公共契约；旧 helper 返回 null = 仅文件名回退）。 */
	searchContent(query: string): Promise<FileContentSearchResult | null>;
	readText(target: ProjectFileTarget, options?: { maxBytes?: number }): Promise<ProjectFileText>;
	/** 远端必须带 readText 返回的 version；缺失/空串由 provider 在触达 IPC 前拒绝。 */
	writeText(target: ProjectFileTarget, content: string, expectedVersion?: string): Promise<ProjectTextSaveReceipt>;
	stat(target: ProjectFileTarget): Promise<ProjectServicePathState>;
	createEntry(parent: ProjectFileTarget, name: string, type: "file" | "directory"): Promise<ProjectEntryReceipt>;
	renameEntry(target: ProjectFileTarget, newName: string, expectedVersion?: string): Promise<ProjectEntryReceipt>;
	/** 移动到项目内另一个目录；destinationRelativePath 是完整目标路径（含文件名）。 */
	moveEntry(target: ProjectFileTarget, destinationRelativePath: string): Promise<ProjectEntryReceipt>;
	deleteEntry(target: ProjectFileTarget, expectedVersion?: string): Promise<ProjectEntryDeleteReceipt>;
	openInEditor(target: ProjectFileTarget): Promise<void>;
	showInFolder(target: ProjectFileTarget): Promise<void>;
};

// ── Git 结果与契约 ──────────────────────────────────────────────────────

/** 创建分支的显式模式：绝不把“仅创建”暗中追加成“创建并切换”。 */
export type ProjectGitBranchMode = "create" | "create-and-checkout";

export type ProjectGitDiscardReceipt = {
	/** 远端可恢复丢弃返回 recoveryRef；本机 discardFiles 没有恢复快照。 */
	recoveryRef?: string | null;
};

/** 同步事实（分支/上游/ahead-behind/remotes）；不触发网络。 */
export type ProjectGitSyncFacts = {
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	remotes: string[];
};

export type ProjectGitRecoveryEntry = { ref: string; oid: string; path: string; bytes: number; at: number };
export type ProjectGitRecoveryListing = { entries: ProjectGitRecoveryEntry[]; truncated: boolean };

/**
 * Git 面板所需动作。读面是公共通道（main 按位置路由）；写面/同步/恢复由 main 逐操作签发令牌，
 * 远端 provider 只负责“写前取 grant、写后作废”，令牌绝不进入渲染层。
 */
export type ProjectGitService = {
	status(repoPath?: ProjectFileTarget): Promise<GitResourceGroups>;
	/** 纯事实强制刷新：越过事实缓存，但不签/不撤授权令牌（远端用 main 的 facts-only 入口，缺省回落带授权副作用的强刷）。 */
	refresh(repoPath?: ProjectFileTarget): Promise<GitResourceGroups>;
	history(options?: { maxCount?: number; skip?: number }, repoPath?: ProjectFileTarget): Promise<GitHistoryPage>;
	repos(): Promise<GitRepositoryListing>;
	refs(repoPath?: ProjectFileTarget): Promise<GitRef[]>;
	compare(base: string, head: string, repoPath?: ProjectFileTarget): Promise<GitCompareRefsValue>;
	workspaceDiff(group: GitWorkspaceDiffGroup, file: ProjectFileTarget, repoPath?: ProjectFileTarget): Promise<GitWorkspaceFileDiff>;
	branches(repoPath?: ProjectFileTarget): Promise<GitBranchInfo>;
	createBranch(name: string, mode: ProjectGitBranchMode, repoPath?: ProjectFileTarget): Promise<void>;
	checkout(branch: string, repoPath?: ProjectFileTarget): Promise<GitBranchInfo>;
	stage(targets: ProjectFileTarget[], repoPath?: ProjectFileTarget): Promise<void>;
	unstage(targets: ProjectFileTarget[], repoPath?: ProjectFileTarget): Promise<void>;
	commit(message: string, repoPath?: ProjectFileTarget): Promise<void>;
	discard(resources: GitDiscardResource[], repoPath?: ProjectFileTarget): Promise<ProjectGitDiscardReceipt>;
	fetch(repoPath?: ProjectFileTarget): Promise<void>;
	pull(repoPath?: ProjectFileTarget): Promise<void>;
	push(repoPath?: ProjectFileTarget): Promise<void>;
	syncFacts(repoPath?: ProjectFileTarget): Promise<ProjectGitSyncFacts>;
	recoveryList(repoPath?: ProjectFileTarget): Promise<ProjectGitRecoveryListing>;
	recoveryRestore(entry: Pick<ProjectGitRecoveryEntry, "ref" | "oid" | "path">, repoPath?: ProjectFileTarget): Promise<void>;
	recoveryDrop(entry: Pick<ProjectGitRecoveryEntry, "ref" | "oid">, repoPath?: ProjectFileTarget): Promise<void>;
	init(): Promise<{ branch: string | null }>;
	deleteFiles(targets: ProjectFileTarget[], repoPath?: ProjectFileTarget): Promise<void>;
	worktreeList(): Promise<WorktreeEntry[]>;
	worktreeCreate(branchName: string): Promise<WorktreeEntry>;
	worktreeRemove(target: ProjectFileTarget): Promise<boolean>;
	/** 当前分支相对上游的差距（本机通道；远端由 provider 从 syncFacts 派生）。 */
	aheadBehind(repoPath?: ProjectFileTarget): Promise<GitAheadBehind | null>;
};

// ── 能力 ────────────────────────────────────────────────────────────────

export type ProjectFileCapabilities = {
	read: boolean;
	/** 文件名搜索：远端 gate helper fs.searchNames。 */
	search: boolean;
	write: boolean;
	/** 删除可恢复（远端 .pideck-trash）；本机 delete 没有回收站收据。 */
	trash: boolean;
	/** 文本保存是否有可校验的 version：远端 required，本机 none。 */
	textVersion: "required" | "none";
	contentSearch: boolean;
	systemOpen: boolean;
	/** full = 有推送/本机 watcher；degraded = 只能显式刷新；none = 读也不可用。 */
	watch: "full" | "degraded" | "none";
};

export type ProjectGitBranchCreateMode = "create" | "create-and-checkout" | "both" | "none";

export type ProjectGitCapabilities = {
	read: boolean;
	/** workspace diff（本地与远端都走公共 git:workspace-diff）。 */
	diff: boolean;
	/** 分支列表（远端由 provider 从 remoteRefs 派生：gate helper git.refs）。 */
	branchRead: boolean;
	/** 历史页：gate helper git.log。 */
	history: boolean;
	/** 仓库发现：gate helper git.repos。 */
	repos: boolean;
	/** 本地引用列表：gate helper git.refs。 */
	refs: boolean;
	/** index/commit/discard 等写动词（远端由 main 逐操作签发令牌：gate helper git.stage/unstage/commit/discard）。 */
	write: boolean;
	branchWrite: boolean;
	branchCreateMode: ProjectGitBranchCreateMode;
	sync: boolean;
	syncFacts: boolean;
	aheadBehind: boolean;
	compare: boolean;
	recovery: boolean;
	worktree: boolean;
	init: boolean;
	/** 纯事实强刷（不签/撤令牌）：远端已接 main 的 facts-only force 入口。 */
	forceRefresh: boolean;
	/** 允许自动触发网络写（自动 fetch）；服务本身从不自动调用。 */
	autoFetch: boolean;
	/** 允许后台定时 status 轮询（远端是 5s 只读轮询 + 事实推送，不 fetch）。 */
	statusPoll: boolean;
	/** 允许 refs 自动刷新（本机 watcher；远端是有界轮询）。 */
	refsWatch: boolean;
	deleteFiles: boolean;
};

export type ProjectServiceCapabilityKey =
	| "files.read"
	| "files.write"
	| "files.trash"
	| "files.search"
	| "files.contentSearch"
	| "files.systemOpen"
	| "files.watch"
	| "git.read"
	| "git.diff"
	| "git.branchRead"
	| "git.history"
	| "git.repos"
	| "git.refs"
	| "git.write"
	| "git.branchWrite"
	| "git.sync"
	| "git.syncFacts"
	| "git.aheadBehind"
	| "git.compare"
	| "git.recovery"
	| "git.worktree"
	| "git.init"
	| "git.forceRefresh"
	| "git.autoFetch"
	| "git.statusPoll"
	| "git.refsWatch"
	| "git.deleteFiles";

/** 每个被关闭能力的第一条稳定原因；可用能力不出现在这里。 */
export type ProjectServiceCapabilityReasons = Partial<Record<ProjectServiceCapabilityKey, string>>;

export type ProjectServiceCapabilities = {
	projectId: string;
	locationKind: "local" | "ssh";
	generation: string;
	trust: ProjectServiceTrust;
	files: ProjectFileCapabilities;
	git: ProjectGitCapabilities;
	blocked: ProjectServiceCapabilityReasons;
};

export type ProjectServices = {
	projectId: string;
	kind: "local" | "remote";
	generation: string;
	facts: ProjectServiceFacts;
	files: ProjectFileService;
	git: ProjectGitService;
	capabilities: ProjectServiceCapabilities;
	/** 服务实例创建时的连接代是否仍是当前代；旧实例不得再发布结果。 */
	isCurrent(): boolean;
	/** 只读重新采集 host/root/trust 事实（trust 决策没有推送事件）。 */
	refresh(): Promise<void>;
};

export type { Project, ProjectFileTarget };
