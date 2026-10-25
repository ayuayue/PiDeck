import { open } from "node:fs/promises";

/**
 * 导入标记（`*_import` 记录）的有界读取。
 *
 * ── 为什么必须存在（2026-09 大会话闪退的第二个入口）──────────────
 * 各导入器判断「源是否已导入 / 是否 outdated」时都要读导入产物的 **头部** import 标记
 * （记录 sourceMtime / sourceSize）。原先实现是 `readFile(targetPath, "utf8")` 后
 * `split("\n").slice(0, 8)`——为了看前 8 行而把整个文件读成字符串。
 *
 * 关键点：这里读的 `targetPath` 正是**导入产物**，也就是那份 1GB 的会话文件。
 * 于是「扫描可导入会话列表」「导入完成后的状态回填」这些普通操作都会把 1GB 字符串
 * 拉进主进程，撞 384MB 老生代堆上限 → V8 FatalProcessOutOfMemory **abort 主进程**
 * （无堆栈，表现为应用闪退）。
 *
 * 现在只读头部固定字节数：import 标记由导入器写在文件最前面（紧随 session 头），
 * 用 256KB 覆盖绰绰有余；超出部分不读、不 decode，内存占用与文件大小彻底解耦。
 */

/**
 * 头部读取字节上限。取 256KB：远大于前几行 import 标记，
 * 又小到可以忽略不计（对比 1GB 会话的整读）。
 */
export const IMPORT_META_HEAD_BYTES = 256 * 1024;

/** 头部扫描的行数上限：import 标记一定出现在最前面的几条记录里。 */
const IMPORT_META_MAX_LINES = 16;

/**
 * 从导入产物头部找出指定 type 的 import 标记，返回其 sourceMtime / sourceSize。
 *
 * 语义与旧的「整读 + 逐行 parse」一致：
 * - 文件不存在 / 不可读 / 没有该标记 → 返回 undefined（调用方据此判定为「未导入」）；
 * - 坏行跳过（头部截断可能切在行中间或多字节字符上，不影响在前几行找到标记）；
 * - 只读头部，**不 materialize 整个文件**。
 */
export async function readImportMetaHead(targetPath: string, type: string): Promise<{ sourceMtime: number; sourceSize: number; version: number } | undefined> {
	let handle;
	try {
		handle = await open(targetPath, "r");
	} catch {
		// 文件不存在：调用方按「尚未导入」处理
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(IMPORT_META_HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, IMPORT_META_HEAD_BYTES, 0);
		if (bytesRead <= 0) return undefined;
		const head = buffer.subarray(0, bytesRead).toString("utf8");

		for (const line of head.split(/\r?\n/)) {
			if (!line) continue;
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				if (entry.type !== type) continue;
				return {
					sourceMtime: Number(entry.sourceMtime),
					sourceSize: Number(entry.sourceSize),
					// 转换器版本（缺省 0 = 老版本产物）：导入器据此把旧转换产物标 outdated 引导重导
					version: Number(entry.version) || 0,
				};
			} catch {
				// 坏行/截断行跳过，继续找标记
			}
		}
		return undefined;
	} finally {
		await handle.close();
	}
}
