import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import { settingsOpenAtom } from "../atoms/app-ui-atoms";
import { remoteHostsConfiguredAtom } from "../atoms/remote-host-atoms";
import { desktopApi } from "../desktopApi";
import { readRemoteHostsConfigured } from "./remoteFeatureVisibility";
import { useRemoteFeatureAvailable } from "./useRemoteFeatureAvailable";

/**
 * 「现在有没有一台可登记的 SSH 主机」（添加项目的远端入口靠它收口）。
 *
 * - 门禁关闭（正式包）不发任何 IPC：通道都不提供，问清单没有意义。
 * - 只在设置页关着时读：主机只可能在「设置 → 远程主机」里增删，出门时读到的才是最终状态；
 *   每次设置页关闭后都会重读一次，所以「刚加完主机就点 +」也能立刻看到远端入口。
 * - 读取失败沿用上一次结论：不把「读不到清单」当成「没有主机」，那样会凭空藏掉一个可用入口。
 *
 * 结论进 atom（remoteHostsConfiguredAtom）而不是本地 state：侧栏「+」与引导页空态是两处挂载点，
 * 一个结论只该存一份。
 */
export function useRemoteHostsConfigured(): boolean | undefined {
	const available = useRemoteFeatureAvailable();
	const settingsOpen = useAtomValue(settingsOpenAtom);
	const configured = useAtomValue(remoteHostsConfiguredAtom);
	const setConfigured = useSetAtom(remoteHostsConfiguredAtom);

	useEffect(() => {
		if (available === false || settingsOpen) return;
		let active = true;
		void (async () => {
			let next: boolean | undefined;
			try {
				next = readRemoteHostsConfigured(await desktopApi.remoteHosts.list());
			} catch {
				return;
			}
			// 卸载或设置页又被打开：迟到的结论丢弃，不能把旧状态盖到新状态上。
			if (active && next !== undefined) setConfigured(next);
		})();
		return () => {
			active = false;
		};
	}, [available, settingsOpen, setConfigured]);

	return available === false ? false : configured;
}
