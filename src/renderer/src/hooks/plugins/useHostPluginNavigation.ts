import { useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { desktopApi } from "../../desktopApi";
import { hostPluginPanelAtom } from "../../atoms/host-plugin-atoms";
import { planRevealAttempt, REVEAL_TIMELINE_ENTRY_EVENT, REVEAL_TIMELINE_ENTRY_POLL_MS } from "../timeline/timelineRevealChannel";

/**
 * 时间线消息锚点选择器（纯函数，可单测）：时间线节点以 data-message-id 暴露稳定锚点
 * （划选引用同一契约，见 AnswerOutput.tsx / ExtensionEntryCard.tsx）。属性值手动转义
 * `"` 与 `\`，不依赖浏览器专属的 CSS.escape，测试环境可直接断言。
 */
export function timelineEntrySelector(entryId: string): string {
	const escaped = entryId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `[data-message-id="${escaped}"]`;
}

/**
 * 事件名、轮询常量与决策纯函数定义在无依赖模块（timelineRevealChannel）：时间线组件
 * 需要事件名，但不能因此把本 hook 的依赖链（desktopApi → browserApi 在模块求值时读
 * window.location.search）拖进时间线的单测沙箱。这里 re-export 保持本 hook 的公开面不变。
 */
export { planRevealAttempt, REVEAL_TIMELINE_ENTRY_EVENT, REVEAL_TIMELINE_ENTRY_POLL_MS, REVEAL_TIMELINE_ENTRY_TIMEOUT_MS, type RevealAttemptPlan } from "../timeline/timelineRevealChannel";

/** 在历史会话加载完成前轮询定位；多次导航只保留最后一次。 */
function revealTimelineEntry(entryId: string, sessionId: string): () => void {
	const selector = timelineEntrySelector(entryId);
	const startedAt = Date.now();
	let eventDispatched = false;
	/** 上次派发时刻：监听方可能晚于首次派发才挂载（会话正在切换），按间隔重派。 */
	let lastDispatchAt = 0;
	let timer = 0;
	const attempt = () => {
		const node = document.querySelector(selector);
		const now = Date.now();
		const plan = planRevealAttempt({ found: Boolean(node), eventDispatched, elapsedMs: now - startedAt, sinceDispatchMs: eventDispatched ? now - lastDispatchAt : undefined });
		if (plan.action === "dispatch") {
			eventDispatched = true;
			lastDispatchAt = now;
			// 只走渲染层事件，不加主进程 IPC：虚拟区外的行由时间线监听方 jumpToMessage 挂出来。
			// 事件可安全重复派发：jumpToMessage 幂等，命中已挂载行时只是重新落位。
			window.dispatchEvent(new CustomEvent(REVEAL_TIMELINE_ENTRY_EVENT, { detail: { entryId, sessionId } }));
		}
		if (plan.action === "scroll" && node) node.scrollIntoView({ behavior: "smooth", block: "center" });
		// 超时只停本 hook 的轮询：冷会话里跳转已挂起到 controller 的 pendingJump，
		// 数据到达后由它自行落位，不会因为这里 4s 到期而丢失。
		if (plan.keepPolling) timer = window.setTimeout(attempt, REVEAL_TIMELINE_ENTRY_POLL_MS);
	};
	timer = window.setTimeout(attempt, 60);
	return () => window.clearTimeout(timer);
}

/**
 * 插件发起的会话导航：broker 已校验权限与项目归属，桌面帧负责执行选中与定位。
 * 会话选择回调由 App 层注入（复用 useSessionActions 的 selectSession，避免第二条选中路径）。
 */
export function useHostPluginNavigation(selectSession: (projectId: string, sessionId: string, scrollToEnd?: boolean) => void, openInBrowser: (url: string) => void) {
	const select = useRef(selectSession);
	select.current = selectSession;
	const openBrowser = useRef(openInBrowser);
	openBrowser.current = openInBrowser;
	// setter 由 jotai 保证引用稳定，无需 ref 包装。
	const closePanel = useSetAtom(hostPluginPanelAtom);
	useEffect(() => {
		let cancelReveal: (() => void) | undefined;
		const unsubscribe = desktopApi.hostPlugins.onNavigate((input) => {
			cancelReveal?.();
			// 带 entryId 时不自动滚到底部，避免与定位滚动互相打架。
			select.current(input.projectId, input.sessionId, input.entryId === undefined);
			if (input.entryId !== undefined) cancelReveal = revealTimelineEntry(input.entryId, input.sessionId);
		});
		// 本地服务的 Web UI 同样由桌面帧打开：地址来自主进程适配器（已收口到回环），插件页拿不到也改不了。
		// 面板（modal 遮罩 / page 覆盖层）必须同时让位，否则刚打开的浏览器抽屉会被遮罩盖住。
		const unsubscribeOpenBrowser = desktopApi.hostPlugins.onOpenBrowser((url) => {
			closePanel(null);
			openBrowser.current(url);
		});
		return () => {
			unsubscribe();
			unsubscribeOpenBrowser();
			cancelReveal?.();
		};
	}, [closePanel]);
}
