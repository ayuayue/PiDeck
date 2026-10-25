/**
 * toast 通知历史持久化（`userData/notice-history.json`）。
 *
 * 背景：通知历史原本只存渲染层内存环形缓冲，重启即清空，用户错过扩展 ctx.ui.notify
 * 的提示后无从追溯。现在渲染层 showNotice 单点记录后经 IPC 推送这里落盘，启动时回灌。
 *
 * 边界：
 * - 主进程内存数组是唯一累积点，防抖写盘（toast 高频连发时合并为一次 IO）；
 * - 条数封顶 NOTICE_HISTORY_MAX_ENTRIES（与渲染层环形缓冲同一上限），超出丢最旧；
 * - 原子写（tmp → renameWithRetry），损坏处理从宽：文件只由本模块写，解析失败记日志返回
 *   空历史即可，下一次成功写入自然覆盖，不做 .bak 备份（低价值数据，备份只会堆垃圾文件）；
 * - 不依赖 electron：文件路径由装配层注入，单测可直接用临时目录。
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import { NOTICE_HISTORY_FILE_VERSION, NOTICE_HISTORY_MAX_ENTRIES, type NoticeHistoryFile, type NoticeHistoryFileEntry } from "../../shared/types/noticeHistory";
import { parseNoticeHistoryFile, sanitizeNoticeHistoryRecord, toNoticeHistoryFileEntry, type NoticeHistoryDatedEntry } from "../../shared/noticeHistory";
import { renameWithRetry } from "../utils/fsRetry";

/** 防抖写盘窗口：连发 toast 合并为一次写。 */
const FLUSH_DEBOUNCE_MS = 500;

export class NoticeHistoryStore {
	private entries: NoticeHistoryDatedEntry[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private writeInProgress: Promise<void> = Promise.resolve();

	constructor(
		private readonly deps: {
			/** 落盘文件绝对路径（主进程用 userData/notice-history.json，测试注入临时文件） */
			getFilePath: () => string;
			/** 日志出口：装配处接 appLogger.info/error */
			log: (level: "info" | "error", message: string, detail?: unknown) => void;
		},
	) {}

	/** 读取全部历史（设置页展示与渲染层启动回灌用）。每次读盘：文件是唯一持久事实，内存数组只服务追加路径。 */
	async load(): Promise<NoticeHistoryFileEntry[]> {
		let text: string;
		try {
			text = await readFile(this.deps.getFilePath(), "utf8");
		} catch {
			return []; // 文件不存在（未产生过通知）或暂不可读：按空历史处理
		}
		const file = parseNoticeHistoryFile(text);
		if (!file) {
			this.deps.log("error", "notice history file unreadable, starting empty", { path: this.deps.getFilePath() });
			return [];
		}
		return file.entries;
	}

	/** 追加一条（IPC record 入口）。入参来自渲染层（不可信），清洗不通过的丢弃并记日志；无返回值——历史记录永不阻塞/打断 toast。 */
	append(input: unknown): void {
		const record = sanitizeNoticeHistoryRecord(input);
		if (!record) {
			this.deps.log("error", "notice history record rejected", { input: typeof input });
			return;
		}
		this.entries.push({ ...record, timestamp: Date.now() });
		if (this.entries.length > NOTICE_HISTORY_MAX_ENTRIES) {
			this.entries = this.entries.slice(this.entries.length - NOTICE_HISTORY_MAX_ENTRIES);
		}
		this.scheduleFlush();
	}

	/** 立即写盘（防抖窗口内的合并写也走这里）；供测试与进程退出前兜底调用。 */
	async flush(): Promise<void> {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		await this.writeNow();
	}

	/** 清空历史并删除文件（设置页清理入口）。 */
	async clear(): Promise<void> {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.entries = [];
		try {
			await rm(this.deps.getFilePath(), { force: true });
		} catch (error) {
			this.deps.log("error", "notice history clear failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/** 文件占用字节（设置页展示）；不存在按 0。 */
	async getSize(): Promise<number> {
		try {
			const fileStat = await stat(this.deps.getFilePath());
			return fileStat.isFile() ? fileStat.size : 0;
		} catch {
			return 0;
		}
	}

	/** 防抖写盘：窗口内有新 append 才写。 */
	private scheduleFlush(): void {
		if (this.flushTimer !== null) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			// 写盘失败不回滚内存数组（重试交给下一次 append 触发），只记日志
			void this.writeNow();
		}, FLUSH_DEBOUNCE_MS);
	}

	private async writeNow(): Promise<void> {
		// 串行化并发写：上一次写盘未完成时排队等待，避免 tmp 路径互相覆盖
		this.writeInProgress = this.writeInProgress.then(() => this.writeEntries());
		await this.writeInProgress;
	}

	private async writeEntries(): Promise<void> {
		const filePath = this.deps.getFilePath();
		try {
			const payload: NoticeHistoryFile = {
				version: NOTICE_HISTORY_FILE_VERSION,
				entries: this.entries.map(toNoticeHistoryFileEntry),
			};
			await mkdir(dirname(filePath), { recursive: true });
			const tmpPath = `${filePath}.tmp`;
			await writeFile(tmpPath, `${JSON.stringify(payload)}\n`, "utf8");
			await renameWithRetry(tmpPath, filePath);
		} catch (error) {
			this.deps.log("error", "notice history write failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
