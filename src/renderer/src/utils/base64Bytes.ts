/**
 * base64 → 字节。大文件走显式循环，避免 `Uint8Array.from(binary, fn)` 的逐元素回调开销。
 * 主进程 `files.readBase64` 返回的是裸 base64（不带 data: 前缀）。
 */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(base64);
	const buffer = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
