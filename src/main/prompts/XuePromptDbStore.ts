/**
 * 提示词库 db 的远程获取与本地缓存（#2 配套：安装包不再内置 xueprompts.db）。
 *
 * 数据源：PiDeck 仓库 Release 资产（AtomGit 主 + GitHub latest 兜底，与更新源
 * 同一坐标），资产三件套：xueprompts.db / xueprompts.db.sha256。版本判定用
 * .sha256 文本（~100B）对比本地缓存指纹，命中即跳过 4.3MB 下载。
 *
 * 路径优先级：userData 缓存 > 仓库 resources 副本（仅 dev/源码运行）> 无（远程下载）。
 * 缓存文件名带 sha 前缀（xueprompts-<sha16>.db）：新版本落新文件，路径字符串变化
 * 天然驱动 XueIndexService 换库重启（其复用条件是 dbPath 相同），无需额外协调；
 * 旧版本文件在下一次启动清理。
 *
 * 失败语义：ensureReady 永不抛异常——已有缓存时远程检查/下载失败继续用旧缓存
 * （不降级、不空态）；无任何本地副本且下载失败才进入 failed（渲染层显示重试）。
 * 下载完整性：db 下载后重算 sha256 与 .sha256 资产比对，不匹配即丢弃（防中间人
 * 篡改/截断），且 sha 与 db 取自同一源，避免跨源指纹错配。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomGitFeedUrl, gitHubLatestDownloadBase } from "../../shared/updateSources";
import type { YaoPromptDbSnapshot } from "../../shared/types";

/** db 资产文件名（Release 资产与本地缓存都用这套名字派生）。 */
const DB_ASSET_NAME = "xueprompts.db";
/** sha256 资产文件名（内容是 sha256sum 风格文本，取首个 hex token）。 */
const SHA_ASSET_NAME = "xueprompts.db.sha256";
/** 下载源清单：AtomGit 国内可达优先，GitHub latest 直连兜底（代理/海外环境）。 */
function buildSourceUrls(): Array<{ shaUrl: string; dbUrl: string; label: string }> {
	return [
		{ shaUrl: `${atomGitFeedUrl()}/${SHA_ASSET_NAME}`, dbUrl: `${atomGitFeedUrl()}/${DB_ASSET_NAME}`, label: "atomgit" },
		{ shaUrl: `${gitHubLatestDownloadBase()}/${SHA_ASSET_NAME}`, dbUrl: `${gitHubLatestDownloadBase()}/${DB_ASSET_NAME}`, label: "github" },
	];
}

/** 远程版本检查节流：有缓存时最多每 1h 查一次 sha（4.3MB 库更新频率远低于此）。 */
const DEFAULT_CHECK_TTL_MS = 60 * 60 * 1000;
/** 单次 HTTP 超时（sha 与 db 下载分别计时）。 */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
/** db 下载大小上限（当前 4.3MB，留一个数量级余量防失控响应）。 */
const MAX_DB_BYTES = 64 * 1024 * 1024;
/** sha 文本上限（sha256sum 输出不足百字节）。 */
const MAX_SHA_BYTES = 4 * 1024;

/** 状态推送负载：与 shared 的 YaoPromptDbSnapshot 同构（preload/渲染层直接消费）。 */
export type XuePromptDbState = YaoPromptDbSnapshot;

export type XuePromptDbStoreOptions = {
	/** 缓存根目录（userData）；db 落在 <userData>/xue/ 下。 */
	userDataDir: string;
	/** 仓库 resources 目录（源码运行时的内置副本）；打包后返回 null。 */
	repoResourceDir: () => string | null;
	/** 网络实现（单测注入）；默认 globalThis.fetch（undici，不受 session 代理影响，与公告拉取同策略）。 */
	fetchImpl?: typeof fetch;
	log?: (domain: string, message: string, details?: Record<string, unknown>) => void;
	/** 状态变化推送（装配层转发渲染层事件）。 */
	onStateChange?: (state: YaoPromptDbSnapshot) => void;
	checkTtlMs?: number;
	fetchTimeoutMs?: number;
	now?: () => number;
};

