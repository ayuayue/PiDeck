/**
 * Go session-index sidecar 的宿主侧客户端（跨会话全文搜索）。
 *
 * 为什么存在：历史会话读取在主进程为防 OOM 全线分页/限流（boundedEntryPage
 * 等），全文检索架构上不存在；侧栏搜索只匹配标题+预览+路径。本服务拉起
 * Go sidecar（native/session-index，预提取正文语料+多核分片扫描）补齐
 * 「在全部历史会话正文里搜词」的能力。
 *
 * 失败语义（调用方依赖降级）：任何失败以 `{ ok: false, reason }` 返回、
 * 绝不抛异常——sidecar 缺失/崩溃/超时一律回退现有标题过滤（fail-open，
 * 与 XueIndexService 同哲学）。二进制未构建（贡献者未跑 build:session-index）
 * 是最常见形态，spawn 立即失败代价可忽略。
 *
 * 生命周期纪律（传输/超时/请求配对统一由 GoSidecarClient 负责）：
 * - roots 签名变化（settings sessionDir 变更）→ 杀旧进程按新 roots 重拉；
 * - boot 超时（真实规模全量首建约 13s，慢盘/杀毒可拖更久；60s 上限）/
 *   进程退出 / stdin 管道错误 → 结算 pending 并标记 dead，下次调用重试；
 * - dispose → 结算 + 杀进程（quitCleanup 登记）；
 * - 就绪态用同步三元态暴露（isReady），交互路径据此降级而不是等 boot 结束。
 *
 * 本模块不 import electron（路径/根目录解析由装配层注入），tests 可用
 * PassThrough 假子进程直接驱动。
 */

import type { SessionSearchResult } from "../../shared/types";
import { GoSidecarClient, type GoSidecarCallResult, type GoSidecarFailureReason, type GoSidecarLogger, type GoSidecarSpawnFn } from "../sidecar/GoSidecarClient";

/** 与 native/session-index/main.go 的 ProtocolVersion 对应；不匹配即拒用（回退标题过滤）。 */
export const SESSION_INDEX_PROTOCOL_VERSION = 1;

/**
 * boot 上限：本机真实规模（1032 会话/1.67GB 源）全量首建约 13s；二次启动
 * 走快照增量仅数十毫秒。60s 覆盖冷盘+杀毒实时扫描的极端形态，超时降级。
 */
const DEFAULT_BOOT_TIMEOUT_MS = 60_000;
/**
 * 单次检索上限：29MB 级语料毫秒级完成；冷页缓存的大语料可能到秒级。
 * 30s 只是对进程卡死的保险，超时由调用方降级。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** stdout 单行上限：搜索响应（30 会话 × 5 命中）远小于此，防异常帧撑爆内存。 */
export const MAX_SESSION_INDEX_LINE_CHARS = 4 * 1024 * 1024;

/**
 * 搜索返回上限：侧栏是「折叠的结果条」而不是结果页——单会话最多展示 5 条
 * （Go 侧按评分取最相关的几条），最多 30 个会话。再多的用户会继续输入缩小范围。
 */
const DEFAULT_SEARCH_SESSION_LIMIT = 30;
const DEFAULT_SEARCH_PER_SESSION = 5;
/** 会话内查找的默认条数上限（单会话、按时间线返回，UI 直接上下跳）。 */
const DEFAULT_IN_SESSION_LIMIT = 100;

export type SessionIndexLogger = GoSidecarLogger;

export type SessionIndexFailureReason = GoSidecarFailureReason;

export type SessionIndexCallResult<T> = GoSidecarCallResult<T>;

export type SessionIndexStats = {
	changedFiles: number;
	removedFiles: number;
	sessionCount: number;
	entryCount: number;
	corpusBytes: number;
	compactReason?: string;
};

export type SessionIndexServiceOptions = {
	/** 语料目录（userData 下专属目录，存 corpus.bin 与 state 快照）。 */
	corpusDir: string;
	/** 二进制定位：返回 null 表示 sidecar 不可用（未构建/未随包分发），调用方直接降级。 */
	resolveBinaryPath: () => string | null;
	logger?: SessionIndexLogger;
	/** 单测注入假子进程用；生产默认 node:child_process。 */
	spawnFn?: GoSidecarSpawnFn;
	timeouts?: { boot?: number; request?: number };
};

export class SessionIndexService extends GoSidecarClient {
	private readonly corpusDir: string;

