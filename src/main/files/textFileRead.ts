import { isUtf8 } from "node:buffer";
import { readFile, stat } from "node:fs/promises";

/** 项目文本读取的异常大小与解码守卫；非文本并不等同于已确认的加密文件。 */
export const MAX_TRUSTED_STAT_BYTES = 1024 ** 4;
const NON_TEXT_SAMPLE_CHARS = 64 * 1024;
const NON_TEXT_RATIO_LIMIT = 0.1;
const ACCESS_DENIED_CODES = new Set(["EACCES", "EPERM", "EBUSY", "EIO"]);

/** 控制字符过多的内容不交给文本编辑器；ESC 保留，以免误伤 ANSI 日志。 */
export function looksNonText(content: string): boolean {
	const sample = content.slice(0, NON_TEXT_SAMPLE_CHARS);
	if (sample.length === 0) return false;
	let suspect = 0;
	for (let index = 0; index < sample.length; index += 1) {
		const code = sample.charCodeAt(index);
		if (code < 0x09 || (code > 0x0d && code < 0x20 && code !== 0x1b)) suspect += 1;
	}
	return suspect / sample.length > NON_TEXT_RATIO_LIMIT;
}

/** 1TiB 是编辑器的保守可信范围，不是文件系统物理上限，也不能据此断定驱动故障。 */
export function assertTrustedStatSize(size: number): void {
	if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TRUSTED_STAT_BYTES) throw new Error(`FILE_SIZE_UNREADABLE:${size}`);
}

/** 权限、占用或 I/O 失败统一提示；保留未知错误和 ENOENT 的原始诊断。 */
export function normalizeFileAccessError(error: unknown): Error {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
	if (typeof code === "string" && ACCESS_DENIED_CODES.has(code)) return new Error(`FILE_ACCESS_DENIED:${code}`);
	return error instanceof Error ? error : new Error(String(error));
}

/** 先按大小预算拦截，再验证 UTF-8；拒绝有损解码，避免乱码进入自动保存链路。 */
export async function readTextFileGuarded(path: string, maxBytes?: number): Promise<string> {
	try {
		const fileStat = await stat(path);
		assertTrustedStatSize(fileStat.size);
		if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0 && fileStat.size > maxBytes) {
			throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(maxBytes)}`);
		}
		const bytes = await readFile(path);
		if (!isUtf8(bytes)) throw new Error(`FILE_NOT_TEXT:${bytes.byteLength}`);
		const content = bytes.toString("utf8");
		if (looksNonText(content)) throw new Error(`FILE_NOT_TEXT:${bytes.byteLength}`);
		return content;
	} catch (error) {
		throw normalizeFileAccessError(error);
	}
}
