import { atom } from "jotai";
import type { AppUpdateStatusSnapshot } from "../../../shared/types";

/**
 * 主进程后台更新检查快照（app:update-status-changed 推送）。
 * 角标/首次 toast 判定都从这里派生；null = 尚未收到任何快照。
 */
export const updateStatusAtom = atom<AppUpdateStatusSnapshot | null>(null);

/** 是否有「可提示」的 PiDeck 更新：有更新 且 未被用户跳过（角标显隐依据）。 */
export const pendingAppUpdateAtom = atom<boolean>((get) => {
	const snapshot = get(updateStatusAtom);
	if (!snapshot?.app) return false;
	const { hasUpdate, latestVersion, skippedVersion } = snapshot.app;
	return hasUpdate && Boolean(latestVersion) && latestVersion !== skippedVersion;
});

/** 是否有「可提示」的 Pi CLI 更新（设置页高亮依据）。 */
export const pendingPiUpdateAtom = atom<boolean>((get) => {
	const snapshot = get(updateStatusAtom);
	return Boolean(snapshot?.piCli?.hasUpdate);
});
