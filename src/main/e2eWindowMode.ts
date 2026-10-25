/**
 * E2E（Playwright 驱动）窗口的「不打扰」摆放策略。
 *
 * 背景：每个 e2e 用例都会启动一个应用窗口。窗口即便用 showInactive 不抢键盘焦点，
 * 在 Windows 上仍会以新窗口身份出现在 z-order 最前；连续跑用例时窗口不断弹到用户桌面
 * 最前面，遮挡并打断其他工作。因此默认把窗口摆到屏幕外：窗口保持 visible、渲染活跃
 * （Playwright 的点击/断言/截图都基于页面，不依赖窗口在屏幕上的可见性），
 * 但用户桌面上什么都不会出现。
 *
 * 需要真实窗口几何/位置的用例（window-memory、quick-task 等）通过
 * `PIDECK_E2E_WINDOW_MODE=visible` 回到旧行为（可见但不抢焦点）。
 */

/** 屏幕外坐标：远离所有常见虚拟桌面范围（多屏虚拟桌面也到不了 -32000）。 */
export const E2E_OFFSCREEN_WINDOW_POSITION = { x: -32000, y: -32000 } as const;

export type E2EWindowPlacement = { mode: "visible" } | { mode: "offscreen"; position: { x: number; y: number } };

/** 解析 E2E 窗口摆放：默认屏幕外；PIDECK_E2E_WINDOW_MODE=visible 显式关闭。 */
export function resolveE2EWindowPlacement(isE2E: boolean, modeEnv: string | undefined): E2EWindowPlacement {
	if (!isE2E) return { mode: "visible" };
	if (modeEnv?.trim().toLowerCase() === "visible") return { mode: "visible" };
	return { mode: "offscreen", position: E2E_OFFSCREEN_WINDOW_POSITION };
}

/**
 * 屏幕外窗口会被 Windows 原生遮挡判定（CalculateNativeWinOcclusion）当成不可见，
 * 进而节流渲染与定时器（Playwright 点击/截图会超时或空白）。这些开关让渲染保持活跃；
 * "CalculateNativeWinOcclusion" 由调用方通过 disable-features 关闭。
 */
export const E2E_RENDERING_SWITCHES = ["disable-background-timer-throttling", "disable-renderer-backgrounding", "disable-backgrounding-occluded-windows"] as const;

/** 只依赖 setPosition/setSkipTaskbar 两个方法：单元测试可用普通对象替身。 */
export type E2EPlaceableWindow = {
	setPosition?: (x: number, y: number) => void;
	setSkipTaskbar?: (skip: boolean) => void;
};

/**
 * 应用摆放策略；任何一步失败（部分窗口管理器不支持负坐标/跳过任务栏）都静默忽略——
 * e2e 的可用性（能跑）优先于「不打扰」这个体验优化。
 */
export function applyE2EWindowPlacement(win: E2EPlaceableWindow, placement: E2EWindowPlacement): void {
	if (placement.mode !== "offscreen") return;
	try {
		win.setSkipTaskbar?.(true);
		win.setPosition?.(placement.position.x, placement.position.y);
	} catch {
		// 失败时保持 showInactive 的旧行为，不让 e2e 起不来。
	}
}
