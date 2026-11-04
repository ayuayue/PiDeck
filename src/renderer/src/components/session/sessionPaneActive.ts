import { createContext, useContext, useEffect, useState } from "react";
import { useStore } from "jotai";
import type { Atom } from "jotai";

/**
 * 会话栏渲染模式：
 * - active：聚焦 + 窗口可见，正常打字机 / Markdown 增量渲染；
 * - background：可见但未聚焦（非焦点分屏、侧边任务栏等），停打字机，按 1s 粗粒度
 *   刷新文本（不重放逐字动画，也不做 settle 全量高亮）；
 * - hidden：窗口不可见（最小化 / 后台标签页），完全冻结画面，只保留数据。
 *
 * 三档而不是两档的原因：非焦点分屏仍然在屏幕上，完全冻结会让用户看到一栏空白
 * 或停在半截；1s 粗刷新既能看到进度，又把逐帧 Markdown 重排成本压到 ~1/60。
 */
export type SessionPaneRenderMode = "active" | "background" | "hidden";

export const SessionPaneRenderModeContext = createContext<SessionPaneRenderMode>("active");

export function useSessionPaneRenderMode(): SessionPaneRenderMode {
	return useContext(SessionPaneRenderModeContext);
}

/** 只有 active 才算「用户正在看」；background/hidden 都应停掉逐字动画与秒表。 */
export function useSessionPaneActive(): boolean {
	return useSessionPaneRenderMode() === "active";
}

/**
 * 按渲染模式读 atom：
 * - active：正常订阅，每次更新都重渲染；
 * - background：每 intervalMs 采样一次，避免 live delta 驱动整栏重渲染；
 * - hidden：切到该模式时对齐一次当前值，之后冻结。
 *
 * 不用 selectAtom 的相等判断来冻结，是因为 background 还需要 1s 粗刷新；
 * 直接用 store.sub / 定时采样能同时覆盖「冻结」与「低频更新」两种语义。
 */
export function usePacedAtomValue<T>(atom: Atom<T>, mode: SessionPaneRenderMode, intervalMs = 1000): T {
	const store = useStore();
	// 连 atom 身份一起存：切会话时 atom 变了，必须同一帧换成新 atom 的当前值，
	// 否则会先闪一帧上一个会话的文本（effect 里的对齐发生在 paint 之后）。
	const [snapshot, setSnapshot] = useState<{ atom: Atom<T>; value: T }>(() => ({ atom, value: store.get(atom) }));
	if (snapshot.atom !== atom) {
		const next = store.get(atom);
		setSnapshot({ atom, value: next });
		return next;
	}
	useEffect(() => {
		// 值未变时保留原快照，避免 1s 采样在没有新内容时也触发一次渲染。
		const sync = () =>
			setSnapshot((previous) => {
				const next = store.get(atom);
				return Object.is(previous.value, next) ? previous : { atom, value: next };
			});
		// 切模式先对齐当前值：hidden 冻结在切换瞬间；background/active 立刻拿最新。
		sync();
		if (mode === "hidden") return;
		if (mode === "background") {
			const timer = window.setInterval(sync, intervalMs);
			return () => window.clearInterval(timer);
		}
		return store.sub(atom, sync);
	}, [atom, mode, store, intervalMs]);
	return snapshot.value;
}
