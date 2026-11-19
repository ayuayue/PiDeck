import type { ComponentProps, ReactNode, RefObject } from "react";
import { deepClone } from "../../utils/deepEqual";
import type { PiDesktopApi } from "../../../../preload";
import type { PiConfigTarget } from "../../../../shared/piConfig";
import type { ConfigTab } from "../configTypes";
import { TrustTab } from "../TrustTab";
import { WslConfigSourceHint } from "../WslConfigSourceHint";
import type { WslConfigTargetHost } from "../piConfigTargetModel";

type ConfigTrustEditingDeps = {
	api: PiDesktopApi;
	configTargetOption: { target: PiConfigTarget } | undefined;
	trustData: Record<string, boolean>;
	baselineTrustRef: RefObject<Record<string, boolean>>;
	saveAndReload: (saveFn: () => Promise<{ valid: boolean; error?: string }>, successMessage?: string, dirtyKey?: string) => Promise<boolean>;
	reloadConfig: (target: ConfigTab, options?: { force?: boolean; silent?: boolean }) => Promise<void>;
};

/** 信任页写回 trust.json，保存成功后重读并保留其他页的草稿。 */
export function useConfigTrustEditing(deps: ConfigTrustEditingDeps) {
	const { api, configTargetOption, trustData, baselineTrustRef, saveAndReload, reloadConfig } = deps;

	const handleSaveTrust = async (): Promise<boolean> => {
		const ok = await saveAndReload(() => api.config.saveRaw("trust.json", JSON.stringify(trustData, null, 2), configTargetOption), undefined, "config:trust");
		if (ok) baselineTrustRef.current = deepClone(trustData);
		if (ok) await reloadConfig("trust");
		return ok;
	};

	return { handleSaveTrust };
}

export type ConfigTrustTabProps = {
	/** WSL 来源提示。 */
	wslTargetHost: WslConfigTargetHost | undefined;
	statusBlock: ReactNode;
	configDiagnosticBlock: ReactNode;
	loading: boolean;
	/** 信任规则草稿的变更入口（父级据此 setTrustData + markDirty）。 */
	onChange: (data: Record<string, boolean>) => void;
} & ComponentProps<typeof TrustTab>;

/** 信任页内容（`config:trust` TabsContent 整块）。 */
export function ConfigTrustTab({ wslTargetHost, statusBlock, configDiagnosticBlock, loading, ...trustTabProps }: ConfigTrustTabProps) {
	return (
		<div className="config-content">
			{wslTargetHost ? <WslConfigSourceHint host={wslTargetHost} file="trust" /> : null}
			{statusBlock}
			{configDiagnosticBlock}
			{!loading && <TrustTab {...trustTabProps} />}
		</div>
	);
}
