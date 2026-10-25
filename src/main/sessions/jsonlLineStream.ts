import { open, rm } from "node:fs/promises";

/**
 * 会话 JSONL 的流式行扫描器（2026-09 大会话加载崩溃修复）。
 *
 * ── 为什么必须流式 ──────────────────────────────────────────────
 * 历史加载原先一律 `readFile(path, "utf8")` 再 `split("\n")`。两个硬边界决定了
 * 这条路必然崩，且崩法不同：
 *
 * 1. **V8 单字符串上限** = 2^29-24 字符 ≈ 5.37 亿（ASCII 下约 512MiB）。
 *    超过它的文件连字符串都建不出来，`readFile` 直接抛
 *    `Cannot create a string longer than 0x1fffffe8 characters`（ERR_STRING_TOO_LONG）。
 *    实测样本：994MiB / 10.34 亿字符的会话文件落在此区间。
 * 2. **主进程老生代堆被钉在 384MB**（见 `src/main/v8HeapLimits.ts`）。没撞上字符串
 *    上限的文件（如 424MiB / 4.38 亿字符）会先成功建出几百 MB 的字符串，紧接着
 *    撞破 384MB 上限 → V8 `FatalProcessOutOfMemory` **abort 掉整个主进程**。
 *    abort 不是可捕获的 JS 异常：AppLogger 拿不到堆栈，Electron 主进程即应用本体，
 *    用户看到的是「打开大会话后整个应用闪退」。
 *
 * 因此会话文件的读取必须以「定长块 + 行边界」为单位，永不在内存里 materialize
 * 整个文件。本模块按 chunk 读盘、只在**完整行**上 decode，并把每行的
 * **字节偏移 + 字节长度** 回传给调用方；上层据此建立「offset → 解析结果」索引，
 * 之后按 offset 定向读单行（见 SessionHistoryReader.readIndexedSessionMessages）。
 *
 * ── 语义约定（与旧 `split` 口径一致，保证既有索引缓存不失效）─────────
 * - `offset` = 行首字节偏移；`byteLength` = 该行字节数，**不含结尾 `\n`、含 `\r`**。
 *   下一行 offset = 当前 offset + byteLength + 1。
 * - 文件末尾没有 `\n` 的残行会以 `complete: false` 回调一次（pi 正在写）；
 *   需要「只处理完整行」的调用方（增量索引）据 complete 自行跳过。
 * - 空行同样回调（offset 必须连续），由调用方决定忽略。
 * - 单行超过 `maxLineBytes` 时不 decode 正文（否则一个巨型 base64 附件行就能
 *   把堆打穿），只回调 `onOversizedLine` 并给出行首前缀，调用方降级处理。
 */

/** 单行字节上限（默认 64MiB）：正常消息行远小于此值，超限行只保留前缀降级。 */
export const MAX_JSONL_LINE_BYTES = 64 * 1024 * 1024;
/** 单次读盘块大小。 */
export const DEFAULT_JSONL_CHUNK_BYTES = 1024 * 1024;
/** 每解析多少行让出一次事件循环（大会话解析不阻塞 IPC/窗口消息）。 */
export const DEFAULT_JSONL_YIELD_EVERY_LINES = 400;
/** 超长行回传的前缀长度：足够正则取出 id/parentId/type，不足以撑破堆。 */
const OVERSIZED_PREFIX_BYTES = 64 * 1024;

export type JsonlLineContext = {
	/** 行首在文件中的字节偏移。 */
	offset: number;
	/** 行字节长度（不含结尾 `\n`，含 `\r`）。 */
	byteLength: number;
	/** 是否以 `\n` 结尾；false = 文件末尾残行（pi 正在追加）。 */
	complete: boolean;
	/** 行序号（从 0 起，含被跳过的空行/超长行）。 */
	index: number;
};

export type JsonlOversizedLine = {
	offset: number;
	byteLength: number;
	/** 行首若干字节（UTF-8 解码，末尾可能带替换字符）。 */
	prefix: string;
	complete: boolean;
};

export type JsonlScanOptions = {
	/** 起始字节偏移（默认 0）。 */
	start?: number;
	/** 结束字节偏移（不含，默认文件尾）。 */
	end?: number;
	chunkBytes?: number;
	maxLineBytes?: number;
	yieldEveryLines?: number;
	/** 让出事件循环的实现（默认 setImmediate；测试可注入以断言节流）。 */
	yieldToEventLoop?: () => Promise<void>;
	/** 超长行回调（此时不会调用 visitor）。 */
	onOversizedLine?: (info: JsonlOversizedLine) => void;
};

