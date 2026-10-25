/**
 * Go session-store sidecar 的宿主侧客户端（会话数据面 Wave 1 骨架）。
 *
 * 为什么存在：同一份 pi 会话 JSONL 现在被 4 套 TS 各自解析（SessionScanner /
 * SessionCatalog / SessionHistoryReader / usageStats），每次打开会话都要重新读盘。
 * 本服务拉起 Go sidecar（native/session-store），用持久化快照 + 行边界增量扫描维护
 * 每文件的状态（已提交字节数/条目数/压缩标记），为 Wave 2 的窗口化读取与
 * Wave 3 的摘要/用量聚合打底。
 *
 * 失败语义（调用方依赖降级）：任何失败以 `{ ok: false, reason }` 返回、绝不抛异常——
 * sidecar 缺失/崩溃/超时一律回退现有 TS 解析路径（fail-open，与 SessionIndexService、
 * FileIndexService 同哲学）。
 *
 * 生命周期纪律（传输/超时/请求配对统一由 GoSidecarClient 负责）：
 * - boot 超时 / 进程退出 / stdin 管道错误 → 结算 pending 并标记 dead，下次调用重试；
 * - dispose → 结算 + 杀进程（quitCleanup 登记）；
 * - 所有子进程事件回调核对进程身份，旧进程迟到事件只吸收；
 * - 就绪态用同步三元态暴露（isReady），调用方据此降级而不是等 boot 结束。
 *
 * 与三个兄弟服务的差异：roots 是**逐请求**参数（不是 spawn 参数），因此换 roots 不重启
 * 进程——同一进程可以服务任意会话根，快照按路径记账，与 roots 集合无关。
 *
 * 本模块不 import electron（路径解析由装配层注入），tests 可用 PassThrough 假子进程直接驱动。
 */

import { GoSidecarClient, type GoSidecarCallResult, type GoSidecarFailureReason, type GoSidecarLogger, type GoSidecarSpawnFn } from "../sidecar/GoSidecarClient";

/** 与 native/session-store/main.go 的 protocolVersion 对应；不匹配即拒用（回退 TS 解析）。 */
export const SESSION_STORE_PROTOCOL_VERSION = 1;

/** boot 上限：打开快照 + 起进程，正常是毫秒级；20s 已是慢盘/杀毒的极端形态。 */
const DEFAULT_BOOT_TIMEOUT_MS = 20_000;
/**
 * 单次请求上限：`list-files` 首次要读完全部会话文件（实测 889 文件/595MiB ≈ 7.2s），
 * 慢盘上可能更久；命中快照时是几十毫秒。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/**
 * stdout 单行上限：`list-files` 结果按文件数增长（889 文件 ≈ 221KB）；`get-index`
 * 的条目表随会话长度增长（10 万条 × ~250B ≈ 25MB，journal 类超大会话）。
 * 取 32MiB 统一封顶：既不让正常响应被误判成协议异常，也保证异常帧不会撑爆内存
 * （字符串只在单个响应帧上瞬时占用，解析后即释放）。
 */
export const MAX_SESSION_STORE_LINE_CHARS = 32 * 1024 * 1024;

export type SessionStoreLogger = GoSidecarLogger;

export type SessionStoreFailureReason = GoSidecarFailureReason;

export type SessionStoreCallResult<T> = GoSidecarCallResult<T>;

/** 与 Go 侧 fileState 逐字段对齐（native/session-store/store.go）。 */
export type SessionStoreFileState = {
	path: string;
	/** 已提交字节数：恒落在完整行边界上，残行不计入。 */
	size: number;
	mtimeMs: number;
	/** Wave 1 内部口径：带字符串 id 的完整行数（精确去重口径属 Wave 2）。 */
	entryCount: number;
	hasCompaction: boolean;
	endsWithNewline: boolean;
};

export type SessionStoreListStats = {
	files: SessionStoreFileState[];
	reused: number;
	incremental: number;
	full: number;
	pruned: number;
	indexMs: number;
};

export type SessionStoreReadyInfo = {
	snapshotFiles: number;
	bootMs: number;
};

/**
 * `get-index` 的线形状（native/session-store/table.go 的 table）。
 *
 * `entries` 刻意是 `unknown[]`：它来自外部进程（子进程输出一律不可信），
 * 字段级校验与类型收窄由消费者 `SessionHistoryReader` 的 validator 完成，
 * 本服务只保证「取到了 JSON」。
 */
export type SessionStoreIndexTable = {
	path: string;
	size: number;
	mtimeMs: number;
	endsWithNewline: boolean;
	lastEntryId?: string;
	entries: unknown[];
	oversizedLines: number;
};

export type SessionStoreServiceOptions = {
	/** 快照落盘路径（装配层给 `<userData>/session-store/state.bin`）。 */
	statePath: string;
	/**
	 * 条目表落盘目录（装配层给 `<userData>/session-store/tables`，Wave 2b）。
	 * 给了才写盘；缺省时 sidecar 只做进程内缓存（与 Wave 2 行为一致）。
	 */
	tablesDir?: string;
	/** 二进制定位：返回 null 表示 sidecar 不可用（未构建/未随包分发），调用方直接降级。 */
	resolveBinaryPath: () => string | null;
	logger?: SessionStoreLogger;
	/** 单测注入假子进程用；生产默认 node:child_process。 */
	spawnFn?: GoSidecarSpawnFn;
	timeouts?: { boot?: number; request?: number };
};