	constructor(options: SessionIndexServiceOptions) {
		super({
			name: "session-index",
			resolveBinaryPath: options.resolveBinaryPath,
			spawnFn: options.spawnFn,
			timeouts: {
				boot: options.timeouts?.boot ?? DEFAULT_BOOT_TIMEOUT_MS,
				request: options.timeouts?.request ?? DEFAULT_REQUEST_TIMEOUT_MS,
			},
			logger: options.logger,
			protocolVersion: SESSION_INDEX_PROTOCOL_VERSION,
			maxLineChars: MAX_SESSION_INDEX_LINE_CHARS,
			messages: {
				binaryMissing: "会话搜索二进制不存在（未构建或未随包分发）",
				spawnFailed: "会话搜索进程启动失败",
				bootFailed: "会话搜索进程启动失败",
				processError: "会话搜索进程启动失败",
				processExited: (code) => `会话搜索进程退出（code ${code ?? "null"}）`,
				requestTimeout: "会话搜索超时",
				requestFailed: (error) => error ?? "会话搜索失败",
				childUnavailable: "会话搜索进程不可用",
				writeFailed: "会话搜索进程不可用",
				pipeClosed: "会话搜索进程管道已关闭",
				protocolMismatch: "会话搜索协议版本不匹配",
				responseOverflow: "会话搜索响应异常",
				disposed: "会话搜索服务已停止",
				keyChanged: "会话根目录已变更，搜索进程重启",
			},
			onReady: (ready) => {
				options.logger?.info(`session-index ready：${String(ready.sessionCount ?? "?")} 会话 / ${String(ready.entryCount ?? "?")} 条正文，语料 ${String(ready.corpusBytes ?? "?")}B，索引 ${String(ready.indexMs ?? "?")}ms${ready.fullRebuild ? "（全量重建）" : ""}`);
			},
		});
		this.corpusDir = options.corpusDir;
	}

	/**
	 * 就绪探测：同步返回「现在发请求不会卡在 boot 上」。不拉进程、不等待。
	 *
	 * 交互路径（侧栏搜索）先用它判断——未就绪直接降级标题过滤，后台预热继续
	 * 进行，索引就绪后下一次输入自然生效；只有就绪后的调用才值得走 search/refresh，
	 * 否则渲染层请求会被挂在 boot 上（首建索引可达数十秒）。
	 */
	isReady(roots: string[]): boolean {
		return this.isReadyForKey(roots.join("\0"));
	}

	/**
	 * 后台预热：确保有 roots 对应的进程在跑（已有 booting/ready 的同 roots 进程时
	 * 什么都不做）。交互路径不想等 boot 时用它——本次降级标题过滤，但索引必须有
	 * 人建，否则会出现「这次没人等、以后也没人建」（首次安装、settings sessionDir
	 * 刚变更）。fire-and-forget，失败只记日志。
	 */
	warmup(roots: string[]): void {
		if (this.disposed || roots.length === 0) return;
		if (this.isActiveForKey(roots.join("\0"))) return;
		void this.refresh(roots).catch(() => {});
	}

	/**
	 * 全文检索。roots 决定扫描口径，与当前进程不一致时自动重启（settings
	 * sessionDir 变更场景）。本方法会等 boot 结束，交互路径应先 isReady() 探测：
	 * 未就绪直接降级标题过滤，就绪后下一次调用自然生效。
	 */
	async search(roots: string[], query: string, limit = DEFAULT_SEARCH_SESSION_LIMIT, perSession = DEFAULT_SEARCH_PER_SESSION): Promise<SessionIndexCallResult<SessionSearchResult>> {
		const boot = await this.ensureChild(roots);
		if (!boot.ok) return boot;
		return this.request<SessionSearchResult>({ cmd: "search", query, limit, perSession });
	}

	/**
	 * 会话内查找：只扫一个会话文件，命中按时间线顺序返回（上一条/下一条导航）。
	 *
	 * 与 search() 共用索引与匹配逻辑，差异只有范围与顺序；会话文件不在索引里
	 * （未索引/WSL/索引未就绪）时返回空结果而不是错误。
	 */
	async searchInSession(roots: string[], sessionPath: string, query: string, limit = DEFAULT_IN_SESSION_LIMIT): Promise<SessionIndexCallResult<SessionSearchResult>> {
		if (!sessionPath) return { ok: false, reason: "not-ready", message: "缺少会话路径" };
		const boot = await this.ensureChild(roots);
		if (!boot.ok) return boot;
		return this.request<SessionSearchResult>({ cmd: "search-session", path: sessionPath, query, limit });
	}

	/** 增量重扫（新会话文件/mtime 变化/删除）。渲染层搜索前或定期触发。 */
	async refresh(roots: string[]): Promise<SessionIndexCallResult<SessionIndexStats>> {
		const boot = await this.ensureChild(roots);
		if (!boot.ok) return boot;
		return this.request<SessionIndexStats>({ cmd: "refresh" });
	}

	/** 校验 roots 并收敛 spawn 参数（corpusDir 固定，roots 决定扫描口径）。 */
	private async ensureChild(roots: string[]): Promise<SessionIndexCallResult<true>> {
		if (roots.length === 0) return { ok: false, reason: "not-ready", message: "无会话根目录" };
		return this.ensureReady(roots.join("\0"), [this.corpusDir, ...roots]);
	}
}
