import { useEffect, useRef } from "react";
import { desktopApi } from "../../desktopApi";

/**
 * 时间线消息锚点选择器（纯函数，可单测）：时间线节点以 data-message-id 暴露稳定锚点
 * （划选引用同一契约，见 AnswerOutput.tsx / ExtensionEntryCard.tsx）。属性值手动转义
 * `"` 与 `\`，不依赖浏览器专属的 CSS.escape，测试环境可直接断言。
 */
export function timelineEntrySelector(entryId: string): string {
	const escaped = entryId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `[data-message-id="${escaped}"]`;
}

/** 在历史会话加载完成前轮询定位；多次导航只保留最后一次。 */
function revealTimelineEntry(entryId: string): () => void {
	const selector = timelineEntrySelector(entryId);
	const startedAt = Date.now();
	let timer = 0;
	const attempt = () => {
		const node = document.querySelector(selector);
		if (node) {
			node.scrollIntoView({ behavior: "smooth", block: "center" });
			return;
		}
		// 历史会话冷加载（读取 + 渲染）可能超过单帧，超时即放弃，不阻塞也不报错。
		if (Date.now() - startedAt < 4000) timer = window.setTimeout(attempt, 120);
	};
	timer = window.setTimeout(attempt, 60);
	return () => window.clearTimeout(timer);
}

/**
 * 插件发起的会话导航：broker 已校验权限与项目归属，桌面帧负责执行选中与定位。
 * 会话选择回调由 App 层注入（复用 useSessionActions 的 selectSession，避免第二条选中路径）。
 */
export function useHostPluginNavigation(selectSession: (projectId: string, sessionId: string, scrollToEnd?: boolean) => void) {
	const select = useRef(selectSession);
	select.current = selectSession;
	useEffect(() => {
		let cancelReveal: (() => void) | undefined;
		const unsubscribe = desktopApi.hostPlugins.onNavigate((input) => {
			cancelReveal?.();
			// 带 entryId 时不自动滚到底部，避免与定位滚动互相打架。
			select.current(input.projectId, input.sessionId, input.entryId === undefined);
			if (input.entryId !== undefined) cancelReveal = revealTimelineEntry(input.entryId);
		});
		return () => {
			unsubscribe();
			cancelReveal?.();
		};
	}, []);
}