export type JsonlScanSummary = {
	/** 已扫描字节数（含末尾残行字节）。 */
	bytesScanned: number;
	/** 扫描到的行数（含空行与超长行）。 */
	lines: number;
	/** 扫描区间是否以 `\n` 结束（= 后续可安全走增量追加）。 */
	endsWithNewline: boolean;
	/** 因超过 maxLineBytes 而未 decode 的行数。 */
	oversizedLines: number;
	/** 末尾残行字节数（0 = 区间以完整行结束）。 */
	trailingBytes: number;
};

function defaultYield(): Promise<void> {
	return new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

/**
 * 逐行扫描 JSONL 文件（流式）。visitor 抛错会终止扫描并向上抛出；
 * 返回 `"stop"` 表示调用方已收够数据，扫描立即收尾（不再读盘）。
 */
export async function scanJsonlLines(filePath: string, visitor: (line: string, context: JsonlLineContext) => void | "stop" | Promise<void | "stop">, options: JsonlScanOptions = {}): Promise<JsonlScanSummary> {
	const chunkBytes = Math.max(4096, Math.floor(options.chunkBytes ?? DEFAULT_JSONL_CHUNK_BYTES));
	const maxLineBytes = Math.max(1024, Math.floor(options.maxLineBytes ?? MAX_JSONL_LINE_BYTES));
	const yieldEveryLines = Math.max(1, Math.floor(options.yieldEveryLines ?? DEFAULT_JSONL_YIELD_EVERY_LINES));
	const yieldToEventLoop = options.yieldToEventLoop ?? defaultYield;

	const handle = await open(filePath, "r");
	try {
		const start = Math.max(0, Math.floor(options.start ?? 0));
		const end = options.end === undefined ? undefined : Math.max(start, Math.floor(options.end));

		const buffer = Buffer.allocUnsafe(chunkBytes);
		/** 当前行已累积的字节片段（跨块时才有多个）。 */
		let parts: Buffer[] = [];
		/** 当前行已累积字节数（超长行丢弃片段后仍继续累计，保证 byteLength 准确）。 */
		let pendingBytes = 0;
		/** 当前行是否为超长行（丢弃正文，只保留前缀）。 */
		let oversize = false;
		let oversizePrefix = "";
		let pendingOffset = start;
		let position = start;
		let lineIndex = 0;
		let bytesScanned = 0;
		let oversizedLines = 0;
		let stopped = false;

		const resetLine = () => {
			parts = [];
			pendingBytes = 0;
			oversize = false;
			oversizePrefix = "";
		};

		/**
		 * 追加当前块的一段字节。块内片段保持「视图」（不拷贝，emitLine 当场 decode）；
		 * 跨块时由 consolidatePending() 统一拷成独立 Buffer，避免下一块复写视图。
		 */
		const appendPiece = (piece: Buffer) => {
			if (piece.length === 0) return;
			pendingBytes += piece.length;
			if (oversize) return;
			parts.push(piece);
			if (pendingBytes > maxLineBytes) {
				// 越限：把已累积片段转成前缀后释放，后续字节只计数不驻留。
				oversize = true;
				oversizePrefix = Buffer.concat(parts).subarray(0, OVERSIZED_PREFIX_BYTES).toString("utf8");
				parts = [];
			}
		};

		const emitLine = async (finalPiece: Buffer, complete: boolean) => {
			const offset = pendingOffset;
			const byteLength = pendingBytes;
			const index = lineIndex;
			lineIndex += 1;
			if (oversize) {
				oversizedLines += 1;
				options.onOversizedLine?.({
					offset,
					byteLength,
					prefix: oversizePrefix,
					complete,
				});
			} else {
				const line = parts.length === 0 ? finalPiece.toString("utf8") : parts.length === 1 ? parts[0].toString("utf8") : Buffer.concat(parts, byteLength).toString("utf8");
				if ((await visitor(line, { offset, byteLength, complete, index })) === "stop") stopped = true;
			}
			pendingOffset = offset + byteLength + (complete ? 1 : 0);
			resetLine();
			if (lineIndex % yieldEveryLines === 0) await yieldToEventLoop();
		};

		/** 跨块续行：本块视图即将被下一次 read 复写，先把已累积片段固化。 */
		const consolidatePending = () => {
			if (oversize || pendingBytes === 0 || parts.length === 0) return;
			parts = [Buffer.concat(parts, pendingBytes)];
		};

		// 只按「读到 EOF（short read / 0 字节）」收尾，不预先 stat：少一次系统调用，
		// 也避免依赖 handle.stat（部分 fs 替身只实现 read/close）。
		for (;;) {
			const want = end === undefined ? chunkBytes : Math.min(chunkBytes, end - position);
			if (want <= 0) break;
			const { bytesRead } = await handle.read(buffer, 0, want, position);
			if (bytesRead <= 0) break;
			position += bytesRead;
			bytesScanned += bytesRead;
			const view = buffer.subarray(0, bytesRead);
			let scanFrom = 0;
			for (;;) {
				const newline = view.indexOf(0x0a, scanFrom);
				if (newline < 0) break;
				const piece = view.subarray(scanFrom, newline);
				appendPiece(piece);
				await emitLine(piece, true);
				scanFrom = newline + 1;
				if (stopped) break;
			}
			if (stopped) break;
			if (scanFrom < view.length) appendPiece(view.subarray(scanFrom));
			consolidatePending();
		}

		const trailingBytes = stopped ? 0 : pendingBytes;
		if (trailingBytes > 0) {
			await emitLine(Buffer.alloc(0), false);
		}

		return {
			bytesScanned,
			lines: lineIndex,
			// 提前收尾（visitor 返回 "stop"）时尾部并未读到，不能声称以 \n 结束
			endsWithNewline: !stopped && bytesScanned > 0 && trailingBytes === 0,
			oversizedLines,
			trailingBytes,
		};
	} finally {
		await handle.close();
	}
}

export type JsonlRewriteResult = {
	/** 源文件行数（含空行）。 */
	lines: number;
	/** 实际写入目标文件的行数（transform 返回 null 的被丢弃行不计）。 */
	writtenLines: number;
	/** 因超过 maxLineBytes 未 decode 的行数（这些行按 transform(null) 语义丢弃）。 */
	oversizedLines: number;
};

/** 写盘批大小：把行拼到这么多字节再 write，兼顾系统调用次数与内存占用。 */
const REWRITE_FLUSH_BYTES = 256 * 1024;

/**
 * 流式重写 JSONL：逐行读源 → transform → 写目标，全程不 materialize 整个文件。
 *
 * 用途：rename / copy 这类「整文件行变换 + 追加一行」的会话文件操作。原先走
 * `readFile → split → join → writeFile`，大会话上会先撞字符串上限/堆上限，
 * 而且**写盘前就把全部内容持在内存里**（失败即丢原文件）。这里逐行消费，
 * 目标文件由调用方命名（通常写临时文件再原子改名覆盖源文件）。
 *
 * 注：超长行（> maxLineBytes）不 decode，按丢弃处理（`transform(null)` 语义），
 * 调用方无法对其做行变换——会话 JSONL 里出现这种行说明是异常内容，保留原样更危险。
 */
export async function rewriteJsonlLines(srcPath: string, dstPath: string, transform: (line: string, context: JsonlLineContext | null) => string | null, options: Pick<JsonlScanOptions, "chunkBytes" | "maxLineBytes" | "yieldEveryLines" | "yieldToEventLoop"> = {}): Promise<JsonlRewriteResult> {
	const handle = await open(dstPath, "w");
	let pending: string[] = [];
	let pendingBytes = 0;
	let writtenLines = 0;

	const flush = async () => {
		if (pending.length === 0) return;
		const payload = pending.join("");
		pending = [];
		pendingBytes = 0;
		await handle.write(payload, null, "utf8");
	};

	const writeLine = async (line: string) => {
		const payload = `${line}\n`;
		pending.push(payload);
		pendingBytes += Buffer.byteLength(payload, "utf8");
		writtenLines += 1;
		if (pendingBytes >= REWRITE_FLUSH_BYTES) await flush();
	};

	try {
		const summary = await scanJsonlLines(
			srcPath,
			async (line, context) => {
				const mapped = transform(line, context);
				if (mapped === null) return;
				await writeLine(mapped);
			},
			{
				chunkBytes: options.chunkBytes,
				maxLineBytes: options.maxLineBytes,
				yieldEveryLines: options.yieldEveryLines,
				yieldToEventLoop: options.yieldToEventLoop,
				onOversizedLine: () => {
					// 超长行不进内存：按 transform(null) 语义丢弃（调用方无从变换）
					const mapped = transform("", null);
					if (mapped !== null) void writeLine(mapped);
				},
			},
		);
		await flush();
		await handle.sync();
		await handle.close();
		return { lines: summary.lines, writtenLines, oversizedLines: summary.oversizedLines };
	} catch (error) {
		// 半截目标文件不可用：关句柄 + 删除再抛，避免调用方误当作成功产物
		await handle.close().catch(() => {});
		await rm(dstPath, { force: true }).catch(() => {});
		throw error;
	}
}
