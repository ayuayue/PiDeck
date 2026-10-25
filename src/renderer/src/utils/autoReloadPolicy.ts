/**
 * 崩溃自动刷新策略（纯函数，离开 React 可单测）。
 *
 * 背景：渲染层偶发崩溃（React 渲染异常/页面崩溃）时，自动刷新页面通常能恢复，
 * 但个别稳定复现的 bug 会让「刷新→再崩」死循环。策略：
 * - 连续崩溃（时间窗口内）累计次数，达到上限后停止自动刷新，改显示崩溃页
 *   让用户手动操作（此时自动刷新已证明不可行）；
 * - 时间窗口外首次崩溃重新计数（正常使用一段时间后再崩，允许再次自动刷新）。
 */

/** 崩溃自动刷新的计数存储键（sessionStorage：页面刷新后仍保留，同一窗口会话内共享）。 */
export const CRASH_AUTO_RELOAD_KEY = "pideck:crash-auto-reload";
/** 「短时间内」判定窗口：窗口内连续崩溃才累计，超过则视为新的一轮。 */
export const CRASH_AUTO_RELOAD_WINDOW_MS = 60_000;
/** 自动刷新尝试上限：达到后不再自动刷新（第 4 次崩溃起停止）。 */
export const MAX_AUTO_RELOAD_ATTEMPTS = 3;

export type CrashReloadPlan = {
	/** 窗口内累计崩溃次数（含本次） */
	count: number;
	/** 是否继续自动刷新 */
	shouldAutoReload: boolean;
};

/**
 * 计算本次崩溃的自动刷新决策。
 * @param stored 上次存储的计数（{count, at}）；无存储/解析失败传 null 视为首次。
 * @param now 当前时间戳（测试注入固定值）。
 */
export function computeCrashReloadPlan(params: { stored: { count: number; at: number } | null; now: number }): CrashReloadPlan {
	const { stored, now } = params;
	// 窗口内（距上次崩溃 < 60s）继续累计；窗口外或首次 → 重置为 1。
	const withinWindow = stored !== null && now - stored.at < CRASH_AUTO_RELOAD_WINDOW_MS;
	const count = withinWindow ? stored.count + 1 : 1;
	// 第 1~3 次崩溃各自触发一次自动刷新；第 4 次起停止（刷新 3 次仍失败 = 不可行）。
	return { count, shouldAutoReload: count <= MAX_AUTO_RELOAD_ATTEMPTS };
}
