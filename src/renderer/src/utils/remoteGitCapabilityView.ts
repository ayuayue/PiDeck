import type { TranslationKey } from "../i18n";
import type { ProjectGitCapabilities, ProjectServiceCapabilityKey, ProjectServiceCapabilityReasons } from "../services/projectServiceContracts";

/**
 * 远端 Git 能力条（G4b）的唯一判据：能力只决定 UI 是否提供入口，绝不替代 main 的逐操作授权。
 *
 * 输入是 S 冻结的两份事实——`ProjectGitCapabilities`（哪些入口可用）与 `blocked`（每个被关闭
 * 能力的第一条稳定原因码）。输出只解释「哪些入口不可用、为什么」：可用能力不出现，也绝不生成
 * 按钮、成功分支或假装可用的入口。原因码只映射到既有词典 key；未知码不猜文案（宁可不写，也不编）。
 */

/** 能力条的一行：一组不可用入口 + 它们共同的第一条稳定原因（同原因的入口合并成一行）。 */
export type GitCapabilityBannerLine = {
	/** 稳定 id（该行第一个入口的 id），用作 data-testid 与测试锚点。 */
	id: string;
	/** 不可用入口的既有文案 key；同一行多个词用 " / " 连接。 */
	labels: TranslationKey[];
	/** 第一条稳定原因码（`blocked` 原值）；没有原因时缺席。 */
	reason?: string;
	/** 原因码映射出的既有文案 key；未知码不映射（不猜自由文本）。 */
	reasonKey?: TranslationKey;
};

/** 能力条覆盖的入口 id（与面板门禁一一对应）。 */
export type GitCapabilityBannerItemId = "write" | "branchWrite" | "sync" | "recovery" | "history" | "refs" | "compare" | "forceRefresh" | "init" | "worktree";

type BannerEntry = {
	id: GitCapabilityBannerItemId;
	/** 该入口依赖的能力位。 */
	capability: keyof ProjectGitCapabilities;
	/** blocked 里的键（`git.*`），用来取第一条稳定原因。 */
	blockedKey: ProjectServiceCapabilityKey;
	labels: readonly TranslationKey[];
	/** 整句说明型入口（worktree 不提供）：单独一行，不与其它入口合并。 */
	standalone?: boolean;
};

const BANNER_ENTRIES: readonly BannerEntry[] = [
	{ id: "write", capability: "write", blockedKey: "git.write", labels: ["remoteGit.capabilityWrite"] },
	{ id: "branchWrite", capability: "branchWrite", blockedKey: "git.branchWrite", labels: ["remoteGit.capabilityBranch"] },
	{ id: "sync", capability: "sync", blockedKey: "git.sync", labels: ["remoteGit.capabilitySync"] },
	{ id: "recovery", capability: "recovery", blockedKey: "git.recovery", labels: ["remoteGit.capabilityRecovery"] },
	{ id: "history", capability: "history", blockedKey: "git.history", labels: ["remoteGit.capabilityHistory"] },
	{ id: "refs", capability: "refs", blockedKey: "git.refs", labels: ["remoteGit.capabilityRefs"] },
	{ id: "compare", capability: "compare", blockedKey: "git.compare", labels: ["remoteGit.capabilityCompare"] },
	{ id: "forceRefresh", capability: "forceRefresh", blockedKey: "git.forceRefresh", labels: ["remoteGit.capabilityForceRefresh"] },
	{ id: "init", capability: "init", blockedKey: "git.init", labels: ["remoteGit.capabilityInit"] },
	{ id: "worktree", capability: "worktree", blockedKey: "git.worktree", labels: ["remoteGit.worktreeUnsupported"], standalone: true },
];

/** 远端面板的全集：每个入口都有对应的区块/按钮/effect。 */
export const REMOTE_GIT_BANNER_ITEM_IDS: readonly GitCapabilityBannerItemId[] = BANNER_ENTRIES.map((entry) => entry.id);

/**
 * 共用 GitPanel 真正门禁的入口子集：恢复/历史/引用/分支写不在这个面板里，
 * 传全集会把「本机没有恢复存储」这类正常的关闭渲染成永久告警。
 */
export const SHARED_GIT_BANNER_ITEM_IDS: readonly GitCapabilityBannerItemId[] = ["write", "sync", "forceRefresh", "init", "worktree", "compare"];

/**
 * 稳定原因码 → 既有文案 key。
 *
 * 只认识 `projectServiceCapabilities` 会产出的稳定码，以及 SSH_* 形状的连接失败：
 * - trust 三态 → remoteGit.trustRequired（授权问题不是「不支持」）；
 * - host 未就绪/降级、SSH_* → remoteGit.connection（连接问题，不自动重连）；
 * - helper 未声明方法 / provider 未实现 / UNSUPPORTED* → remoteGit.unsupported；
 * - root 漂移 → remoteGit.changed（项目身份变了，要手动刷新）。
 * 其它码返回 undefined：不把自由文本当文案。
 */
