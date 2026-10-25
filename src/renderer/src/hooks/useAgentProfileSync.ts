import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { desktopApi } from "../desktopApi";
import { agentProfileSnapshotAtom } from "../atoms/agent-atoms";

/**
 * 全局同步主进程智能体快照（agents + settings + revision）。
 * 挂载在 AppBootstrap 顶层：初始拉一次快照，之后主进程每次广播
 * agent-profiles:changed（增删改、设置更新、使用次数变化）都重新拉全量快照。
 * 与 useAutomationSync 同构——渲染层不自己拼状态，只信主进程快照。
 */
export function useAgentProfileSync(): void {
	const setSnapshot = useSetAtom(agentProfileSnapshotAtom);

	useEffect(() => {
		let alive = true;

		desktopApi.agentProfiles
			.getSnapshot()
			.then((snapshot) => {
				if (alive) setSnapshot(snapshot);
			})
			.catch((error) => {
				// 首次快照失败不让应用挂掉：市场面板显示空市场，下一次 changed 事件会自愈。
				console.warn("[agentProfiles] Failed to get initial snapshot", error);
			});

		const unsubscribe = desktopApi.agentProfiles.onChanged(() => {
			if (!alive) return;
			desktopApi.agentProfiles
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
