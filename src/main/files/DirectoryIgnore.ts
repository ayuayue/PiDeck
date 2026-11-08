/**
 * 目录页的 Git ignore 修饰（T6 收尾：把 `git check-ignore` 接进公共目录页）。
 *
 * 本机（`LocalProjectFileBackend`）与远端（`remoteGitReadIpc.probeIgnore`）共用这里的规则：
 * 批次、仓库归因、`applyDirectoryIgnore` 的“只落 true”。两个 backend 只各自负责“怎么问 git”。
 *
 * 语义边界（写下来以免被后来的“顺手优化”带歪）：
 * - **只加修饰，不过滤**：`ignored: true` 只是“这条不会进 git”，条目照常显示；保护性隐藏规则仍在 backend。
 * - **未知 ≠ 未忽略**：没有能力、没有仓库、判定失败时**不填字段**（字段缺失），绝不填 `false` 冒充“查过了”。
 * - **判定是只读**：不需要令牌、不改事实。当前每次目录页都会重判（缓存仍未并入目录 FactCache，见
 *   `docs/remote-ui-unification-wave-3-plan.md` §7.1 P1-6）；修饰缺失不是目录页失败。
 * - **仓库归因只有一条规则**：按仓库列表的最长目录前缀匹配（严格边界，`packages/a-other` 不属于 `packages/a`）。
 *   这是「这条路径归哪个仓库的 ignore 规则」，不是把项目相对路径改写成仓库内路径。
 */

/** 一次目录页最多判定的路径数（目录页上限 2000，故覆盖整页；超出则整页不修饰）。 */
export const DIRECTORY_IGNORE_MAX_PATHS = 2000;
/** helper 链路的单批上限（`git.checkIgnore` 帧）：本机 `GitService.checkIgnore` 一次全量，不分批。 */
export const DIRECTORY_IGNORE_BATCH_SIZE = 64;
/** ignore 判定结果的缓存时长：.gitignore 的外部修改不会触发目录事实失效，只能靠 TTL 兜底。 */
export const DIRECTORY_IGNORE_RESULT_TTL_MS = 30_000;
/** 仓库列表缓存时长：目录页装载时才会用到，避免每个目录页都做一次仓库发现。 */
export const DIRECTORY_IGNORE_REPOS_TTL_MS = 60_000;

/**
 * 目录页的 ignore 判定端口。返回与 `paths` 逐位对应的布尔数组；无法判定时返回 `undefined`
 * （调用方据此**不填** `ignored`，而不是当成“都没被忽略”）。
 */
export type DirectoryIgnoreProbe = (projectId: string, paths: readonly string[]) => Promise<readonly boolean[] | undefined>;

/** 把探测结果按索引应用到目录页条目上：只有 `true` 会落成修饰。 */
export function applyDirectoryIgnore<T extends { ignored?: boolean }>(entries: readonly T[], ignored: readonly boolean[] | undefined): T[] {
	if (ignored === undefined || ignored.length !== entries.length) return [...entries];
	return entries.map((entry, index) => (ignored[index] === true ? { ...entry, ignored: true } : entry));
}

/** 严格目录前缀归因：返回最长匹配的仓库路径；没有仓库覆盖这条路径时返回 `undefined`。 */
export function repoScopeOfPath(repos: readonly string[], path: string): string | undefined {
	let best: string | undefined;
	for (const repo of repos) {
		if (repo === "") {
			if (best === undefined) best = "";
			continue;
		}
		if (path !== repo && !path.startsWith(repo + "/")) continue;
		if (best === undefined || repo.length > best.length) best = repo;
	}
	return best;
}

/** 项目相对路径 → 仓库内路径（归因已确定；调用方保证 `repo` 是 `path` 的前缀）。 */
export function repoRelativePathOf(repo: string, path: string): string {
	return repo === "" ? path : path.slice(repo.length + 1);
}
