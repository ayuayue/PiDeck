import { useCallback, useEffect, useState } from "react";
import { useAtom } from "jotai";
import { desktopApi } from "../desktopApi";
import { cloudSyncStateAtom, cloudSyncTreeAtom } from "../atoms/cloudSyncAtoms";
import type {
	CloudSyncProviderConfigInput,
	CloudSyncSelectionTree,
	CloudSyncSelectionUpdate,
} from "../../../shared/types";

/**
 * 云同步状态/操作 Hook（渲染层唯一入口）。
 * 密码、派生 key、Provider 凭据永远只在主进程；这里只发操作意图并消费状态快照。
 */
export function useCloudSync() {
	const [state, setState] = useAtom(cloudSyncStateAtom);
	const [tree, setTree] = useAtom(cloudSyncTreeAtom);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let disposed = false;
		const refresh = async () => {
			try {
				const snapshot = await desktopApi.cloudSync.getState();
				if (!disposed) setState(snapshot);
			} catch {
				// 主进程不可用时保持原子初值；preload 缺失场景已在桌面 API 层兜底。
			}
		};
		void refresh();
		const unsubscribe = desktopApi.cloudSync.onStateChanged((snapshot) => {
			if (!disposed) setState(snapshot);
		});
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [setState]);

	const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
		setBusy(true);
		setError(null);
		try {
			return await action();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
			return undefined;
		} finally {
			setBusy(false);
		}
	}, []);

	const scan = useCallback(async () => {
		const next = await run(() => desktopApi.cloudSync.scan());
		if (next) setTree(next);
		return next;
	}, [run, setTree]);

	const updateSelection = useCallback(async (update: CloudSyncSelectionUpdate) => {
		const next = await run(() => desktopApi.cloudSync.updateSelection(update));
		if (next) setTree(next);
		return next;
	}, [run, setTree]);

	return {
		state,
		tree,
		busy,
		error,
		setupMasterKey: (password: string) => run(() => desktopApi.cloudSync.setupMasterKey(password)),
		unlock: (password: string) => run(() => desktopApi.cloudSync.unlock(password)),
		lock: () => run(() => desktopApi.cloudSync.lock()),
		changePassword: (oldPassword: string, newPassword: string) =>
			run(() => desktopApi.cloudSync.changePassword(oldPassword, newPassword)),
		configureProvider: (input: CloudSyncProviderConfigInput) =>
			run(() => desktopApi.cloudSync.configureProvider(input)),
		disconnectProvider: (provider: string) =>
			run(() => desktopApi.cloudSync.disconnectProvider(provider)),
		connect: (provider: string) => run(() => desktopApi.cloudSync.connect(provider)),
		scan,
		updateSelection,
		syncNow: (allowShrink?: boolean) => run(() => desktopApi.cloudSync.syncNow({ allowShrink })),
		setAutoSync: (enabled: boolean, intervalMinutes?: number) =>
			run(() => desktopApi.cloudSync.setAutoSync(enabled, intervalMinutes)),
		setStrategy: (strategy: string) => run(() => desktopApi.cloudSync.setStrategy(strategy)),
	};
}

export type CloudSyncHook = ReturnType<typeof useCloudSync>;
