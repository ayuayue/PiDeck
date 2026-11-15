import { useEffect, useImperativeHandle, type MutableRefObject, type Ref } from "react";
import type { PiConfigTarget } from "../../../../shared/piConfig";
import { orderDirtyKeysForSave } from "../configDirtyMarks";
import type { ConfigUnsavedItem, ConfigUnsavedSummary } from "../configUnsavedChangesSummary";

/**
 * 嵌入设置窗口的配置管理分区句柄：外壳（SettingsModal）标题栏的「保存/导出/导入」按钮经 ref 调用。
 * 与独立 ConfigModal 顶部按钮共用同一套 handler（saveByKey/export/import/close），保证两个入口逻辑一致。
 */
export type ConfigPaneHandle = {
	/** 保存当前 tab（内部与 ConfigModal 顶部保存按钮同源）。 */
	saveCurrent: () => Promise<void>;
	/** 导出三个配置文件为 JSON 下载。 */
	exportConfig: () => void;
	/** 从 JSON 文件导入配置。 */
	importConfig: () => void;
	/** 保存全部脏来源（外壳统一关闭确认的「保存并关闭」委托；任一失败返回 false 留在窗口）。 */
	saveAllDirty: () => Promise<boolean>;
};

/** 外壳标题栏所需的状态快照：保存禁用 / 黄点 / 关闭确认清单。 */
export type ConfigPaneState = {
	saving: boolean;
	hasDirty: boolean;
	/** 非本机目标（WSL/ssh）禁用配置导出/导入：外壳按钮据此置灰（handler 侧同样拒绝）。 */
	exportImportAllowed: boolean;
	/** 未保存清单（tabKey/itemKey 为 i18n key，关闭确认整体展示）。 */
	unsaved: { totalCount: number; items: ConfigUnsavedItem[] };
};

type ConfigPaneBridgeDeps = {
	paneRef: Ref<ConfigPaneHandle> | undefined;
	onPaneStateChange: ((state: ConfigPaneState) => void) | undefined;
	handleSaveCurrent: () => Promise<void>;
	handleExport: () => void;
	handleImport: () => void;
	saveByKey: (tabKey: string) => Promise<boolean>;
	dirtyTabs: Set<string>;
	remoteConfigDirty: boolean;
	saving: boolean;
	hasDirty: boolean;
	configTarget: PiConfigTarget;
	configUnsavedSummary: ConfigUnsavedSummary | null;
	providerPageSavePendingRef: MutableRefObject<boolean>;
	addingProvider: boolean;
	editingProvider: string | null;
	handleSaveModels: () => Promise<boolean>;
};

/**
 * 嵌入模式（ConfigPane）桥：把句柄暴露给外壳标题栏，并把 saving/黄点/关闭清单同步给外壳。
 * 独立弹窗下 paneRef/onPaneStateChange 都是 undefined，这两段等价于空操作。
 */
export function useConfigPaneBridge(deps: ConfigPaneBridgeDeps) {
	const { paneRef, onPaneStateChange, handleSaveCurrent, handleExport, handleImport, saveByKey, dirtyTabs, remoteConfigDirty, saving, hasDirty, configTarget, configUnsavedSummary, providerPageSavePendingRef, addingProvider, editingProvider, handleSaveModels } = deps;

	// ── 嵌入模式句柄与状态上报（ConfigPane） ──
	// 外壳标题栏的保存/导出/导入/关闭按钮直接委托给这里的同一个 handler；
	// saving/hasDirty 同步到外壳，驱动保存按钮禁用与黄点，避免两处按钮行为分叉。
	useImperativeHandle(
		paneRef,
		() => ({
			saveCurrent: () => handleSaveCurrent(),
			exportConfig: handleExport,
			importConfig: handleImport,
			// 外壳统一关闭确认时调用：把配置分区全部脏来源逐个保存（dsh:<nav> 归并 dsh），
			// 与独立 ConfigModal「保存并关闭」走同一套 saveByKey 分发，任一失败返回 false 留在窗口。
			saveAllDirty: async () => {
				// 只有远端 patch 时本机保存链路无事可做；返回 false 让外壳保留窗口，用户可显式丢弃/关闭。
				if (dirtyTabs.size === 0 && remoteConfigDirty) return false;
				const roots = new Set<string>();
				for (const key of dirtyTabs) {
					roots.add(key.startsWith("dsh:") ? "dsh" : key);
				}
				for (const key of orderDirtyKeysForSave(roots)) {
					const ok = await saveByKey(key);
					if (!ok) return false;
				}
				return true;
			},
		}),
		[handleSaveCurrent, handleExport, handleImport, saveByKey, dirtyTabs],
	);
	// 标题栏保存触发页内提交后，下一轮 state 更新会重新进入 models 保存路径；
	// 这样用户一次点击即可完成「页内草稿 → models.json」两步提交。
	useEffect(() => {
		if (!providerPageSavePendingRef.current) return;
		if (addingProvider || editingProvider) return;
		if (!dirtyTabs.has("config:models")) {
			// 表单校验未通过时没有 models 草稿可保存，避免 pending 标记污染下一次进入页面。
			providerPageSavePendingRef.current = false;
			return;
		}
		providerPageSavePendingRef.current = false;
		void handleSaveModels();
	}, [addingProvider, editingProvider, dirtyTabs, handleSaveModels]);

	useEffect(() => {
		onPaneStateChange?.({
			saving,
			hasDirty: hasDirty || remoteConfigDirty,
			exportImportAllowed: configTarget.kind === "local",
			unsaved: configUnsavedSummary ? { totalCount: configUnsavedSummary.totalCount, items: configUnsavedSummary.items } : { totalCount: 0, items: [] },
		});
	}, [saving, hasDirty, configUnsavedSummary, configTarget, onPaneStateChange]);
}
