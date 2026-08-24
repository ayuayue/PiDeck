import { atom } from "jotai";
import type {
	CloudSyncSelectionTree,
	CloudSyncStateSnapshot,
} from "../../../shared/types";

/** 云同步全局状态快照：主进程推送 + 渲染层主动拉取共同维护。 */
export const cloudSyncStateAtom = atom<CloudSyncStateSnapshot | null>(null);

/** 最近一次扫描的会话/资源选择树（设置页展示；选择变更后由 IPC 返回新树）。 */
export const cloudSyncTreeAtom = atom<CloudSyncSelectionTree | null>(null);
