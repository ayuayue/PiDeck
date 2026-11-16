import type { ComponentProps, ReactNode } from "react";
import type { PiDesktopApi } from "../../../../preload";
import type { PiConfigTarget } from "../../../../shared/piConfig";
import type { ConfigTab } from "../configTypes";
import { RemoteConfigPanel } from "../RemoteConfigPanel";
import { TrustTab } from "../TrustTab";
import { WslConfigSourceHint } from "../WslConfigSourceHint";
import type { WslConfigTargetHost } from "../piConfigTargetModel";

type ConfigTrustEditingDeps = {
	api: PiDesktopApi;
	configTargetOption: { target: PiConfigTarget } | undefined;
	trustData: Record<string, boolean>;
	saveAndReload: (saveFn: () => Promise<{ valid: boolean; error?: string }>, successMessage?: string, dirtyKey?: string) => Promise<boolean>;
	reloadConfig: (target: ConfigTab, options?: { force?: boolean; silent?: boolean }) => Promise<void>;
};

/** 信任页的保存动作（搬迁自 ConfigModal，行为不变）：整份 trust.json 原样写回后 force 重读。 */
export function useConfigTrustEditing(deps: ConfigTrustEditingDeps) {
	const { api, configTargetOption, trustData, saveAndReload, reloadConfig } = deps;

	const handleSaveTrust = async (): Promise<boolean> => {
		const ok = await saveAndReload(() => api.config.saveRaw("trust.json", JSON.stringify(trustData, null, 2), configTargetOption), undefined, "config:trust");
		await reloadConfig("trust", { force: true });
		return ok;
	};

	return { handleSaveTrust };
}

export type ConfigTrustTabProps = {
	/** ssh 目标的主机 id：非空时整页换成远端 patch 面板。 */
	remoteTargetHostId: string | null;
	remoteHostLabel: string | undefined;
	onRemoteDirtyChange: (dirty: boolean) => void;
	/** WSL 目标的来源提示（只在本地编辑分支显示）。 */
	wslTargetHost: WslConfigTargetHost | undefined;
	statusBlock: ReactNode;
	configDiagnosticBlock: ReactNode;
	loading: boolean;
	/** 信任规则草稿的变更入口（父级据此 setTrustData + markDirty）。 */
	onChange: (data: Record<string, boolean>) => void;
} & ComponentProps<typeof TrustTab>;

/** 信任页内容（`config:trust` TabsContent 整块）。 */
export function ConfigTrustTab({ remoteTargetHostId, remoteHostLabel, onRemoteDirtyChange, wslTargetHost, statusBlock, configDiagnosticBlock, loading, ...trustTabProps }: ConfigTrustTabProps) {
	return (
		<div className="config-content">
			{remoteTargetHostId ? (
				<RemoteConfigPanel key={"remote-trust-" + remoteTargetHostId} file="trust" hostId={remoteTargetHostId} hostLabel={remoteHostLabel} onDirtyChange={onRemoteDirtyChange} />
			) : (
				<>
					{wslTargetHost ? <WslConfigSourceHint host={wslTargetHost} file="trust" /> : null}
					{statusBlock}
					{configDiagnosticBlock}
					{!loading && <TrustTab {...trustTabProps} />}
				</>
			)}
		</div>
	);
}
