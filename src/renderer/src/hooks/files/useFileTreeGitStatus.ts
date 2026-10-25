import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_FILE_TREE_GIT_STATUS, buildFileTreeGitStatusLookup, dropNestedRepoUntrackedPlaceholders, mergeGitResourceGroups, type FileTreeGitStatusLookup } from "../../utils/fileTreeGitStatus";
import type { GitResourceGroups } from "../../../../shared/types";

/**
 * 文件树 Git 着色状态域（IDEA 风格：modified 蓝 / added 绿 / untracked 琥珀棕 / conflict 红）。
 * 数据复用 GitPanel 同一 `git:status` IPC；非 git 项目 / git 未安装时静默退化为无着色
 * （文件树不是 git 面板，不该弹错误提示）。
 * 取数范围与 Git 抽屉对齐：
 * - 多仓项目内每个仓库各取一次后合并（文件树覆盖整个项目）；
 * - 项目根自身不是仓库时补一次默认 scope（项目根）——项目目录位于更大仓库内部时
 *   `listRepos` 返回空数组，只靠它会整盘不上色，而 Git 抽屉正是走默认 scope。
 * 刷新时机由调用方驱动：面板挂载与切项目（本 hook 自带）、刷新按钮、文件树内容变化后的防抖
 * 重拉（FilesPanel 内）。agent 改文件不会自动重扫文件树，着色与树同节奏陈旧、同按钮刷新。
 */

/** 一次 git:status 的取数目标：repoPath 缺省 = 默认 scope（项目根）；repoRoot 非空 = 取的是嵌套仓根目录。 */
type GitStatusTarget = { repoPath?: string; repoRoot: string | null };

/** 取数结果：失败仓为 null（跳过它，不让单仓故障拖垮整盘着色）。 */
type GitStatusFetch = { target: GitStatusTarget; groups: GitResourceGroups } | null;

export function useFileTreeGitStatus(options: { projectId?: string; projectRoot?: string }) {
	// 状态就是一张查表函数（含大小写兜底与精确优先），换表即触发重渲染；未命中 = 该行不上色。
	// 注意：React 把函数型入参当 lazy initializer / updater，查表函数必须包一层 () => …，
	// 否则会被当场调用一次，state 里落地的是它的返回值（undefined）。
	const [statusOf, setStatusOf] = useState<FileTreeGitStatusLookup>(() => EMPTY_FILE_TREE_GIT_STATUS);
	// 代次防竞态：切项目后迟到的旧请求不能覆盖新项目的着色（同 files:list 的防竞态思路）。
	const requestSeqRef = useRef(0);
	// projectId/projectRoot 走 ref：refresh 保持恒定引用，调用方 effect 不因它重跑。
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const refresh = useCallback(async () => {
		const { projectId, projectRoot } = optionsRef.current;
		if (!projectId) {
			setStatusOf(() => EMPTY_FILE_TREE_GIT_STATUS);
			requestSeqRef.current += 1;
			return;
		}
		const seq = ++requestSeqRef.current;
		try {
			const repos = await window.piDesktop.git.listRepos(projectId);
			const targets: GitStatusTarget[] = repos.map((repo) => ({ repoPath: repo.path, repoRoot: repo.relativePath === "" ? null : repo.path }));
			// relativePath 为空的条目就是项目根仓库，此时默认 scope 与它同义；没有这种条目
			// （项目根不是仓库：可能是更大仓库里的子目录，也可能压根不在 git 里）才补默认 scope。
			if (!repos.some((repo) => repo.relativePath === "")) targets.push({ repoRoot: null });
			const fetched = (
				await Promise.all(
					targets.map(async (target): Promise<GitStatusFetch> => {
						try {
							return { target, groups: await window.piDesktop.git.status(projectId, target.repoPath) };
						} catch {
							// 单个仓库失败（仓刚被删 / 权限变化 / 不在 git 里）不能让整盘着色归零：跳过它，其余照常上色。
							return null;
						}
					}),
				)
			).filter((entry): entry is Exclude<GitStatusFetch, null> => entry !== null);
			if (seq !== requestSeqRef.current) return; // 迟到的旧请求：静默丢弃
			// 嵌套仓目录会被外层仓整个报成未跟踪（git 不递归进另一个仓库），这些占位项按嵌套仓
			// 自己的状态处理（见 dropNestedRepoUntrackedPlaceholders）；只认同「真的取到状态」的
			// 嵌套仓根——该仓失败时留着占位，至少还能显示「这里有未跟踪内容」，而不是整棵子树无色。
			const succeededNestedRoots = fetched.flatMap((entry) => (entry.target.repoRoot ? [entry.target.repoRoot] : []));
			const nextLookup = buildFileTreeGitStatusLookup(mergeGitResourceGroups(fetched.map((entry) => dropNestedRepoUntrackedPlaceholders(entry.groups, succeededNestedRoots))), projectRoot);
			setStatusOf(() => nextLookup);
		} catch {
			// 非 git 项目 / 发现仓库失败：着色整体退场。保留旧表反而会误导（项目可能刚被拆分）。
			if (seq === requestSeqRef.current) setStatusOf(() => EMPTY_FILE_TREE_GIT_STATUS);
		}
	}, []);

	// 挂载与项目切换即时拉取；projectRoot 不单独触发（换仓库根时 projectId 必先变）。
	useEffect(() => {
		void refresh();
	}, [refresh, options.projectId]);

	// 卸载作废在途请求，防止 setState 落到已卸载组件
	useEffect(
		() => () => {
			requestSeqRef.current += 1;
		},
		[],
	);

	/** 行级查询：树节点渲染时按路径 O(1) 查表（未命中 = 该行不上色）。 */
	return { statusOf, refresh };
}
