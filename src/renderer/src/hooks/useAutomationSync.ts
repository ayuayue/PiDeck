import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { desktopApi } from "../desktopApi";
import { automationSnapshotAtom } from "../atoms/automation-atoms";

/**
 * 全局同步主进程定时任务快照与变更事件。
 * 挂载在 AppBootstrap 顶层，窗口激活或主进程广播 automationChanged 时刷新。
 */
export function useAutomationSync(): void {
	const setSnapshot = useSetAtom(automationSnapshotAtom);

	useEffect(() => {
		let alive = true;

		// 初始拉取快照
		desktopApi.automation
			.getSnapshot()
			.then((snapshot) => {
				if (alive) setSnapshot(snapshot);
			})
			.catch((err) => {
				console.warn("[automation] Failed to get initial snapshot", err);
			});

		// 订阅主进程变更通知（任务增删改、设置更新、运行状态推进）
		const unsubscribe = desktopApi.automation.onChanged(() => {
			if (!alive) return;
			desktopApi.automation
				.getSnapshot()
				.then((snapshot) => {
					if (alive) setSnapshot(snapshot);
				})
				.catch(() => undefined);
		});

		return () => {
			alive = false;
			unsubscribe();
		};
	}, [setSnapshot]);
}
