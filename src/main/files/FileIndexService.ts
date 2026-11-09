/**
 * Go file-index sidecar 的宿主侧客户端（工作区文件索引：名字模糊检索 + 有界内容检索）。
 *
 * 为什么存在：主进程实时 BFS 有 8s 超时、200 条上限和扫描预算，不支持内容检索。
 * Go sidecar 提供内存文件名索引与有界内容检索；缺失、启动失败或超时时，
 * 任何失败以 `{ ok: false, reason }` 返回，调用方回退实时 BFS。
 *
 * 生命周期纪律（传输/超时/请求配对统一由 GoSidecarClient 负责）：
 * - roots 签名变化（切换项目）→ 杀旧进程按新 roots 重拉（索引在内存里，重扫由 Go 完成）；
 * - boot 超时 / 进程退出 / stdin 管道错误 → 结算 pending 并标记 dead，下次调用重试；
 * - dispose → 结算 + 杀进程（quitCleanup 登记）。
 * - ready 前 Go 已完成首次 Index，因此预热只等待就绪，不再额外 refresh。
 * - 名字/内容搜索前有界检查过期并合并刷新，避免逐键全量扫描。
 *
 * 本模块不 import electron（路径解析由装配层注入），tests 可用 PassThrough 假子进程直接驱动。
 */

import type { FileContentSearchHit, FileContentSearchResult, FileSearchResult } from "../../shared/types";
import { GoSidecarClient, type GoSidecarCallResult, type GoSidecarFailureReason, type GoSidecarLogger, type GoSidecarSpawnFn } from "../sidecar/GoSidecarClient";

/** 与 native/file-index/main.go 的 ProtocolVersion 对应；不匹配即拒用（回退 BFS）。 */
export const FILE_INDEX_PROTOCOL_VERSION = 1;
/** boot 上限：内存索引一次目录树扫描（大仓库秒级），20s 已是慢盘/杀毒的极端形态。 */
const DEFAULT_BOOT_TIMEOUT_MS = 20_000;
/** 请求超时只是进程卡死的保险，查询自身的扫描预算必须保证有界。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** 同一快照内合并高频查询；过期全量刷新只允许一个在途请求。 */
const INDEX_REFRESH_AGE_MS = 5_000;
/** stdout 单行上限：防止异常帧撑爆主进程。 */
export const MAX_FILE_INDEX_LINE_CHARS = 4 * 1024 * 1024;
/** 与 FILE_SEARCH_MAX_RESULTS / 检索面板的有界结果预算对齐。 */
const DEFAULT_NAME_LIMIT = 200;
const DEFAULT_CONTENT_LIMIT = 50;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_SCANNED_BYTES = 64 * 1024 * 1024;

export type FileIndexLogger = GoSidecarLogger;
export type FileIndexFailureReason = GoSidecarFailureReason;
export type FileIndexCallResult<T> = GoSidecarCallResult<T>;
export type FileIndexStats = {
	rootCount: number;
	fileCount: number;
	dirCount: number;
	indexMs: number;
	truncated: boolean;
};
/** 名字命中：shared 的 FileSearchResult 加上 Go 侧评分（IPC 边界剥掉评分）。 */
export type FileIndexNameHit = FileSearchResult & { score: number };
export type FileIndexNameResult = {
	hits: FileIndexNameHit[];
	indexed: number;
	truncated: boolean;
};

export type FileIndexServiceOptions = {
	/** 二进制定位：返回 null 表示 sidecar 不可用（未构建/未随包分发），调用方直接降级。 */
	resolveBinaryPath: () => string | null;
	logger?: FileIndexLogger;
	/** 单测注入假子进程用；生产默认 node:child_process。 */
	spawnFn?: GoSidecarSpawnFn;
	timeouts?: { boot?: number; request?: number };
	/** 单测注入时钟，用确定性边界覆盖快照刷新与并发合并。 */
	now?: () => number;
};

export class FileIndexService extends GoSidecarClient {
	private readonly now: () => number;
	private indexFreshness: { rootKey: string; indexedAt: number } | undefined;
	private searchRefresh: { rootKey: string; promise: Promise<FileIndexCallResult<FileIndexStats>> } | undefined;

