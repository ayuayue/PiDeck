/**
 * 通知历史纯函数：入参清洗 + 落盘编解码。
 *
 * 只做数据变换，无 Node/Electron/渲染层依赖，主进程与单测共用同一份规则：
 * - 清洗策略「保事实」：档位非法归为 neutral、文案超长截断，只有缺主文案才整条丢弃；
 * - 常驻时长（Infinity）落盘编码为 -1 哨兵，读取时还原——JSON 无法序列化 Infinity。
 */
import { NOTICE_HISTORY_DESCRIPTION_MAX_CHARS, NOTICE_HISTORY_FILE_VERSION, NOTICE_HISTORY_KINDS, NOTICE_HISTORY_STICKY_DURATION_ENCODING, NOTICE_HISTORY_TITLE_MAX_CHARS, type NoticeHistoryFile, type NoticeHistoryFileEntry, type NoticeHistoryKind, type NoticeHistoryRecordInput } from "./types/noticeHistory";

const KIND_SET: ReadonlySet<string> = new Set(NOTICE_HISTORY_KINDS);

function clampText(value: unknown, maxChars: number): string {
	return typeof value === "string" ? value.slice(0, maxChars) : "";
}

/**
 * 清洗一条来自渲染层的记录；缺主文案或时长不合法时返回 null（调用方丢弃并记日志）。
 * 描述为空串时归一为 undefined，避免文件里出现无意义的空字段。
 */
export function sanitizeNoticeHistoryRecord(input: unknown): NoticeHistoryRecordInput | null {
	if (!input || typeof input !== "object") return null;
	const raw = input as Record<string, unknown>;
	const title = clampText(raw.title, NOTICE_HISTORY_TITLE_MAX_CHARS);
	if (!title.trim()) return null;
	// 时长只接受非负有限数或常驻哨兵 Infinity；NaN 因所有比较为 false 必须显式排除
	if (typeof raw.duration !== "number" || (!Number.isFinite(raw.duration) && raw.duration !== Number.POSITIVE_INFINITY) || raw.duration < 0) return null;
	const description = clampText(raw.description, NOTICE_HISTORY_DESCRIPTION_MAX_CHARS);
	const kind: NoticeHistoryKind = KIND_SET.has(raw.kind as string) ? (raw.kind as NoticeHistoryKind) : "neutral";
	return {
		title,
		description: description || undefined,
		kind,
		duration: raw.duration,
	};
}

/** 带时间戳的完整记录（store 收到时打点，落盘/展示共用）。 */
export type NoticeHistoryDatedEntry = NoticeHistoryRecordInput & { timestamp: number };

/** 落盘编码：常驻时长 → -1 哨兵，其余按毫秒原样存。 */
export function toNoticeHistoryFileEntry(entry: NoticeHistoryDatedEntry): NoticeHistoryFileEntry {
	return {
		timestamp: entry.timestamp,
		kind: entry.kind,
		title: entry.title,
		description: entry.description,
		duration: entry.duration === Number.POSITIVE_INFINITY ? NOTICE_HISTORY_STICKY_DURATION_ENCODING : entry.duration,
	};
}

/** 落盘解码：-1 哨兵 → 常驻；结构不合法的条目直接丢弃（坏一条不坏整份）。 */
export function fromNoticeHistoryFileEntry(raw: unknown): NoticeHistoryFileEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	const title = clampText(record.title, NOTICE_HISTORY_TITLE_MAX_CHARS);
	if (!title.trim()) return null;
	if (typeof record.timestamp !== "number" || !Number.isFinite(record.timestamp)) return null;
	const duration = record.duration;
	if (typeof duration !== "number" || (!Number.isFinite(duration) && duration !== NOTICE_HISTORY_STICKY_DURATION_ENCODING)) return null;
	const description = clampText(record.description, NOTICE_HISTORY_DESCRIPTION_MAX_CHARS);
	const kind: NoticeHistoryKind = KIND_SET.has(record.kind as string) ? (record.kind as NoticeHistoryKind) : "neutral";
	return {
		timestamp: record.timestamp,
		kind,
		title,
		description: description || undefined,
		duration: duration === NOTICE_HISTORY_STICKY_DURATION_ENCODING ? Number.POSITIVE_INFINITY : duration,
	};
}

/** 解析整份文件内容；顶层结构不对返回 null（调用方按「不可识别」处理）。 */
export function parseNoticeHistoryFile(text: string): NoticeHistoryFile | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const raw = parsed as Record<string, unknown>;
	if (raw.version !== NOTICE_HISTORY_FILE_VERSION || !Array.isArray(raw.entries)) return null;
	const entries = raw.entries.map(fromNoticeHistoryFileEntry).filter((entry): entry is NoticeHistoryFileEntry => entry !== null);
	return { version: NOTICE_HISTORY_FILE_VERSION, entries };
}
