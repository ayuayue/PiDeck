import { useAtomValue } from "jotai";
import { updateChannelInfoAtom } from "../atoms/channelSwitchAtoms";

/**
 * 远端入口是否可用：false = 主进程不提供远端能力，界面不渲染任何入口。
 *
 * 判据与主进程装配同源，经 App 启动时那次 `update:get-channel` 的
 * `remoteAvailable` 下发；更新通道只表示发布线，不参与功能门禁。
 * 未拿到通道信息时返回 undefined，调用方先照常渲染，避免入口闪现。
 */
export function useRemoteFeatureAvailable(): boolean | undefined {
	return useAtomValue(updateChannelInfoAtom)?.remoteAvailable;
}
