import type { CommitDetail, CommitEntry, GitAheadBehind, GitChangedFile, GitDiscardResource, GitFileStatus, GitRef, GitResourceGroups, ProjectFileTarget } from "../../../../shared/types";
import type { GitHistoryCommit, RemoteGitCommitDetail } from "../../../../shared/types/git";
import type { ProjectServices } from "../../services/projectServiceContracts";
import type { CompareChangesResult } from "../app/git/GitCompareChanges";
import { remoteGitErrorMessage, remoteGitErrorText } from "../../utils/gitErrorPresentation";
import { t } from "../../i18n";

/**
 * 远端项目的 Git 面板数据面：把 `ProjectGitService`（按位置分派）接到本机 `GitPanel` 的 props 上。
 *
 * 这一层只做四件事，不发明能力：
 * - 绑定仓库作用域（每次写都带同一个 repo target，切换仓库就是换一份桥）；
 * - 把服务失败折成稳定码对应的本地文案（远端不外传 stderr/路径），同时保留 `code`/`outcome`
 *   供展示层判定“不是仓库 / 没有授权 / 结果未确认”；
 * - 把服务的结果形状映射成面板已有的行类型（CommitEntry / CommitDetail / CompareChangesResult）；
 * - 补齐「本机由通道一肩挑、远端要两次读」的展示数据：ref 装饰（本机 %D 一趟就有）与总数徽章。
 *
 * 远端仍然没有的数据面不在这里伪造：图谱写操作（cherry-pick/revert/reset/drop）没有对应 helper 动词，
 * 对应 props 直接不提供，面板按能力位隐藏入口。
 */
/**
 * ahead/behind 与 ref 装饰在远端都是一次 helper 往返，而共用面板的 5 秒轮询会一直来问：
 * 缓存一小段时间、显式刷新/写动作立即作废，避免把“本机读 refs”的节奏照搬到 SSH 上。
 */
const AHEAD_TTL_MS = 30_000;
const REF_DECORATION_TTL_MS = 15_000;

/**
 * `git.log` 的 `maxCount` 硬上限：main 的 REMOTE_GIT_LOG_MAX_COUNT 与 helper 是同一个 100，超了整页
 * 以 GIT_RESULT_INVALID 拒绝。面板「加载更多」每次 +30 且自己没有上限，第 4 次点击就会把图谱打成
 * 一句通用失败文案（且请求夹不回来，刷新也只是重发同一次超限请求）。
 */
export const REMOTE_GIT_LOG_PAGE_LIMIT = 100;

/** 请求页大小夹到协议上限；未指定页大小时保持缺失，让 helper 用自己的默认值。 */
export function clampRemoteLogPageSize(requested?: number): number | undefined {
	return requested === undefined ? undefined : Math.min(requested, REMOTE_GIT_LOG_PAGE_LIMIT);
}

/** 远端 ref 只有全名；面板下拉给的是短名（`main` / `v1.0`），比较入口必须先补成全名。 */
const REF_NAMES = { heads: "refs/heads/", tags: "refs/tags/" } as const;

/**
 * 冷启动竞态：窗口打开时 SSH 主机常常还在连接（实测差 4 秒才 ready）。读路径按设计
 * `requireReady: true`——没 ready 就当场失败、不自动拨号，而历史没有事实缓存（status 有），
 * 所以那唯一一次失败会让图谱永久空白：没有任何东西会重新触发它。
 *
 * 这里只等**已经在进行**的预热：不发起连接、不重连，有上限，且只重试连接类码。
 * 其它失败（参数 / 回包形状 / 权限）立刻上抛，不被重试掩盖。
 */
const HOST_WARMING_CODES = new Set(["SSH_HOST_NOT_READY", "SSH_HOST_DISCONNECTED", "REMOTE_CONNECTION_LOST"]);
const HOST_WARMING_RETRY_MS = 1000;
const HOST_WARMING_DEADLINE_MS = 15_000;

function failureCodeOf(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" && code.length > 0 ? code : undefined;
}

/** 主机热身期间重试同一个读；超出上限或非连接类失败按原错误上抛。 */
async function whileHostWarms<T>(task: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + HOST_WARMING_DEADLINE_MS;
	for (;;) {
		try {
			return await task();
		} catch (error) {
			const code = failureCodeOf(error);
			if (code === undefined || !HOST_WARMING_CODES.has(code) || Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, HOST_WARMING_RETRY_MS));
		}
	}
}