export function gitCapabilityReasonKey(code: string | undefined): TranslationKey | undefined {
	if (code === undefined) return undefined;
	if (code === "PROJECT_SERVICE_CAPABILITY_TRUST_REQUIRED" || code === "PROJECT_SERVICE_CAPABILITY_TRUST_STALE" || code === "PROJECT_SERVICE_CAPABILITY_TRUST_UNKNOWN") return "remoteGit.trustRequired";
	if (code === "PROJECT_CAPABILITY_HOST_NOT_READY" || code === "PROJECT_CAPABILITY_WRITE_NEEDS_READY_HOST" || code.startsWith("SSH_")) return "remoteGit.connection";
	if (code === "PROJECT_SERVICE_CAPABILITY_HELPER_METHOD_MISSING" || code === "PROJECT_SERVICE_CAPABILITY_PROVIDER_UNSUPPORTED" || code.startsWith("UNSUPPORTED")) return "remoteGit.unsupported";
	if (code === "PROJECT_SERVICE_CAPABILITY_ROOT_NEEDS_ATTENTION") return "remoteGit.capabilityRootNeedsAttention";
	return undefined;
}

/**
 * 能力条判据：按入口顺序给出「不可用入口」行，同原因相邻入口合并成一行。
 *
 * @param git     冻结的能力表（S 契约 `services.capabilities.git`）。
 * @param blocked 每个被关闭能力的第一条稳定原因码。
 * @param items   本面板真正门禁的入口；缺省 = 远端面板全集。
 */
export function describeGitCapabilityBanner(git: ProjectGitCapabilities, blocked: ProjectServiceCapabilityReasons = {}, items: readonly GitCapabilityBannerItemId[] = REMOTE_GIT_BANNER_ITEM_IDS): GitCapabilityBannerLine[] {
	const wanted = new Set(items);
	const lines: GitCapabilityBannerLine[] = [];
	const standaloneLines = new Set<string>();
	for (const entry of BANNER_ENTRIES) {
		if (!wanted.has(entry.id)) continue;
		if (git[entry.capability] !== false) continue;
		if (entry.standalone === true) {
			lines.push({ id: entry.id, labels: [...entry.labels] });
			standaloneLines.add(entry.id);
			continue;
		}
		// read 关闭时上游会把每个能力位短路掉，blocked 只留 git.read：项目级原因就是整行的原因。
		const reason = blocked[entry.blockedKey] ?? blocked["git.read"];
		const reasonKey = gitCapabilityReasonKey(reason);
		const previous = lines.at(-1);
		if (previous !== undefined && !standaloneLines.has(previous.id) && previous.reason === reason && previous.reasonKey === reasonKey) {
			previous.labels.push(...entry.labels);
			continue;
		}
		lines.push({ id: entry.id, labels: [...entry.labels], reason, reasonKey });
	}
	return lines;
}

/**
 * 能力条的双态模型：`available` 是当前**真正可用**的入口标签（面板顶部要能清楚说明“现在能做什么”），
 * `blocked` 是不可用入口 + 第一条稳定原因。两者都由同一份能力表推出，不新增第二套判定。
 */
export type GitCapabilityBannerModel = { available: TranslationKey[]; blocked: GitCapabilityBannerLine[] };

/**
 * 双态判据：与 `describeGitCapabilityBanner` 同源（后者只回答“缺什么”，这里同时回答“有什么”）。
 * 可用入口按入口顺序去重合并成一组标签；缺 `blocked` 原因时只是没有原因文案，不会被当成可用。
 */
export function describeGitCapabilityBannerModel(git: ProjectGitCapabilities, blocked: ProjectServiceCapabilityReasons = {}, items: readonly GitCapabilityBannerItemId[] = REMOTE_GIT_BANNER_ITEM_IDS): GitCapabilityBannerModel {
	const wanted = new Set(items);
	const available: TranslationKey[] = [];
	for (const entry of BANNER_ENTRIES) {
		// standalone 入口（worktree 不提供）只以整句说明出现在“不可用”里，不能混进“可用”那一行。
		if (!wanted.has(entry.id) || entry.standalone === true || git[entry.capability] === false) continue;
		for (const label of entry.labels) if (!available.includes(label)) available.push(label);
	}
	return { available, blocked: describeGitCapabilityBanner(git, blocked, items) };
}

/** 缺省值：缺省 = 全可用。共用面板不传能力时与改前完全一致。 */
export const ALL_GIT_CAPABILITIES: ProjectGitCapabilities = {
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
	autoFetch: true,
	statusPoll: true,
	refsWatch: true,
	deleteFiles: true,
};

/** 把可选的局部能力补全成全表；`undefined` 返回同一份全可用常量（零行为变化）。 */
export function normalizeGitCapabilities(partial?: Partial<ProjectGitCapabilities>): ProjectGitCapabilities {
	if (partial === undefined) return ALL_GIT_CAPABILITIES;
	return { ...ALL_GIT_CAPABILITIES, ...partial };
}
