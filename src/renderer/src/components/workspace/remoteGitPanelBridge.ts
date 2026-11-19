import type { CommitDetail, CommitEntry, GitAheadBehind, GitChangedFile, GitDiscardResource, GitFileStatus, GitRef, GitResourceGroups, ProjectFileTarget } from "../../../../shared/types";
import type { GitHistoryCommit, RemoteGitCommitDetail } from "../../../../shared/types/git";
import type { ProjectServices } from "../../services/projectServiceContracts";
import type { CompareChangesResult } from "../app/git/GitCompareChanges";
import { remoteGitErrorMessage } from "../../utils/gitErrorPresentation";

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

/** 远端 ref 只有全名；面板下拉给的是短名（`main` / `v1.0`），比较入口必须先补成全名。 */
const REF_NAMES = { heads: "refs/heads/", tags: "refs/tags/" } as const;

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

	/** 远端失败只有稳定码：文案走同一份字典，`code`/`outcome` 原样带上，供面板判定不重放。 */
	const fail = (error: unknown): never => {
		const code = (error as { code?: unknown } | null)?.code;
		// helper 自带的原文（远端 git/hook 的 stderr 摘要）优先：与本机一样能看到真正的原因；
		// 没有原文时才回落到词典文案，闭集码仍然决定分类与重放判断。
		const detail = (error as { detail?: unknown } | null)?.detail;
		const text = typeof detail === "string" && detail.trim().length > 0 ? detail : typeof code === "string" && code.length > 0 ? remoteGitErrorMessage(code) : error instanceof Error ? error.message : String(error);
		throw Object.assign(new Error(text), { code, outcome: (error as { outcome?: unknown } | null)?.outcome });
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
				const page = await services.git.history({ maxCount: options?.maxEntries, ...(ref === undefined ? {} : { ref }), ...(filtered && options?.allBranches !== undefined ? { all: options.allBranches } : {}) }, repo);
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
				const page = await services.git.history({ maxCount: 1, ...(ref === undefined ? {} : { ref }), ...(options?.allBranches === undefined ? {} : { all: options.allBranches }), withCount: true }, repo);
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
