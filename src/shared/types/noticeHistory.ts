/**
 * toast 通知历史跨进程契约。
 *
 * 数据源是持久化文件 `userData/notice-history.json`，主进程 NoticeHistoryStore 读写；
 * 渲染层 showNotice 单点记录后经 IPC 推送主进程落盘，启动时回灌渲染层环形缓冲。
 * 渲染层模块自增 id（React list key）不落盘——落盘条目以 timestamp + 内容为身份，
 * hydrate 时由渲染层重新编号。
 */

/** 通知档位：与渲染层 NoticeKind 一致，外加无 kind 调用共用的 neutral 档。 */
export const NOTICE_HISTORY_KINDS = ["info", "error", "warning", "question", "neutral"] as const;

export type NoticeHistoryKind = (typeof NOTICE_HISTORY_KINDS)[number];

/** 单条记录入参：showNotice 记录环形缓冲与推送主进程共用同一形状。 */
export type NoticeHistoryRecordInput = {
	/** 主文案（卡片标题位） */
	title: string;
	/** 描述（有标题时的正文部分） */
	description?: string;
	kind: NoticeHistoryKind;
	/** 生效时长（ms）；Number.POSITIVE_INFINITY = 常驻（落盘编码为 -1，JSON 无穷大不可序列化） */
	duration: number;
};

/** 落盘条目：不含渲染层模块 id。 */
export type NoticeHistoryFileEntry = {
	timestamp: number;
	kind: NoticeHistoryKind;
	title: string;
	description?: string;
	duration: number;
};

export type NoticeHistoryFile = { version: typeof NOTICE_HISTORY_FILE_VERSION; entries: NoticeHistoryFileEntry[] };

export const NOTICE_HISTORY_FILE_VERSION = 1;

/** 条数封顶：渲染层环形缓冲与落盘文件共用同一上限（超出丢最旧）。 */
export const NOTICE_HISTORY_MAX_ENTRIES = 200;

/** 文案长度上限：超长截断而非拒收——历史记录不能因为文案长而丢事实。 */
export const NOTICE_HISTORY_TITLE_MAX_CHARS = 2000;
export const NOTICE_HISTORY_DESCRIPTION_MAX_CHARS = 8000;

/** 常驻档在文件中的编码（JSON 无法表达 Infinity，用 -1 哨兵）。 */
export const NOTICE_HISTORY_STICKY_DURATION_ENCODING = -1;
