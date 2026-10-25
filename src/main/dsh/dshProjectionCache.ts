import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 只读解析 DSH 官方投影缓存里的会话标题。
 *
 * 权威落点：`$DSH_HOME/storages/session_projcache.json`
 * （`@deepseek-ai/dsh-session-projection-cache` 的 `session_projcache` 域）。
 * dsh-web 侧栏标题来自这里的 `tables.sessions[id].rows.title.val`，
 * 会话 header 本身没有 title。
 *
 * 只读、失败跳过：扫描路径不启动 host、不写缓存、不 attach。
 * 写回只走官方 `@deepseek-ai/dsh-session-projection-cache`（host 挂载后
 * turn/end / dispose / coldSnapshot），禁止手写这份 JSON。
 */

export const DSH_PROJECTION_CACHE_RELATIVE = join("storages", "session_projcache.json");

/** 读取上界（稳定性约束 3：会话扫描要有大小上限）：标题是增强数据，超限（损坏/
 *  外部异常增长）宁整块跳过，让扫描回退既有的「日志折叠取标题」路径；无界整读
 *  会在后台扫描路径制造主进程内存尖峰（对齐 SessionScanner 的上界体系与生图
 *  BLOB 读取上界修复，同一事故模式）。正常缓存每记录 ~1KB，32MB 已足够宽裕。 */
export const DSH_PROJECTION_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** 从一条缓存记录取出非空 title；结构不对或空白视为缺失。 */
export function titleFromProjectionRecord(record: unknown): string | undefined {
	if (!record || typeof record !== "object") return undefined;
	const rows = (record as { rows?: unknown }).rows;
	if (!rows || typeof rows !== "object") return undefined;
	const titleRow = (rows as { title?: unknown }).title;
	if (!titleRow || typeof titleRow !== "object") return undefined;
	const value = (titleRow as { val?: unknown }).val;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

/**
 * 解析整份 session_projcache JSON 文本 → sessionId → title。
 * 缺表、坏 JSON、非对象行都跳过，不抛给扫描调用方。
 */
export function parseProjectionTitles(raw: string): Map<string, string> {
	const titles = new Map<string, string>();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return titles;
	}
	if (!parsed || typeof parsed !== "object") return titles;
	const tables = (parsed as { tables?: unknown }).tables;
	if (!tables || typeof tables !== "object") return titles;
	const sessions = (tables as { sessions?: unknown }).sessions;
	if (!sessions || typeof sessions !== "object") return titles;
	for (const [sessionId, record] of Object.entries(sessions as Record<string, unknown>)) {
		if (!sessionId.trim()) continue;
		const title = titleFromProjectionRecord(record);
		if (title) titles.set(sessionId, title);
	}
	return titles;
}

/** 读 DSH_HOME 上的官方投影缓存标题（文件缺失/超限/不可读 = 空表）。 */
export function readSessionProjectionTitles(dshHome: string): Map<string, string> {
	const filePath = join(dshHome, DSH_PROJECTION_CACHE_RELATIVE);
	if (!existsSync(filePath)) return new Map();
	try {
		// 先 stat 后读：超限文件连读都不读（与生图 BLOB 读取同防御）。TOCTOU 窗口内
		// 文件被替换大文件时由 readFileSync 自身异常兑底，同样落在空表分支。
		if (statSync(filePath).size > DSH_PROJECTION_CACHE_MAX_BYTES) return new Map();
		return parseProjectionTitles(readFileSync(filePath, "utf8"));
	} catch {
		return new Map();
	}
}
