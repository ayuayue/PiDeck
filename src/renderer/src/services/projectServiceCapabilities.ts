import { PROJECT_CAPABILITY_REASONS, resolveProjectCapabilities } from "../../../shared/projectCapabilities";
import { REMOTE_CONTENT_SEARCH_CAPABILITY } from "../utils/fileSearchCapability";
import type { ProjectGitBranchCreateMode, ProjectGitCapabilities, ProjectFileCapabilities, ProjectServiceCapabilities, ProjectServiceCapabilityKey, ProjectServiceCapabilityReasons, ProjectServiceFacts } from "./projectServiceContracts";

/**
 * 服务能力（S 检查点的唯一判定）。
 *
 * 输入分三层：
 * 1. shared/projectCapabilities 的连接/可写判定（「主机 ready」只有一个定义）；
 * 2. 项目事实（root 复核、trust、helper hello 声明的实际方法）；
 * 3. provider 的**实际方法支持**（例如远端 Git 写、分支、同步、恢复与纯事实强刷是否真的实现）。
 *
 * 原则：能力只决定 UI 是否提供入口，绝不替代 main 的逐操作授权；能力缺失必须带稳定原因，
 * 未知一律按不可用处理（helper 能力缺席 = 不支持，不靠“试一次失败”来猜）。
 */

/** helper hello 的方法名（与 main/remote/RemoteHelperContract.ts 同 wire 词汇；渲染层不能 import 主进程模块）。 */
const HELPER_METHOD = {
	gitStatus: "git.status",
	gitWorkspaceDiff: "git.workspaceDiff",
	gitLog: "git.log",
	gitRepos: "git.repos",
	gitRefs: "git.refs",
	gitCompare: "git.compare",
	gitStage: "git.stage",
	gitDiscard: "git.discard",
	gitUnstage: "git.unstage",
	gitCommit: "git.commit",
	gitCreateBranch: "git.createBranch",
	gitSwitchBranch: "git.switchBranch",
	gitFetch: "git.fetch",
	gitPush: "git.push",
	gitPull: "git.pull",
	gitSyncFacts: "git.syncFacts",
	gitInit: "git.init",
	gitRecoveryList: "git.recoveryList",
	gitRecoveryRestore: "git.recoveryRestore",
	gitRecoveryDrop: "git.recoveryDrop",
	fsWatch: "fs.watch",
	fsSearchNames: "fs.searchNames",
} as const;

export const PROJECT_SERVICE_CAPABILITY_REASONS = {
	hostNotReady: PROJECT_CAPABILITY_REASONS.hostNotReady,
	hostDegraded: PROJECT_CAPABILITY_REASONS.hostDegraded,
	rootNeedsAttention: "PROJECT_SERVICE_CAPABILITY_ROOT_NEEDS_ATTENTION",
	trustRequired: "PROJECT_SERVICE_CAPABILITY_TRUST_REQUIRED",
	trustStale: "PROJECT_SERVICE_CAPABILITY_TRUST_STALE",
	trustUnknown: "PROJECT_SERVICE_CAPABILITY_TRUST_UNKNOWN",
	helperMethodMissing: "PROJECT_SERVICE_CAPABILITY_HELPER_METHOD_MISSING",
	providerUnsupported: "PROJECT_SERVICE_CAPABILITY_PROVIDER_UNSUPPORTED",
} as const;

/** provider 真实实现的方法集合；能力只决定 UI 入口，main 仍逐操作授权。 */
export type ProjectServiceMethodSupport = {
	systemOpen: boolean;
	fileSearch: boolean;
	fileTrash: boolean;
	gitRead: boolean;
	gitDiff: boolean;
	gitBranches: boolean;
	gitAheadBehind: boolean;
	gitWrite: boolean;
	gitBranchWrite: boolean;
	gitBranchCreateMode: ProjectGitBranchCreateMode;
	gitSync: boolean;
	gitSyncFacts: boolean;
	gitRecovery: boolean;
	gitWorktree: boolean;
	gitInit: boolean;
	gitForceRefresh: boolean;
	gitAutoFetch: boolean;
	gitStatusPoll: boolean;
	gitRefsWatch: boolean;
	gitDeleteFiles: boolean;
};

