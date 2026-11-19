/**
 * 父会话下面两类子项的展开规则（纯函数：侧栏 controller 与单测共用同一份判定）。
 *
 * 两类子项一律**默认收起**：侧栏以「父会话」为浏览单位，子项展开是显式动作——
 * 一个父会话挂 30 条链接会话时，默认展开会把侧栏撑成一条长列表（用户反馈），
 * 折叠后父行只留 `🔗 30` / `🤖 21` 两个计数，想看再点开。
 *
 * 两类分开记：收起 30 条会话不影响正在跑的子智能体，反之亦然。
 * 覆盖值只活在本次运行内（controller 持有的 Map，键见 childGroupOverrideKey），
 * 重启后回到「全部收起」——避免上次收起后忘了，以为子项丢了。
 */
export type ChildGroupKind = "linked" | "agents";

/** 没有用户覆盖时的默认展开态：两类都收起。 */
export const CHILD_GROUP_DEFAULT_EXPANDED = false;

export function childGroupOverrideKey(groupKey: string, kind: ChildGroupKind): string {
	return `${groupKey}:${kind}`;
}

export function resolveChildGroupExpanded(overrides: ReadonlyMap<string, boolean>, groupKey: string, kind: ChildGroupKind, count: number): boolean {
	// 没有子项时恒为收起：覆盖值也不能把空分组展开成一条空导轨。
	if (count <= 0) return false;
	return overrides.get(childGroupOverrideKey(groupKey, kind)) ?? CHILD_GROUP_DEFAULT_EXPANDED;
}
