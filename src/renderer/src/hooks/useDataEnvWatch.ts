import { useEffect } from "react";
import { useSetAtom } from "jotai";
import type { PiDesktopApi } from "../../../preload";
import { dataEnvDecisionRequiredAtom, dataEnvImportProgressAtom, dataEnvMismatchAtom } from "../atoms/dataEnvAtoms";

export type DataEnvWatchOptions = {
	api: PiDesktopApi;
};

/**
 * 数据环境事件订阅（模式照 useChannelSwitchWatch：App 装配处挂载一次，卸载全部退订）。
 *
 * - dataEnvDecisionRequired → 置位首启数据模式选择弹窗（DataModeChoiceDialog）；
 * - dataEnvMismatchDetected → 记录目录标记载荷并弹出警告（DataEnvMismatchDialog）；
 * - dataEnvImportProgress → 更新导入进度快照（DataImportProgressDialog 渲染消费）。
 *
 * 本 hook 只做事件→atom 转发，不做交互决策；弹窗流程收敛在各自组件内。
 */
export function useDataEnvWatch(options: DataEnvWatchOptions): void {
	const { api } = options;
	const setDecisionRequired = useSetAtom(dataEnvDecisionRequiredAtom);
	const setMismatch = useSetAtom(dataEnvMismatchAtom);
	const setImportProgress = useSetAtom(dataEnvImportProgressAtom);

	useEffect(() => {
		const offDecisionRequired = api.dataEnv.onDecisionRequired(() => setDecisionRequired(true));
		const offMismatch = api.dataEnv.onMismatchDetected(setMismatch);
		const offProgress = api.dataEnv.onImportProgress(setImportProgress);
		return () => {
			offDecisionRequired();
			offMismatch();
			offProgress();
		};
	}, [api, setDecisionRequired, setMismatch, setImportProgress]);
}