export const LOCAL_PROJECT_SERVICE_METHODS: ProjectServiceMethodSupport = {
	systemOpen: true,
	fileSearch: true,
	fileTrash: false,
	gitRead: true,
	gitDiff: true,
	gitBranches: true,
	gitAheadBehind: true,
	gitWrite: true,
	gitBranchWrite: true,
	gitBranchCreateMode: "create-and-checkout",
	gitSync: true,
	gitSyncFacts: false,
	gitRecovery: false,
	gitWorktree: true,
	gitInit: true,
	gitForceRefresh: true,
	gitAutoFetch: true,
	gitStatusPoll: true,
	gitRefsWatch: true,
	gitDeleteFiles: true,
};

/**
 * 远端：文件读写由既有 helper 通道承担；Git 读/强刷由 main 路由，写面走 main 逐操作签发的令牌。
 * 能力只决定 UI 入口，不替代 main 的授权：每一项在 helper 未声明时仍由 helperBlock 关闭。
 * autoFetch 恒 false（远端只在显式同步时联网）；worktree/deleteFiles 保持不可用（远端无本机 .git 目录，
 * 删除归文件服务回收站路径）。
 */
export const REMOTE_PROJECT_SERVICE_METHODS: ProjectServiceMethodSupport = {
	systemOpen: false,
	fileSearch: true,
	fileTrash: true,
	gitRead: true,
	gitDiff: true,
	gitBranches: true,
	gitAheadBehind: true,
	gitWrite: true,
	gitBranchWrite: true,
	gitBranchCreateMode: "both",
	gitSync: true,
	gitSyncFacts: true,
	gitRecovery: true,
	gitWorktree: false,
	gitInit: true,
	gitForceRefresh: true,
	gitAutoFetch: false,
	gitStatusPoll: true,
	gitRefsWatch: true,
	gitDeleteFiles: false,
};

function declares(facts: ProjectServiceFacts, method: string): boolean {
	return (facts.helperCapabilities ?? []).includes(method);
}

function declaresAll(facts: ProjectServiceFacts, methods: readonly string[]): boolean {
	return methods.every((method) => declares(facts, method));
}

/** trust 只门禁 main 真的会现读 trust 的面：远端 Git。文件 API 不读 trust，不能替它发明策略。 */
function gitTrustBlock(facts: ProjectServiceFacts): string | undefined {
	if (facts.locationKind !== "ssh") return undefined;
	if (facts.trust === "approved") return undefined;
	if (facts.trust === "stale") return PROJECT_SERVICE_CAPABILITY_REASONS.trustStale;
	if (facts.trust === "unknown") return PROJECT_SERVICE_CAPABILITY_REASONS.trustUnknown;
	return PROJECT_SERVICE_CAPABILITY_REASONS.trustRequired;
}

/** 远端 helper 必须显式声明该动作，旧 helper 缺席就是不可用；本机不走 helper。 */
function helperBlock(facts: ProjectServiceFacts, methods: readonly string[]): string | undefined {
	if (facts.locationKind !== "ssh") return undefined;
	return declaresAll(facts, methods) ? undefined : PROJECT_SERVICE_CAPABILITY_REASONS.helperMethodMissing;
}

function providerBlock(availableByMethod: boolean): string | undefined {
	return availableByMethod ? undefined : PROJECT_SERVICE_CAPABILITY_REASONS.providerUnsupported;
}

