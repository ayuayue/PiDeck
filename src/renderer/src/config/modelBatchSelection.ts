/**
 * 模型表格的批量选择策略：用行索引做一次批量编辑会话内的临时身份。
 * 模型 ID 本身可编辑且可能重复，因此不把 ID 当作选择键；确认删除后由调用方一次性提交新数组。
 */

export type ModelSelectionState = "checked" | "indeterminate" | "unchecked";

/** 切换单个模型行的选中状态，返回新集合，避免原地修改 React state。 */
export function toggleModelIndex(selectedIndexes: ReadonlySet<number>, index: number): Set<number> {
	const next = new Set(selectedIndexes);
	if (next.has(index)) next.delete(index);
	else next.add(index);
	return next;
}

/** 计算当前有效选中行数；数据变化后遗留的越界索引不会污染批量工具栏。 */
export function countSelectedModelIndexes(selectedIndexes: ReadonlySet<number>, total: number): number {
	let count = 0;
	for (const index of selectedIndexes) {
		if (index >= 0 && index < total) count += 1;
	}
	return count;
}

/** 表头三态：全选、部分选中或未选。 */
export function getModelSelectionState(selectedIndexes: ReadonlySet<number>, total: number): ModelSelectionState {
	const selectedCount = countSelectedModelIndexes(selectedIndexes, total);
	if (selectedCount === 0) return "unchecked";
	return selectedCount === total ? "checked" : "indeterminate";
}

/** 表头切换：已全选时清空，否则选中当前表格的所有行。 */
export function toggleAllModelIndexes(selectedIndexes: ReadonlySet<number>, total: number): Set<number> {
	if (total > 0 && getModelSelectionState(selectedIndexes, total) === "checked") {
		return new Set<number>();
	}
	return new Set(Array.from({ length: total }, (_, index) => index));
}

/** 全选：返回 0..total-1 的完整行号集合。 */
export function selectAllModelIndexes(total: number): Set<number> {
	const next = new Set<number>();
	for (let i = 0; i < total; i += 1) next.add(i);
	return next;
}

/** 反选：在 0..total-1 全集内翻转 current（越界残留项不会重新出现）。 */
export function invertModelIndexes(current: ReadonlySet<number>, total: number): Set<number> {
	const next = new Set<number>();
	for (let i = 0; i < total; i += 1) {
		if (!current.has(i)) next.add(i);
	}
	return next;
}

/** 按选中行索引移除模型，供确认删除回调和测试共同复用。 */
export function removeSelectedModelIndexes<T>(items: ReadonlyArray<T>, selectedIndexes: ReadonlySet<number>): T[] {
	return items.filter((_, index) => !selectedIndexes.has(index));
}
