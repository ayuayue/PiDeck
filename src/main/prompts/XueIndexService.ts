/**
 * Go xue-index sidecar 的宿主侧客户端（提示词库检索提速通道）。
 *
 * 职责：按 dbPath 拉起/复用常驻 Go 进程（`resources/xue-index/bin/xue-index[.exe]`，
 * 由 scripts/build-xue-index.mjs 构建、extraResources 分发），把 list/get 编成
 * NDJSON 指令发给 stdin，按 id 配对 stdout 响应帧。
 *
 * 失败语义（调用方 XuePromptManager 依赖这一点做降级）：任何失败都以
 * `{ ok: false, reason }` 返回，绝不抛异常——sidecar 缺失/崩溃/超时一律由
 * 调用方回退 sql.js 路径，不影响商店可用性。二进制不存在（贡献者未跑
 * build:xue-index）是最常见形态，spawn 立即失败，代价可忽略。
 *
 * 生命周期纪律（传输/超时/请求配对统一由 GoSidecarClient 负责）：
 * - dbPath 变化（远程库更新后缓存文件被原子替换）→ 杀旧进程按新路径重拉；
 * - boot 超时 / 进程退出 / stdin 管道错误 → 结算全部 pending 并标记 dead，
 *   下次调用重试新进程；dispose → 结算 + 杀进程。
 * - 所有子进程事件回调核对进程身份，旧进程迟到事件只吸收。
 *
 * 本模块不 import electron（路径解析、二进制定位由装配层/调用方注入），
 * 保证 tests 能用 PassThrough 假子进程直接驱动。
 */

import type { YaoPromptCategory, YaoPromptItem } from "../../shared/types";
import { GoSidecarClient, type GoSidecarCallResult, type GoSidecarFailureReason, type GoSidecarLogger, type GoSidecarSpawnFn } from "../sidecar/GoSidecarClient";

/** 与 native/xue-index/main.go 的 ProtocolVersion 对应；不匹配即拒用（回退 sql.js）。 */
export const XUE_INDEX_PROTOCOL_VERSION = 1;

/**
 * boot 上限：正常加载 4012 条约 140ms，但 Windows 首次运行杀毒实时扫描可让
 * 首次启动拖到数秒；15s 足够宽且不会让用户端降级等待过久（超时即回退）。
 */
const DEFAULT_BOOT_TIMEOUT_MS = 15_000;
/** 单次检索上限：内存内过滤毫秒级，10s 只是对进程卡死的保险。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** stdout 单行上限：全量形态的响应帧（4000+ 条目）可达数 MB，与 Go 侧 16MB scanner 上限一致。 */
export const MAX_XUE_INDEX_LINE_CHARS = 16 * 1024 * 1024;

export type XueIndexLogger = GoSidecarLogger;

/** 覆盖层条目（宿主把官方模板热更新目录解析成此结构随请求下发，Go 侧无状态）。 */
export type XueIndexOverlayEntry = {
	slug: string;
	title?: string;
	description?: string;
	category?: string;
	content: string;
};

export type XueIndexListParams = {
	category?: string;
	search?: string;
	page?: number;
	pageSize?: number;
	overlay?: XueIndexOverlayEntry[];
};

/** Go 侧单条明文文档（detail 的 db 部分；fullContent 由 XuePromptManager 组装）。 */
export type XueIndexDoc = {
	slug: string;
	url: string;
	title: string;
	category: string;
	content: string;
	description: string;
};

/** Go 侧 list 结果：分页形态带 total/page/pageSize，全量形态省略（omitempty）。 */
export type XueIndexListResult = {
	categories: YaoPromptCategory[];
	prompts: YaoPromptItem[];
	total?: number;
	page?: number;
	pageSize?: number;
};

export type XueIndexFailureReason = GoSidecarFailureReason;

export type XueIndexCallResult<T> = GoSidecarCallResult<T>;

export type XueIndexServiceOptions = {
	/** 二进制定位：返回 null 表示 sidecar 不可用（未构建/未打包），调用方直接降级。 */
	resolveBinaryPath: () => string | null;
	logger?: XueIndexLogger;
	/** 单测注入假子进程用；生产默认 node:child_process。 */
	spawnFn?: GoSidecarSpawnFn;
	timeouts?: { boot?: number; request?: number };
};

export class XueIndexService extends GoSidecarClient {
	constructor(options: XueIndexServiceOptions) {
		super({
			name: "xue-index",
			resolveBinaryPath: options.resolveBinaryPath,
			spawnFn: options.spawnFn,
			timeouts: {
				boot: options.timeouts?.boot ?? DEFAULT_BOOT_TIMEOUT_MS,
				request: options.timeouts?.request ?? DEFAULT_REQUEST_TIMEOUT_MS,
			},
			logger: options.logger,
			protocolVersion: XUE_INDEX_PROTOCOL_VERSION,
			maxLineChars: MAX_XUE_INDEX_LINE_CHARS,
			messages: {
				binaryMissing: "提示词检索二进制不存在（未构建或未随包分发）",
				spawnFailed: "提示词检索进程启动失败",
				bootFailed: "提示词检索进程启动失败，已回退内置检索",
				processError: "提示词检索进程启动失败",
				processExited: (code) => `提示词检索进程退出（code ${code ?? "null"}）`,
				requestTimeout: "提示词检索超时",
				requestFailed: (error) => error ?? "提示词检索失败",
				childUnavailable: "提示词检索进程不可用",
				writeFailed: "提示词检索进程不可用",
				pipeClosed: "提示词检索进程管道已关闭",
				protocolMismatch: "提示词检索协议版本不匹配",
				responseOverflow: "提示词检索响应异常",
				disposed: "提示词检索服务已停止",
				keyChanged: "提示词库已更新，检索进程重启",
			},
			onReady: (ready) => {
				options.logger?.debug(`xue-index ready：${String(ready.count ?? "?")} 条，加载 ${String(ready.loadMs ?? "?")}ms`);
			},
		});
	}

	/**
	 * 检索。dbPath 决定 sidecar 装载哪个库文件；与当前进程不一致时自动重启
	 * （远程库更新 → 缓存原子替换 → 下一次 list 自然换库，无需全局协调）。
	 */
	async list(dbPath: string, params: XueIndexListParams): Promise<XueIndexCallResult<XueIndexListResult>> {
		const boot = await this.ensureChild(dbPath);
		if (!boot.ok) return boot;
		return this.request<XueIndexListResult>({ cmd: "list", params });
	}

	/** 取单条明文；未命中时 value 为 null（区别于 ok:false 的通道失败）。 */
	async get(dbPath: string, slug: string): Promise<XueIndexCallResult<XueIndexDoc | null>> {
		const boot = await this.ensureChild(dbPath);
		if (!boot.ok) return boot;
		return this.request<XueIndexDoc | null>({ cmd: "get", slug });
	}

	/** 换库即重启：复用键是 dbPath，spawn 参数也只带它。 */
	private async ensureChild(dbPath: string): Promise<XueIndexCallResult<true>> {
		return this.ensureReady(dbPath, [dbPath]);
	}
}