	constructor(options: FileIndexServiceOptions) {
		super({
			name: "file-index",
			resolveBinaryPath: options.resolveBinaryPath,
			spawnFn: options.spawnFn,
			timeouts: {
				boot: options.timeouts?.boot ?? DEFAULT_BOOT_TIMEOUT_MS,
				request: options.timeouts?.request ?? DEFAULT_REQUEST_TIMEOUT_MS,
			},
			logger: options.logger,
			protocolVersion: FILE_INDEX_PROTOCOL_VERSION,
			maxLineChars: MAX_FILE_INDEX_LINE_CHARS,
			logStderr: true,
			writeFailureLogLevel: "error",
			messages: {
				binaryMissing: "文件索引二进制不存在（未构建或未随包分发）",
				spawnFailed: "文件索引进程启动失败",
				bootFailed: "文件索引进程启动失败",
				processError: "文件索引进程启动失败",
				processExited: (code) => `文件索引进程退出（code ${code ?? "null"}）`,
				requestTimeout: "文件索引检索超时",
				requestFailed: (error) => error ?? "文件索引检索失败",
				childUnavailable: "文件索引进程不可用",
				writeFailed: "文件索引进程管道写入失败",
				pipeClosed: "文件索引进程管道已关闭",
				protocolMismatch: "文件索引协议版本不匹配",
				responseOverflow: "文件索引响应异常",
				disposed: "文件索引服务已停止",
				keyChanged: "文件索引根目录已变更，索引进程重启",
			},
			onReady: (ready) => {
				options.logger?.info(`file-index ready：${String(ready.fileCount ?? "?")} 文件 / ${String(ready.dirCount ?? "?")} 目录，索引 ${String(ready.indexMs ?? "?")}ms${ready.truncated ? "（已截断）" : ""}`);
			},
		});
		this.now = options.now ?? Date.now;
	}

	/** 就绪探测：同步返回是否可以直接请求；不拉进程、不等待。 */
	isReady(roots: string[]): boolean {
		return this.isReadyForKey(roots.join("\0"));
	}

	/** 后台预热：boot ready 已经包含一次完整建索引，不再重复 refresh。 */
	warmup(roots: string[]): void {
		if (this.disposed || roots.length === 0) return;
		const rootKey = roots.join("\0");
		if (this.isActiveForKey(rootKey)) return;
		this.indexFreshness = { rootKey, indexedAt: this.now() };
		void this.ensureChild(roots).catch(() => {});
	}

	/** 名字模糊检索（评分排序）。未就绪时会等 boot 结束，交互路径应先 isReady 判断。 */
	async searchNames(roots: string[], query: string, limit = DEFAULT_NAME_LIMIT): Promise<FileIndexCallResult<FileIndexNameResult>> {
		const boot = await this.prepareSearch(roots);
		if (!boot.ok) return boot;
		return this.request<FileIndexNameResult>({ cmd: "search-name", query, limit });
	}

	/** 内容检索（有界实时扫描）。同样应先 isReady 再调用。 */
	async searchContent(roots: string[], query: string, limit = DEFAULT_CONTENT_LIMIT, maxFileBytes = DEFAULT_MAX_FILE_BYTES, maxScannedBytes = DEFAULT_MAX_SCANNED_BYTES): Promise<FileIndexCallResult<FileContentSearchResult & { hits: FileContentSearchHit[] }>> {
		const boot = await this.prepareSearch(roots);
		if (!boot.ok) return boot;
		return this.request<FileContentSearchResult & { hits: FileContentSearchHit[] }>({ cmd: "search-content", query, limit, maxFileBytes, maxScannedBytes });
	}

	/** 显式刷新。只有成功才更新时间戳，刷新失败保留失败语义。 */
	async refresh(roots: string[]): Promise<FileIndexCallResult<FileIndexStats>> {
		const boot = await this.ensureChild(roots);
		if (!boot.ok) return boot;
		return this.refreshReadyIndex(roots.join("\0"));
	}

	/** 刷新过期快照；同根目录并发查询复用一个在途全量刷新。 */
	private async prepareSearch(roots: string[]): Promise<FileIndexCallResult<true>> {
		const rootKey = roots.join("\0");
		const boot = await this.ensureChild(roots);
		if (!boot.ok) return boot;
		if (this.indexFreshness?.rootKey !== rootKey) this.indexFreshness = { rootKey, indexedAt: this.now() };
		if (this.now() - this.indexFreshness.indexedAt < INDEX_REFRESH_AGE_MS) return boot;
		const existing = this.searchRefresh?.rootKey === rootKey ? this.searchRefresh.promise : undefined;
		if (existing) {
			await existing;
			return boot;
		}
		const promise = this.refreshReadyIndex(rootKey);
		this.searchRefresh = { rootKey, promise };
		try {
			await promise;
			return boot;
		} finally {
			if (this.searchRefresh?.promise === promise) this.searchRefresh = undefined;
		}
	}

	private async refreshReadyIndex(rootKey: string): Promise<FileIndexCallResult<FileIndexStats>> {
		const result = await this.request<FileIndexStats>({ cmd: "refresh" });
		if (result.ok) this.indexFreshness = { rootKey, indexedAt: this.now() };
		return result;
	}

	/** 校验 roots 并把 spawn 参数收敛到一个入口（索引进程只服务一组 roots）。 */
	private async ensureChild(roots: string[]): Promise<FileIndexCallResult<true>> {
		if (roots.length === 0) return { ok: false, reason: "not-ready", message: "无文件索引根目录" };
		return this.ensureReady(roots.join("\0"), roots);
	}
}
