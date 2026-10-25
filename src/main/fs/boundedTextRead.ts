import { open, readFile, stat } from "node:fs/promises";

/**
 * 有界文本读取：stat 预检后按 maxBytes 只读文件头部或尾部，禁止整读超大文件。
 *
 * - 不超过 maxBytes 时等价于整读（常规小文件零额外开销）；
 * - 截断时做行对齐：head 丢弃末尾半行、tail 丢弃开头半行——半行对 JSONL 消费方
 *   必然解析失败，主动剔除避免脏数据进缓存/去重集合/展示层；
 * - 文件不存在/不可读时向上抛，由调用方决定兜底（与 readFile 语义一致）。
 * 参照 health/LogBundleExporter 的 stat 后 tail-read 模式，供日志域与 IPC 复用。
 */
export async function readTextBounded(path: string, maxBytes: number, mode: "head" | "tail" = "tail"): Promise<string> {
	const size = (await stat(path)).size;
	if (size <= maxBytes) return readFile(path, "utf8");
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(maxBytes);
		const position = mode === "tail" ? size - maxBytes : 0;
		await handle.read(buffer, 0, maxBytes, position);
		const text = buffer.toString("utf8");
		if (mode === "tail") {
			// 窗口开头大概率是被切开的半行
			const firstLineBreak = text.indexOf("\n");
			return firstLineBreak >= 0 ? text.slice(firstLineBreak + 1) : "";
		}
		const lastLineBreak = text.lastIndexOf("\n");
		return lastLineBreak >= 0 ? text.slice(0, lastLineBreak) : "";
	} finally {
		await handle.close();
	}
}
