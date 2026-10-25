/**
 * Tab 栏 layout 动画的纯策略：决定「这一次渲染要不要重新测量并播位移」。
 *
 * 只有 Tab **集合**真的变化（新开、关闭、关组）才 +1：
 * - 关闭中间 Tab 后，右侧 Tab 需要收拢而不是瞬移——这是本函数要放行的那一帧；
 * - 拖拽重排不 +1：原生拖拽自带插入指示线，若同时播 layout 位移，行会跟着指针回弹；
 * - 状态徽章 / 标题 / 运行时长每帧都可能变，不能因此触发整条 Tab 栏重新测量。
 *
 * 用集合比较而不是顺序比较，正是「重排不计入」的落点；id 唯一，无需考虑重复。
 */
export function resolveTabLayoutGeneration(previousIds: readonly string[] | null, currentIds: readonly string[], generation: number): number {
	if (previousIds === null) return generation;
	if (previousIds.length === currentIds.length) {
		const previousSet = new Set(previousIds);
		if (currentIds.every((id) => previousSet.has(id))) return generation;
	}
	return generation + 1;
}
