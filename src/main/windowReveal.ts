/**
 * 主窗口「唤起」策略：把用户最后一次选定的呈现态（最大化 / 原生全屏）在唤回时重新施加。
 *
 * 为什么需要它（实测 win32 + Electron 43，屏幕 2048×1152）：
 * - 「最大化 → minimize() → 只 show()+focus()」得到的窗口 isMaximized()===false，
 *   几何仍是 -7,-7 2064×1120（铺满屏但系统视为普通窗口）。这个「伪全屏」状态一旦被
 *   还原/拖动，就掉回 1522×857 的正常尺寸——用户看到的就是「点通知打开后窗口变小」。
 * - 全屏若只按最大化持久化，关窗即退出（closeToTray=false）后重启只剩最大化，
 *   用户看到的就是「之前是全屏，现在不是全屏了」。
 * 因此唤回统一为：先 restore 最小化，再按 intent 回填（最大化在 show 前、全屏在 show 后，
 * 避免首帧跳动与隐藏态 setFullScreen 被平台吞掉），最后 show + focus。
 *
 * 纯逻辑放在这里，真实窗口行为由 tests/windowRevealState.test.mjs 与
 * e2e/window-memory.spec.ts 钉住。
 */

export type MainWindowVisualIntent = "normal" | "maximized" | "fullscreen";

/** 窗口当前的原生状态；由调用方从 BrowserWindow 读，纯函数不碰 Electron。 */
export type MainWindowVisualState = {
	minimized: boolean;
	maximized: boolean;
	fullscreen: boolean;
};

export type MainWindowVisualEvent = "maximize" | "unmaximize" | "enter-full-screen" | "leave-full-screen";

export type MainWindowRevealPlan = {
	/** 最小化时需要 restore() 才能回到原来的呈现态（show() 单独不会恢复最大化）。 */
	restore: boolean;
	/** show() 之前 maximize()：避免从还原尺寸闪一下。 */
	maximizeBeforeShow: boolean;
	/** show() 之后 setFullScreen(true)：隐藏态的 setFullScreen 会被平台吞掉。 */
	fullscreenAfterShow: boolean;
};

/**
 * 窗口事件 → 新的呈现态意图。
 * 全屏期间 Windows 会连带发出 maximize/unmaximize，这时的意图仍是全屏，不能被改写成
 * 最大化或普通（否则关窗时会把「全屏」记成最大化）。
 */
export function nextMainWindowVisualIntent(intent: MainWindowVisualIntent, state: MainWindowVisualState, event: MainWindowVisualEvent): MainWindowVisualIntent {
	switch (event) {
		case "enter-full-screen":
			return "fullscreen";
		case "leave-full-screen":
			return state.maximized ? "maximized" : "normal";
		case "maximize":
			return state.fullscreen ? "fullscreen" : "maximized";
		case "unmaximize":
			return state.fullscreen ? "fullscreen" : "normal";
		default:
			return intent;
	}
}

/**
 * 计算一次唤回要做的几何动作。
 * e2e 下只做 restore（用例的几何基准与截屏不能被铺满屏打乱）。
 */
export function planMainWindowReveal(intent: MainWindowVisualIntent, state: MainWindowVisualState, options: { e2e?: boolean } = {}): MainWindowRevealPlan {
	const restore = state.minimized;
	if (options.e2e) return { restore, maximizeBeforeShow: false, fullscreenAfterShow: false };
	if (intent === "normal") return { restore, maximizeBeforeShow: false, fullscreenAfterShow: false };
	if (intent === "fullscreen") {
		// 全屏本身包含最大化：先 maximize 再进全屏，退出全屏时才能回到最大化而不是正常尺寸。
		return { restore, maximizeBeforeShow: !state.fullscreen && !state.maximized, fullscreenAfterShow: !state.fullscreen };
	}
	return { restore, maximizeBeforeShow: !state.maximized && !state.fullscreen, fullscreenAfterShow: false };
}
