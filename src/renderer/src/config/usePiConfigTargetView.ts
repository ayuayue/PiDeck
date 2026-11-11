import { useCallback, useMemo } from "react";
import type { PiConfigTarget } from "../../../shared/piConfig";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { localEditorTargetOption, providerOpsAllowed, wslTargetHostOf, type PiConfigTargetHost, type WslConfigTargetHost } from "./piConfigTargetModel";

/**
 * 配置目标视图层派生（P1-1）：当前目标对应哪个 WSL 环境、本地编辑器要带的 target 选项、
 * provider 探针能不能点。集中成一个 hook 后，ConfigModal 的各个 tab 只取结果，
 * 不必各自判断目标种类，也不会出现「模型页拦住了、设置页忘了拦」这种分裂。
 */
export function usePiConfigTargetView(hosts: readonly PiConfigTargetHost[], target: PiConfigTarget) {
	const wslHost: WslConfigTargetHost | undefined = useMemo(() => wslTargetHostOf(hosts, target), [hosts, target]);
	/** 本地 models/settings 编辑器要带的选项：只有 wsl 目标需要（ssh 由远端面板接管）。 */
	const option = useMemo(() => localEditorTargetOption(target), [target]);
	/** provider 探针只对本机开放：非本机目标提前拦下并说明（主进程同样会拒绝，界面不能假装能点）。 */
	const guardProviderOp = useCallback(
		(action: () => void) => {
			if (providerOpsAllowed(target)) {
				action();
				return;
			}
			showNotice(t("config.target.wslProviderOps"), 5000, "warning");
		},
		[target],
	);
	return { wslHost, option, guardProviderOp };
}
