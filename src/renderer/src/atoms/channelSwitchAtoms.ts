import { atom } from "jotai";
import type { ChannelSwitchSnapshot, UpdateChannelInfo } from "../../../shared/types";

/**
 * 当前更新通道与应用版本（update:get-channel 初拉；通道编译期决定，运行期不变）。
 * AppUpdateCard 徽章与切换按钮方向、任务 9 的 UpdateSourceSetting 置灰共用。
 */
export const updateChannelInfoAtom = atom<UpdateChannelInfo | null>(null);

/**
 * 通道切换全流程快照（ChannelSwitchService 经 channelSwitchStateChanged 推送 + getStatus 初拉）。
 * ChannelSwitchDialog 按快照 phase 渲染切换向导，不持有本地状态副本。
 */
export const channelSwitchStatusAtom = atom<ChannelSwitchSnapshot | null>(null);
