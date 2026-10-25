/**
 * 批量选择的状态操作（收藏 / 智能体两个页面共用）。
 *
 * 选中的是一组 id，页面只关心三件事：单个切换、按可见列表全选/反选、列表变化后裁剪。
 * 单独抽出来是为了让「搜索过滤后全选只作用于可见项」「条目被删除后选区自动收缩」
 * 这类容易写错的地方有单测兜住，而不是在两份 JSX 里各写一遍。
 */

/** 切换一项；返回新 Set（React 需要新引用才会重渲染）。 */
export function toggleSelection(current: ReadonlySet<string>, id: string): Set<string> {
	const next = new Set(current);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return next;
}

/** 全选/取消全选给定的 id 集合；已选中的其它（被过滤掉的）id 保留，避免搜索时误清空选区。 */
export function setSelectionFor(current: ReadonlySet<string>, ids: readonly string[], selected: boolean): Set<string> {
	const next = new Set(current);
	for (const id of ids) {
		if (selected) next.add(id);
		else next.delete(id);
	}
	return next;
}

/** 只保留仍然存在的 id（删除后收缩选区，避免把已消失的 id 继续算进「已选 N 项」）。 */
export function pruneSelection(current: ReadonlySet<string>, validIds: readonly string[]): Set<string> {
	const valid = new Set(validIds);
	const next = new Set<string>();
	for (const id of current) if (valid.has(id)) next.add(id);
	return next.size === current.size ? (current as Set<string>) : next;
}

/** 给定 id 是否已全选（空列表返回 false，避免 0/0 显示成「已全选」）。 */
export function areAllSelected(current: ReadonlySet<string>, ids: readonly string[]): boolean {
	if (ids.length === 0) return false;
	return ids.every((id) => current.has(id));
}
