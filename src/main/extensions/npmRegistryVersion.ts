import { clearTimeout, setTimeout } from "node:timers";

/**
 * npm registry HTTP 快路：扩展列表 forceRefresh 时逐包查询最新版本。
 *
 * 背景：`npm view <pkg> version` 每次 spawn 一个 npm 子进程（实测单个 1s 量级），
 * N 个扩展串行/重复 spawn 是扩展页手动刷新变慢的主因。registry 的 packument 接口
 * 一次 HTTP 就能拿到 `dist-tags.latest`，且可用实例内去重 + 并发闸把 N 次子进程
 * 风暴收敛成最多 6 条在途请求。
 *
 * 语义红线：本模块只是传输层优化。任何失败（网络错误 / 非 2xx / 坏 JSON /
 * 超时 / 基址解析失败）都必须回退调用方注入的 npmViewFallback，保证版本字段
 * 的最终值与时机和现状一致——不缺失、不抛错。
 */

/** 与 pi.dev 版本探测一致的 10s 超时：覆盖 DNS/连接挂起，避免设置页长时间转圈。 */
const DEFAULT_TIMEOUT_MS = 10_000;
/** 2MB 上限：corgi 文档通常几十 KB，超限说明拿到了完整 packument 或异常响应。 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/** 并发闸默认 6：避免 N 包同时打 registry 触发限流。 */
const DEFAULT_CONCURRENCY = 6;

/** 最小响应形状：支持流式 body（undici/Node fetch 必有）或整体 arrayBuffer（测试替身）。 */
type ResponseBodyLike = {
	getReader(): {
		read(): Promise<{ done?: boolean; value?: Uint8Array }>;
		cancel(): Promise<void>;
	};
};
type ResponseLike = {
	ok: boolean;
	status: number;
	body?: ResponseBodyLike | null;
	arrayBuffer?(): Promise<ArrayBuffer>;
};

export type NpmRegistryVersionResolverOptions = {
	/** 网络实现注入（单测）；默认 globalThis.fetch。 */
	fetchImpl?: typeof fetch;
	/** 解析 registry 基址（如 `npm config get registry`）；返回 null 表示整轮走回退。 */
	resolveRegistryBase: () => Promise<string | null>;
	/** 快路失败时逐包回退的 npm view 实现。 */
	npmViewFallback: (packageName: string) => Promise<string | null>;
	timeoutMs?: number;
	maxBytes?: number;
	concurrency?: number;
};

export type NpmRegistryVersionResolver = {
	resolveLatestVersion(packageName: string): Promise<string | null>;
};

/**
 * 创建一个 resolver 实例。实例创建即异步发起一次基址解析并 memo（尊重调用方
 * 每轮新建实例的语义：npmrc 变更后下一轮自然拿到新基址）。
 */
export function createNpmRegistryVersionResolver(options: NpmRegistryVersionResolverOptions): NpmRegistryVersionResolver {
	const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
	const npmViewFallback = options.npmViewFallback;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

	// 基址解析失败（含同步抛错）一律按 null 处理：整轮回退，零行为变化。
	const registryBasePromise = (async () => {
		try {
			return await options.resolveRegistryBase();
		} catch {
			return null;
		}
	})();

	/** 同包去重：实例内一个包只发起一次查询（含回退路径），后到者复用同一 Promise。 */
	const pending = new Map<string, Promise<string | null>>();
	/** 并发闸：在途请求计数 + 等待队列，峰值不超过 concurrency。 */
	let active = 0;
	const waiters: (() => void)[] = [];

	async function acquire(): Promise<() => void> {
		while (active >= concurrency) {
			await new Promise<void>((resolve) => waiters.push(resolve));
		}
		active += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			active -= 1;
			waiters.shift()?.();
		};
	}

	async function resolveLatestVersion(packageName: string): Promise<string | null> {
		const cached = pending.get(packageName);
		if (cached) return cached;
		const task = (async () => {
			const release = await acquire();
			try {
				const registryBase = await registryBasePromise;
				// 基址缺失（npm config 失败 / 输出非法）→ 整轮直接走 npm view，不发 HTTP。
				if (!registryBase) return await npmViewFallback(packageName);
				try {
					return await fetchLatestVersion(registryBase, packageName);
				} catch {
					// 网络错误 / 非 2xx / 坏 JSON / 超时 / 超限：该包回退子进程，版本信息不缺失。
					return await npmViewFallback(packageName);
				}
			} finally {
				release();
			}
		})();
		pending.set(packageName, task);
		return task;
	}

	async function fetchLatestVersion(registryBase: string, packageName: string): Promise<string | null> {
		// registry 常带尾斜杠（npm config get registry 的默认输出），去掉避免双斜杠。
		const base = registryBase.replace(/\/+$/, "");
		const url = `${base}/${encodeURIComponent(packageName)}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			// corgi（application/vnd.npm.install-v1+json）是精简文档：只含 dist-tags 与
			//各版本 minimal 元数据，体积远小于完整 packument。
			// 直接按结构类型接收：fetchImpl 声明的返回是标准 Response，其 body/status/ok/arrayBuffer
			// 与下面两个结构子集兼容，无需 as 强转（ResponseLike 只作读取时的最小形状约束）。
			const response: ResponseLike = await fetchImpl(url, { headers: { Accept: "application/vnd.npm.install-v1+json" }, signal: controller.signal });
			if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status} for ${packageName}`);
			const body = await readBodyWithCap(response, maxBytes, controller, url);
			const payload = JSON.parse(body.toString("utf8")) as { "dist-tags"?: { latest?: unknown } };
			const latest = payload?.["dist-tags"]?.latest;
			if (typeof latest !== "string" || !latest.trim()) throw new Error(`npm registry response has no dist-tags.latest for ${packageName}`);
			return latest.trim();
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * 流式读取响应体并按 maxBytes 提前中止：
	 * - 有 body（undici ReadableStream）：增量累计，超限立刻 controller.abort() 断开连接 + reader.cancel()。
	 * - 无 body（测试替身 / 受限运行时）：回落 arrayBuffer() 整读 + 事后校验。
	 * 用 getReader().read() 循环而非 for-await：本模块在测试经 vm 沙箱加载时，
	 * 沙箱与宿主的 Symbol.asyncIterator 分属不同 realm，for-await 跨 realm 会静默失败。
	 */
	async function readBodyWithCap(response: ResponseLike, limit: number, controller: AbortController, url: string): Promise<Buffer> {
		const body = response.body;
		if (body && typeof body.getReader === "function") {
			const reader = body.getReader();
			const chunks: Buffer[] = [];
			let total = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value || typeof value.byteLength !== "number" || value.byteLength === 0) continue;
				total += value.byteLength;
				if (total > limit) {
					// 先 abort 断网再 cancel reader：宁可连接复位，也不把剩余字节拉进内存
					controller.abort();
					try {
						await reader.cancel();
					} catch {
						// 连接已随 abort 关闭
					}
					throw new Error(`response too large (over ${limit} bytes) for ${url}`);
				}
				chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
			}
			return Buffer.concat(chunks);
		}
		if (typeof response.arrayBuffer !== "function") {
			throw new Error(`response without readable body for ${url}`);
		}
		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.byteLength > limit) {
			throw new Error(`response too large (${buffer.byteLength} bytes) for ${url}`);
		}
		return buffer;
	}

	return { resolveLatestVersion };
}