export function resolveProjectServiceCapabilities(facts: ProjectServiceFacts, methods: ProjectServiceMethodSupport): ProjectServiceCapabilities {
	const base = resolveProjectCapabilities({
		locationKind: facts.locationKind,
		hostState: facts.hostState,
		...(facts.helperCapabilities === undefined ? {} : { helperCapabilities: facts.helperCapabilities }),
	});
	const blocked: ProjectServiceCapabilityReasons = {};
	const close = (key: ProjectServiceCapabilityKey, reason: string | undefined): boolean => {
		if (reason === undefined) return true;
		blocked[key] = reason;
		return false;
	};

	// root 漂移是项目级事实：读面也不能继续把旧目录当成可用；unknown 不阻断（main 仍逐次校验）。
	const rootBlock = facts.rootStatus === "needs-attention" ? PROJECT_SERVICE_CAPABILITY_REASONS.rootNeedsAttention : undefined;
	const hostReadBlock = base.readFiles ? undefined : (base.reason ?? PROJECT_SERVICE_CAPABILITY_REASONS.hostNotReady);
	const hostWriteBlock = base.writeFiles ? undefined : (base.reason ?? PROJECT_SERVICE_CAPABILITY_REASONS.hostDegraded);

	const filesRead = close("files.read", rootBlock ?? hostReadBlock);
	const filesWrite = close("files.write", rootBlock ?? hostWriteBlock);
	const filesTrash = filesWrite ? close("files.trash", providerBlock(methods.fileTrash)) : close("files.trash", rootBlock ?? hostWriteBlock);
	const helperSearch = facts.locationKind === "local" || declares(facts, HELPER_METHOD.fsSearchNames);
	const filesSearch = filesRead ? close("files.search", providerBlock(methods.fileSearch) ?? (helperSearch ? undefined : PROJECT_SERVICE_CAPABILITY_REASONS.helperMethodMissing)) : close("files.search", rootBlock ?? hostReadBlock);
	const helperContentSearch = facts.locationKind === "local" ? facts.environment !== "wsl" : declares(facts, REMOTE_CONTENT_SEARCH_CAPABILITY);
	const filesContentSearch = filesRead ? close("files.contentSearch", helperContentSearch ? undefined : PROJECT_SERVICE_CAPABILITY_REASONS.helperMethodMissing) : close("files.contentSearch", rootBlock ?? hostReadBlock);
	const filesSystemOpen = close("files.systemOpen", providerBlock(methods.systemOpen));
	const watch: ProjectFileCapabilities["watch"] = facts.locationKind === "local" ? "full" : !filesRead ? "none" : base.watch ? "full" : "degraded";
	if (watch !== "full") blocked["files.watch"] = filesRead ? PROJECT_CAPABILITY_REASONS.helperNoWatch : (rootBlock ?? hostReadBlock ?? PROJECT_SERVICE_CAPABILITY_REASONS.hostNotReady);

	const trustBlock = gitTrustBlock(facts);
	const gitRead = close("git.read", rootBlock ?? hostReadBlock ?? trustBlock ?? providerBlock(methods.gitRead) ?? helperBlock(facts, [HELPER_METHOD.gitStatus]));
	const gitDiff = gitRead && close("git.diff", providerBlock(methods.gitDiff) ?? helperBlock(facts, [HELPER_METHOD.gitWorkspaceDiff]));
	const gitHistory = gitRead && close("git.history", helperBlock(facts, [HELPER_METHOD.gitLog]));
	const gitRepos = gitRead && close("git.repos", helperBlock(facts, [HELPER_METHOD.gitRepos]));
	const gitRefs = gitRead && close("git.refs", helperBlock(facts, [HELPER_METHOD.gitRefs]));
	// 分支读实际走 helper 的 git.refs（provider.branches 由 remoteRefs 派生）：helper 没声明就不能宣布可用。
	const gitBranchRead = gitRead && close("git.branchRead", providerBlock(methods.gitBranches) ?? helperBlock(facts, [HELPER_METHOD.gitRefs]));
	// ahead/behind 由 provider 从 syncFacts 派生：helper 没声明 git.syncFacts 时它必然失败。
	const gitAheadBehind = gitRead && close("git.aheadBehind", providerBlock(methods.gitAheadBehind) ?? helperBlock(facts, [HELPER_METHOD.gitSyncFacts]));
	// Git 写面与文件写共用同一个主机可写结论：degraded 的会话不健康，写错是数据损坏；main 仍逐操作授权。
	// discard 也是写动作：main 只在 helper 声明 git.discard 时签 discardToken，缺席就保守关闭整个写入口。
	const gitWrite = gitRead && close("git.write", hostWriteBlock ?? providerBlock(methods.gitWrite) ?? helperBlock(facts, [HELPER_METHOD.gitStage, HELPER_METHOD.gitUnstage, HELPER_METHOD.gitCommit, HELPER_METHOD.gitDiscard]));
	const gitBranchWrite = gitRead && close("git.branchWrite", hostWriteBlock ?? providerBlock(methods.gitBranchWrite) ?? helperBlock(facts, [HELPER_METHOD.gitCreateBranch, HELPER_METHOD.gitSwitchBranch]));
	const branchCreateMode: ProjectGitBranchCreateMode = gitBranchWrite ? methods.gitBranchCreateMode : "none";
	const gitSync = gitRead && close("git.sync", hostWriteBlock ?? providerBlock(methods.gitSync) ?? helperBlock(facts, [HELPER_METHOD.gitFetch, HELPER_METHOD.gitPush, HELPER_METHOD.gitPull]));
	const gitSyncFacts = gitRead && close("git.syncFacts", providerBlock(methods.gitSyncFacts) ?? helperBlock(facts, [HELPER_METHOD.gitSyncFacts]));
	const gitCompare = gitRead && close("git.compare", helperBlock(facts, [HELPER_METHOD.gitCompare]));
	// 恢复区的还原/删除是写：主机不可写时整区关闭（列表同为读取，但能力位不拆两档）。
	const gitRecovery = gitRead && close("git.recovery", hostWriteBlock ?? providerBlock(methods.gitRecovery) ?? helperBlock(facts, [HELPER_METHOD.gitRecoveryList, HELPER_METHOD.gitRecoveryRestore, HELPER_METHOD.gitRecoveryDrop]));
	const gitWorktree = facts.locationKind === "local" ? close("git.worktree", providerBlock(methods.gitWorktree)) : close("git.worktree", PROJECT_SERVICE_CAPABILITY_REASONS.providerUnsupported);
	const gitInit = gitRead && close("git.init", hostWriteBlock ?? providerBlock(methods.gitInit) ?? helperBlock(facts, [HELPER_METHOD.gitInit]));
	const gitForceRefresh = gitRead && close("git.forceRefresh", providerBlock(methods.gitForceRefresh));
	const gitAutoFetch = gitRead && close("git.autoFetch", providerBlock(methods.gitAutoFetch));
	const gitStatusPoll = gitRead && close("git.statusPoll", providerBlock(methods.gitStatusPoll));
	const gitRefsWatch = gitRead && close("git.refsWatch", providerBlock(methods.gitRefsWatch));
	const gitDeleteFiles = gitRead && close("git.deleteFiles", providerBlock(methods.gitDeleteFiles));

	return {
		projectId: facts.projectId,
		locationKind: facts.locationKind,
		generation: facts.generation,
		trust: facts.trust,
		files: {
			read: filesRead,
			search: filesSearch,
			write: filesWrite,
			trash: filesTrash,
			textVersion: facts.locationKind === "ssh" ? "required" : "none",
			contentSearch: filesContentSearch,
			systemOpen: filesSystemOpen,
			watch,
		},
		git: {
			read: gitRead,
			diff: gitDiff,
			branchRead: gitBranchRead,
			history: gitHistory,
			repos: gitRepos,
			refs: gitRefs,
			write: gitWrite,
			branchWrite: gitBranchWrite,
			branchCreateMode,
			sync: gitSync,
			syncFacts: gitSyncFacts,
			aheadBehind: gitAheadBehind,
			compare: gitCompare,
			recovery: gitRecovery,
			worktree: gitWorktree,
			init: gitInit,
			forceRefresh: gitForceRefresh,
			autoFetch: gitAutoFetch,
			statusPoll: gitStatusPoll,
			refsWatch: gitRefsWatch,
			deleteFiles: gitDeleteFiles,
		},
		blocked,
	};
}