export function createRemoteGitPanelBridge(services: ProjectServices, repo: ProjectFileTarget | undefined) {
	const projectId = services.projectId;
	/**
	 * 新协议探测：`git.stagedDiff` 是同一批新增里唯一的新方法名，helper 声明它就说明这一批
	 * （log 过滤/总数、numstat、三点比较、暂存 diff）全在。旧 helper 上不发送新参数，
	 * 让面板退回 HEAD-only + 两树比较，而不是把未知参数变成整块历史失败。
	 */
	const upgraded = (): boolean => services.kind === "local" || (services.facts?.helperCapabilities?.includes("git.stagedDiff") ?? false);
	let aheadCache: { at: number; value: GitAheadBehind | null } | undefined;
	let decorationCache: { at: number; value: RefDecoration } | undefined;
	let watchId: string | undefined;
	const invalidateCaches = () => {
		aheadCache = undefined;
		decorationCache = undefined;
	};

	/**
	 * 远端失败只有稳定码：文案走同一个出口（原文 → 词典 → 兜底），`code`/`outcome` 原样带上，
	 * 供面板判定不重放；内部说明只随错误对象走调试通道，不参与文案。
	 */
	const fail = (error: unknown): never => {
		const source = error as { code?: unknown; outcome?: unknown; internal?: unknown } | null;
		const code = typeof source?.code === "string" && source.code.length > 0 ? source.code : undefined;
		const text = remoteGitErrorText(error);
		// 未入词典的码只会得到一句通用兜底文案，且这类失败常常发生在渲染层（不过主进程日志）：
		// 把码附在后面，否则“图谱空白”既查不到日志、也无从在界面或截图里看出是哪一步被拒。
		const message = code !== undefined && text === t("remoteGit.failed") ? `${text}（${code}）` : text;
		throw Object.assign(new Error(message), { code: source?.code, outcome: source?.outcome, internal: source?.internal });
	};
	const run = async <T>(task: () => Promise<T>): Promise<T> => {
		try {
			return await task();
		} catch (error) {
			return fail(error);
		}
	};

	const entryOf = (commit: Pick<GitHistoryCommit, "oid" | "parents" | "subject" | "authorName" | "authorEmail" | "authorTimeMs" | "shortHash" | "refNames" | "graph" | "fullMessage">): CommitEntry => ({
		hash: commit.oid,
		shortHash: commit.shortHash ?? commit.oid.slice(0, 7),
		message: commit.subject,
		authorName: commit.authorName,
		authorEmail: commit.authorEmail,
		authorDate: commit.authorTimeMs,
		parents: commit.parents,
		refNames: commit.refNames ?? [],
		graph: commit.graph ?? [],
		fullMessage: commit.fullMessage,
	});
	/** 提交详情的时间是秒：面板的 authorDate 一律是毫秒，不在这里换算就会显示成 1970。 */
	const detailEntry = (detail: RemoteGitCommitDetail): CommitEntry => ({
		hash: detail.oid,
		shortHash: detail.oid.slice(0, 7),
		message: detail.subject,
		authorName: detail.authorName,
		authorEmail: detail.authorEmail,
		authorDate: detail.authorTimeSec * 1000,
		parents: detail.parents,
		refNames: [],
		graph: [],
		fullMessage: detail.message,
		...(detail.shortStat === undefined ? {} : { shortStat: detail.shortStat }),
	});

	/** 对比/详情里的状态是单字母；面板的行类型要闭集枚举，未知字母按 modified 处理（不丢行）。 */
	const toFileStatus = (status: string): GitFileStatus => {
		const letter = status.trim().toUpperCase().slice(0, 1);
		if (letter === "A") return "added";
		if (letter === "D") return "deleted";
		if (letter === "R") return "renamed";
		return "modified";
	};
	const toChangedFile = (file: { path: string; status: string; oldPath?: string; additions?: number; deletions?: number }): GitChangedFile => ({
		path: file.path,
		target: { projectId, relativePath: file.path },
		displayPath: file.path,
		status: toFileStatus(file.status),
		...(file.oldPath ? { originalPath: file.oldPath, originalTarget: { projectId, relativePath: file.oldPath } } : {}),
	});

	/** 分支/tag 装饰：本机由 `git log %D` 一趟带回，远端要 refs + 当前分支两次读（同一份帧可复用 15 秒）。 */
	type RefDecoration = { byOid: Map<string, string[]> };
	const decorations = async (): Promise<RefDecoration> => {
		if (decorationCache !== undefined && Date.now() - decorationCache.at < REF_DECORATION_TTL_MS) return decorationCache.value;
		const [refs, branches] = await Promise.all([services.git.refs(repo), services.git.branches(repo)]);
		const byOid = new Map<string, string[]>();
		for (const ref of refs) {
			// 与 `git log %D` 同一套写法：当前分支画成 `HEAD -> x`，tag 画成 `tag: x`，其余只留名字。
			const label = ref.type === "tag" ? `tag: ${ref.name}` : ref.name === branches.current ? `HEAD -> ${ref.name}` : ref.name;
			const existing = byOid.get(ref.hash);
			if (existing === undefined) byOid.set(ref.hash, [label]);
			else existing.push(label);
		}
		const value = { byOid };
		decorationCache = { at: Date.now(), value };
		return value;
	};

	/** 短名 → 全名：面板下拉给短名，helper 只认 `refs/heads/*` / `refs/tags/*`；同名时分支优先。 */
	const fullRefOf = async (name: string): Promise<string> => {
		if (name.startsWith(REF_NAMES.heads) || name.startsWith(REF_NAMES.tags)) return name;
		const refs = await services.git.refs(repo);
		const branch = refs.find((ref) => ref.type === "head" && ref.name === name);
		if (branch !== undefined) return `${REF_NAMES.heads}${name}`;
		const tag = refs.find((ref) => ref.type === "tag" && ref.name === name);
		if (tag !== undefined) return `${REF_NAMES.tags}${name}`;
		throw Object.assign(new Error(remoteGitErrorMessage("GIT_REF_NOT_FOUND")), { code: "GIT_REF_NOT_FOUND", outcome: "rejected" });
	};

	return {
		/** 显式刷新走纯事实强刷；静默轮询读事实缓存。 */
		getStatus: (_projectId: string, options?: { force?: boolean }): Promise<GitResourceGroups> => {
			if (options?.force) invalidateCaches();
			return run(() => (options?.force ? services.git.refresh(repo) : services.git.status(repo)));
		},
		stageFiles: (_projectId: string, targets: ProjectFileTarget[]) => run(() => services.git.stage(targets, repo)),
		unstageFiles: (_projectId: string, targets: ProjectFileTarget[]) => run(() => services.git.unstage(targets, repo)),
		discardFile: (_projectId: string, group: "workingTree" | "untracked", target: ProjectFileTarget) => run(async () => void (await services.git.discard([{ group, target }], repo))),
		discardFiles: (_projectId: string, resources: GitDiscardResource[]) => run(async () => void (await services.git.discard(resources, repo))),
		commit: (_projectId: string, message: string) => run(() => services.git.commit(message, repo)).finally(invalidateCaches),
		/** 历史页：ref/全部分支/总数都走同一条 helper log（远端已支持），装饰按 OID 补齐。 */
		commitLog: (_projectId: string, options?: { maxEntries?: number; ref?: string; allBranches?: boolean }) =>
			run(async () => {
				const filtered = upgraded();
				const ref = filtered && options?.ref !== undefined ? await fullRefOf(options.ref) : undefined;
				// 夹到上限后返回的条数 < 面板的 loadCount，按「等于 loadCount 才有更多」的判据按钮自然消失。
				const page = await whileHostWarms(() => services.git.history({ maxCount: clampRemoteLogPageSize(options?.maxEntries), ...(ref === undefined ? {} : { ref }), ...(filtered && options?.allBranches !== undefined ? { all: options.allBranches } : {}) }, repo));
				const decoration = page.commits.length === 0 ? undefined : await decorations().catch(() => undefined);
				return page.commits.map((commit) => {
					const entry = entryOf(commit);
					const names = decoration?.byOid.get(commit.oid);
					return names === undefined ? entry : { ...entry, refNames: names };
				});
			}),
		/** 与图谱过滤同一条条件的总数：helper 在同一次 log 过滤上做 rev-list --count。 */
		commitCount: (_projectId: string, options?: { ref?: string; allBranches?: boolean }) =>
			run(async () => {
				const ref = options?.ref === undefined ? undefined : await fullRefOf(options.ref);
				const page = await whileHostWarms(() => services.git.history({ maxCount: 1, ...(ref === undefined ? {} : { ref }), ...(options?.allBranches === undefined ? {} : { all: options.allBranches }), withCount: true }, repo));
				return page.totalCount ?? 0;
			}),
		commitDetail: (_projectId: string, ref: string) =>
			run(async (): Promise<CommitDetail> => {
				const detail = await services.git.commitDetail(ref, repo);
				return { commit: detailEntry(detail), files: detail.files.map(toChangedFile) };
			}),
		branchCompare: (_projectId: string, base: string, target: string) =>
			run(async (): Promise<CompareChangesResult> => {
				// 面板给短名，helper 只吃全名：先补全再比较，同名时分支优先（与下拉展示一致）。
				const [baseRef, headRef] = await Promise.all([fullRefOf(base), fullRefOf(target)]);
				const compared = await services.git.compare(baseRef, headRef, repo, upgraded() ? "threeDot" : "trees");
				// 三点语义才带 ahead/behind；trees 缺省原样透传，面板据此不显示 0/0。
				return { files: compared.files.map(toChangedFile), ahead: compared.ahead, behind: compared.behind };
			}),
		push: () => run(() => services.git.push(repo)).finally(invalidateCaches),
		pull: () => run(() => services.git.pull(repo)).finally(invalidateCaches),
		fetch: () => run(() => services.git.fetch(repo)).finally(invalidateCaches),
		aheadBehind: async (): Promise<GitAheadBehind | null> => {
			if (aheadCache !== undefined && Date.now() - aheadCache.at < AHEAD_TTL_MS) return aheadCache.value;
			const value = await run(() => services.git.aheadBehind(repo));
			aheadCache = { at: Date.now(), value };
			return value;
		},
		/** 提交图谱写动词：与面板共用的四个动作，远端各自一枚令牌；写成功后历史与 HEAD 都变了，缓存作废。 */
		cherryPick: (_projectId: string, hash: string) => run(() => services.git.cherryPick(hash, repo)).finally(invalidateCaches),
		revert: (_projectId: string, hash: string) => run(() => services.git.revert(hash, repo)).finally(invalidateCaches),
		reset: (_projectId: string, hash: string, mode: "soft" | "mixed" | "hard") => run(() => services.git.reset(hash, mode, repo)).finally(invalidateCaches),
		dropCommit: (_projectId: string, hash: string) => run(() => services.git.dropCommit(hash, repo)).finally(invalidateCaches),
		/** AI 摘要的输入：远端暂存区 unified diff（本机是 git:generate-commit-message 自己读）。 */
		stagedDiff: (): Promise<string> =>
			run(async () => {
				// 只有远端 provider 实现这个读口；缺席说明位置不支持，明确失败而不是回退成本机读。
				if (services.git.stagedDiff === undefined) throw Object.assign(new Error(remoteGitErrorMessage("GIT_WRITE_UNSUPPORTED")), { code: "GIT_WRITE_UNSUPPORTED" });
				return services.git.stagedDiff(repo);
			}),
		/** 变更文件删除：远端归文件服务回收站（可恢复），不是 git discard。 */
		deleteFiles: (_projectId: string, targets: ProjectFileTarget[]) => run(() => services.git.deleteFiles(targets, repo)),
		gitInit: async (): Promise<void> => run(async () => void (await services.git.init())),
		/**
		 * 远端 refs 变化订阅：主进程为这个仓库订阅 `.git` 目录族，事件经项目事实通道回来。
		 * 订阅失败（helper 没有 fs.watch / 路径不存在 / 预算触顶）不抛给展示层：面板仍有 5 秒轮询兜底。
		 */
		watchRefs: async (_projectId: string): Promise<string> => {
			const result = await run(() => services.git.watchRefs?.(repo) ?? Promise.resolve(undefined));
			if (result === undefined) throw Object.assign(new Error(remoteGitErrorMessage("GIT_WATCH_UNAVAILABLE")), { code: "GIT_WATCH_UNAVAILABLE" });
			watchId = result;
			return result;
		},
		unwatchRefs: async (id: string): Promise<void> => {
			watchId = undefined;
			await run(() => services.git.unwatchRefs?.(id) ?? Promise.resolve());
		},
		/** 事实推送 → 面板重读：只认「本仓库 status 被标脏」。 */
		onRefsChanged: (listener: (watchId: string) => void): (() => void) =>
			services.subscribeFacts?.((scope) => {
				if (scope.kind !== "status" || scope.repoPath !== (repo?.relativePath ?? "")) return;
				if (watchId !== undefined) listener(watchId);
			}) ?? (() => undefined),
	};
}
