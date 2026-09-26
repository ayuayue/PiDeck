import { useEffect } from "react";
import { useSetAtom } from "jotai";
import type { PiDesktopApi } from "../../../preload";
import { channelSwitchStatusAtom, updateChannelInfoAtom } from "../atoms/channelSwitchAtoms";

export type ChannelSwitchWatchOptions = {
	api: PiDesktopApi;
};

/**
 * 通道切换状态订阅（ChannelSwitchService 快照驱动，App 装配处与 useBackgroundUpdateWatch 同点挂载一次）。
 *
 * 挂载时初拉当前通道（updateChannelInfoAtom）与切换快照（channelSwitchStatusAtom），
 * 订阅 channelSwitchStateChanged 增量更新，卸载退订；本 hook 不做 toast 打扰，
 * 用户交互全部收敛在设置页 AppUpdateCard → ChannelSwitchDialog。
 */
export function useChannelSwitchWatch(options: ChannelSwitchWatchOptions): void {
	const { api } = options;
	const setChannelInfo = useSetAtom(updateChannelInfoAtom);
	const setSwitchStatus = useSetAtom(channelSwitchStatusAtom);

	useEffect(() => {
		// 初拉：挂载晚于主进程首查（或用户未打开过设置页）时也能拿到当前状态。
		void api.app
			.getChannel()
			.then(setChannelInfo)
			.catch(() => undefined);
		void api.channelSwitch
			.getStatus()
			.then(setSwitchStatus)
			.catch(() => undefined);
		const unsubscribe = api.channelSwitch.onStateChanged(setSwitchStatus);
		return () => unsubscribe();
	}, [api, setChannelInfo, setSwitchStatus]);
}
