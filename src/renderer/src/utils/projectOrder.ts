export type ProjectDropPosition = "before" | "after";

/**
 * 项目拖拽重排的纯计算：把 source 移到 target 的上/下边缘位置。
 *
 * 拖放判定（用户反馈“拖动判定不好用”）从“整行命中 + 按新旧索引猜插入点”改为
 * “按指针在目标行的上下半区显式决定 before/after”，这里只做纯列表变换，方便单测；
 * source === target 或任一 id 不存在时原样返回同一引用，调用方可据此跳过持久化。
 */
export function reorderProjectList<T>(items: readonly T[], idOf: (item: T) => string, sourceId: string, targetId: string, position: ProjectDropPosition): readonly T[] {
	if (sourceId === targetId) return items;
	const sourceIndex = items.findIndex((item) => idOf(item) === sourceId);
	const targetIndex = items.findIndex((item) => idOf(item) === targetId);
	if (sourceIndex === -1 || targetIndex === -1) return items;
	const next = [...items];
	const [moved] = next.splice(sourceIndex, 1);
	const targetIndexAfterRemoval = next.findIndex((item) => idOf(item) === targetId);
	next.splice(targetIndexAfterRemoval + (position === "after" ? 1 : 0), 0, moved);
	return next;
}
