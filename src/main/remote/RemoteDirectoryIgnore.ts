/**
 * 目录页的 Git ignore 修饰（T6 收尾：把 `git.checkIgnore` 接进公共目录页）。
 *
 * 语义边界（写下来以免被后来的“顺手优化”带歪）：
 * - **只加修饰，不过滤**：`ignored: true` 只是“这条不会进 git”，条目照常显示；保护性隐藏规则仍在 backend。
 * - **未知 ≠ 未忽略**：没有能力、没有仓库、判定失败时**不填字段**（字段缺失），绝不填 `false` 冒充“查过了”。
 * - **判定是只读**：不需要令牌、不改事实；结果随目录页事实一起缓存，暖命中不重复判定。
 * - **仓库归因只有一条规则**：按仓库列表的最长目录前缀匹配（严格边界，`packages/a-other` 不属于 `packages/a`）。
 *   这是「这条路径归哪个仓库的 ignore 规则」，不是把项目相对路径改写成仓库内路径。
 */

/** 一次目录页最多判定的路径数（目录页上限 2000，故覆盖整页；超出则整页不修饰）。 */
export const DIRECTORY_IGNORE_MAX_PATHS = 2000;
/** helper/本机 git 的单批上限：与 `git.checkIgnore` 的既有契约一致。 */
export const DIRECTORY_IGNORE_BATCH_SIZE = 64;
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
