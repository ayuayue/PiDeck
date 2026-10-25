/**
 * Go file-index sidecar 的宿主侧客户端（工作区文件索引：名字模糊检索 + 有界内容检索）。
 *
 * 为什么存在：主进程的文件名搜索（src/main/fs/FileSystemService.ts::searchNames）是
 * 实时 BFS——8s 超时、200 条上限、单目录 >5000 项跳过、只匹配条目名本身、无内容检索。
 * 本服务拉起 Go sidecar（native/file-index，内存索引 + 多核扫描）把名字检索做成毫秒级
 * 带评分排序，并补上「在工作区文件内容里搜词」的能力。
 *
 * 失败语义（调用方依赖降级）：任何失败以 `{ ok: false, reason }` 返回、绝不抛异常——
 * sidecar 缺失/崩溃/超时一律回退现有 BFS（fail-open，与 SessionIndexService 同哲学）。
 *
 * 生命周期纪律（传输/超时/请求配对统一由 GoSidecarClient 负责）：
 * - roots 签名变化（切换项目）→ 杀旧进程按新 roots 重拉（索引在内存里，重扫由 Go 完成）；
 * - boot 超时 / 进程退出 / stdin 管道错误 → 结算 pending 并标记 dead，下次调用重试；
 * - dispose → 结算 + 杀进程（quitCleanup 登记）；
 * - 就绪态用同步三元态暴露（isReady），交互路径据此降级而不是等 boot 结束。
 *
 * 已知取舍：单进程单 roots（切项目重建索引，Go 侧毫秒级~秒级）。首查未就绪时回退 BFS
 * 并后台预热，下一次输入即走索引。
 *
 * 本模块不 import electron（路径解析由装配层注入），tests 可用 PassThrough 假子进程直接驱动。
 */

import type { FileContentSearchHit, FileContentSearchResult, FileSearchResult } from "../../shared/types";
import { GoSidecarClient, type GoSidecarCallResult, type GoSidecarFailureReason, type GoSidecarLogger, type GoSidecarSpawnFn } from "../sidecar/GoSidecarClient";

/** 与 native/file-index/main.go 的 ProtocolVersion 对应；不匹配即拒用（回退 BFS）。 */
export const FILE_INDEX_PROTOCOL_VERSION = 1;

/** boot 上限：内存索引一次目录树扫描（大仓库秒级），20s 已是慢盘/杀毒的极端形态。 */
const DEFAULT_BOOT_TIMEOUT_MS = 20_000;
/** 单次检索上限：名字检索毫秒级；内容检索受全局字节预算约束，15s 只是进程卡死保险。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** stdout 单行上限：结果规模（200 条名字 / 50 条内容命中）远小于此，防异常帧撑爆内存。 */
export const MAX_FILE_INDEX_LINE_CHARS = 4 * 1024 * 1024;

/** 名字检索结果上限：与 FILE_SEARCH_MAX_RESULTS（共享契约）对齐，渲染层已有 200 条的心理预期。 */
const DEFAULT_NAME_LIMIT = 200;
/** 内容检索结果上限：面板只展示摘要条，再多用户会继续输入缩小范围。 */
const DEFAULT_CONTENT_LIMIT = 50;
/** 内容检索单文件上限：超过即跳过（大二进制/日志文件对「搜代码」没有价值却吃满预算）。 */
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
/** 内容检索全局扫描字节预算：一次查询最多读这么多字节，防止大仓库把磁盘打满。 */
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

/** 名字命中：shared 的 FileSearchResult 加上 Go 侧评分（渲染层不需要评分，IPC 边界会剥掉）。 */
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
};

export class FileIndexService extends GoSidecarClient {
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
	}

	/**
	 * 就绪探测：同步返回「现在发请求不会卡在 boot 上」。不拉进程、不等待。
	 * 交互路径（文件名搜索）先用它判断——未就绪直接回退 BFS，后台预热继续，
	 * 索引就绪后下一次输入自然走索引。
	 */
	isReady(roots: string[]): boolean {
		return this.isReadyForKey(roots.join("\0"));
	}

	/**
	 * 后台预热：fire-and-forget 建索引，失败静默（调用方已有 BFS 兜底）。
	 * 未就绪时每次搜索都会调它，因此必须防重入（booting/ready 且 roots 未变则直接返回）。
	 */
	warmup(roots: string[]): void {
		if (this.disposed || roots.length === 0) return;
		if (this.isActiveForKey(roots.join("\0"))) return;
		void this.refresh(roots).catch(() => {});
	}

	/** 名字模糊检索（评分排序）。未就绪时会等 boot 结束，交互路径应先 isReady 判断。 */
	async searchNames(roots: string[], query: string, limit = DEFAULT_NAME_LIMIT): Promise<FileIndexCallResult<FileIndexNameResult>> {
		const boot = await this.ensureChild(roots);
		if (!boot.ok) return boot;
		return this.request<FileIndexNameResult>({ cmd: "search-name", query, limit });
	}

	/** 内容检索（有界实时扫描）。同样应先 isReady 再调用。 */
	async searchContent(roots: string[], query: string, limit = DEFAULT_CONTENT_LIMIT, maxFileBytes = DEFAULT_MAX_FILE_BYTES, maxScannedBytes = DEFAULT_MAX_SCANNED_BYTES): Promise<FileIndexCallResult<FileContentSearchResult & { hits: FileContentSearchHit[] }>> {
		const boot = await this.ensureChild(roots);
		if (!boot.ok) return boot;
		return this.request<FileContentSearchResult & { hits: FileContentSearchHit[] }>({ cmd: "search-content", query, limit, maxFileBytes, maxScannedBytes });
	}

	/** 重建索引（预热与手动刷新用）。 */
	async refresh(roots: string[]): Promise<FileIndexCallResult<FileIndexStats>> {
		const boot = await this.ensureChild(roots);
		if (!boot.ok) return boot;
		return this.request<FileIndexStats>({ cmd: "refresh" });
	}

	/** 校验 roots 并把 spawn 参数收敛到一个入口（索引进程只服务一组 roots）。 */
	private async ensureChild(roots: string[]): Promise<FileIndexCallResult<true>> {
		if (roots.length === 0) return { ok: false, reason: "not-ready", message: "无文件索引根目录" };
		return this.ensureReady(roots.join("\0"), roots);
	}
}
