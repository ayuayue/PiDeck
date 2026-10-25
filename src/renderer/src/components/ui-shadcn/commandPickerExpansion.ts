/**
 * Command 选择器分组展开/折叠的纯状态机。
 *
 * 设计动机：折叠此前是面板「挂载时的一次性快照」，而分组全集（如模型目录）可能在
 * 面板挂载后才异步到达——挂载瞬间空目录 → 折叠集合算成空 → 数据到达后所有分组
 * 全展开且不再响应。改为「派生状态 + 用户覆盖」后，未覆盖的分组始终跟随默认展开
 * 集合（defaultExpandedIds）实时变化，数据何时到达都不影响折叠正确性；用户显式
 * 切换过的分组（单组 toggle / 全部展开 / 全部折叠）以 overrides/mode 优先。
 *
 * mode 记录面板级操作，overrides 记录单分组切换；两者都由用户意图驱动，default
 * 只在没有被覆盖时生效。
 */

/** 面板级展示模式：default 跟随默认展开集合；allExpanded/allCollapsed 为用户显式选择。 */
export type PickerGroupMode = "default" | "allExpanded" | "allCollapsed";

export type PickerGroupSelection = {
	mode: PickerGroupMode;
	/** 用户显式切换过的分组 → 目标状态（展开 true / 折叠 false） */
	overrides: ReadonlyMap<string, boolean>;
};

export const INITIAL_PICKER_GROUP_SELECTION: PickerGroupSelection = {
	mode: "default",
	overrides: new Map(),
};

/**
 * 计算某分组当前是否展开。
 * defaultExpandedIds 为 null 表示「默认全展开」（非模型类选择器的历史行为）。
 */
export function resolveGroupExpanded(params: { selection: PickerGroupSelection; defaultExpandedIds: ReadonlySet<string> | null; searchActive: boolean; groupId: string }): boolean {
	const { selection, defaultExpandedIds, searchActive, groupId } = params;
	// 搜索期间强制展开，避免用户搜到隐藏分组中的项目却看不到结果。
	if (searchActive) return true;
	const override = selection.overrides.get(groupId);
	if (override !== undefined) return override;
	if (selection.mode === "allExpanded") return true;
	if (selection.mode === "allCollapsed") return false;
	return defaultExpandedIds === null || defaultExpandedIds.has(groupId);
}

/**
 * 应用面板动作，返回新 selection（不修改入参）：
 * - expandAll：全部展开，清空单组覆盖；
 * - collapseAll：全部折叠，清空单组覆盖（与既有一致：全部折叠后再点单组只展开该组）；
 * - toggle：翻转某组当前（非搜索态）展开状态，写入覆盖。搜索态点击同样记录，
 *   清空搜索后按覆盖生效——与旧 collapsedGroups/expandedGroups 表现一致。
 */
export function applyPickerGroupAction(params: { selection: PickerGroupSelection; defaultExpandedIds: ReadonlySet<string> | null; action: { kind: "expandAll" } | { kind: "collapseAll" } | { kind: "toggle"; groupId: string } }): PickerGroupSelection {
	const { selection, defaultExpandedIds, action } = params;
	if (action.kind === "expandAll") return { mode: "allExpanded", overrides: new Map() };
	if (action.kind === "collapseAll") return { mode: "allCollapsed", overrides: new Map() };

	const { groupId } = action;
	const currentlyExpanded = resolveGroupExpanded({
		selection,
		defaultExpandedIds,
		searchActive: false,
		groupId,
	});
	const overrides = new Map(selection.overrides);
	overrides.set(groupId, !currentlyExpanded);
	return { mode: selection.mode, overrides };
}