function sha256Hex(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** 解析 sha256sum 风格文本（`<hex>  filename` 或纯 hex）；非法返回 null。 */
function parseShaText(text: string): string | null {
	const token = text.trim().split(/\s+/)[0] ?? "";
	return /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : null;
}

/** 缓存文件名 → 其 sha 前缀；非本命名规约的文件返回 null。 */
function cacheFileSha(name: string): string | null {
	const match = /^xueprompts-([0-9a-f]{16})\.db$/.exec(name);
	return match ? match[1] : null;
}

export class XuePromptDbStore {
	private readonly fetchImpl: typeof fetch;
	private readonly log: (domain: string, message: string, details?: Record<string, unknown>) => void;
	private readonly onStateChange: (state: YaoPromptDbSnapshot) => void;
	private readonly now: () => number;
	private readonly checkTtlMs: number;
	private readonly fetchTimeoutMs: number;

	private cacheDir: string;
	private state: XuePromptDbState = { state: "missing" };
	private lastCheckedAt = 0;
	private inFlight: Promise<XuePromptDbState> | null = null;
	/** 后台刷新标记：repo 副本可用时避免每次 list 都发起网络（也用于单测断言）。 */
	private backgroundRefreshStarted = false;
	private disposed = false;

	constructor(private readonly options: XuePromptDbStoreOptions) {
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.log = options.log ?? (() => {});
		this.onStateChange = options.onStateChange ?? (() => {});
		this.now = options.now ?? Date.now;
		this.checkTtlMs = options.checkTtlMs ?? DEFAULT_CHECK_TTL_MS;
		this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
		this.cacheDir = join(options.userDataDir, "xue");
	}

	getState(): XuePromptDbState {
		return this.state;
	}

	/**
	 * 惰性入口（每次 list/detail 前调用，内部有 TTL/防重入节流）：
	 * 有缓存 → TTL 内直接可用；过期查 sha，命中免下载，不命中下载替换；
	 * 无缓存有 repo 副本 → 立即返回副本路径并后台刷新缓存；
	 * 都没有 → 前台下载（渲染层经状态流显示进度），失败进入 failed。
	 */
	async ensureReady(): Promise<XuePromptDbState> {
		if (this.inFlight) return this.inFlight;
		const run = this.runEnsureReady();
		this.inFlight = run.finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	/** failed 后的用户重试：绕过 TTL 强制走完整检查（与 ensureReady 共享防重入）。 */
	async retry(): Promise<XuePromptDbState> {
		this.lastCheckedAt = 0;
		return this.ensureReady();
	}

	dispose(): void {
		this.disposed = true;
	}

	private setState(next: XuePromptDbState): void {
		this.state = next;
		this.onStateChange(next);
	}

	private async runEnsureReady(): Promise<XuePromptDbState> {
		if (this.disposed) return this.state;
		const cached = this.findCachedDb();
		if (cached) {
			// TTL 内零网络：商店页频繁进出不产生远程请求
			if (this.now() - this.lastCheckedAt < this.checkTtlMs) {
				return this.state.state === "ready" ? this.state : this.readyFromCache(cached);
			}
			// TTL 过期：本地缓存立即可用，绝不为此阻塞调用方——断网时同步等远程检查会让
			// 每次 list 都被「2 源 × 连接超时」拖 ~10s（2026-10 Web 走查实测 /api/prompts
			// 逐次 10.6s，商店/移动端提示词库形似卡死）。远程检查转后台，成功换库经
			// onStateChange 通知渲染层，下一次调用自然取到新缓存路径。
			this.startCacheBackgroundRefresh(cached.path);
			return this.readyFromCache(cached);
		}
		const repoPath = this.findRepoDb();
		if (repoPath) {
			// repo 副本立即可用；远程刷新放后台（成功后路径变化，下次 list 走新缓存）
			this.startBackgroundRefresh(repoPath);
			return this.readyFromRepo(repoPath);
		}
		// 打包后首次使用（无缓存无副本）：前台下载，进度对用户可见
		return this.downloadToCache();
	}

	private readyFromCache(cached: { path: string; sha16: string }): XuePromptDbState {
		const state: XuePromptDbState = { state: "ready", path: cached.path, sha256: cached.sha16, source: "cache" };
		this.setState(state);
		return state;
	}

	private readyFromRepo(repoPath: string): XuePromptDbState {
		const state: XuePromptDbState = { state: "ready", path: repoPath, sha256: null, source: "repo" };
		this.setState(state);
		return state;
	}

	/** 扫缓存目录找当前缓存 db（命名规约内最新一个；正常情况只有一个）。 */
	private findCachedDb(): { path: string; sha16: string } | null {
		try {
			if (!existsSync(this.cacheDir)) return null;
			const names = readdirSync(this.cacheDir)
				.map((name) => cacheFileSha(name))
				.filter((sha): sha is string => sha !== null)
				.sort();
			if (names.length === 0) return null;
			const sha16 = names[names.length - 1];
			const path = join(this.cacheDir, `xueprompts-${sha16}.db`);
			return statSync(path).isFile() ? { path, sha16 } : null;
		} catch {
			return null;
		}
	}

	private findRepoDb(): string | null {
		const dir = this.options.repoResourceDir();
		if (!dir) return null;
		const path = join(dir, DB_ASSET_NAME);
		return existsSync(path) ? path : null;
	}

	private startBackgroundRefresh(fallbackPath: string): void {
		if (this.backgroundRefreshStarted) return;
		this.backgroundRefreshStarted = true;
		void this.refreshFromRemote(fallbackPath).catch(() => {});
	}

	/**
	 * 无任何本地副本时的前台下载（打包后首次使用）：失败进入 failed 态
	 * （渲染层显示重试），永不抛异常。下载中经 setState 推送进度。
	 */
	private async downloadToCache(): Promise<XuePromptDbState> {
		try {
			const installed = await this.downloadIfChanged();
			this.lastCheckedAt = this.now();
			if (installed) return this.readyFromCache(installed);
			// 理论不可达（无缓存时 sha 对比恒不命中）；防御性回置 missing
			return this.state;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log("xueprompts", "db download failed", { error: message });
			const state: XuePromptDbState = { state: "failed", message };
			this.setState(state);
			return state;
		}
	}

	/**
	 * 查远程 sha：与缓存一致 → 只刷新检查时间戳；不一致 → 下载替换；
	 * 网络全源失败 → 记日志返回 null（有本地副本时继续用旧数据，不降级）。
	 */
	private async refreshFromRemote(localPath: string): Promise<XuePromptDbState | null> {
		try {
			const result = await this.downloadIfChanged();
			this.lastCheckedAt = this.now();
			if (result) return this.readyFromCache(result);
			return null; // 远程与缓存同版本，无需变更
		} catch (error) {
			// 失败同样推进 TTL 水位：TTL 是「检查频率上限」而非「成功频率上限」。
			// 只在成功时更新会让断网环境的 lastCheckedAt 永不前进，每个请求都重付
			// 全套远程探测成本（2 源 × 连接超时），见 runEnsureReady 注释。
			this.lastCheckedAt = this.now();
			this.log("xueprompts", "remote db refresh failed, keep local", {
				path: localPath,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * 缓存态的后台远程检查（去重：同一窗口内并发的多个 list 只触发一次检查）。
	 * 换库成功时 refreshFromRemote 内部经 readyFromCache → onStateChange 通知渲染层。
	 */
	private cacheRefresh: Promise<void> | null = null;
	private startCacheBackgroundRefresh(localPath: string): void {
		if (this.cacheRefresh) return;
		this.cacheRefresh = this.refreshFromRemote(localPath)
			.then(() => undefined)
			.catch(() => {})
			.finally(() => {
				this.cacheRefresh = null;
			});
	}

	/** 等待进行中的后台检查结束（测试用；无进行中的检查时立即返回）。 */
	pendingBackgroundRefresh(): Promise<void> {
		return this.cacheRefresh ?? Promise.resolve();
	}

	/**
	 * 按源顺序尝试（sha 与 db 同源配对，防跨源指纹错配）：
	 * 返回 {path,sha16}=新缓存已落盘；null=远程与缓存同版本；抛错=全源失败。
	 */
	private async downloadIfChanged(): Promise<{ path: string; sha16: string } | null> {
		let lastError: unknown;
		for (const source of buildSourceUrls()) {
			try {
				const remoteSha = await this.fetchRemoteSha(source.shaUrl);
				if (!remoteSha) throw new Error(`invalid sha payload from ${source.label}`);
				const cached = this.findCachedDb();
				if (cached && cached.sha16 === remoteSha.slice(0, 16)) {
					return null; // 版本一致，无需下载
				}
				const installed = await this.fetchAndInstallDb(source.dbUrl, remoteSha);
				return installed;
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError ?? new Error("no db sources");
	}

	private async fetchRemoteSha(shaUrl: string): Promise<string | null> {
		const response = await this.fetchWithTimeout(shaUrl, MAX_SHA_BYTES);
		const text = await response.text();
		return parseShaText(text);
	}

	private async fetchWithTimeout(url: string, maxBytes: number): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
		try {
			const response = await this.fetchImpl(url, {
				signal: controller.signal,
				redirect: "follow",
				headers: { "user-agent": "PiDeck-xueprompts" },
			});
			if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
			const declared = Number(response.headers.get("content-length") ?? "0");
			if (declared > maxBytes) throw new Error(`response too large (${declared} bytes) for ${url}`);
			return response;
		} finally {
			clearTimeout(timer);
		}
	}

	/** 流式下载 db（推送进度）→ sha 校验 → tmp+rename 原子落盘；不匹配抛错丢弃。 */
	private async fetchAndInstallDb(dbUrl: string, expectedSha: string): Promise<{ path: string; sha16: string }> {
		const response = await this.fetchWithTimeout(dbUrl, MAX_DB_BYTES);
		const totalBytes = Number(response.headers.get("content-length") ?? "") || null;
		const chunks: Uint8Array[] = [];
		let receivedBytes = 0;
		if (response.body) {
			const reader = response.body.getReader();
			// fetchWithTimeout 的计时随响应头到达就结束了；body 是几十 MB 的流式读取，
			// 连接半死时 read() 会永久挂着（ensureReady 的共享 promise 不结算 → 提示词列表
			// 一直空态且不再重试）。按「停滞」而非总时长计时：每收一块重置，超时即 cancel
			// 释放连接并抛出可读错误（正常大文件下载不受影响）。
			let stalled = false;
			let stallTimer: ReturnType<typeof setTimeout> | null = null;
			const armStallTimer = () => {
				if (stallTimer) clearTimeout(stallTimer);
				stallTimer = setTimeout(() => {
					stalled = true;
					void reader.cancel().catch(() => {});
				}, this.fetchTimeoutMs);
			};
			try {
				armStallTimer();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (!value) continue;
					armStallTimer();
					receivedBytes += value.byteLength;
					if (receivedBytes > MAX_DB_BYTES) throw new Error(`db exceeds size limit (${receivedBytes} bytes)`);
					chunks.push(value);
					this.setState({ state: "downloading", receivedBytes, totalBytes });
				}
				if (stalled) throw new Error(`db download stalled (${this.fetchTimeoutMs}ms without progress) for ${dbUrl}`);
			} catch (error) {
				// 中途退出（超限/停滞/网络错）必须释放 reader，否则 body 挂着不回收
				await reader.cancel().catch(() => {});
				throw error;
			} finally {
				if (stallTimer) clearTimeout(stallTimer);
			}
		} else {
			const buffer = await response.arrayBuffer();
			chunks.push(new Uint8Array(buffer));
			receivedBytes = buffer.byteLength;
		}
		const merged = new Uint8Array(receivedBytes);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const actualSha = sha256Hex(merged);
		if (actualSha !== expectedSha) {
			throw new Error(`sha256 mismatch: expected ${expectedSha}, got ${actualSha}`);
		}
		if (receivedBytes === 0) throw new Error("empty db payload");
		return this.installCacheDb(merged, actualSha);
	}

	/** 落盘：xueprompts-<sha16>.db（tmp+rename）；成功后清理旧版本与残留 tmp。 */
	private installCacheDb(bytes: Uint8Array, sha: string): { path: string; sha16: string } {
		mkdirSync(this.cacheDir, { recursive: true });
		const sha16 = sha.slice(0, 16);
		const finalPath = join(this.cacheDir, `xueprompts-${sha16}.db`);
		const tmpPath = `${finalPath}.tmp`;
		writeFileSync(tmpPath, bytes);
		renameSync(tmpPath, finalPath);
		this.pruneStaleCacheFiles(sha16);
		this.log("xueprompts", "db cache installed", { sha16, bytes: bytes.byteLength });
		return { path: finalPath, sha16 };
	}

	/** 清理非当前版本缓存与半写 tmp（启动后首次落盘时调用；失败只记日志）。 */
	private pruneStaleCacheFiles(currentSha16: string): void {
		try {
			if (!existsSync(this.cacheDir)) return;
			for (const name of readdirSync(this.cacheDir)) {
				if (name.endsWith(".tmp")) {
					unlinkSync(join(this.cacheDir, name));
					continue;
				}
				const sha = cacheFileSha(name);
				if (sha !== null && sha !== currentSha16) {
					unlinkSync(join(this.cacheDir, name));
				}
			}
		} catch (error) {
			this.log("xueprompts", "db cache prune failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}
}
