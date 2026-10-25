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

/** 是否有「可提示」的内置模型目录更新（设置页高亮依据；不弹 toast，仅角标/页面提示）。 */
export const pendingCatalogUpdateAtom = atom<boolean>((get) => {
	const snapshot = get(updateStatusAtom);
	return Boolean(snapshot?.catalog?.hasUpdate);
});

/** 是否有任一「可提示」更新（侧栏设置按钮角标依据：app / pi CLI / 模型目录）。 */
export const hasPendingUpdateAtom = atom<boolean>((get) => {
	return get(pendingAppUpdateAtom) || get(pendingPiUpdateAtom) || get(pendingCatalogUpdateAtom);
});
