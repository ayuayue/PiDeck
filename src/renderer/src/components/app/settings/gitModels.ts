/**
 * Git 摘要模型列表数据源 hook：与 pi --list-models 全局缓存共用。
 *
 * 独立成文件的原因：壳组件（SettingsModal）在打开时就要拉模型列表，
 * 但 CommonTab 组件应能 lazy 加载——若 hook 与组件同文件，壳的静态
 * import 会把整个 tab 拖进首开 chunk。
 *
 * report/refreshing/reload 与 useBackendModelCatalog 对齐：
 * 走 listModelsReport（优先 pi --list-models，失败回退本地 models.json），
 * reload(true) 绕过缓存重新 fork，「模型列表加载不出来」时用户可立即重试。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AvailableModel, ModelListReport } from "../../../../../shared/types";
import { desktopApi } from "../../../desktopApi";

export function useGitModels() {
	const [gitModels, setGitModels] = useState<AvailableModel[]>([]);
	/** 最近一次加载报告：空列表时供选择器展示失败原因引导。 */
	const [report, setReport] = useState<ModelListReport | null>(null);
	/** 手动刷新进行中（选择器刷新按钮转圈） */
	const [refreshing, setRefreshing] = useState(false);
	const [gitModelPickerOpen, setGitModelPickerOpen] = useState(false);
	const sequenceRef = useRef(0);

	const load = useCallback((force = false) => {
		const sequence = ++sequenceRef.current;
		if (force) setRefreshing(true);
		void desktopApi.projects
			.listModelsReport(undefined, force)
			.then((next) => {
				if (sequence !== sequenceRef.current) return;
				setGitModels(next.models);
				setReport(next);
				setRefreshing(false);
			})
			.catch(() => {
				if (sequence !== sequenceRef.current) return;
				setGitModels([]);
				setReport(null);
				setRefreshing(false);
			});
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const openPicker = useCallback(() => setGitModelPickerOpen(true), []);
	const closePicker = useCallback(() => setGitModelPickerOpen(false), []);

	return { gitModels, report, refreshing, reload: load, gitModelPickerOpen, openPicker, closePicker };
}
