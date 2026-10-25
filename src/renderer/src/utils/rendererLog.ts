/**
 * 渲染层 → 主进程应用日志（userData/logs，设置 → 日志可查）。
 *
 * 用于记录「后台功能为什么什么都没发生」这类无声决策（如输入预测没触发）；
 * 不属于用户可见提示，因此不弹 toast、不做频率限制，由调用方自己克制。
 * 没有预加载（浏览器预览 / LAN 网页 / 旧 preload）时静默丢弃：日志绝不能反过来影响功能。
 */
export function logFromRenderer(level: "debug" | "info" | "warn" | "error", scope: string, message: string, detail?: unknown): void {
	try {
		const pending = window.piDesktop?.app?.rendererLog?.(level, scope, message, detail);
		if (pending && typeof pending.catch === "function") pending.catch(() => undefined);
	} catch {
		// 没有日志通道是允许的状态（非 Electron 运行时），吞掉即可。
	}
}
