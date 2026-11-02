/** 批量移除项目记录的汇总结果：只回数量——移除成功的项目已从清单里消失，无需回填 id。 */
export type BatchProjectRemovalOutcome = { removed: number; failed: number };

/**
 * 逐个移除项目记录，单个失败只计数、不中断后续。
 *
 * 为什么串行而不是 Promise.all：主进程的 projects.remove 会顺带清理该项目的会话索引与
 * worktree 子工作区，多个项目并发写同一份索引没有并发收益，反而把「删到一半」的中间态
 * 扩大成并发中间态。为什么吞掉失败继续：批量操作不能因为第 3 个目录里还有运行中的 Agent，
 * 就把前两个已成功的删掉又不告诉用户——调用方按 removed/failed 汇总成一句话。
 *
 * onProgress 在每个项目结算后回调一次（成功或失败都算一次），供弹窗展示 done/total。
 */
export async function removeProjectsSequentially(projectIds: readonly string[], removeOne: (projectId: string) => Promise<void>, onProgress?: (done: number, total: number) => void): Promise<BatchProjectRemovalOutcome> {
	let removed = 0;
	let failed = 0;
	for (const [index, projectId] of projectIds.entries()) {
		try {
			await removeOne(projectId);
			removed += 1;
		} catch {
			failed += 1;
		}
		onProgress?.(index + 1, projectIds.length);
	}
	return { removed, failed };
}
