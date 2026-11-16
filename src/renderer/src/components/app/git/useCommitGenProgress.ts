/**
 * 提交摘要生成的进度条（从 `GitPanel.tsx` 原样搬出）。
 *
 * 按 composer atom 里的 `startedAt` 续跑：切走再回来不会从 0 重开；封顶 95%，
 * 真正结束靠 `generating` 清零。生成态本身跨面板存在 atom 里，这里只负责本地百分比
 * 与「切回仍在生成的仓库时续上同一条进度 toast」。
 */
import { useEffect, useState } from "react";
import { COMMIT_GEN_TIMEOUT_MS, showCommitGenProgressToast } from "./gitPanelToasts";

export function useCommitGenProgress(input: { commitGenLoading: boolean; startedAt: number | undefined; composerScopeKey: string }) {
	const { commitGenLoading, startedAt: composerStartedAt, composerScopeKey } = input;
	const [commitGenProgress, setCommitGenProgress] = useState(0);
	useEffect(() => {
		if (!commitGenLoading) {
			setCommitGenProgress(0);
			return;
		}
		const startedAt = composerStartedAt ?? Date.now();
		const tickProgress = () => {
			const ratio = Math.min(1, (Date.now() - startedAt) / COMMIT_GEN_TIMEOUT_MS);
			// 封顶 95%，避免还没返回就显示满格；真正结束靠 generating 清零。
			setCommitGenProgress(Math.max(4, Math.round(ratio * 95)));
		};
		tickProgress();
		const tick = window.setInterval(tickProgress, 200);
		return () => window.clearInterval(tick);
	}, [commitGenLoading, composerStartedAt]);
	useEffect(() => {
		// 切回仍在生成的仓库：用同一 toast id 续上进度提示（抽屉卸载过也能再挂上）。
		if (!commitGenLoading) return;
		showCommitGenProgressToast(composerScopeKey);
	}, [commitGenLoading, composerScopeKey]);

	return commitGenProgress;
}
