import { useCallback, useMemo, useRef, useState } from "react";
import { t } from "../../i18n";
import { formatConfigUnsavedMessage, summarizeConfigUnsavedChanges } from "../configUnsavedChangesSummary";

/**
 * 未保存修改集合（脏标记）与派生展示值：`dirtyTabs` 用 sectionTabValue 编码（如 "config:models"/"skills"），
 * 顶部保存按钮、导航黄点与关闭确认清单都从这里派生。
 * `dirtyTabsRef` 与 state 同步维护：loadConfig 等回调不能依赖 dirtyTabs（否则切 tab 会重建回调并误触发重载）。
 */
export function useConfigDirtyMarks() {
	/** 各 tab 未保存修改集合：key 用 sectionTabValue 编码（如 "config:models"/"skills"），顶部保存按钮与关闭确认依赖它 */
	const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
	/** loadConfig 不能依赖 dirtyTabs（否则切 tab 会重建回调并误触发重载）；用 ref 读最新脏集合。 */
	const dirtyTabsRef = useRef(dirtyTabs);
	dirtyTabsRef.current = dirtyTabs;
	const hasDirty = dirtyTabs.size > 0;
	// DSH/Pi 顶层分页与 DSH 左侧导航的黄点来源：dsh:<nav> 归 DSH，其余归 Pi
	const dshDirtyNavIds = useMemo(() => {
		const ids = new Set<string>();
		for (const key of dirtyTabs) if (key.startsWith("dsh:")) ids.add(key);
		return ids;
	}, [dirtyTabs]);
	const hasDshDirty = dshDirtyNavIds.size > 0;
	const hasPiDirty = dirtyTabs.size > 0 && !hasDshDirty;
	/** 关闭确认摘要：列出全部脏 tab（不再只点第一条），供 AlertDialog 逐条展示。 */
	const configUnsavedSummary = useMemo(() => summarizeConfigUnsavedChanges(dirtyTabs), [dirtyTabs]);
	const configUnsavedMessage = useMemo(() => formatConfigUnsavedMessage(configUnsavedSummary, t), [configUnsavedSummary]);

	/** 标记某 tab 存在未保存修改（幂等；只用 setDirtyTabs 函数式更新，引用稳定） */
	const markDirty = useCallback((tabKey: string) => {
		setDirtyTabs((prev) => {
			if (prev.has(tabKey)) return prev;
			const next = new Set(prev).add(tabKey);
			dirtyTabsRef.current = next;
			return next;
		});
	}, []);

	/** 清除某 tab 的未保存修改标记（保存成功或主动放弃编辑时调用） */
	const clearDirty = useCallback((tabKey: string) => {
		setDirtyTabs((prev) => {
			if (!prev.has(tabKey)) return prev;
			const next = new Set([...prev].filter((k) => k !== tabKey));
			dirtyTabsRef.current = next;
			return next;
		});
	}, []);

	/** DSH 页脏状态：保留聚合 "dsh" 给保存按钮，同时记下 dsh:<nav> 供侧栏黄点/关闭文案。 */
	const handleDshDirtyChange = useCallback((dirty: boolean, keys: string[] = []) => {
		setDirtyTabs((prev) => {
			const next = new Set([...prev].filter((key) => key !== "dsh" && !key.startsWith("dsh:")));
			if (dirty) {
				next.add("dsh");
				for (const key of keys) {
					if (key.startsWith("dsh:")) next.add(key);
				}
			}
			dirtyTabsRef.current = next;
			return next;
		});
	}, []);

	return { dirtyTabs, setDirtyTabs, dirtyTabsRef, hasDirty, dshDirtyNavIds, hasDshDirty, hasPiDirty, configUnsavedSummary, configUnsavedMessage, markDirty, clearDirty, handleDshDirtyChange };
}
