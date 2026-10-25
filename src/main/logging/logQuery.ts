import type { AppLogEntry, AppLogPage, AppLogQuery } from "../../shared/types";

/**
 * 日志查询纯函数：不依赖 electron/fs，AppLogger 只负责文件 IO，
 * 过滤/分页/日期范围收敛逻辑全部在此，便于 node --test 直接单测。
 */

export const LOG_FILE_PATTERN = /^app-(\d{4})-(\d{2})-(\d{2})\.log$/;

/** 单个日志文件读取行数防御上限：防畸形超大文件拖垮查询（正常按天日志远低于此） */
export const MAX_FILE_LINES = 200_000;

/** 默认每页条数 */
export const DEFAULT_PAGE_SIZE = 50;

function dayToMs(year: number, month: number, day: number): number {
	// 本地时区零点：与写入端 formatDate 的本地日期口径一致，避免时区偏移一天
	return new Date(year, month - 1, day).getTime();
}

/**
 * 按日期范围收敛需要读取的日志文件（文件名 app-YYYY-MM-DD.log）。
 * from/to 之外的日期文件直接跳过，避免全量读盘——时间筛选慢/查不到的根因之一。
 */
export function filterLogFiles(fileNames: string[], from?: number, to?: number): string[] {
	return fileNames
		.filter((name) => {
			const match = LOG_FILE_PATTERN.exec(name);
			if (!match) return false;
			const fileDay = dayToMs(Number(match[1]), Number(match[2]), Number(match[3]));
			if (from !== undefined && fileDay < from) return false;
			// to 取当天结束：选「到 8/9」应包含 8/9 整天
			if (to !== undefined && fileDay > dayToMs(new Date(to).getFullYear(), new Date(to).getMonth() + 1, new Date(to).getDate()) + 86_400_000 - 1) {
				return false;
			}
			return true;
		})
		.sort();
}

/** 解析单行 JSON；损坏行跳过（不中断整批查询）。 */
export function parseLogLine(line: string): AppLogEntry | null {
	try {
		const entry = JSON.parse(line) as AppLogEntry;
		if (!entry || typeof entry.id !== "string" || typeof entry.time !== "number") return null;
		return entry;
	} catch {
		return null;
	}
}

export type QueryResult = {
	total: number;
	entries: AppLogEntry[];
};

/**
 * 过滤 + 分页（时间倒序，最新在前）。
 * - 不截断历史：过滤发生在分页之前，任意时间范围的旧日志都能翻到；
 * - limit 兼容旧调用：不传 page 时取最近 limit 条（默认 500）。
 */
export function queryLogLines(lines: string[], query: AppLogQuery): QueryResult {
	const search = query.search?.trim().toLowerCase();
	const matches = (entry: AppLogEntry) => {
		if (query.from !== undefined && entry.time < query.from) return false;
		if (query.to !== undefined && entry.time > query.to) return false;
		if (query.level && query.level !== "all" && entry.level !== query.level) return false;
		if (search) {
			const haystack = `${entry.level} ${entry.scope} ${entry.message} ${JSON.stringify(entry.detail ?? "")}`.toLowerCase();
			if (!haystack.includes(search)) return false;
		}
		return true;
	};

	const matched: AppLogEntry[] = [];
	for (const line of lines) {
		const entry = parseLogLine(line);
		if (entry && matches(entry)) matched.push(entry);
	}
	// 倒序：最新在前，翻页看更早
	matched.reverse();

	// 分页模式：page 与 pageSize 同时为数字才走分页；否则兼容旧调用取最近 limit 条
	const pageSize = typeof query.pageSize === "number" ? Math.max(1, Math.min(query.pageSize, 200)) : 0;
	if (pageSize === 0) {
		const limit = Math.max(1, Math.min(query.limit ?? 500, 2000));
		return { total: matched.length, entries: matched.slice(0, limit) };
	}
	const page = Math.max(0, query.page ?? 0);
	const start = page * pageSize;
	return {
		total: matched.length,
		entries: matched.slice(start, start + pageSize),
	};
}

/** 将 queryLogLines 结果包装为分页结构（hasMore 由 total 与页码推导）。 */
export function toAppLogPage(result: QueryResult, page: number, pageSize: number): AppLogPage {
	return {
		entries: result.entries,
		total: result.total,
		page,
		pageSize,
		hasMore: (page + 1) * pageSize < result.total,
	};
}
