import { open, rename, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { scanJsonlLines } from "./jsonlLineStream";

/**
 * 外部会话源（Claude / Cursor / WorkBuddy / Codex）的头部有界读取与并发工具。
 *
 * ── 为什么需要（2026-09 第三次同类闪退）──────────────────────────
 * 各导入器的 `scan()` 为生成「可导入会话列表」的摘要，原先对**每个源文件**调用
 * `readFile(file, "utf8")` 全量解析，且用 `Promise.all` 并发。源 transcript 常达
 * 几十 MB~GB（Codex 已有 head-only + 分块并发，其余三家没有），于是：
 *  - 单个大文件整读：几百 MB 字符串撞主进程 384MB 老生代堆 → V8
 *    `FatalProcessOutOfMemory` **abort 主进程**（无堆栈，表现为应用闪退）；
 *  - **并发才是乘数**：12 个 60MB 文件并行整读，累计 720MB 同样 abort
 *    （实测 exit 134）。只做「文件级上界」不够，必须同时限制并发。
 *
 * 因此这里提供两件配套能力：
 *  1. `readSessionSourceHead`：只读前 N 字节，内存占用与文件体积解耦；
 *  2. `mapWithConcurrency`：有界并发，避免「每个都不大、合起来超限」。
 *
 * 为什么不是流式全读：scan 只需要摘要（标题/预览/时间/条数），头部即可近似；
 * 真正的导入（转换并写盘）另有流式实现，见各 importOne 的 streaming 路径。
 */

/**
 * 扫描阶段读取的头部字节上限。
 * 取 1MB 与 Codex 的 `SCAN_HEAD_LIMIT` 对齐：足够覆盖头部若干行元数据与首条用户消息，
 * 又小到即便同时驻留若干份也不会把堆压垮（配合 mapWithConcurrency 使用）。
 */
export const SESSION_SCAN_HEAD_BYTES = 1024 * 1024;

/**
 * 扫描并发上限。
 *
 * 单份头部缓冲 = 1MB，6 路并发 ≈ 6MB 常驻，与 Codex 的 `SCAN_CONCURRENCY` 一致；
 * 之所以必须设上限：并发整读时内存是**乘数关系**（文件数 × 体积），
 * 这正是「每个文件都不大但一进列表就崩」的成因。
 */
export const SESSION_SCAN_CONCURRENCY = 6;

/**
 * 读取文件前 `limit` 字节并解码为 UTF-8。
 *
 * 返回 `{ head, size, mtimeMs }`：size/mtime 供摘要与「是否已导入」判定使用，
 * 这样调用方不必再单独 stat 一次。
 *
 * 注意：头部可能在多字节字符或行中间被切断，解码末尾会出现替换字符。
 * 调用方按「坏行跳过」处理即可（与既有 head-only 解析同策略）；
 * 需要精确取某行的调用方应容忍最后一行不完整。
 */
export async function readSessionSourceHead(filePath: string, limit: number = SESSION_SCAN_HEAD_BYTES): Promise<{ head: string; size: number; mtimeMs: number; truncated: boolean }> {
	const info = await stat(filePath);
	const handle = await open(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(limit);
		const { bytesRead } = await handle.read(buffer, 0, limit, 0);
		return {
			head: bytesRead > 0 ? buffer.subarray(0, bytesRead).toString("utf8") : "",
			size: info.size,
			mtimeMs: info.mtimeMs,
			/**
			 * 头部是否被截断（文件比上限大）。
			 *
			 * 调用方据此选时间口径：**未截断时头部就是全文件**，首末时间用内容里的真实
			 * 时间戳（列表排序靠它，用 mtime 会让同一批导出的会话时间全部相同）；
			 * 截断时才退化用 mtime（看不到文件尾，mtime 比头部最大值更接近真实末次活动）。
			 */
			truncated: info.size > bytesRead,
		};
	} finally {
		await handle.close();
	}
}

/**
 * 有界并发 map：最多 `limit` 个任务同时进行，结果顺序与输入一致。
 *
 * 用「工作槽」而非分块（chunk）实现：分块会让每块都等最慢的那个任务，
 * 慢文件会拖住整块；这里完成一个就补一个，吞吐更平滑。
 *
 * 单个任务抛错由调用方在 task 内自行吞掉（既有实现都是 `.catch(() => null)`），
 * 本函数不吞错——避免把真实故障静默成「没有会话」。
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const size = Math.max(1, Math.floor(limit));
	const results = new Array<R>(items.length);
	let next = 0;

	const worker = async () => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			results[index] = await task(items[index], index);
		}
	};

	await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
	return results;
}

/**
 * 逐行异步读取 JSONL 源文件，产出**已解析的对象**。
 *
 * 基于 scanJsonlLines（自有 chunk 流式实现）而非裸 readline：readline 对单行
 * 无界缓冲，导入源含数 GB 无换行内容时会撞 384MB 堆 FatalProcessOutOfMemory
 * （不可 catch，主进程直接 abort）——2026-03 导入器安全审计确认导入路径绕过了
 * 回放侧的 64MiB 单行防线，此处收口。任何时刻只持有一个 chunk 与当前行，
 * 内存 O(单行)，巨型会话可直接导入。
 *
 * 坏行默认抛错（与旧全量实现一致：导入要严格，不能静默丢消息）；错误信息截取行前缀，
 * 避免把整行内容刷进日志。`skipBadLines: true` 切宽容模式（坏行/半行跳过）——
 * 活跃会话文件可能正被追加，最后一行写一半，严格模式会把「导入到一半遇到半行」
 * 变成整个会话导入失败（Kimi wire / Minimax 用）。
 * 超长行（>64MiB）两种模式都抛错而非静默丢弃——严格模式丢行会让产物不完整，
 * 宽容模式丢行也会把超大内容静默漏掉，报错更能暴露源文件异常。
 */
export async function* readJsonlObjects(filePath: string, options: { maxLineBytes?: number; skipBadLines?: boolean } = {}): AsyncGenerator<Record<string, any>> {
	// 异步队列桥接：scanJsonlLines（callback 式）→ async generator（消费方 for await 式）。
	// 生产者在后台跑，清空队列后消费者 await notify；单消费者模式（async generator 语义保证）。
	type Slot = { value?: Record<string, any>; error?: Error; done?: boolean };
	const queue: Slot[] = [];
	let notify: (() => void) | undefined;
	let wakeup = () => {
		const n = notify;
		notify = undefined;
		n?.();
	};
	void scanJsonlLines(
		filePath,
		(line) => {
			if (!line.trim()) return;
			try {
				const parsed = JSON.parse(line) as unknown;
				if (parsed && typeof parsed === "object") {
					queue.push({ value: parsed as Record<string, any> });
					wakeup();
				}
			} catch (error) {
				if (options.skipBadLines) return; // 宽容模式：坏行/半行跳过（见函数注释）
				throw new Error(`Invalid JSON line in ${filePath}: ${line.slice(0, 120)} (${error instanceof Error ? error.message : String(error)})`);
			}
		},
		{
			maxLineBytes: options.maxLineBytes,
			onOversizedLine: (info) => {
				throw new Error(`Oversized line (${info.byteLength} bytes) in ${filePath}: ${info.prefix.slice(0, 120)}`);
			},
		},
	).then(
		() => {
			queue.push({ done: true });
			wakeup();
		},
		(error: unknown) => {
			queue.push({ error: error instanceof Error ? error : new Error(String(error)) });
			wakeup();
		},
	);
	try {
		for (;;) {
			const slot = queue.shift();
			if (slot?.error) throw slot.error;
			if (slot?.done) return;
			if (slot) {
				yield slot.value!;
				continue;
			}
			// 队列空：等生产者 wakeup。同步块内赋 notify 后再查队列：生产者要么
			// 已在本同步块前 push（队列非空立即醒），要么在之后 push（notify 已挂上），无漏醒窗口
			await new Promise<void>((resolve) => {
				notify = resolve;
				if (queue.length > 0) resolve();
			});
		}
	} finally {
		// 消费方提前 break/抛错：禁用后续 wakeup（避免迟到回调打醒无人消费的等待）。
		// 后台扫描会自然跑到文件尾并自关句柄，无泄漏。
		wakeup = () => {};
		notify = undefined;
	}
}

/**
 * 原子改名，失败重试一次。
 *
 * WSL 走 `\\wsl.localhost` 的 9P 通道时 rename 会偶发瞬时失败（EPERM/EBUSY，
 * 与 SessionScanner.renameWithRetry 观察一致）；重试一次即可，仍失败则让错误抛出。
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
	try {
		await rename(from, to);
	} catch {
		await new Promise((resolve) => setTimeout(resolve, 60));
		await rename(from, to);
	}
}

/**
 * 批量写盘的行 sink，返回 `{ sink, flush }`。
 *
 * 巨型会话可达几十万行，逐行 `handle.write` 系统调用太慢（实测占比可观）；
 * 这里按 1MB 聚合再写。调用方必须在结束前 `await flush()`，否则尾部缓冲会丢。
 */
export function createBufferedLineSink(handle: Pick<FileHandle, "write">, flushBytes: number = 1024 * 1024): { sink: (line: string) => Promise<void>; flush: () => Promise<void> } {
	let buffer = "";
	const flush = async () => {
		if (!buffer) return;
		const payload = buffer;
		buffer = "";
		await handle.write(payload, null, "utf8");
	};
	const sink = async (line: string) => {
		buffer += `${line}\n`;
		if (buffer.length >= flushBytes) await flush();
	};
	return { sink, flush };
}