/** 进程本身与 roots 无关，复用键恒为常量；换 roots 只换请求参数。 */
const STORE_PROCESS_KEY = "session-store";

export class SessionStoreService extends GoSidecarClient {
	private readonly statePath: string;
	private readonly tablesDir: string;

	constructor(options: SessionStoreServiceOptions) {
		super({
			name: "session-store",
			resolveBinaryPath: options.resolveBinaryPath,
			spawnFn: options.spawnFn,
			timeouts: {
				boot: options.timeouts?.boot ?? DEFAULT_BOOT_TIMEOUT_MS,
				request: options.timeouts?.request ?? DEFAULT_REQUEST_TIMEOUT_MS,
			},
			logger: options.logger,
			protocolVersion: SESSION_STORE_PROTOCOL_VERSION,
			maxLineChars: MAX_SESSION_STORE_LINE_CHARS,
			logStderr: true,
			writeFailureLogLevel: "error",
			messages: {
				binaryMissing: "会话存储二进制不存在（未构建或未随包分发）",
				spawnFailed: "会话存储进程启动失败",
				bootFailed: "会话存储进程启动失败",
				processError: "会话存储进程启动失败",
				processExited: (code) => `会话存储进程退出（code ${code ?? "null"}）`,
				requestTimeout: "会话存储扫描超时",
				requestFailed: (error) => error ?? "会话存储扫描失败",
				childUnavailable: "会话存储进程不可用",
				writeFailed: "会话存储进程管道写入失败",
				pipeClosed: "会话存储进程管道已关闭",
				protocolMismatch: "会话存储协议版本不匹配",
				responseOverflow: "会话存储响应异常",
				disposed: "会话存储服务已停止",
				keyChanged: "会话存储进程重启",
			},
			onReady: (ready) => {
				const snapshotFiles = typeof ready.snapshotFiles === "number" ? ready.snapshotFiles : 0;
				const bootMs = typeof ready.bootMs === "number" ? ready.bootMs : 0;
				options.logger?.info(`session-store ready：快照 ${snapshotFiles} 文件，boot ${bootMs}ms`);
			},
		});
		this.statePath = options.statePath;
		this.tablesDir = options.tablesDir ?? "";
	}

	/** 就绪探测：同步返回「现在发请求不会卡在 boot 上」。不拉进程、不等待。 */
	isReady(): boolean {
		return this.isReadyAny();
	}

	/** 最近一次 ready 帧（诊断/日志用）；未就绪为 null。 */
	snapshotInfo(): SessionStoreReadyInfo | null {
		const ready = this.getReadyFrame();
		if (!ready) return null;
		return {
			snapshotFiles: typeof ready.snapshotFiles === "number" ? ready.snapshotFiles : 0,
			bootMs: typeof ready.bootMs === "number" ? ready.bootMs : 0,
		};
	}

	/**
	 * 后台预热：只把进程拉起来（快照在 Go 侧 load，毫秒级），不发请求。
	 * fire-and-forget，失败静默（调用方有 TS 解析兜底）。
	 */
	warmup(): void {
		if (this.disposed || this.isActiveForKey(STORE_PROCESS_KEY)) return;
		void this.ensureStoreReady().catch(() => {});
	}

	/**
	 * 扫描会话根并返回文件状态（未变的复用快照、追加的只读尾段、变短的重扫）。
	 * 调用方应先 isReady() 判断；这里会等 boot 结束。
	 */
	async listFiles(roots: readonly string[]): Promise<SessionStoreCallResult<SessionStoreListStats>> {
		if (roots.length === 0) return { ok: false, reason: "not-ready", message: "无会话根目录" };
		const boot = await this.ensureStoreReady();
		if (!boot.ok) return boot;
		return this.request<SessionStoreListStats>({ cmd: "list-files", roots: [...roots] });
	}

	/** 显式重建：与 listFiles 同一条请求（Go 侧按 mtime/size 自动决定复用/增量/全扫）。 */
	async refresh(roots: readonly string[]): Promise<SessionStoreCallResult<SessionStoreListStats>> {
		if (roots.length === 0) return { ok: false, reason: "not-ready", message: "无会话根目录" };
		const boot = await this.ensureStoreReady();
		if (!boot.ok) return boot;
		return this.request<SessionStoreListStats>({ cmd: "refresh", roots: [...roots] });
	}

	/**
	 * 取单个会话文件的条目表（Wave 2：替代「缓存未命中时的全量逐行解析」）。
	 *
	 * 与 list-files 一样会等 boot 结束；调用方应先 isReady() 判断，未就绪就走 TS 解析。
	 * 返回的行数据未经校验，消费方必须做字段级校验后再用。
	 */
	async getIndex(hostPath: string): Promise<SessionStoreCallResult<SessionStoreIndexTable>> {
		if (!hostPath) return { ok: false, reason: "not-ready", message: "会话文件路径为空" };
		const boot = await this.ensureStoreReady();
		if (!boot.ok) return boot;
		return this.request<SessionStoreIndexTable>({ cmd: "get-index", roots: [], path: hostPath });
	}

	/** 进程无复用键：启动一次后一直复用，参数只在 spawn 时取。 */
	private ensureStoreReady(): Promise<SessionStoreCallResult<true>> {
		const args = this.tablesDir ? [this.statePath, this.tablesDir] : [this.statePath];
		return this.ensureReady(STORE_PROCESS_KEY, args);
	}
}
