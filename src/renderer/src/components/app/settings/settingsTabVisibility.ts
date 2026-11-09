import type { SettingsTabId } from "../../../atoms";
import { HIDEABLE_SETTINGS_TAB_IDS, isModuleHidden, type HideableSettingsTabId } from "../../../../../shared/hiddenModules";
import { SETTINGS_TAB_LAYOUT, type SettingsTabLayoutEntry } from "./settingsTabLayout";

/**
 * 设置页侧栏的「隐藏模块」过滤策略（纯函数，配 tests/settingsTabVisibility.test.mjs）。
 *
 * 隐藏只发生在侧栏渲染层：SettingsTabId、深链、localStorage 记忆、脏标记都仍按 tab id 工作。
 * 深链（settingsFocusAtom）指向已隐藏 tab 时不阻断——用户是主动要去（Git「去设置」、
 * 命令面板搜到「已隐藏，点击显示」），此时把该 tab 加入 revealed 集合临时显示，
 * 不改持久化的 hiddenModules；弹窗关闭即失效。
 */

function isHideableTab(tab: SettingsTabId): tab is HideableSettingsTabId {
	return (HIDEABLE_SETTINGS_TAB_IDS as readonly string[]).includes(tab);
}

/** 某 tab 是否被用户隐藏（非可隐藏 tab 永远返回 false，未知 id 不影响）。 */
export function isSettingsTabHidden(hiddenModules: readonly string[], tab: SettingsTabId): boolean {
	return isHideableTab(tab) && isModuleHidden(hiddenModules, tab);
}

/**
 * 过滤隐藏 tab，簇首项隐藏时把标题与分隔线顺延到该簇的下一可见项。
 * 若整个簇隐藏，下一簇的标题取代待展示的标题；首项不显示悬空分隔线。
 */
export function resolveVisibleSettingsTabs(hiddenModules: readonly string[], revealedTabs: ReadonlySet<SettingsTabId>, layout: readonly SettingsTabLayoutEntry[] = SETTINGS_TAB_LAYOUT): SettingsTabLayoutEntry[] {
	const visible: SettingsTabLayoutEntry[] = [];
	let pendingDivider = false;
	let pendingGroupLabel: SettingsTabLayoutEntry["groupLabel"];
	for (const entry of layout) {
		if (entry.dividerBefore) pendingDivider = true;
		if (entry.groupLabel) pendingGroupLabel = entry.groupLabel;
		if (isSettingsTabHidden(hiddenModules, entry.id) && !revealedTabs.has(entry.id)) continue;
		visible.push({ id: entry.id, ...(pendingDivider && visible.length > 0 ? { dividerBefore: true } : {}), ...(pendingGroupLabel ? { groupLabel: pendingGroupLabel } : {}) });
		pendingDivider = false;
		pendingGroupLabel = undefined;
	}
	return visible;
}

/**
 * 弹窗打开时的初始 tab：深链优先（即使指向隐藏 tab，由调用方临时显示）；
 * 否则恢复上次记忆的 tab，但记忆值已被隐藏时回退「常用」——不能让用户打开设置就停在
 * 一个侧栏里找不到的页面。
 */
export function resolveInitialSettingsTab(focusTab: SettingsTabId | undefined, lastTab: SettingsTabId, hiddenModules: readonly string[]): SettingsTabId {
	if (focusTab) return focusTab;
	return isSettingsTabHidden(hiddenModules, lastTab) ? "common" : lastTab;
}
