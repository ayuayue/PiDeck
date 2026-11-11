import { useEffect } from "react";
import type { createStore } from "jotai";
import { currentSessionIdAtom, sessionTabIdsAtom, stoppedSessionIdsAtom, trimSessionMessageCacheAtom } from "../atoms";

/**
 * 已停止运行时的会话在**离开视野**后立刻回收消息缓存（issue #519）。
 *
 * 背景：消息缓存的淘汰只在写入路径触发，而「打开着的 Tab」被无条件保护。任务做完 →
 * Agent 被手动关闭或闲置释放 → detach 只清了运行时态，那个 Tab 还开着，于是整段会话
 * 消息（可达数十 MB）一直留在唯一渲染进程里，长跑只增不减。
 *
 * 分工：detach 时已裁剪一次（此时聚焦会话仍受保护，不会清掉屏幕上的内容）；本 hook 补
 * 「切走 / 关 Tab」这两个后续时机——停掉的会话一离开视野就按已关闭条目口径回收。
 * 运行中会话的 Tab 仍无条件保护（既有语义不变），不会出现切回闪骨架。
 */
export function useStoppedSessionCacheTrim(store: ReturnType<typeof createStore>) {
	useEffect(() => {
		if (!store) return;

		const trim = () => {
			if (store.get(stoppedSessionIdsAtom).size === 0) return;
			store.set(trimSessionMessageCacheAtom);
		};

		trim();
		const unsubscribeFocused = store.sub(currentSessionIdAtom, trim);
		const unsubscribeTabs = store.sub(sessionTabIdsAtom, trim);
		return () => {
			unsubscribeFocused();
			unsubscribeTabs();
		};
	}, [store]);
}
