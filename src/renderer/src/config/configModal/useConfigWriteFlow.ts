import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ConfigTab } from "../configTypes";
import type { DshConfigTabHandle } from "../DshConfigTab";
import type { TokendanceInstallOutcome } from "../TokenDancePanel";
import { t } from "../../i18n";

type ConfigWriteFlowDeps = {
	setSaving: Dispatch<SetStateAction<boolean>>;
	setError: Dispatch<SetStateAction<string | null>>;
	onSaved: () => void;
	showToast: (message: string) => void;
	clearDirty: (tabKey: string) => void;
	reloadConfig: (target: ConfigTab, options?: { force?: boolean }) => Promise<void>;
	/** DSH 配置页句柄：TokenDance 落盘后要刷新 DSH 侧配置。 */
	dshConfigRef: RefObject<DshConfigTabHandle | null>;
};

/**
 * 落盘流程的两块公共语义：统一保存（saving/error/toast/清脏标记）与安装类动作的整页重载。
 * 各 Tab 的保存 hook 都经 saveAndReload 上报同一套状态，避免每页各写一份 try/catch。
 */
export function useConfigWriteFlow(deps: ConfigWriteFlowDeps) {
	const { setSaving, setError, onSaved, showToast, clearDirty, reloadConfig, dshConfigRef } = deps;

	/** 统一保存流程：写盘 → 校验 → toast；成功时清除对应 tab 的未保存标记，返回是否成功。 */
	const saveAndReload = async (saveFn: () => Promise<{ valid: boolean; error?: string }>, successMessage?: string, dirtyKey?: string): Promise<boolean> => {
		setSaving(true);
		setError(null);
		try {
			const result = await saveFn();
			if (!result.valid) {
				setError(result.error ?? t("config.saveFailed"));
				return false;
			}
			onSaved();
			showToast(successMessage ?? t("config.saved"));
			if (dirtyKey) clearDirty(dirtyKey);
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			setSaving(false);
		}
	};

	/** TokenDance 一键安装成功：刷新 Pi 模型数据 + DSH 配置页（主进程已直写两侧配置文件）。 */
	const handleTokendanceInstalled = useCallback(
		(outcome: TokendanceInstallOutcome) => {
			// 主进程已直接落盘 models.json：以磁盘为准整页重载（force 清空草稿保留集——
			// 安装是明确的落盘动作，与保存/导入同语义）；DSH 侧若写入成功同步刷新配置页。
			void reloadConfig("models", { force: true }).catch(() => undefined);
			if (outcome.dshSaved) {
				void dshConfigRef.current?.reload().catch(() => undefined);
			}
		},
		[reloadConfig, dshConfigRef],
	);

	return { saveAndReload, handleTokendanceInstalled };
}
