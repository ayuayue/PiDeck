import { canonicalizeRoots } from "./localImageAccess";
import { nativeRealpath } from "./nativeRealpath";

/**
 * 白名单根的「规范化 + 短时缓存」提供者（协议与 IPC 共用一份）。
 *
 * 背景：
 * - 每次图片请求都要拿真实的根目录做边界判定，而 `realpathSync.native` 是**同步**
 *   系统调用；一条消息里几十张图 × 十几个项目根 = 主进程被反复阻塞（2026-10-20 review）。
 * - 规范化不能省：Windows 上 `app.getPath("temp")` 返回 8.3 短名，与消息里的长名路径
 *   字面不等（2026-10-19 真机事故）。
 *
 * 因此缓存规范化结果 `ttlMs`（默认 5s）：新增/删除项目最多延迟 5 秒生效，代价可接受。
 */
export type CanonicalRootsProvider = () => Promise<string[]>;

export type CanonicalRootsOptions = {
	/** 缓存有效期（毫秒），默认 5s。 */
	ttlMs?: number;
	/** 时钟注入（测试用）。 */
	now?: () => number;
	/** 真实路径解析注入（测试用，生产是 nativeRealpath；失败返回 null → 保留原值）。 */
	realpath?: (path: string) => string | null;
};

export function createCanonicalRootsProvider(resolveRoots: () => readonly string[], options: CanonicalRootsOptions = {}): CanonicalRootsProvider {
	const ttlMs = options.ttlMs ?? 5_000;
	const now = options.now ?? Date.now;
	const realpath =
		options.realpath ??
		((path: string) => {
			try {
				return nativeRealpath(path);
			} catch {
				return null;
			}
		});
	let cached: { at: number; roots: string[] } | null = null;
	let inFlight: Promise<string[]> | null = null;

	return async () => {
		const timestamp = now();
		if (cached && timestamp - cached.at < ttlMs) return cached.roots;
		// 并发请求合并成一次规范化（首屏几十张图同时请求时不会各自跑一遍）
		if (inFlight) return inFlight;
		inFlight = canonicalizeRoots(resolveRoots(), async (root) => realpath(root) ?? root)
			.then((roots) => {
				cached = { at: now(), roots };
				return roots;
			})
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	};
}
