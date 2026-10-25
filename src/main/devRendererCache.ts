/**
 * dev 态渲染层缓存护栏（只作用于未打包的 `npm run dev`，调用点见 `createWindow`）。
 *
 * 要防的问题：Vite 给预构建依赖打的是 `Cache-Control: max-age=31536000, immutable`，
 * 缓存键只有「URL + `?v=browserHash`」，而 browserHash 由 lockfile 与配置推导，
 * 重新预构建改变 chunk 切分时它可以不变——同一个 URL 在磁盘上换了内容，Chromium 却
 * 认定缓存仍新鲜，返回旧副本；旧副本 import 的那个 chunk 已经被本轮预构建删掉，
 * Vite 对它回 504（outdated optimize dep），于是动态 import 抛
 * `Failed to fetch dynamically imported module`。又因为请求根本没出网络，
 * Vite 收到 504 后触发 full-reload 的自愈路径也不会发生。
 * 收口点只能在加载 renderer 之前：先把默认 session 的 HTTP 缓存与编译缓存清空。
 *
 * 逃生开关：`PIDECK_DEV_KEEP_HTTP_CACHE=1` 跳过清理（想保留 dev 态登录态/排查冷启动时用）。
 */

/** 关掉护栏的环境变量名，值按 truthy 解释（`1` / `true`）。 */
export const KEEP_DEV_HTTP_CACHE_ENV = "PIDECK_DEV_KEEP_HTTP_CACHE";

/** 只声明本模块用到的 session 能力：便于单测注入替身，也不把本模块绑死在 Electron 运行时上。 */
export type RendererCacheSession = {
	clearCache(): Promise<void>;
	clearCodeCaches(options: { urls?: string[] }): Promise<void>;
};

function isTruthyFlag(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
}

/** 护栏开关判定（纯函数）：置了保留标记就整体跳过。 */
export function shouldClearDevRendererCache(keepHttpCacheFlag: string | undefined): boolean {
	return !isTruthyFlag(keepHttpCacheFlag);
}

/**
 * 清掉默认 session 的 HTTP 缓存与全部 JS 编译缓存（`urls: []` = 全清，chunk URL 每轮都变，无法逐条指定）。
 * fail-safe：清理失败只记录、不抛——挡住宿主窗口创建比留着过期缓存严重得多。
 */
export async function clearDevRendererCache(input: { session: RendererCacheSession; keepHttpCacheFlag?: string; onLog: (outcome: "cleared" | "skipped" | "failed", detail?: unknown) => void }): Promise<void> {
	if (!shouldClearDevRendererCache(input.keepHttpCacheFlag)) {
		input.onLog("skipped");
		return;
	}
	try {
		await input.session.clearCache();
		await input.session.clearCodeCaches({ urls: [] });
		input.onLog("cleared");
	} catch (error) {
		input.onLog("failed", error);
	}
}
