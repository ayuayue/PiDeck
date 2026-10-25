/**
 * 日志文件行缓存（纯逻辑，无 electron 依赖，可单测）。
 *
 * 背景：设置页「存储与日志」tab 的 LogViewer 每次激活都会 listPage 一次，
 * 主进程要读全部日志文件（最多 MAX_LOG_FILES 个）。App 日志按天写入——
 * 历史文件写入后不再变化，只有当天文件持续 append。按 mtime+size 指纹缓存
 * 历史文件的行，查询时只重读变化文件，避免每次进 tab 都全量读盘。
 *
 * 缓存策略：
 * - 指纹 = mtimeMs + size（stat 元数据，不读内容）；指纹未变 → 复用行；
 * - 缓存按文件数设上限（FIFO 淘汰），防长期运行内存膨胀；
 * - 每文件保留尾部 maxLinesPerFile 行（与 AppLogger 既有防御上限一致）。
 */

export type LogLineCacheDeps = {
	readFile: (path: string) => Promise<string>;
	/** 大文件尾部有界读（stat 预检后只读 maxBytes）：注入时超过 maxBytesPerFile 的
	 * 日志不再整读进内存；未注入时退回整读+内存截尾（兼容旧 harness）。 */
	readFileTail?: (path: string, maxBytes: number) => Promise<string>;
	stat: (path: string) => Promise<{ mtimeMs: number; size: number }>;
};

type CachedLines = { fingerprint: string; lines: string[] };

export class LogLineCache {
	private readonly deps: LogLineCacheDeps;
	private readonly maxFiles: number;
	private readonly maxLinesPerFile: number;
	/** 单文件驻留字节预算（2026 内存排查：日志行可超 100B（堆栈/JSON），
	 *  仅按行数截断时 200K 行 × 32 文件可达数百 MB 常驻）。 */
	private readonly maxBytesPerFile: number;
	private readonly cache = new Map<string, CachedLines>();

	constructor(deps: LogLineCacheDeps, maxFiles = 32, maxLinesPerFile = 200_000, maxBytesPerFile = 8 * 1024 * 1024) {
		this.deps = deps;
		this.maxFiles = maxFiles;
		this.maxLinesPerFile = maxLinesPerFile;
		this.maxBytesPerFile = maxBytesPerFile;
	}

	/** 文件的尾部行（指纹未变时零 IO 复用缓存）。 */
	async linesOf(filePath: string): Promise<string[]> {
		// stat 只取一次：指纹与「是否走尾部有界读」共用，避免重复元数据 IO
		const info = await this.deps
			.stat(filePath)
			.then((s) => s)
			.catch(() => null);
		const fingerprint = info ? `${info.mtimeMs}:${info.size}` : "missing";
		const hit = this.cache.get(filePath);
		if (hit && hit.fingerprint === fingerprint) {
			return hit.lines;
		}
		// 超过单文件字节预算的日志只读尾部：整读的峰值内存与字符串拷贝都被钉在预算内
		const raw = info && info.size > this.maxBytesPerFile && this.deps.readFileTail ? await this.deps.readFileTail(filePath, this.maxBytesPerFile).catch(() => "") : await this.deps.readFile(filePath).catch(() => "");
		const rawLines = raw.split(/\r?\n/).filter(Boolean);
		// 行数 + 字节双预算：从尾部向前累积（日志只关心最近），
		// 至少保留一行；line.length 为 UTF-16 单元近似字节数，预算本身是粗粒度防护。
		const lines: string[] = [];
		let bytes = 0;
		for (let index = rawLines.length - 1; index >= 0 && lines.length < this.maxLinesPerFile; index -= 1) {
			const line = rawLines[index];
			if (lines.length > 0 && bytes + line.length > this.maxBytesPerFile) break;
			lines.unshift(line);
			bytes += line.length;
		}
		this.cache.set(filePath, { fingerprint, lines });
		this.evictIfNeeded();
		return lines;
	}

	/** 清空缓存（日志被清除后调用，防止旧行残留）。 */
	clear(): void {
		this.cache.clear();
	}

	private evictIfNeeded(): void {
		if (this.cache.size <= this.maxFiles) return;
		const oldest = this.cache.keys().next().value;
		if (oldest !== undefined) this.cache.delete(oldest);
	}
}
