import { useEffect } from "react";
import { dismissBootOverlay } from "../../utils/bootOverlay";

/**
 * 开屏遮罩的撤除时机（启动交接）：内容就绪立刻撤；未就绪最多再等 graceMs。
 *
 * 为什么需要宽限：渲染层无法区分「会话还没恢复完」和「确实没有会话可恢复」——
 * 两种情况下首帧都是空。异步恢复通常在 200ms 内落地（实测挂载后约 205ms 触发
 * 首次 focus），宽限期让它在空态被暴露之前先到；宽限到点仍未就绪，则说明本次
 * 启动确实没有会话要恢复（空态/引导页就是正确内容），照常撤除。
 *
 * 宽限期只影响「无会话可恢复」这一种情况（耗时更长会拖慢首屏），所以取得较短；
 * 启动异常导致本 hook 永不触发的兜底超时在 main.tsx。
 */
export function useBootOverlayReady(contentReady: boolean, graceMs = 600): void {
	useEffect(() => {
		if (contentReady) {
			dismissBootOverlay();
			return;
		}
		const timer = window.setTimeout(dismissBootOverlay, graceMs);
		return () => window.clearTimeout(timer);
	}, [contentReady, graceMs]);
}
