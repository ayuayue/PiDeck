import type { ComponentProps, Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import type { PiDesktopApi } from "../../../../preload";
import type { PiConfigTarget } from "../../../../shared/piConfig";
import { pruneModelThinkingLevelOrphans } from "../../../../shared/modelThinkingLevels";
import { deepClone } from "../../utils/deepEqual";
import type { ConfigTab, ModelsFile, SettingsFile } from "../configTypes";
import { RemoteConfigPanel } from "../RemoteConfigPanel";
import { SettingsTab } from "../SettingsTab";
import { WslConfigSourceHint } from "../WslConfigSourceHint";
import type { WslConfigTargetHost } from "../piConfigTargetModel";
import { modelIdIndex } from "./modelIdIndex";

type ConfigSettingsEditingDeps = {
	api: PiDesktopApi;
	configTargetOption: { target: PiConfigTarget } | undefined;
	settingsData: SettingsFile;
	setSettingsData: Dispatch<SetStateAction<SettingsFile>>;
	modelsData: ModelsFile;
	/** settings.json 的基准快照：只写不重载的保存路径要把基准同步到刚写下的内容。 */
	baselineSettingsRef: RefObject<SettingsFile>;
	saveAndReload: (saveFn: () => Promise<{ valid: boolean; error?: string }>, successMessage?: string, dirtyKey?: string) => Promise<boolean>;
	reloadConfig: (target: ConfigTab, options?: { force?: boolean; silent?: boolean }) => Promise<void>;
};

/**
 * 设置页的保存动作（搬迁自 ConfigModal，行为不变）：落盘前先清掉指向已删除模型的孤儿档位键。
 * settings.json 的重载会连带刷新 models/auth/raw，只写不重载的路径单独留给模型页顺带提交。
 */
export function useConfigSettingsEditing(deps: ConfigSettingsEditingDeps) {
	const { api, configTargetOption, settingsData, setSettingsData, modelsData, baselineSettingsRef, saveAndReload, reloadConfig } = deps;

	/**
	 * 落 settings.json 前清掉「模型已不在列表里」的孤儿档位键（设置跟着模型走），
	 * 清理结果同步回 UI 草稿（否则界面还挂着已经写掉的旧值）。
	 */
	const pruneProviderThinkingLevelOrphans = (): Record<string, unknown> => {
		const pruned = pruneModelThinkingLevelOrphans(settingsData, modelIdIndex(modelsData.providers));
		if (pruned !== settingsData) setSettingsData(pruned);
		return pruned;
	};

	const handleSaveSettings = async (): Promise<boolean> => {
		const pruned = pruneProviderThinkingLevelOrphans();
		const ok = await saveAndReload(() => api.config.saveSettings(pruned, configTargetOption), undefined, "config:settings");
		await reloadConfig("settings", { force: true });
		return ok;
	};

	/**
	 * 只落 settings.json 并把该草稿标记为干净，**不**整页重载。
	 * 模型页保存顺带提交 settings 草稿时用它：handleSaveSettings 的 force 重载会连带拉取
	 * models/auth/raw，把它们的未保存草稿静默冲掉。
	 */
	const saveSettingsDraftOnly = async (): Promise<boolean> => {
		const pruned = pruneProviderThinkingLevelOrphans();
		const ok = await saveAndReload(() => api.config.saveSettings(pruned, configTargetOption), undefined, "config:settings");
		// 基准同步到刚写下的内容，否则脏检测（数据 vs 基准）会把刚清掉的黄点又标回来。
		if (ok) baselineSettingsRef.current = deepClone(pruned);
		return ok;
	};

	return { handleSaveSettings, saveSettingsDraftOnly };
}

export type ConfigSettingsTabProps = {
	/** WSL 目标的来源提示（本机为 undefined）。 */
	wslTargetHost: WslConfigTargetHost | undefined;
	/** ssh 目标的主机 id：非空时整页换成远端 patch 面板。 */
	remoteTargetHostId: string | null;
	remoteHostLabel: string | undefined;
	onRemoteDirtyChange: (dirty: boolean) => void;
	statusBlock: ReactNode;
	configDiagnosticBlock: ReactNode;
	loading: boolean;
	/** settings.json 是否已真实读入内存：模型页与设置页的编辑入口都等它。 */
	settingsLoaded: boolean;
	/** 打开页面时的格式归一（normalize）不是用户编辑：父级据此刷新基准快照而不是标脏。 */
	onChange: (data: SettingsFile, reason?: "normalize") => void;
} & ComponentProps<typeof SettingsTab>;

/** 设置页内容（`config:settings` TabsContent 整块）。 */
export function ConfigSettingsTab({ wslTargetHost, remoteTargetHostId, remoteHostLabel, onRemoteDirtyChange, statusBlock, configDiagnosticBlock, loading, settingsLoaded, ...settingsTabProps }: ConfigSettingsTabProps) {
	return (
		<div className="config-content">
			{wslTargetHost ? <WslConfigSourceHint host={wslTargetHost} file="settings" /> : null}
			{remoteTargetHostId ? (
				<RemoteConfigPanel key={"remote-settings-" + remoteTargetHostId} file="settings" hostId={remoteTargetHostId} hostLabel={remoteHostLabel} onDirtyChange={onRemoteDirtyChange} />
			) : (
				<>
					{statusBlock}
					{configDiagnosticBlock}
					{!loading && settingsLoaded && <SettingsTab {...settingsTabProps} />}
				</>
			)}
		</div>
	);
}
