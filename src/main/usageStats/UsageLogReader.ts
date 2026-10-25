/**
 * usage.jsonl 游标增量读取器。
 *
 * 游标 = { size, mtimeMs, ino, count }，以 append-only 为前提：
 *  - size 相同 → 无新增，空增量
 *  - size 变大 → 只读新增字节段（createReadStream start 偏移）
 *  - size 变小 / ino 变化 / 无游标 → 全量重扫（截断/重写安全）
 *
 * 行切分严格按 LF（U+2028/U+2029 在 JSON 字符串内合法，不得拆行），
 * 行尾 \r 剥离（兼容 CRLF）。坏行跳过并计数，不中断。
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { UsageRecord } from "../../shared/types/usageStats";
import { parseUsageLogLine } from "./usageLogParser.ts";

/** 单行解析器：坏行返回 null，由读取层计数跳过。 */
export type UsageLineParser = (line: string) => UsageRecord | null;

/** 游标：上次读取结束时的文件状态。 */
export type LogFileState = {
	size: number;
	mtimeMs: number;
	/** 跨平台 inode（Windows 亦可用），检测同名文件被替换 */
	ino?: number;
	/** 已累计解析的唯一记录数 */
	count: number;
};

export type IncrementalReadResult = {
	/** 本次新解析出的记录（本次读取范围内已去重） */
	newRecords: UsageRecord[];
	/** 本次是否全量重扫 */
	fullRescan: boolean;
	/** 读取后的游标；文件不存在为 null */
	fileState: LogFileState | null;
	/** 坏行数（JSON/结构非法） */
	skippedLines: number;
	/** 文件超过读取上限被截断（数据不完整，调用方应告警） */
	truncated: boolean;
};

export type UsageLogReaderOptions = {
	/** 读流块大小（测试用小值强制跨块行） */
	highWaterMark?: number;
	/** 单次读取字节上限：防御日志失控导致的全量读 OOM（超限截读并标记 truncated） */
	maxBytes?: number;
	/** 行解析器（默认 pi-tracker 数组行；dsh-bill 传入对象行解析） */
	parseLine?: UsageLineParser;
};

/** 日志失控防御上限：单次读取超过即截断（设计文档 §7 性能预算）。 */
export const DEFAULT_MAX_LOG_BYTES = 256 * 1024 * 1024;

function isMissingFileError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

/** 解码一行：剥离行尾 \r（CRLF 兼容），按 utf8 还原。 */
function decodeLine(buffer: Buffer): string {
	const content = buffer.length > 0 && buffer[buffer.length - 1] === 0x0d ? buffer.subarray(0, buffer.length - 1) : buffer;
	return content.toString("utf8");
}

/** 严格 LF 行切分：跨 chunk 片段缓冲，U+2028/2029 不拆行。 */
async function* physicalLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
	let fragments: Buffer[] = [];
	let fragmentsBytes = 0;
	for await (const chunk of stream) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		let start = 0;
		let newline = buffer.indexOf(0x0a);
		while (newline !== -1) {
			const fragment = buffer.subarray(start, newline);
			const lineBuffer = fragments.length === 0 ? fragment : Buffer.concat([...fragments, fragment], fragmentsBytes + fragment.length);
			fragments = [];
			fragmentsBytes = 0;
			yield decodeLine(lineBuffer);
			start = newline + 1;
			newline = buffer.indexOf(0x0a, start);
		}
		if (start < buffer.length) {
			fragments.push(Buffer.from(buffer.subarray(start)));
			fragmentsBytes += buffer.length - start;
		}
	}
	if (fragmentsBytes > 0) {
		yield decodeLine(Buffer.concat(fragments, fragmentsBytes));
	}
}

export class UsageLogReader {
	private readonly highWaterMark: number;
	private readonly maxBytes: number;
	private readonly parseLine: UsageLineParser;

	constructor(options: UsageLogReaderOptions = {}) {
		this.highWaterMark = options.highWaterMark ?? 64 * 1024;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
		this.parseLine = options.parseLine ?? parseUsageLogLine;
	}

	/**
	 * 增量读取：返回本次新增记录与更新后的游标。
	 * 文件不存在返回 fileState=null（调用方视为「未安装」）。
	 */
	async readIncremental(logPath: string, prev: LogFileState | null): Promise<IncrementalReadResult> {
		let fileStat;
		try {
			fileStat = await stat(logPath);
		} catch (error) {
			if (isMissingFileError(error)) {
				return { newRecords: [], fullRescan: false, fileState: null, skippedLines: 0, truncated: false };
			}
			throw error;
		}

		const inodeChanged = prev !== null && prev.ino !== undefined && prev.ino !== fileStat.ino;
		const fullRescan =
			!prev ||
			fileStat.size < prev.size ||
			inodeChanged ||
			// 同尺寸原地重写（mtime 变化）也重扫：append-only 假设之外的防御
			(fileStat.size === prev.size && fileStat.mtimeMs !== prev.mtimeMs);
		// 无变化：size 与 mtime 均相同且非全量重扫场景返回空增量（prev 此时必非 null）
		if (prev && !fullRescan && fileStat.size === prev.size && fileStat.mtimeMs === prev.mtimeMs) {
			return { newRecords: [], fullRescan: false, fileState: prev, skippedLines: 0, truncated: false };
		}

		// 超限截读：防御日志失控（正常增量读只涉及新增段，超限只可能出现在全量重扫）
		const truncated = fileStat.size > this.maxBytes;
		const endOffset = truncated ? this.maxBytes - 1 : undefined;
		const startOffset = fullRescan || !prev ? 0 : prev.size;
		const stream = createReadStream(logPath, {
			start: startOffset,
			end: endOffset,
			highWaterMark: this.highWaterMark,
		});

		const newRecords: UsageRecord[] = [];
		const seenKeys = new Set<string>();
		let skippedLines = 0;

		for await (const line of physicalLines(stream)) {
			if (!line.trim()) continue;
			const record = this.parseLine(line);
			if (!record) {
				skippedLines++;
				continue;
			}
			// 本次读取范围内去重（防御：文件被非 append 方式改写造成段内重复）
			const key = `${record.ts}|${record.sid}|${record.model}`;
			if (seenKeys.has(key)) continue;
			seenKeys.add(key);
			newRecords.push(record);
		}

		return {
			newRecords,
			fullRescan,
			truncated,
			fileState: {
				size: fileStat.size,
				mtimeMs: fileStat.mtimeMs,
				ino: fileStat.ino,
				count: fullRescan ? newRecords.length : (prev ? prev.count : 0) + newRecords.length,
			},
			skippedLines,
		};
	}
}
