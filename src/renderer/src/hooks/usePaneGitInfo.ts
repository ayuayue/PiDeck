import { useCallback, useEffect, useRef, useState } from "react";
import type { GitBranchInfo } from "../../../shared/types";
import { desktopApi } from "../desktopApi";

type UsePaneGitInfoOptions = {
	/** 分支信息变化（refs 事件发现外部变更 / 切换成功或失败回读）时回写；App 只在 projectId 为聚焦项目时采纳。 */
	onChanged?: (projectId: string, info: GitBranchInfo) => void;
	/** 切换分支失败时给调用方的用户反馈；内部已回读最新分支兜底恢复显示。 */
	onSwitchError?: (error: unknown) => void;
};

/**
 * 按项目加载并轮询 Git 分支信息的栏级 hook。
 * 分屏各栏绑定各自会话的 projectId（worktree），分支展示与切换目标都不得跟随
 * App 聚焦项目——否则点击任一栏，所有栏的分支会一起切成该栏项目（历史缺陷）。
 * 状态为栏内 local state：栏间互不重渲染；无 projectId 时保持空态（chip 隐藏）。
 */
export function usePaneGitInfo(projectId: string | undefined, options?: UsePaneGitInfoOptions) {
	const [gitInfo, setGitInfo] = useState<GitBranchInfo>({ current: null, branches: [] });
	// 回调走 ref：轮询 effect 只依赖 projectId，回调身份变化不重启定时器。
	const onChangedRef = useRef(options?.onChanged);
	onChangedRef.current = options?.onChanged;
	const onSwitchErrorRef = useRef(options?.onSwitchError);
	onSwitchErrorRef.current = options?.onSwitchError;

	useEffect(() => {
		if (!projectId) {
			setGitInfo({ current: null, branches: [] });
			return;
		}
		let stopped = false;
		const refresh = async () => {
			try {
				const next = await desktopApi.git.branches(projectId);
				if (stopped) return;
				// 只在真实变化时更新，避免每次回读写相同对象引发本栏无谓重渲染。
				setGitInfo((current) => (current.current === next.current && current.branches.join("\n") === next.branches.join("\n") ? current : next));
			} catch {
				if (!stopped) setGitInfo({ current: null, branches: [] });
			}
		};
		// 项目身份切换后先清空旧分支再加载新项目，避免短暂显示上一个 worktree 的分支。
		setGitInfo({ current: null, branches: [] });
		void refresh();
		// 分支信息事件源：主进程 GitRefsWatcher 按 (projectId, repoPath) 复用一份 1.5s
		// refs 签名轮询，代替本栏 4s 盲轮询——分屏 N 栏同仓也只有主进程一份开销，
		// 外部终端/IDE 切分支的追平延迟上限即 watcher 的 1.5 秒。
		// 订阅失败（非 git 项目、磁盘不可读）时静默降级：初始 refresh 已给出空态，
		// 本仓库内的切换由 switchBranch 回读兜底。
		const offRefsChanged = desktopApi.git.onRefsChanged((changedWatchId) => {
			if (changedWatchId !== watchId || stopped) return;
			void refresh();
		});
		const watchPromise = desktopApi.git.watchRefs(projectId).catch(() => null);
		let watchId: string | null = null;
		void watchPromise.then((id) => {
			watchId = id;
		});
		return () => {
			stopped = true;
			offRefsChanged();
			// 竞态安全：卸载时 watch 可能尚未 resolve，退订等它落地后执行；
			// 未知 watchId 主进程静默忽略，重复退订安全。
			void watchPromise.then((id) => {
				if (id) void desktopApi.git.unwatchRefs(id);
			});
		};
	}, [projectId]);

	/** 切换分支：目标写死为本栏 projectId，绝不落到全局聚焦项目；成功/回读后通知 App 同步。 */
	const switchBranch = useCallback(
		async (branch: string) => {
			if (!projectId || !branch || branch === gitInfo.current) return;
			try {
				const next = await desktopApi.git.checkout(projectId, branch);
				setGitInfo(next);
				onChangedRef.current?.(projectId, next);
			} catch (error) {
				// 失败（脏工作区/冲突被 git 拒绝等）时回读一次真实分支，恢复 chip 显示。
				const refreshed = await desktopApi.git.branches(projectId).catch(() => ({ current: null, branches: [] }));
				setGitInfo(refreshed);
				onChangedRef.current?.(projectId, refreshed);
				onSwitchErrorRef.current?.(error);
			}
		},
		[projectId, gitInfo.current],
	);

	return { gitInfo, switchBranch };
}
