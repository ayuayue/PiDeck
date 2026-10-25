/**
 * 解析剪贴板图片 data URL。
 * 允许 MIME 带 charset 等参数（如 image/png;charset=utf-8），
 * 否则 preload 的旧正则会把合法图片判失败，表现为「复制失败且无 log」。
 */
export function parseClipboardImageDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
	if (typeof dataUrl !== "string") return null;
	const match = /^data:(image\/[a-zA-Z0-9.+-]+)(?:;[^,]*)?;base64,(.+)$/s.exec(dataUrl.trim());
	if (!match) return null;
	return { mimeType: match[1], base64: match[2] };
}
