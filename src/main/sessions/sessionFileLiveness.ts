import { existsSync } from "node:fs";

/**
 * 会话文件存在性（死链判定）TTL 缓存。
 *
 * 为什么需要（2027-02 性能审计）：catalog 列表 IPC 每次调用都对全部记录逐条
 * existsSync——几百条会话 ≈ 每次 5-30ms 的连续同步 stat（机械盘/杀毒 hook 下
 * 放大且抖动），而这条 handler 在切项目 / catalog-refreshed 事件时都会被重拉。
 * 存在性在这里只用于「最近会话不落到必然 ENOENT 的死链上」的过滤，
 * 2s 的陈旧窗口无害（文件恢复/删除最多延迟 2s 反映），后台 mergeScanned
 * 的清理闸仍是权威；写路径（编辑/删除/重发后的强制重载）不走这里。
 *
 * 只缓存本地盘符路径的判定；UNC/WSL/dsh/活运行时条目由调用方豁免，不会进来。
 */
const SESSION_FILE_LIVENESS_TTL_MS = 2_000;

/** 防陈旧键无界积累（会话文件路径数实际上限几百，删除的路径不再被查询后残留）。 */
const SESSION_FILE_LIVENESS_CACHE_MAX = 2_000;

const cache = new Map<string, { exists: boolean; expires: number }>();

/** 带 TTL 的存在性判定（测试可注入时钟）。 */
export function sessionFileExistsCached(filePath: string, now: number = Date.now()): boolean {
	const cached = cache.get(filePath);
	if (cached && cached.expires > now) return cached.exists;
	const exists = existsSync(filePath);
	if (cache.size >= SESSION_FILE_LIVENESS_CACHE_MAX) cache.clear();
	cache.set(filePath, { exists, expires: now + SESSION_FILE_LIVENESS_TTL_MS });
	return exists;
}

/** 清空缓存（测试隔离用）。 */
export function clearSessionFileLivenessCache(): void {
	cache.clear();
}
