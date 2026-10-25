import { useCallback, useEffect, useRef, useState } from "react";
import type { GitRepoInfo } from "../../../shared/types";

export type UseGitRepoScopeInput = {
	projectId: string | undefined;
	listRepos: (projectId: string) => Promise<GitRepoInfo[]>;
};

/**
 * 发现项目中的独立 Git 仓库。
 *
 * 多仓抽屉会同时挂载每个仓库的面板，因此不再保存“当前选中仓库”；
 * 选择状态会让用户只能看到一个仓库，也会把各面板的操作作用域重新耦合在一起。
 */
export function useGitRepoScope(input: UseGitRepoScopeInput) {
	const { projectId, listRepos } = input;
	const [repos, setRepos] = useState<GitRepoInfo[]>([]);
	const requestRef = useRef(0);

	const refreshRepos = useCallback(async () => {
		if (!projectId) {
			setRepos([]);
			return;
		}
		const request = ++requestRef.current;
		try {
			const next = await listRepos(projectId);
			if (request !== requestRef.current) return;
			setRepos(next);
		} catch {
			if (request !== requestRef.current) return;
			setRepos([]);
		}
	}, [projectId, listRepos]);

	useEffect(() => {
		void refreshRepos();
	}, [refreshRepos]);

	return {
		repos,
		hasMultipleRepos: repos.length > 1,
		refreshRepos,
	};
}
